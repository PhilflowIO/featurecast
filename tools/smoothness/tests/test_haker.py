"""Die Definition "Haker", Stueck fuer Stueck.

Diese Datei ist die Antwort auf einen Mutationsbefund: die Stillstands-
Erkennung komplett abzuschalten toetete zunaechst KEINEN Test. Die
Mutationsproben am Material (tests/test_mutation.py) pruefen nur, dass das
Urteil SCHLECHTER wird -- und das tat es weiterhin, weil die
Nachholspruenge nach jedem Stillstand dieselben Stoerstellen erzeugten. Zwei
Haelften der Definition, die sich gegenseitig decken, sind zusammen nicht
geprueft.

Hier wird deshalb jede Haelfte einzeln angesteuert, mit von Hand gebauten
Schrittfolgen, in denen genau EIN Merkmal steckt.

FIXTURE-HERKUNFT: gerechnete Schrittfolgen, kein Video und kein
Aufnahmelauf. Geprueft wird die Definition, nicht die Bildmathematik --
dafuer sind tests/test_eichung.py und tests/test_mutation.py da.
"""

from __future__ import annotations

import numpy as np

from smoothness.hitches import finde_haker
from smoothness.knobs import KNOBS

FPS = 60.0
TEMPO = 4.0


def _reise(n: int = 30) -> list[float]:
    """Gleichmaessige Fahrt ohne jedes Merkmal."""
    return [TEMPO] * n


def test_gleichmaessige_fahrt_hat_keinen_haker():
    befund = finde_haker(np.array(_reise()), 1, FPS)
    assert befund.stoerstellen == []
    assert befund.ereignisse == []
    assert befund.mikro.zaehler == 0
    assert befund.mikro.nenner == befund.reisestrecke_bildpaare


def test_zwei_stehende_bilder_sind_ein_haker():
    """Der Stillstand allein, ohne Nachholsprung danach: die Fahrt geht mit
    dem alten Tempo weiter. Nur die Stillstands-Haelfte der Definition kann
    das sehen."""
    schritte = _reise()
    schritte[14] = 0.0
    schritte[15] = 0.0
    befund = finde_haker(np.array(schritte), 1, FPS)
    assert len(befund.stoerstellen) == 1
    assert befund.stoerstellen[0]["art"] == "Stillstand"
    assert befund.stillstands_histogramm == {"2_Bilder": 1}
    assert befund.ereignisse[0]["bilder"] == 2
    assert befund.ereignisse[0]["ms"] == 33.3


def test_ein_einzelnes_stehendes_bild_ist_ein_mikro_aussetzer_kein_haker():
    """33 ms ist die Sichtbarkeitsgrenze. Ein Bild ist die Haelfte davon --
    es wird nicht verschwiegen, sondern mit eigenem Nenner ausgewiesen."""
    schritte = _reise()
    schritte[14] = 0.0
    befund = finde_haker(np.array(schritte), 1, FPS)
    assert befund.stoerstellen == []
    assert befund.mikro.zaehler == 1
    assert befund.mikro.nenner == befund.reisestrecke_bildpaare
    assert "Reisestrecke" in befund.mikro.nenner_bedeutung


def test_ein_nachholsprung_ist_ein_haker():
    """Der Sprung allein, ohne Stillstand davor. Nur die Sprung-Haelfte der
    Definition kann das sehen."""
    schritte = _reise()
    schritte[14] = TEMPO * 3
    befund = finde_haker(np.array(schritte), 1, FPS)
    assert len(befund.stoerstellen) == 1
    assert befund.stoerstellen[0]["art"] == "Sprung"
    assert befund.stillstands_histogramm == {}


def test_stillstand_mit_nachsprung_zaehlt_als_eine_stelle():
    """Die Aufnahme haengt und holt auf. Das ist EIN Ereignis, nicht zwei --
    sonst zaehlt jeder haengende Bildwechsel doppelt."""
    schritte = _reise()
    schritte[14] = 0.0
    schritte[15] = 0.0
    schritte[16] = TEMPO * 3
    befund = finde_haker(np.array(schritte), 1, FPS)
    assert len(befund.stoerstellen) == 1
    assert befund.stoerstellen[0]["ereignisse"] == 1
    assert befund.ereignisse[0]["art"] == "Stillstand+Nachsprung"


def test_zwei_nahe_ereignisse_sind_eine_stoerstelle_zwei_ferne_sind_zwei():
    """`merge_gap` ist der Wert, an dem sich das entscheidet. Der Test faehrt
    beide Seiten der Grenze ab, damit die Zahl nicht nur zufaellig passt."""
    nah = _reise(40)
    nah[14] = TEMPO * 3
    nah[14 + KNOBS.merge_gap] = TEMPO * 3
    befund_nah = finde_haker(np.array(nah), 1, FPS)
    assert len(befund_nah.stoerstellen) == 1
    assert befund_nah.stoerstellen[0]["ereignisse"] == 2

    fern = _reise(40)
    fern[14] = TEMPO * 3
    fern[14 + KNOBS.merge_gap + 1] = TEMPO * 3
    befund_fern = finde_haker(np.array(fern), 1, FPS)
    assert len(befund_fern.stoerstellen) == 2


