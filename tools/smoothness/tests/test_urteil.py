"""Wann ein Fenster ein Urteil bekommt, und was das Urteil wiegt.

Zwei Defekte, beide beim ersten Kontakt mit echten Laufdaten gefunden:

  #28  Sortier-Fenster -- die Tabelle zeichnet neu, nichts gleitet -- bekamen
       einen Haker. Ihre Streckenschranke war ungeprueft (kein Sollwert), und
       "ungeprueft" wurde wie "bestanden" behandelt.
  #29  Die Haker-ZAHL sortierte einen Teleport ueber die ganze Strecke besser
       ein als einen leicht rauen Scroll: eine Stoerstelle gegen zwei.

Bedingungen:
  MUTATION         jeder Test hier ist gegen den Code VOR dem Fix gelaufen
                   bzw. gegen gezielt zurueckgebaute Stellen (PR-Beschreibung).
  ERREICHBARKEIT   jeder Test beweist zuerst, dass der alte Weg den Defekt
                   wirklich erzeugt haette -- sonst prueft er nichts.
  NENNER           Zusammenfassung und Laufvergleich nennen ihren Nenner; die
                   Tests pruefen ihn mit.
  AEUSSERER ANKER  Sollstrecke und Dauer sind hier von Hand gesetzt, nicht aus
                   der Messung gerechnet.
  FIXTURE-HERKUNFT von Hand gebaute Bildpaare. Die Pixelmathematik ist nicht
                   Gegenstand; die echten Laeufe prueft test_browser_arme.py.
"""

from __future__ import annotations

import numpy as np

from smoothness.bounds import Dauer
from smoothness.hitches import finde_haker
from smoothness.pairs import Pair
from smoothness.report import (
    NICHT_MESSBAR,
    beurteile_fenster,
    fasse_zusammen,
    vergleiche_laeufe,
)
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


# ------------------------------------------------------------------ #29
# Nachgebaut aus den echten Fenstern `tasks:scroll-right:1`: 135 px Strecke.
STRECKE = 135.0
TELEPORT = [0.0] * 8 + [111.0] + [0.0] * 5 + [12.0, 6.0, 4.0, 2.0]          # 18 Paare
RAU = [4.0, 5.0, 7.0, 8.0, 8.0, 0.0, 0.0, 24.0, 8.0, 8.0, 8.0, 0.0,
       0.0, 22.0, 8.0, 8.0, 7.0, 6.0, 4.0]                                   # 19 Paare


def _urteil(name: str, schritte: list[float]) -> dict:
    assert abs(sum(schritte) - STRECKE) < 1e-9, "Fixture verfehlt die eigene Sollstrecke"
    return beurteile_fenster(_paare(schritte), _fenster(name, len(schritte), STRECKE), FPS)


def test_teleport_heisst_teleport():
    u = _urteil("teleport", TELEPORT)
    assert u["schwere"]["teleport"] is True
    assert str(u["urteil"]).startswith("Teleport")
    assert u["schwere"]["groesster_sprung_anteil_strecke"] == round(111 / 135, 3)
    assert u["schwere"]["gleichschritt_px"] == round(135 / 18, 3)
    assert "Sollstrecke" in str(u["schwere"]["gleichschritt_herkunft"])


def test_ein_teleport_wiegt_schwerer_als_zwei_kleine_haker():
    # Derselbe Fenstername in beiden Laeufen: verglichen wird nur ueber
    # gemeinsame Fenster.
    teleport = _urteil("tasks:scroll-right:1", TELEPORT)
    rau = _urteil("tasks:scroll-right:1", RAU)

    # Erreichbarkeit: nach der blossen Zahl liegt der Fall genau falsch herum.
    # Sonst belegt dieser Test die Schwere nicht.
    assert rau["stoerstellen_anzahl"] > teleport["stoerstellen_anzahl"], (
        rau["stoerstellen"], teleport["stoerstellen"])

    assert rau["schwere"]["teleport"] is False
    assert (teleport["schwere"]["groesster_sprung_gleichschritte"]
            > 3 * rau["schwere"]["groesster_sprung_gleichschritte"])

    vergleich = vergleiche_laeufe({
        "teleport": {"fenster": [teleport]},
        "rau": {"fenster": [rau]},
    })
    assert vergleich["gemeinsam_beurteilt"]["anzahl"] == 1
    reihenfolge = [r["lauf"] for r in vergleich["reihenfolge_glatt_nach_hakelig"]]
    assert reihenfolge == ["rau", "teleport"]


def test_jede_stoerstelle_traegt_ihre_schwere():
    rau = _urteil("rau", RAU)
    assert rau["stoerstellen"], "Fixture ohne Stoerstelle prueft nichts"
    for s in rau["stoerstellen"]:
        assert s["groesster_schritt_px"] > 0
        assert s["gleichschritte"] == round(s["groesster_schritt_px"] / (135 / 19), 2)
        assert s["stillstand_ms"] >= 0
    assert "Gleichschritte" in str(rau["urteil"])


def test_laufvergleich_zaehlt_nur_fenster_die_ueberall_beurteilt_wurden():
    """Sonst gewinnt der Lauf, dessen schlimmstes Fenster verweigert wurde."""
    teleport = _urteil("scroll-right", TELEPORT)
    rau = _urteil("scroll-right", RAU)
    verweigert = {**teleport, "urteil": NICHT_MESSBAR, "grund_code": "strecke_verfehlt"}
    glatt = beurteile_fenster(_paare([4.0] * 20), _fenster("scroll-down", 20, 80.0), FPS)

    vergleich = vergleiche_laeufe({
        # Lauf A: das Teleport-Fenster ist verweigert, nur das glatte zaehlt.
        "A": {"fenster": [verweigert, glatt]},
        "B": {"fenster": [rau, glatt]},
    })
    assert vergleich["fenster"] == ["scroll-down"]
    g = vergleich["gemeinsam_beurteilt"]
    assert (g["anzahl"], g["von"]) == (1, 2)
    assert "allen Laeufen" in g["nenner_bedeutung"]
