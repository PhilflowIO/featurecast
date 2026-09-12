"""Mutation am MATERIAL: macht das Video kaputt, das Urteil muss folgen.

Ein Messgeraet, das kaputtes Material weiter fuer gut erklaert, ist der
Befund. Grundlage ist `c14_scroll_rampe` -- ein synthetischer Scroll mit
Anlauf- und Bremskurve, der im unversehrten Zustand als "glatt" durchgeht.
Genau das macht ihn brauchbar: eine Verschlechterung ist dann nicht mit
Vorschaden zu verwechseln.

FIXTURE-HERKUNFT: synthetisch (tests/synth_fixtures.py, fester Keim). Der
Mutationsnachweis des Prototyps lief auf echtem Material -- Feld 3 des
Vergleichsvideos compare3-full.mp4, Bilder 1518-1575, vom Owner als fluessig
bezeichnet. Dieses Video liegt nicht im Repo (.gitignore schliesst *.mp4
aus) und der Rechner, der es erzeugt, war zum Zeitpunkt dieser Arbeit nicht
erreichbar. Die Zahlen von dort stehen in
.claude/handoffs/messtechnik-glaette.md, Abschnitt 3; sie sind hier NICHT
nachgestellt und gelten als ungeprueft, bis der Lauf wiederholbar ist.

Bedingungen: MUTATION -- ist der Inhalt dieser Datei. ERREICHBARKEIT -- es
laeuft `analysiere`, derselbe Weg wie die CLI. NENNER -- jede verglichene
Quote fuehrt ihren Nenner mit. AEUSSERER ANKER -- die Mutation ist bekannt
und stammt nicht aus der Messung.
"""

from __future__ import annotations

import pytest

from smoothness.analyse import analysiere
from smoothness.report import als_text

FALL = "c14_scroll_rampe"


@pytest.fixture(scope="module")
def original(eichfall):
    mp4, _ = eichfall(FALL)
    return analysiere(str(mp4))


@pytest.mark.langsam
def test_unversehrtes_material_gilt_als_glatt(original):
    (fenster,) = original["fenster"]
    assert fenster["urteil"] == "glatt"
    assert fenster["stoerstellen_anzahl"] == 0
    assert fenster["wiederholte_bilder"]["anzahl"] == 0
    assert fenster["wiederholte_bilder"]["von"] == fenster["bildpaare"]


@pytest.mark.langsam
@pytest.mark.parametrize("art", ["wiederholt3", "wiederholt5"])
def test_wiederholte_bilder_verschlechtern_das_urteil(art, original, mutant):
    """Die Aufnahme haengt: jedes N-te Bild wiederholt sich, danach folgt ein
    Nachholsprung. Beides muss das Geraet sehen."""
    bericht = analysiere(str(mutant(FALL, art)))
    (fenster,) = bericht["fenster"]
    (vorher,) = original["fenster"]
    assert fenster["stoerstellen_anzahl"] > vorher["stoerstellen_anzahl"]
    assert fenster["urteil"] != "glatt"
    wdh = fenster["wiederholte_bilder"]
    assert wdh["anzahl"] > 0 and wdh["von"] == fenster["bildpaare"]
    assert wdh["quote"] > vorher["wiederholte_bilder"]["quote"]


@pytest.mark.langsam
def test_geloeschte_bilder_verschlechtern_das_urteil(original, mutant):
    """Die Aufnahme verliert jedes vierte Bild und der Rest rueckt auf. Es
    gibt dann KEINE wiederholten Bilder -- die Verschlechterung muss sich
    allein an den Schrittweiten zeigen, sonst haengt das Urteil an der
    Wiederholungsquote statt an der Bewegung."""
    bericht = analysiere(str(mutant(FALL, "fehlt4")))
    (fenster,) = bericht["fenster"]
    (vorher,) = original["fenster"]
    assert fenster["wiederholte_bilder"]["anzahl"] == 0
    assert fenster["stoerstellen_anzahl"] > vorher["stoerstellen_anzahl"]
    assert fenster["schritt_px"]["median"] > vorher["schritt_px"]["median"]


@pytest.mark.langsam
def test_vertauschte_bilder_kippen_in_eine_verweigerung(mutant):
    """Der schwaechste Punkt des Verfahrens, offen ausgewiesen: paarweise
    vertauschte Bilder zersplittern die Bewegung so, dass gar kein Fenster
    mehr zustandekommt. Dann darf das Geraet NICHT schweigen -- Schweigen
    liest sich wie ein Bestehen. Es meldet die Verweigerung und das
    Zappel-Mass."""
    bericht = analysiere(str(mutant(FALL, "vertauscht")))
    assert bericht["fenster"] == []
    rw = bericht["richtungswechsel"]
    assert rw["quote"] > 0.2, f"Zappel-Mass zu klein: {rw}"
    assert rw["von_bewegten_bildpaaren"] > 0 and rw["nenner_bedeutung"]
    text = als_text(bericht)
    assert "KEIN auswertbares Bewegungsfenster" in text
    assert "KEIN gutes Zeugnis" in text
