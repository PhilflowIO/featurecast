"""Eichung gegen bekannte Wahrheit.

Die fuenf Bedingungen, die ein Test in diesem Repo erfuellen muss (eine
gruene Suite hat hier achtmal einen echten Defekt durchgelassen):

  MUTATION         siehe tests/test_mutation.py und den Mutationsnachweis in
                   der PR-Beschreibung -- diese Datei stirbt, wenn das
                   Mehrdeutigkeits-Tor ausgebaut wird (c12) oder der
                   Schiedsrichter das falsche Vorzeichen bekommt (c5).
  ERREICHBARKEIT   die Videos laufen durch `lies_graustufen` und
                   `messe_bildpaare`, also durch genau den Pfad, den auch die
                   CLI nimmt -- nicht an einer Abkuerzung vorbei.
  NENNER           jede Zahl unten nennt ihren Nenner: 59 Bildpaare je Fall.
  AEUSSERER ANKER  die Wahrheit stammt aus dem ERZEUGER, nicht aus dem
                   Messgeraet. Ein Fall, dessen Sollwert aus der Messung
                   berechnet waere, koennte nie fehlschlagen.
  FIXTURE-HERKUNFT synthetisch, tests/synth_fixtures.py, fester Keim --
                   siehe dortigen Modul-Docstring. KEIN Aufnahmelauf.
"""

from __future__ import annotations

import numpy as np
import pytest

from smoothness.frames import lies_graustufen
from smoothness.pairs import STATUS_GUELTIG, messe_bildpaare
from smoothness.report import beurteile_fenster
from smoothness.windows import QUELLE_PRODUKT, Fenster

# Fall -> (zulaessiger mittlerer Fehler, zulaessiger groesster Fehler) in px.
# Gemessen am 2026-09-12 mit diesem Werkzeug, dann auf den naechsten
# runden Wert darueber gesetzt -- nicht umgekehrt. Die Sub-Pixel-Faelle
# duerfen mehr, weil Kodierung und bikubische Fensterung dort wirken.
SCHRANKEN = {
    "c1_gleichmaessig_h": (0.01, 0.05),
    "c2_periodisch_h": (0.01, 0.05),
    "c3_subpixel_h": (0.12, 0.25),
    "c4_gehaltene_bilder": (0.01, 0.05),
    "c5_teleport": (0.01, 0.05),
    "c6_umkehr": (0.01, 0.05),
    "c7_senkrecht": (0.01, 0.05),
    "c8_nebenanimation": (0.01, 0.05),
    "c9_periodisch_umkehr_subpixel": (0.08, 0.20),
    "c10_streng_stehend": (0.01, 0.05),
    "c11_streng_langsam": (0.06, 0.15),
    "c13_szenenwechsel": (0.01, 0.05),
    "c14_scroll_rampe": (0.10, 0.30),
}


def _fehler(mp4, wahrheit):
    pairs = messe_bildpaare(lies_graustufen(str(mp4)))
    tdx = np.array(wahrheit["dx"], dtype=float)
    tdy = np.array(wahrheit["dy"], dtype=float)
    edx = np.array([p.dx for p in pairs])
    edy = np.array([p.dy for p in pairs])
    gueltig = np.array([p.status in STATUS_GUELTIG for p in pairs])
    hat_wahrheit = ~np.isnan(tdx)
    fehler = np.hypot(edx - tdx, edy - tdy)
    return pairs, fehler, gueltig, hat_wahrheit


@pytest.mark.langsam
@pytest.mark.parametrize("fall", sorted(SCHRANKEN))
def test_eichfall_trifft_die_bekannte_wahrheit(fall, eichfall):
    mp4, wahrheit = eichfall(fall)
    pairs, fehler, gueltig, hat_wahrheit = _fehler(mp4, wahrheit)
    m = gueltig & hat_wahrheit
    nenner = int(hat_wahrheit.sum())
    assert nenner >= 55, f"{fall}: nur {nenner} Bildpaare mit bekannter Wahrheit"
    # Nenner ausdruecklich: von `nenner` Bildpaaren mit bekannter Wahrheit
    # muessen fast alle angenommen worden sein. Ein Geraet, das fast alles
    # verweigert, haette sonst einen perfekten mittleren Fehler.
    assert int(m.sum()) >= nenner - 1, (
        f"{fall}: nur {int(m.sum())}/{nenner} Bildpaare angenommen")
    mittel_max, max_max = SCHRANKEN[fall]
    assert float(np.nanmean(fehler[m])) <= mittel_max
    assert float(np.nanmax(fehler[m])) <= max_max
    assert int(np.nansum(fehler[m] > 1.0)) == 0, (
        f"{fall}: grob falsche Bildpaare unter den angenommenen Messungen")