def test_anlauf_und_bremskurve_sind_kein_haker():
    """Der erste Grund fuer das oertliche Tempo: Rampen gehoeren gar nicht
    erst zur Reisestrecke."""
    t = np.linspace(0.0, 1.0, 40)
    rampe = 6.0 * np.sin(np.pi * t) ** 0.7
    befund = finde_haker(rampe, 1, FPS)
    assert befund.stoerstellen == [], befund.ereignisse
    assert befund.reisestrecke_bildpaare < len(rampe), (
        "Anlauf und Auslauf muessen aus der Reisestrecke herausfallen")


def test_starke_beschleunigung_innerhalb_der_reisestrecke_ist_kein_haker():
    """Der eigentliche Grund fuer das oertliche Tempo.

    Hier beschleunigt die Bewegung gleichmaessig um 12 % je Bild und bleibt
    dabei die ganze Zeit in der Reisestrecke -- nichts daran stolpert, jeder
    Schritt passt zu seinen Nachbarn. Gegen einen FESTEN Massstab (den
    Median des ganzen Fensters) waere das Ende dieser Fahrt mehr als das
    Doppelte des Mittelwerts und wuerde als Nachholsprung gezaehlt. Genau
    dieser Fehler erzeugte in der ersten Fassung 33 Haker in einem
    47-Bild-Fenster.
    """
    rampe = 1.0 * 1.12 ** np.arange(40)
    befund = finde_haker(rampe, 1, FPS)
    assert befund.stoerstellen == [], befund.ereignisse

    # Erreichbarkeit: der feste Massstab wuerde hier wirklich ausschlagen --
    # sonst prueft der Test oben nichts.
    reise = rampe[rampe >= KNOBS.cruise_frac * np.median(rampe)]
    fest = np.median(reise)
    assert (reise / fest).max() > KNOBS.jump_factor, (
        "gegen den Fenster-Median schlaegt hier nichts aus -- dann ist dieser "
        "Test kein Beleg fuer das oertliche Tempo")


def test_gegen_stehende_nachbarn_wird_kein_faktor_behauptet():
    """Ein Teleport: die Nachbarn stehen, dann springt das Bild. Die erste
    Fassung teilte durch 1e-6 und meldete den Nachsprung als 110-millionenfaches
    Tempo -- eine Zahl, die aussieht wie eine Messung und keine ist."""
    schritte = np.array([0.0] * 8 + [111.0] + [0.0] * 9)
    befund = finde_haker(schritte, 1, FPS)
    assert befund.ereignisse, "der Teleport muss als Ereignis erscheinen"
    (nachsprung,) = [e for e in befund.ereignisse if e.get("nachsprung_px") == 111.0]
    # Kein Faktor, nicht bloss ein kleinerer: gegen die Rauschgrenze gerechnet
    # waeren es 444 -- ebenso eine Zahl, die nichts misst.
    assert nachsprung["nachsprung_x"] is None, nachsprung
    (stelle,) = [s for s in befund.stoerstellen if s["groesster_schritt_px"] > 0]
    assert stelle["groesster_schritt_px"] == 111.0
    assert stelle["stillstand_ms"] > 0


def test_zusammengefasste_stoerstelle_behaelt_ihren_schwersten_sprung():
    """Zwei nahe Ereignisse werden EINE Stoerstelle. Deren Schwere ist der
    groessere der beiden Spruenge, gleich in welcher Reihenfolge sie kommen
    -- sonst entscheidet die Reihenfolge ueber das Urteil."""
    schritte = _reise(40)
    schritte[14] = TEMPO * 3
    schritte[14 + KNOBS.merge_gap] = TEMPO * 5
    (stelle,) = finde_haker(np.array(schritte), 1, FPS).stoerstellen
    assert stelle["ereignisse"] == 2
    assert stelle["groesster_schritt_px"] == TEMPO * 5
    assert stelle["stillstand_ms"] == 0.0


def test_rauschen_neben_stehenden_nachbarn_ist_kein_sprung():
    """Die Rauschgrenze `still_px` ist der Bezug, wenn die Nachbarn stehen --
    ein Zehntelpixel ist dann Messrauschen, kein Nachholsprung."""
    schritte = [TEMPO] * 10 + [0.0] * 3 + [0.1] + [0.0] * 3 + [TEMPO] * 10
    befund = finde_haker(np.array(schritte), 1, FPS)
    assert not [e for e in befund.ereignisse if "prung" in e["art"]], befund.ereignisse
    assert befund.ereignisse, "der Stillstand selbst muss weiter erscheinen"


def test_die_reisestrecke_ist_der_nenner_nicht_das_ganze_fenster():
    """Sonst verduennt jede lange Anlaufkurve die Haker-Quote."""
    t = np.linspace(0.0, 1.0, 40)
    rampe = 6.0 * np.sin(np.pi * t) ** 0.7
    befund = finde_haker(rampe, 100, FPS)
    assert befund.von_bildpaar_reise > 100, (
        "der erste Reise-Bildpaar-Index muss hinter dem Fensteranfang liegen")
    assert befund.mikro.nenner == befund.reisestrecke_bildpaare
