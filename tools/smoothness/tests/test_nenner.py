"""Jede Quote nennt ihren eigenen Nenner -- geprueft, nicht versprochen.

In diesem Projekt waren zwei Messgeraete um die Haelfte falsch, beide sahen
plausibel aus, und beide hatten einen unbenannten Nenner
(`src/paint-rate.ts`, die erste Fassung von `src/efficiency.ts`). Dieser
Test laeuft ueber den GESAMTEN Bericht und verlangt von jedem Objekt, das
eine Quote fuehrt, dass daneben Zaehler, Nenner und die Bedeutung des
Nenners in Worten stehen.

Er ist absichtlich strukturell: er kennt die Namen der Quoten nicht. Eine
neue Quote, die ihren Nenner vergisst, faellt hier auf, ohne dass jemand
diesen Test anfassen muss.

Beide Tests laufen ueber den PRODUKTPFAD (Fenster mit Sollstrecke aus der
Wahrheitsdatei): ohne Sollstrecke gibt es seit Ticket 28 kein Urteil, und ein
verweigertes Fenster fuehrt die Haker- und Wiederholungsquoten gar nicht erst
-- der Test haette sie dann nie gesehen.
"""

from __future__ import annotations

import cv2
import pytest
from synth_fixtures import W, schreibe_lauf_ueber_ganzes_video

from smoothness.analyse import analysiere
from smoothness.frames import AUFNAHME_BREITE_PX

QUOTEN_SCHLUESSEL = "quote"
NENNER_FELDER = ("von", "von_bewegten_bildpaaren")


def _bericht_ueber_produktpfad(mp4, wahrheit, ziel) -> dict:
    cap = cv2.VideoCapture(str(mp4))
    bilder = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    strecke = sum(wahrheit["dx"]) * AUFNAHME_BREITE_PX / W
    lauf = schreibe_lauf_ueber_ganzes_video(ziel, bilder, "c14:scroll-right", strecke)
    bericht = analysiere(str(mp4), lauf_verzeichnis=lauf)
    assert all(f["urteil"] != "NICHT MESSBAR" for f in bericht["fenster"]), (
        "ohne beurteiltes Fenster fehlen genau die Quoten, die hier geprueft werden")
    return bericht


def _sammle_quoten(knoten, pfad="bericht"):
    if isinstance(knoten, dict):
        if QUOTEN_SCHLUESSEL in knoten:
            yield pfad, knoten
        for schluessel, wert in knoten.items():
            yield from _sammle_quoten(wert, f"{pfad}.{schluessel}")
    elif isinstance(knoten, list):
        for i, wert in enumerate(knoten):
            yield from _sammle_quoten(wert, f"{pfad}[{i}]")


@pytest.mark.langsam
def test_jede_quote_im_bericht_nennt_ihren_nenner(eichfall, tmp_path):
    mp4, wahrheit = eichfall("c14_scroll_rampe")
    bericht = _bericht_ueber_produktpfad(mp4, wahrheit, tmp_path)
    quoten = list(_sammle_quoten(bericht))
    # Erreichbarkeit: wenn hier nichts gefunden wird, prueft der Test nichts.
    assert len(quoten) >= 4, f"nur {len(quoten)} Quoten gefunden: {[p for p, _ in quoten]}"

    for pfad, objekt in quoten:
        nenner_feld = next((f for f in NENNER_FELDER if f in objekt), None)
        assert nenner_feld is not None, f"{pfad}: Quote ohne Nenner: {objekt}"
        assert isinstance(objekt[nenner_feld], int), f"{pfad}: Nenner ist keine Anzahl"
        bedeutung = objekt.get("nenner_bedeutung", "")
        assert bedeutung, f"{pfad}: Nenner ohne Bedeutung"
        assert len(bedeutung.split()) >= 2, f"{pfad}: Nenner-Bedeutung zu duenn: {bedeutung!r}"
        if objekt["quote"] is not None and objekt[nenner_feld]:
            zaehler = objekt.get("anzahl")
            assert zaehler is not None, f"{pfad}: Quote ohne Zaehler"
            assert objekt["quote"] == pytest.approx(zaehler / objekt[nenner_feld], abs=5e-5), (
                f"{pfad}: Quote passt nicht zu Zaehler/Nenner")


@pytest.mark.langsam
def test_nenner_sind_je_fenster_verschieden_und_nicht_verwechselt(eichfall, mutant, tmp_path):
    """Die Wiederholungsquote teilt durch die Bildpaare des Fensters, die
    Haker-Quote durch die Bildpaare der REISESTRECKE. Das sind verschiedene
    Zahlen, und ihre Verwechslung ist genau der Fehler, den dieses Projekt
    schon zweimal hatte."""
    _, wahrheit = eichfall("c14_scroll_rampe")
    bericht = _bericht_ueber_produktpfad(mutant("c14_scroll_rampe", "wiederholt3"), wahrheit,
                                         tmp_path)
    (fenster,) = bericht["fenster"]
    assert fenster["wiederholte_bilder"]["von"] == fenster["bildpaare"]
    assert fenster["haker"]["von"] == fenster["reisestrecke_bildpaare"]
    assert fenster["mikro_aussetzer"]["von"] == fenster["reisestrecke_bildpaare"]
    assert fenster["reisestrecke_bildpaare"] <= fenster["bildpaare"]
    assert fenster["wiederholte_bilder"]["nenner_bedeutung"] != \
        fenster["haker"]["nenner_bedeutung"]
