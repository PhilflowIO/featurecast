"""Die Schaetzverfahren fuer den Versatz zwischen zwei aufeinanderfolgenden
Bildern -- und der Schiedsrichter, der entscheidet, wenn sie sich uneinig
sind.

Warum drei statt eines: die Fehler der Verfahren sind verschieden gelagert,
und genau das ist der Schutz. Lucas-Kanade ist auf der Eichstrecke am
genauesten (0,014 px mittlerer Fehler), kann aber weiten Spruengen
prinzipiell nicht folgen und meldete auf streng periodischem Inhalt
zuversichtlich -41 px, wo +70 px richtig war. Die Phasenkorrelation merkt
genau diese Mehrdeutigkeit an ihrem Nebenmaximum und verweigert. Der
Schiedsrichter sieht als einziger direkt ins Bild statt auf einen
Korrelationsgipfel.

`naive_mad` gehoert nicht in den Messpfad. Es ist das Verfahren, das in
diesem Projekt gescheitert ist (konstant 111 px auf kaum bewegten Bildern,
verhakt am Spaltenraster der Tabelle), und steht hier ausschliesslich als
Gegenprobe in den Tests: tests/test_naiver_schaetzer.py zeigt, dass es dort
zuversichtlich falsch liegt, wo das gewaehlte Verfahren verweigert.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

__all__ = ["Est", "lk_median", "naive_mad", "phasecorr_gate", "residual_ratio"]


@dataclass(frozen=True)
class Est:
    """Ein Schaetzwert fuer den Versatz von `prev` nach `cur`."""

    dx: float
    """Versatz in Pixeln DES GEMESSENEN AUSSCHNITTS, nicht in Aufnahme- oder
    CSS-Pixeln. Die Umrechnung passiert genau einmal, in `frames.py`."""
    dy: float
    conf: float
    """0..1. Kein Wahrscheinlichkeitsmass, nur eine Rangordnung."""
    tag: str = ""
    """Kurzdiagnose. Beginnt mit "AMBIG", wenn der Versatz mehrdeutig ist."""


def _hann(h: int, w: int) -> np.ndarray:
    return np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)


def _parabola(v_m1: float, v_0: float, v_p1: float) -> float:
    """Sub-Pixel-Scheitel einer Parabel durch drei Abtastwerte."""
    d = v_m1 - 2 * v_0 + v_p1
    if abs(d) < 1e-12:
        return 0.0
    return float(np.clip(0.5 * (v_m1 - v_p1) / d, -1.0, 1.0))


def phasecorr_gate(prev: np.ndarray, cur: np.ndarray, amb_ratio: float,
                   excl: int = 6) -> Est:
    """Phasenkorrelation ueber FFT mit Mehrdeutigkeits-Tor.

    Ein Versatz gilt nur, wenn sein Korrelationsgipfel deutlich besser ist
    als das beste Nebenmaximum ausserhalb eines Kreises vom Radius `excl`
    um den Gipfel. `amb_ratio` hat KEINEN Vorgabewert: eine Schwelle mit
    Vorgabewert ist eine zweite Stelle, an der sie steht, und die driftet.
    Sie kommt aus knobs.py. Auf streng periodischem Inhalt (Spaltenraster) sind
    mehrere Gipfel gleich gut -- dann ist "ich weiss es nicht" die einzig
    richtige Antwort, und der tag beginnt mit "AMBIG".
    """
    h, w = prev.shape
    win = _hann(h, w)
    a = np.fft.rfft2(prev.astype(np.float32) * win)
    b = np.fft.rfft2(cur.astype(np.float32) * win)
    r = a * np.conj(b)
    r /= np.abs(r) + 1e-9
    korr = np.fft.fftshift(np.fft.irfft2(r, s=(h, w)))
    cy, cx = h // 2, w // 2
    iy, ix = np.unravel_index(np.argmax(korr), korr.shape)
    gipfel = float(korr[iy, ix])
    yy, xx = np.ogrid[:h, :w]
    maske = (yy - iy) ** 2 + (xx - ix) ** 2 > excl**2
    zweiter = float(korr[maske].max()) if maske.any() else 0.0
    ratio = zweiter / gipfel if gipfel > 0 else 1.0
    sx = _parabola(korr[iy, (ix - 1) % w], gipfel, korr[iy, (ix + 1) % w])
    sy = _parabola(korr[(iy - 1) % h, ix], gipfel, korr[(iy + 1) % h, ix])
    conf = float(np.clip(1.0 - ratio / amb_ratio, 0.0, 1.0))
    tag = "ok" if ratio < amb_ratio else f"AMBIG(r={ratio:.2f})"
    return Est(float((ix + sx) - cx), float((iy + sy) - cy), conf, tag)


def lk_median(prev: np.ndarray, cur: np.ndarray, pitch: int = 28, win: int = 21,
              levels: int = 4, min_pts: int = 40) -> Est:
    """Blockweiser Lucas-Kanade-Fluss, Median ueber die Bloecke.

    Zweite, anders gebaute Meinung: arbeitet im Ortsraum statt im
    Frequenzraum. Jeder Punkt wird vorwaerts und rueckwaerts verfolgt; nur
    Punkte, die zu sich selbst zurueckfinden (< 1 px), zaehlen. Zu wenige
    ueberlebende Punkte sind kein Messwert, sondern ein NaN.
    """
    h, w = prev.shape
    ys = np.arange(pitch, h - pitch, pitch)
    xs = np.arange(pitch, w - pitch, pitch)
    pts = np.array([[x, y] for y in ys for x in xs], np.float32).reshape(-1, 1, 2)
    krit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01)
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(win, win),
                                          maxLevel=levels, criteria=krit)
    back, st2, _ = cv2.calcOpticalFlowPyrLK(cur, prev, nxt, None, winSize=(win, win),
                                            maxLevel=levels, criteria=krit)
    fb = np.linalg.norm((back - pts).reshape(-1, 2), axis=1)
    gut = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < 1.0)
    if gut.sum() < min_pts:
        return Est(float("nan"), float("nan"), 0.0, f"few-pts({int(gut.sum())})")
    d = (nxt - pts).reshape(-1, 2)[gut]
    mdx, mdy = float(np.median(d[:, 0])), float(np.median(d[:, 1]))
    streuung = float(np.median(np.abs(d[:, 0] - mdx)) + np.median(np.abs(d[:, 1] - mdy)))
    conf = float(np.clip(1.0 - streuung / 1.5, 0.0, 1.0))
    # Vorzeichen: der Fluss beschreibt, wohin der INHALT wandert; wir
    # berichten den Versatz des Blicks, also mit umgekehrtem Vorzeichen --
    # dieselbe Konvention wie phasecorr_gate.
    return Est(-mdx, -mdy, conf, f"spread={streuung:.2f} n={int(gut.sum())}")


def naive_mad(prev: np.ndarray, cur: np.ndarray, radius: int = 150) -> Est:
    """Kleinste mittlere absolute Differenz ueber ganzzahligen Versatz.

    NICHT im Messpfad. Genau das Verfahren, das sich im Projekt am
    111-px-Spaltenraster verhakt hat -- hier nur als Gegenprobe in den
    Tests. Es meldet immer `conf=1.0`: es kennt keinen Zweifel, und das ist
    sein Defekt.
    """
    p = prev.astype(np.int16)
    c = cur.astype(np.int16)
    bester: float | None = None
    bdx = 0
    for dx in range(-radius, radius + 1):
        if dx >= 0:
            a, b = p[:, dx:], c[:, : c.shape[1] - dx]
        else:
            a, b = p[:, : p.shape[1] + dx], c[:, -dx:]
        if a.shape[1] < 50:
            continue
        v = float(np.abs(a - b).mean())
        if bester is None or v < bester:
            bester, bdx = v, dx
    return Est(float(bdx), 0.0, 1.0, "naive")


def residual_ratio(prev: np.ndarray, cur: np.ndarray, dx: float, dy: float) -> float:
    """Schiedsrichter: erklaert der behauptete Versatz die Aenderung wirklich?

    Schiebt `cur` um den behaupteten Versatz zurueck und vergleicht den
    Restunterschied mit dem unverschobenen. Rueckgabe:
    Rest(verschoben) / Rest(unverschoben) -- klein heisst, der Versatz
    erklaert die Aenderung. Unabhaengig von jedem Korrelationsgipfel, weil
    direkt im Bild nachgesehen wird.

    Es wird NUR dort hingesehen, wo sich ueberhaupt etwas geaendert hat:
    in der echten Oberflaeche steht die Seitenleiste still und wuerde,
    ueber das ganze Bild gemittelt, jeden echten Sprung ueberstimmen.

    Das VORZEICHEN wurde nicht hergeleitet, sondern gemessen: an
    compare3-full Feld 1, Bildpaar 608 (bekannter Versatz +4,87 px) ergibt
    +dx ein Rest-Verhaeltnis von 0,128 und -dx eines von 0,877.
    """
    h, w = prev.shape
    m = np.float32([[1, 0, dx], [0, 1, dy]])
    warped = cv2.warpAffine(cur, m, (w, h), flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    mx, my = int(np.ceil(abs(dx))) + 2, int(np.ceil(abs(dy))) + 2
    if mx * 2 >= w or my * 2 >= h:
        return 1.0
    a = prev[my : h - my, mx : w - mx].astype(np.int16)
    b = warped[my : h - my, mx : w - mx].astype(np.int16)
    c = cur[my : h - my, mx : w - mx].astype(np.int16)
    geaendert = np.abs(a - c) > 8
    if geaendert.mean() < 0.002:
        return 1.0
    r_shift = float(np.abs(a - b)[geaendert].mean())
    r_zero = float(np.abs(a - c)[geaendert].mean())
    return r_shift / r_zero if r_zero > 1e-6 else 1.0
