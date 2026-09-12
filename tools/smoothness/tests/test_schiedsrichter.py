"""Der Schiedsrichter und sein Vorzeichen.

Der Schiedsrichter entscheidet nur dann, wenn Phasenkorrelation und
Lucas-Kanade sich uneinig sind -- selten, und deshalb in den Videofaellen
kaum abgedeckt. Ein Vorzeichenfehler in `residual_ratio` bliebe dort fast
unsichtbar und wuerde genau in den seltenen, schwierigen Bildpaaren den
falschen Vorschlag gewinnen lassen. Also wird er hier direkt geprueft.

Das Vorzeichen wurde im Prototyp nicht hergeleitet, sondern gemessen: an
compare3-full Feld 1, Bildpaar 608 (bekannter Versatz +4,87 px) ergab +dx
ein Rest-Verhaeltnis von 0,128 und -dx eines von 0,877. Dieser Test baut
dieselbe Situation kuenstlich nach, damit die Aussage ohne das
Vergleichsvideo pruefbar bleibt.

FIXTURE-HERKUNFT: gerechnetes Rauschbild, fester Zufallskeim. Kein Video,
kein Aufnahmelauf -- geprueft wird eine reine Rechenregel.
"""

from __future__ import annotations

import numpy as np

from smoothness.estimators import phasecorr_gate, residual_ratio
from smoothness.knobs import KNOBS

VERSATZ = 5


def _bildpaar() -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(20260912)
    prev = rng.integers(0, 256, (240, 320), dtype=np.uint8)
    # Der Inhalt wandert nach links, der Blick also nach rechts: dx = +5.
    cur = np.ascontiguousarray(np.roll(prev, -VERSATZ, axis=1))
    return prev, cur


def test_die_konvention_ist_dieselbe_wie_die_des_schaetzers():
    """Erreichbarkeit und Anker in einem: das kuenstliche Bildpaar muss vom
    Schaetzer genau so gelesen werden wie vom Schiedsrichter, sonst prueft
    der Test unten eine andere Situation als die echte."""
    prev, cur = _bildpaar()
    est = phasecorr_gate(prev, cur, amb_ratio=KNOBS.amb_ratio)
    assert est.tag == "ok"
    assert abs(est.dx - VERSATZ) < 0.1
    assert abs(est.dy) < 0.1


def test_richtiges_vorzeichen_erklaert_die_aenderung_falsches_nicht():
    prev, cur = _bildpaar()
    richtig = residual_ratio(prev, cur, VERSATZ, 0.0)
    falsch = residual_ratio(prev, cur, -VERSATZ, 0.0)
    assert richtig < KNOBS.residual_max, (
        f"der richtige Versatz halbiert den Restfehler nicht: {richtig:.3f}")
    assert falsch > KNOBS.residual_max, (
        f"der falsche Versatz wird nicht verworfen: {falsch:.3f}")
    assert richtig < falsch / 2


def test_ein_erfundener_versatz_erklaert_nichts():
    """Eine Zahl, die niemand behauptet hat, darf nicht gewinnen."""
    prev, cur = _bildpaar()
    assert residual_ratio(prev, cur, 17.0, 0.0) > KNOBS.residual_max
    assert residual_ratio(prev, cur, 0.0, 9.0) > KNOBS.residual_max
