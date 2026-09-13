"""Der Versatz je Bildpaar -- und wann das Werkzeug lieber schweigt.

Ein Bildpaar liefert nur dann einen Messwert, wenn zwei verschieden gebaute
Verfahren sich einig sind oder ein dritter Test direkt am Bild entscheidet.
Alles andere bekommt einen Status statt einer Zahl. Diese Statuszahlen sind
kein Rauschen, sie sind das Ergebnis: ein Fenster mit vielen verweigerten
Bildpaaren ist nicht glatt, es ist ungemessen.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass

import numpy as np

from .estimators import lk_median, phasecorr_gate, residual_ratio
from .knobs import KNOBS, Knobs

__all__ = ["Pair", "STATUS_GUELTIG", "messe_bildpaare"]

STATUS_GUELTIG = ("ok", "schiedsspruch")
"""Die beiden Status, die einen verwertbaren Versatz tragen. Jeder andere
Status bedeutet: keine Zahl, und das Bildpaar faellt aus jedem Zaehler
heraus -- aber nicht aus dem Nenner, der es zaehlt."""

STATUS_ALLE = ("ok", "schiedsspruch", "mehrdeutig", "uneinig", "wenig-punkte")


@dataclass(frozen=True)
class Pair:
    """Der Versatz von Bild i-1 nach Bild i."""

    i: int
    dx: float
    """NaN, wenn `status` nicht in STATUS_GUELTIG steht. Nie 0 als Ersatz --
    eine erfundene Null ist von einem stehenden Bild nicht zu unterscheiden."""
    dy: float
    status: str
    """ok | schiedsspruch | mehrdeutig | uneinig | wenig-punkte"""
    ratio: float
    """Nebenmaximum/Gipfel der Phasenkorrelation, wenn mehrdeutig."""
    mad: float
    """Mittlere absolute Pixeldifferenz. Schaetzer-UNABHAENGIG: das ist die
    Groesse, aus der die Wiederholungsquote gebildet wird, damit sie nicht
    von dem Verfahren abhaengt, das sie erklaeren soll."""
    dup: bool
    """Bild ist eine Wiederholung seines Vorgaengers (`mad <= dup_mad`)."""


def messe_bildpaare(frames: Iterable[np.ndarray], k: Knobs = KNOBS) -> list[Pair]:
    """Misst jedes aufeinanderfolgende Bildpaar.

    `frames` darf ein Strom sein; gehalten wird immer nur das Vorgaengerbild.

    Reihenfolge der Entscheidungen, und warum:
      1. Wiederholtes Bild? Dann ist der Versatz 0 und kein Schaetzer noetig.
      2. Phasenkorrelation mit Mehrdeutigkeits-Tor. Schlaegt das Tor an, ist
         "mehrdeutig" die Antwort -- nicht der Gipfel, der zufaellig
         gewonnen hat.
      3. Lucas-Kanade als zweite Meinung. Zu wenige Punkte = keine Antwort.
      4. Einig? Dann gilt der LK-Wert (bester Sub-Pixel-Fehler in der
         Eichung) mit dem Tor der Phasenkorrelation.
      5. Uneinig? Dann entscheidet der Schiedsrichter am Bild. Erklaert
         keiner der beiden Vorschlaege die Aenderung, wird verworfen --
         weite Spruenge kann LK prinzipiell nicht folgen, die
         Phasenkorrelation schon, und umgekehrt.
    """
    pairs: list[Pair] = []
    bilder = iter(frames)
    a = next(bilder, None)
    for i, b in enumerate(bilder, start=1):
        pairs.append(_miss_paar(i, a, b, k))
        a = b
    return pairs


def _miss_paar(i: int, a: np.ndarray, b: np.ndarray, k: Knobs) -> Pair:
    """Ein Bildpaar, Entscheidungsreihenfolge siehe `messe_bildpaare`."""
    mad = float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean())
    if mad <= k.dup_mad:
        return Pair(i, 0.0, 0.0, "ok", 0.0, mad, True)
    p = phasecorr_gate(a, b, amb_ratio=k.amb_ratio)
    ratio = 0.0
    if p.tag.startswith("AMBIG"):
        ratio = float(p.tag.split("=")[1].rstrip(")"))
        return Pair(i, math.nan, math.nan, "mehrdeutig", ratio, mad, False)
    lk = lk_median(a, b)
    if not np.isfinite(lk.dx):
        return Pair(i, math.nan, math.nan, "wenig-punkte", ratio, mad, False)
    if abs(lk.dx - p.dx) > k.agree_px or abs(lk.dy - p.dy) > k.agree_px:
        rp = residual_ratio(a, b, p.dx, p.dy)
        rl = residual_ratio(a, b, lk.dx, lk.dy)
        if min(rp, rl) > k.residual_max:
            return Pair(i, math.nan, math.nan, "uneinig", ratio, mad, False)
        sieger = p if rp <= rl else lk
        return Pair(i, float(sieger.dx), float(sieger.dy), "schiedsspruch", ratio, mad, False)
    return Pair(i, float(lk.dx), float(lk.dy), "ok", ratio, mad, False)