@pytest.mark.langsam
def test_szenenwechsel_wird_verweigert(eichfall):
    """c13: beim Schnitt gibt es keinen gueltigen Versatz. Genau EIN Bildpaar
    darf verweigert werden -- mehr waere Blindheit, weniger waere Raten."""
    mp4, wahrheit = eichfall("c13_szenenwechsel")
    pairs, _, gueltig, hat_wahrheit = _fehler(mp4, wahrheit)
    verweigert = [p.i for p, g in zip(pairs, gueltig, strict=True) if not g]
    assert verweigert == [30], f"verweigerte Bildpaare: {verweigert} von {len(pairs)}"


@pytest.mark.langsam
def test_c12_ist_die_grenze_des_verfahrens_und_wird_gemeldet(eichfall):
    """c12 ist die Stelle, an der das Verfahren aufhoert zu koennen -- und
    der Test, der das nicht verschweigt.

    Bei streng periodischem Inhalt und 70 px Versatz je Bild sind +70 und
    70-111 = -41 dieselbe Bildinformation. Aus zwei Bildern ist das
    PRINZIPIELL nicht entscheidbar. Erwartet wird deshalb zweierlei:
    das Geraet verweigert die Mehrheit der Bildpaare, und die aeussere
    Streckenschranke faengt den Rest ab, indem sie das Fenster als
    NICHT MESSBAR kennzeichnet.

    Ein Test, der c12 weglaesst, behauptet eine Genauigkeit, die es nicht
    gibt.
    """
    mp4, wahrheit = eichfall("c12_streng_alias_70px")
    pairs, _, gueltig, _ = _fehler(mp4, wahrheit)
    verweigert = int((~gueltig).sum())
    # Untergrenze statt "Mehrheit": gemessen (Ticket 158) verweigert das
    # Geraet auf demselben Rohmaterial 28 bis 41 von 59 Bildpaaren, je
    # nachdem welcher x264 mit wie vielen Faeden kodiert hat -- auf dem
    # festgenagelten Kodierer dieses Repositorys sind es 29. Eine Schranke
    # bei der Haelfte (29,5) liegt mitten in dieser Streuung: sie hat auf
    # einer 16-Kern-Maschine gehalten und auf einer 4-Kern-Maschine nicht,
    # und entschieden hat das EIN Bildpaar. Geprueft wird hier also, dass
    # das Tor ueberhaupt in grossem Umfang greift; dass die durchgelassenen
    # Messungen nicht als Glaette-Urteil durchgehen, prueft der zweite Teil
    # dieses Tests -- das ist die eigentliche Zusage.
    assert verweigert >= len(pairs) // 3, (
        f"nur {verweigert}/{len(pairs)} Bildpaare verweigert -- das "
        f"Mehrdeutigkeits-Tor greift nicht mehr")

    # Die ersten zehn Bildpaare fahren laut Erzeuger 10 x 70 px nach rechts.
    # Der Sollwert stammt aus der Wahrheitsdatei, also aus dem ERZEUGER --
    # nicht aus dieser Messung.
    soll = float(abs(sum(wahrheit["dx"][:10])))
    assert soll == 700.0
    fenster = Fenster(name="c12:erste-zehn", von_bildpaar=1, bis_bildpaar=10,
                      quelle=QUELLE_PRODUKT, soll_px=soll,
                      soll_herkunft="c12.truth.json: Summe der ersten zehn Schritte",
                      # Keine externe Dauer: hier soll ausschliesslich die
                      # Streckenschranke anschlagen, damit der Test nicht offen
                      # laesst, welche der beiden Schranken gegriffen hat.
                      dauer=None,
                      richtung="rechts")
    urteil = beurteile_fenster(pairs, fenster, 60.0)
    assert urteil["urteil"] == "NICHT MESSBAR"
    assert urteil["grund"] == "Strecke verfehlt"
    assert urteil["schranke_strecke"]["haelt"] is False
    assert "stoerstellen_anzahl" not in urteil, (
        "ein nicht messbares Fenster darf kein Glaette-Urteil abgeben")
