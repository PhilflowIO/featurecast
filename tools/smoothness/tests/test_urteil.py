"""Wann ein Fenster ein Urteil bekommt, und was das Urteil wiegt.

Ein Defekt, beim ersten Kontakt mit echten Laufdaten gefunden:

  #28  Sortier-Fenster -- die Tabelle zeichnet neu, nichts gleitet -- bekamen
       einen Haker. Ihre Streckenschranke war ungeprueft (kein Sollwert), und
       "ungeprueft" wurde wie "bestanden" behandelt.

Bedingungen:
  MUTATION         jeder Test hier ist gegen den Code VOR dem Fix gelaufen
                   bzw. gegen gezielt zurueckgebaute Stellen (PR-Beschreibung).
  ERREICHBARKEIT   jeder Test beweist zuerst, dass der alte Weg den Defekt
                   wirklich erzeugt haette -- sonst prueft er nichts.
  NENNER           die Zusammenfassung nennt ihren Nenner; die
                   Tests pruefen ihn mit.
  AEUSSERER ANKER  Sollstrecke und Dauer sind hier von Hand gesetzt, nicht aus
                   der Messung gerechnet.
  FIXTURE-HERKUNFT von Hand gebaute Bildpaare. Die Pixelmathematik ist nicht
                   Gegenstand.
"""

from __future__ import annotations

import numpy as np

from smoothness.bounds import Dauer
from smoothness.hitches import finde_haker
from smoothness.pairs import Pair
from smoothness.report import NICHT_MESSBAR, beurteile_fenster, fasse_zusammen
from smoothness.windows import QUELLE_PRODUKT, Fenster

FPS = 60.0


def _paare(schritte: list[float], dup_bei_null: bool = True) -> list[Pair]:
    return [Pair(i, dx, 0.0, "ok", 0.0, 0.0 if (dx == 0.0 and dup_bei_null) else 9.0,
                 dx == 0.0 and dup_bei_null)
            for i, dx in enumerate(schritte, start=1)]


def _fenster(name: str, n: int, soll: float | None, richtung: str | None = "rechts",
             dauer: bool = True) -> Fenster:
    return Fenster(name=name, von_bildpaar=1, bis_bildpaar=n, quelle=QUELLE_PRODUKT,
                   soll_px=soll, soll_herkunft="Test: von Hand" if soll else None,
                   dauer=Dauer(n / 60, "Test: externe Dauer") if dauer else None,
                   richtung=richtung, bilder_extern=n + 1 if dauer else None)


# ------------------------------------------------------------------ #28
def test_neuzeichnen_ohne_translation_bekommt_kein_urteil():
    """Ein Sortier-Fenster: 26 Bildpaare, nichts gleitet, kein Sollwert."""
    pairs = _paare([0.0] * 26)

    # Erreichbarkeit: die Haker-Definition allein benotet das mit einem
    # Stillstand. Genau das stand im Bericht der ersten Fassung.
    assert finde_haker(np.zeros(26), 1, FPS).stoerstellen, (
        "die Definition sieht hier keinen Stillstand mehr -- dann belegt der "
        "Test die Verweigerung nicht")

    urteil = beurteile_fenster(pairs, _fenster("expenses:2:sort-desc", 26, None, None), FPS)
    assert urteil["urteil"] == NICHT_MESSBAR
    assert urteil["grund_code"] == "strecke_ungeprueft"
    assert "keine Translation" in str(urteil["grund"])
    assert "stoerstellen_anzahl" not in urteil
    assert "haker" not in urteil


def test_richtung_wird_aus_einer_nullmessung_nicht_erfunden():
    urteil = beurteile_fenster(_paare([0.0] * 26), _fenster("sort", 26, None, None), FPS)
    assert urteil["translation_gemessen"] is False
    assert urteil["richtung"] is None
    assert "keine" in str(urteil["richtung_herkunft"])


def test_ungepruefte_streckenschranke_haelt_das_urteil_zurueck_auch_bei_bewegung():
    """Nicht nur Neuzeichnen: jede Bewegung ohne Sollwert bleibt ohne Urteil.
    Die erste Fassung haette hier "glatt" gesagt."""
    urteil = beurteile_fenster(_paare([4.0] * 20), _fenster("ohne-soll", 20, None), FPS)
    assert urteil["schranke_strecke"]["haelt"] is None
    assert urteil["urteil"] == NICHT_MESSBAR
    assert urteil["grund_code"] == "strecke_ungeprueft"
    assert "keine Translation" not in str(urteil["grund"])


def test_ungepruefte_60hz_schranke_haelt_das_urteil_zurueck():
    """Dieselbe Regel fuer die zweite Schranke."""
    urteil = beurteile_fenster(_paare([4.0] * 20),
                               _fenster("ohne-dauer", 20, 80.0, dauer=False), FPS)
    assert urteil["schranke_strecke"]["haelt"] is True
    assert urteil["schranke_60hz"]["haelt"] is None
    assert urteil["urteil"] == NICHT_MESSBAR
    assert urteil["grund_code"] == "60hz_ungeprueft"


def test_zusammenfassung_nennt_beurteilte_und_zurueckgehaltene_fenster():
    urteile = [
        beurteile_fenster(_paare([4.0] * 20), _fenster("scroll", 20, 80.0), FPS),
        beurteile_fenster(_paare([0.0] * 26), _fenster("sort-a", 26, None, None), FPS),
        beurteile_fenster(_paare([0.0] * 26), _fenster("sort-b", 26, None, None), FPS),
    ]
    zf = fasse_zusammen(urteile)
    assert (zf["beurteilt"]["anzahl"], zf["beurteilt"]["von"]) == (1, 3)
    assert zf["beurteilt"]["nenner_bedeutung"] == "Fenster des Laufs"
    assert zf["zurueckgehalten"] == {"strecke_ungeprueft": 2}
    assert zf["haker"] == 0
    assert zf["je_richtung"]["rechts"]["beurteilt"]["anzahl"] == 1
    assert zf["je_richtung"]["ohne Richtung"]["beurteilt"] == {
        "anzahl": 0, "von": 2, "nenner_bedeutung": "Fenster dieser Richtung", "quote": 0.0}
