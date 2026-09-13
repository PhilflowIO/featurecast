"""Die beiden aeusseren Schranken -- und der Beweis, dass sie aeusserlich sind.

Der wichtigste Test dieser Datei ist
`test_schranke_aus_eigener_rechnung_kann_nie_anschlagen`. Er baut den Fehler
absichtlich, den die erste Fassung der 60-Hz-Schranke hatte (und den
`src/paint-rate.ts` und die erste Fassung von `src/presented.ts` im Produkt
hatten): die Dauer aus der eigenen Bildzaehlung. Er zeigt zweierlei -- dass
das Werkzeug so eine Dauer zurueckweist, UND dass sie ueber den gesamten
Wertebereich nie haette anschlagen koennen. Ohne den zweiten Teil waere
"die Schranke haelt" keine Nachricht.

Bedingungen: MUTATION -- stirbt, wenn `pruefe_60hz` die Herkunft nicht mehr
prueft oder `path_tol` ins Unendliche waechst. ERREICHBARKEIT -- geprueft
wird ueber `beurteile_fenster`, denselben Weg, den die CLI nimmt. NENNER --
beide Schranken nennen Zaehler, Sollwert und Toleranz in ihrer Ausgabe.
AEUSSERER ANKER -- genau das Thema dieser Datei. FIXTURE-HERKUNFT -- die
Bildpaare sind hier von Hand gebaut, weil die Schranken ueber ZAHLEN
urteilen und kein Bild brauchen; die Bildpfade sind in test_eichung.py und
test_mutation.py abgedeckt.
"""

from __future__ import annotations

import math
from fractions import Fraction

import pytest

from smoothness.bounds import HERKUNFT_EIGENE_ZAEHLUNG, Dauer, pruefe_60hz
from smoothness.knobs import KNOBS
from smoothness.pairs import Pair
from smoothness.report import beurteile_fenster
from smoothness.windows import QUELLE_PRODUKT, Fenster


def _gleichmaessige_paare(n: int, dx: float = 4.0) -> list[Pair]:
    return [Pair(i, dx, 0.0, "ok", 0.0, 9.0, False) for i in range(1, n + 1)]


def test_streckenschranke_schlaegt_an_wenn_die_strecke_verfehlt_wird():
    pairs = _gleichmaessige_paare(20, 4.0)      # gemessen: 80 px
    fenster = Fenster(name="soll-verletzt", von_bildpaar=1, bis_bildpaar=20,
                      quelle=QUELLE_PRODUKT, soll_px=200.0,
                      soll_herkunft="Test: absichtlich verletzt", richtung="rechts")
    urteil = beurteile_fenster(pairs, fenster, 60.0)
    assert urteil["urteil"] == "NICHT MESSBAR"
    assert urteil["grund"] == "Strecke verfehlt"
    s = urteil["schranke_strecke"]
    assert s["gemessen_px"] == 80.0 and s["soll_px"] == 200.0
    assert s["soll_herkunft"] == "Test: absichtlich verletzt"


def test_streckenschranke_haelt_wenn_die_strecke_stimmt():
    pairs = _gleichmaessige_paare(20, 4.0)
    fenster = Fenster(name="soll-getroffen", von_bildpaar=1, bis_bildpaar=20,
                      quelle=QUELLE_PRODUKT, soll_px=80.0,
                      soll_herkunft="Test", richtung="rechts",
                      dauer=Dauer(20 / 60, "Test: echte Fensterdauer"))
    urteil = beurteile_fenster(pairs, fenster, 60.0)
    assert urteil["schranke_strecke"]["haelt"] is True
    assert urteil["schranke_60hz"]["haelt"] is True
    assert urteil["urteil"] != "NICHT MESSBAR"


def test_60hz_schranke_schlaegt_an_bei_zu_kurzer_dauer():
    """21 Bilder koennen in 0,100 s nicht stecken: hoechstens 60*0,1+1 = 7."""
    pairs = _gleichmaessige_paare(20, 4.0)      # 20 Bildpaare = 21 Bilder
    fenster = Fenster(name="dauer-verletzt", von_bildpaar=1, bis_bildpaar=20,
                      quelle=QUELLE_PRODUKT, soll_px=80.0, soll_herkunft="Test",
                      dauer=Dauer(0.100, "Test: absichtlich zu kurz"),
                      richtung="rechts")
    urteil = beurteile_fenster(pairs, fenster, 60.0)
    assert urteil["urteil"] == "NICHT MESSBAR"
    assert urteil["grund"] == "60-Hz-Schranke verletzt"
    b = urteil["schranke_60hz"]
    assert b["gezaehlt"] == 21 and b["hoechstens"] == 7
    assert "unabhaengig" in str(b["gezaehlt_quelle"])


