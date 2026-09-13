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

Seit #28 laeuft jede Probe, die ein Urteil erwartet, ueber den PRODUKTPFAD:
ein Fenster ueber das ganze Video mit Sollstrecke aus der Wahrheitsdatei und
Bildzahl aus der Mutation. Ohne Sollstrecke verweigert das Geraet das Urteil
-- die Proben liefen vorher ueber die eigene Zerlegung und haetten damit ab
jetzt nur noch Verweigerungen verglichen. Alle drei Mutationen erhalten die
Gesamtstrecke (erstes und letztes Bild bleiben stehen), die Streckenschranke
muss also halten; tut sie es nicht, ist das ein eigener Befund.

Bedingungen: MUTATION -- ist der Inhalt dieser Datei. ERREICHBARKEIT -- es
laeuft `analysiere`, derselbe Weg wie die CLI. NENNER -- jede verglichene
Quote fuehrt ihren Nenner mit. AEUSSERER ANKER -- die Mutation ist bekannt
und stammt nicht aus der Messung.
"""

from __future__ import annotations

import cv2
import pytest
from synth_fixtures import W, schreibe_lauf_ueber_ganzes_video

from smoothness.analyse import analysiere
from smoothness.frames import AUFNAHME_BREITE_PX
from smoothness.report import als_text

FALL = "c14_scroll_rampe"


def _urteil_ueber_produktpfad(mp4, wahrheit, ziel) -> dict:
    cap = cv2.VideoCapture(str(mp4))
    bilder = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    strecke = sum(wahrheit["dx"]) * AUFNAHME_BREITE_PX / W
    lauf = schreibe_lauf_ueber_ganzes_video(ziel, bilder, "c14:scroll-right", strecke)
    bericht = analysiere(str(mp4), lauf_verzeichnis=lauf)
    (fenster,) = bericht["fenster"]
    assert fenster["schranke_strecke"]["haelt"] is True, fenster["schranke_strecke"]
    assert fenster["schranke_60hz"]["haelt"] is True, fenster["schranke_60hz"]
    return bericht


@pytest.fixture(scope="module")
def wahrheit(eichfall):
    return eichfall(FALL)[1]


@pytest.fixture(scope="module")
def original(eichfall, tmp_path_factory):
    mp4, wahrheit = eichfall(FALL)
    return _urteil_ueber_produktpfad(mp4, wahrheit, tmp_path_factory.mktemp("original"))


@pytest.mark.langsam
def test_unversehrtes_material_gilt_als_glatt(original):
    (fenster,) = original["fenster"]
    assert fenster["urteil"] == "glatt"
    assert fenster["stoerstellen_anzahl"] == 0
    assert fenster["wiederholte_bilder"]["anzahl"] == 0
    assert fenster["wiederholte_bilder"]["von"] == fenster["bildpaare"]


@pytest.mark.langsam
@pytest.mark.parametrize("art", ["wiederholt3", "wiederholt5"])
def test_wiederholte_bilder_verschlechtern_das_urteil(art, original, mutant, wahrheit,
                                                     tmp_path):
    """Die Aufnahme haengt: jedes N-te Bild wiederholt sich, danach folgt ein
    Nachholsprung. Beides muss das Geraet sehen."""
    bericht = _urteil_ueber_produktpfad(mutant(FALL, art), wahrheit, tmp_path)
    (fenster,) = bericht["fenster"]
    (vorher,) = original["fenster"]
    assert fenster["stoerstellen_anzahl"] > vorher["stoerstellen_anzahl"]
    assert fenster["urteil"] != "glatt"
    wdh = fenster["wiederholte_bilder"]
    assert wdh["anzahl"] > 0 and wdh["von"] == fenster["bildpaare"]
    assert wdh["quote"] > vorher["wiederholte_bilder"]["quote"]


@pytest.mark.langsam
def test_geloeschte_bilder_verschlechtern_das_urteil(original, mutant, wahrheit, tmp_path):
    """Die Aufnahme verliert jedes vierte Bild und der Rest rueckt auf. Es
    gibt dann KEINE wiederholten Bilder -- die Verschlechterung muss sich
    allein an den Schrittweiten zeigen, sonst haengt das Urteil an der
    Wiederholungsquote statt an der Bewegung."""
    bericht = _urteil_ueber_produktpfad(mutant(FALL, "fehlt4"), wahrheit, tmp_path)
    (fenster,) = bericht["fenster"]
    (vorher,) = original["fenster"]
    assert fenster["wiederholte_bilder"]["anzahl"] == 0
    assert fenster["stoerstellen_anzahl"] > vorher["stoerstellen_anzahl"]
    assert fenster["schritt_px"]["median"] > vorher["schritt_px"]["median"]


@pytest.mark.langsam
def test_vertauschte_bilder_kippen_in_eine_verweigerung(mutant):
    """Bleibt bewusst auf der eigenen Zerlegung: geprueft wird, dass gar kein
    Fenster zustandekommt, nicht ein Urteil.

    Der schwaechste Punkt des Verfahrens, offen ausgewiesen: paarweise
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
