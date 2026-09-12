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
"""

from __future__ import annotations

import pytest

from smoothness.analyse import analysiere

QUOTEN_SCHLUESSEL = "quote"
NENNER_FELDER = ("von", "von_bewegten_bildpaaren")


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
def test_jede_quote_im_bericht_nennt_ihren_nenner(eichfall):
    mp4, _ = eichfall("c14_scroll_rampe")
    bericht = analysiere(str(mp4))
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
def test_nenner_sind_je_fenster_verschieden_und_nicht_verwechselt(eichfall, mutant):
    """Die Wiederholungsquote teilt durch die Bildpaare des Fensters, die
    Haker-Quote durch die Bildpaare der REISESTRECKE. Das sind verschiedene
    Zahlen, und ihre Verwechslung ist genau der Fehler, den dieses Projekt
    schon zweimal hatte."""
    bericht = analysiere(str(mutant("c14_scroll_rampe", "wiederholt3")))
    (fenster,) = bericht["fenster"]
    assert fenster["wiederholte_bilder"]["von"] == fenster["bildpaare"]
    assert fenster["haker"]["von"] == fenster["reisestrecke_bildpaare"]
    assert fenster["mikro_aussetzer"]["von"] == fenster["reisestrecke_bildpaare"]
    assert fenster["reisestrecke_bildpaare"] <= fenster["bildpaare"]
    assert fenster["wiederholte_bilder"]["nenner_bedeutung"] != \
        fenster["haker"]["nenner_bedeutung"]