def test_60hz_schranke_haelt_bei_ehrlicher_dauer():
    pairs = _gleichmaessige_paare(20, 4.0)
    fenster = Fenster(name="dauer-ok", von_bildpaar=1, bis_bildpaar=20,
                      quelle=QUELLE_PRODUKT, soll_px=80.0, soll_herkunft="Test",
                      dauer=Dauer(20 / 60, "Test: echte Fensterdauer"), richtung="rechts")
    urteil = beurteile_fenster(pairs, fenster, 60.0)
    assert urteil["schranke_60hz"]["haelt"] is True
    assert urteil["schranke_60hz"]["hoechstens"] == 21  # floor(60*20/60)+1
    assert urteil["schranke_60hz"]["gezaehlt"] == 21


def test_fehlende_dauer_ist_keine_bestandene_schranke():
    """haelt=None ist nicht haelt=True. Schweigen ist keine gute Nachricht."""
    b = pruefe_60hz(21, None)
    assert b["haelt"] is None
    assert "kein Bestehen" in str(b["hinweis"])


def test_schranke_aus_eigener_rechnung_kann_nie_anschlagen():
    """Der eigentliche Beweis, warum die Dauer von aussen kommen MUSS.

    Teil 1: Eine Dauer aus der eigenen Bildzaehlung wird zurueckgewiesen --
    das Werkzeug faellt nicht darauf herein.

    Teil 2: Und wenn es darauf hereinfiele, waere die Schranke wertlos. Ueber
    den ganzen sinnvollen Wertebereich haelt sie bei dieser Herleitung
    IMMER: bildzaehlung/60 Sekunden ergibt floor(60 * n/60) + 1 = n + 1
    Bilder Obergrenze fuer genau n + 1 Bilder. Ein Messgeraet, dessen
    Ausschlag mathematisch unmoeglich ist, misst nichts.
    """
    falsche = Dauer.aus_bildzaehlung(20, 60.0)
    assert falsche.herkunft == HERKUNFT_EIGENE_ZAEHLUNG
    abgelehnt = pruefe_60hz(21, falsche)
    assert abgelehnt["haelt"] is None
    assert "abgelehnt" in str(abgelehnt["hinweis"])

    # Exakt gerechnet (Fraction statt float, damit nicht Rundungsrauschen
    # einen Ausschlag vortaeuscht, den es fachlich nicht gibt):
    # n Bildpaare sind n+1 Bilder; die selbst gerechnete Dauer n/60 ergibt
    # die Obergrenze floor(60 * n/60) + 1 = n + 1. Die Schranke haelt damit
    # fuer JEDES n, unabhaengig davon, wie kaputt das Material ist.
    sechzig = Fraction(int(KNOBS.fps_nominal))
    for bildpaare in range(2, 500):
        selbst_gerechnet = Fraction(bildpaare, int(KNOBS.fps_nominal))
        grenze = math.floor(sechzig * selbst_gerechnet) + 1
        assert bildpaare + 1 <= grenze, (
            "unerwartet: die selbst gerechnete Schranke schlaegt an -- dann ist "
            "die Begruendung dieses Tests falsch, nicht der Code")

    # Gegenprobe mit derselben Rechnung, aber externer Dauer: hier gibt es
    # sehr wohl Faelle, in denen die Schranke reisst.
    reisst = [n for n in range(2, 500)
              if n + 1 > math.floor(sechzig * Fraction(n, 120)) + 1]
    assert reisst, "die externe Schranke muesste bei doppelter Bildrate reissen"


@pytest.mark.parametrize("herkunft", [HERKUNFT_EIGENE_ZAEHLUNG])
def test_beurteile_fenster_meldet_die_abgelehnte_herkunft_weiter(herkunft):
    """Die Ablehnung darf nicht im Innern versickern -- sie steht in der
    Ausgabe, sonst sieht ein Leser eine ungeprueft gebliebene Schranke fuer
    eine bestandene an."""
    pairs = _gleichmaessige_paare(20, 4.0)
    fenster = Fenster(name="falsche-herkunft", von_bildpaar=1, bis_bildpaar=20,
                      quelle=QUELLE_PRODUKT, soll_px=80.0, soll_herkunft="Test",
                      dauer=Dauer(20 / 60, herkunft), richtung="rechts")
    urteil = beurteile_fenster(pairs, fenster, 60.0)
    assert urteil["schranke_60hz"]["quelle"] == herkunft
    assert urteil["schranke_60hz"]["haelt"] is None
