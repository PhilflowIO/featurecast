"""Eichvideos mit BEKANNTEM Versatz je Bild -- reproduzierbar erzeugt.

FIXTURE-HERKUNFT (die Frage, die jeder Test hier beantworten muss):
Diese Videos stammen aus KEINEM Aufnahmelauf. Sie sind gerechnet, mit festem
Zufallskeim, und ihre Wahrheit ist deshalb exakt bekannt -- das ist der ganze
Punkt: ein Messgeraet, dessen Antwort man nicht gegen eine bekannte Antwort
halten kann, ist kein Beleg. Modelliert ist die Oberflaeche, die das Produkt
aufnimmt (demo/m1-capture.ts: MUI DataGrid, Spaltenraster um 111 px), in der
Aufloesung eines Feldes der Vergleichsvideos (960x540, 60 fps, libx264
crf 18 -- dieselbe Kodierung wie src/assemble.ts sie erzeugt).

Warum erzeugt statt eingecheckt: ein eingechecktes MP4 ist ein Binaerklotz,
dessen Herkunft nach zwei Monaten niemand mehr nachvollzieht, und .gitignore
dieses Repos schliesst *.mp4 ohnehin aus. Erzeugt heisst: die Wahrheit steht
im Code daneben.

Uebernommen aus dem Prototyp /home/philflow/featurecast-bench/glaette-work/
(synth.py, synth2.py, mutiere.py), Stand 2026-09-12.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

W, H, FPS = 960, 540, 60
N = 60
CW, CH = 2600, 1800
X0, Y0 = 700, 500
KEIM = 20260912


def ffmpeg_vorhanden() -> bool:
    return shutil.which("ffmpeg") is not None


# ----------------------------------------------------------------- Leinwaende
def canvas_texture(rng: np.random.Generator) -> np.ndarray:
    """Nicht-periodischer Inhalt: gefiltertes Rauschen + Formen."""
    a = rng.normal(128, 40, (CH, CW)).astype(np.float32)
    a = cv2.GaussianBlur(a, (0, 0), 1.6)
    for _ in range(400):
        x, y = rng.integers(0, CW - 200), rng.integers(0, CH - 200)
        w, h = rng.integers(20, 200), rng.integers(10, 120)
        cv2.rectangle(a, (int(x), int(y)), (int(x + w), int(y + h)),
                      float(rng.integers(0, 255)), -1)
    for _ in range(300):
        x, y = rng.integers(0, CW), rng.integers(0, CH)
        cv2.circle(a, (int(x), int(y)), int(rng.integers(3, 40)),
                   float(rng.integers(0, 255)), -1)
    return np.clip(cv2.GaussianBlur(a, (0, 0), 0.8), 0, 255).astype(np.uint8)


def canvas_grid(rng: np.random.Generator, col_pitch: int = 111,
                row_pitch: int = 36) -> np.ndarray:
    """Periodischer Inhalt wie ein DataGrid: gleiches Raster, darin
    variierender schwacher "Text". Der Zellinhalt bricht die Periodizitaet --
    genau deshalb ueberlebt der naive Schaetzer diesen Fall noch."""
    a = np.full((CH, CW), 250, np.uint8)
    for x in range(0, CW, col_pitch):
        a[:, x : x + 1] = 150
    for y in range(0, CH, row_pitch):
        a[y : y + 1, :] = 205
        if (y // row_pitch) % 2 == 0:
            a[y + 1 : y + row_pitch, :] = np.minimum(a[y + 1 : y + row_pitch, :], 244)
    for row in range(CH // row_pitch):
        for col in range(CW // col_pitch):
            x = col * col_pitch + 6
            y = row * row_pitch + row_pitch - 10
            for k in range(int(rng.integers(3, 9))):
                cv2.rectangle(a, (x + k * 10, y - 8), (x + k * 10 + 7, y),
                              int(rng.integers(165, 195)), -1)
    return a


def canvas_strict_grid(rng: np.random.Generator, col: int = 111,
                       row: int = 36) -> np.ndarray:
    """STRENG periodisch: eine Kachel 111x36, exakt wiederholt. Der Fall, der
    den naiven Schaetzer im Projekt getoetet hat ("konstant 111 px fuer kaum
    bewegte Bilder")."""
    tile = np.full((row, col), 250, np.uint8)
    tile[:, 0] = 150
    tile[0, :] = 205
    for k in range(5):
        cv2.rectangle(tile, (6 + k * 19, row - 22), (6 + k * 19 + 14, row - 10), 172, -1)
    a = np.tile(tile, (CH // row + 2, CW // col + 2))[:CH, :CW].copy()
    return np.clip(a.astype(np.float32) + rng.normal(0, 0.8, a.shape), 0, 255).astype(np.uint8)


def add_spinner(frame: np.ndarray, t: int) -> np.ndarray:
    """Unabhaengige Nebenanimation: drehendes Symbol + einblendender Tooltip."""
    f = frame.copy()
    cx, cy, r = W - 70, 60, 26
    cv2.circle(f, (cx, cy), r, 200, 3)
    cv2.ellipse(f, (cx, cy), (r, r), (t * 24) % 360, 0, 110, 40, 5)
    if t > 25:
        al = min(1.0, (t - 25) / 10.0)
        box = f[H - 120 : H - 60, 40:340].astype(np.float32)
        f[H - 120 : H - 60, 40:340] = (box * (1 - al) + 30 * al).astype(np.uint8)
        cv2.putText(f, "Aktualisiert", (56, H - 82), cv2.FONT_HERSHEY_SIMPLEX,
                    0.8, int(230 * al), 2)
    return f


def window(canvas: np.ndarray, x: float, y: float) -> np.ndarray:
    """Fenster an moeglicherweise gebrochener Position, bikubisch."""
    assert 4 <= x <= CW - W - 4 and 4 <= y <= CH - H - 4, (x, y)
    ix, iy = int(np.floor(x)), int(np.floor(y))
    fx, fy = x - ix, y - iy
    pad = 4
    sub = canvas[iy - pad : iy + H + pad, ix - pad : ix + W + pad].astype(np.float32)
    if fx or fy:
        m = np.float32([[1, 0, -fx], [0, 1, -fy]])
        sub = cv2.warpAffine(sub, m, (sub.shape[1], sub.shape[0]),
                             flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    return np.clip(sub[pad : pad + H, pad : pad + W], 0, 255).astype(np.uint8)


def encode(frames: list[np.ndarray], pfad: Path, fps: int = FPS) -> None:
    """Graustufen-Rohbilder nach H.264 -- dieselben Kodier-Einstellungen, mit
    denen src/assemble.ts das echte Erzeugnis baut."""
    h, w = frames[0].shape[:2]
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", f"{w}x{h}", "-r", str(fps), "-i", "-", "-c:v", "libx264",
         "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", str(pfad)],
        stdin=subprocess.PIPE)
    assert p.stdin is not None
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    assert p.wait() == 0


# --------------------------------------------------------------------- Faelle
def _gleich(dx: float, dy: float = 0.0) -> list[tuple[float, float]]:
    return [(dx, dy)] * (N - 1)


def _rampe() -> list[tuple[float, float]]:
    """Produktnaher Scroll: Anlauf, Reisetempo, Bremsen. Der Fall, an dem sich
    entscheidet, ob eine Beschleunigung faelschlich als Haker zaehlt."""
    schritte = []
    for i in range(N - 1):
        t = i / (N - 2)
        schritte.append((round(6.0 * float(np.sin(np.pi * t)) ** 0.7, 3), 0.0))
    return schritte


CASES: dict[str, dict] = {
    "c1_gleichmaessig_h": dict(leinwand="texture", steps=_gleich(4.0)),
    "c2_periodisch_h": dict(leinwand="grid", steps=_gleich(4.0)),
    "c3_subpixel_h": dict(leinwand="texture", steps=_gleich(0.4)),
    "c4_gehaltene_bilder": dict(
        leinwand="texture",
        steps=[(0.0, 0.0) if i % 3 == 2 else (6.0, 0.0) for i in range(N - 1)]),
    "c5_teleport": dict(
        leinwand="texture",
        steps=[(120.0, 0.0) if i == 30 else (0.0, 0.0) for i in range(N - 1)]),
    "c6_umkehr": dict(
        leinwand="texture",
        steps=[(5.0 if (i < 20 or i >= 40) else -5.0, 0.0) for i in range(N - 1)]),
    "c7_senkrecht": dict(leinwand="texture", steps=_gleich(0.0, 7.0)),
    "c8_nebenanimation": dict(leinwand="texture", steps=_gleich(5.0), spinner=True),
    "c9_periodisch_umkehr_subpixel": dict(
        leinwand="grid",
        steps=[(2.6 if (i < 20 or i >= 40) else -2.6, 0.0) for i in range(N - 1)]),
    "c10_streng_stehend": dict(leinwand="strict", steps=_gleich(0.0)),
    "c11_streng_langsam": dict(leinwand="strict", steps=_gleich(0.6)),
    # 70 px je Bild auf streng periodischem Inhalt: +70 und 70-111 = -41 sind
    # dieselbe Bildinformation. Aus zwei Bildern nicht entscheidbar. Richtig
    # ist VERWEIGERN, nicht raten -- siehe tests/test_eichung.py.
    "c12_streng_alias_70px": dict(
        leinwand="strict",
        steps=[(70.0 if (i // 10) % 2 == 0 else -70.0, 0.0) for i in range(N - 1)]),
    "c13_szenenwechsel": dict(leinwand="texture", steps=_gleich(5.0), hardcut_bei=30),
    "c14_scroll_rampe": dict(leinwand="texture", steps=_rampe()),
}


def _leinwand(art: str, rng: np.random.Generator) -> np.ndarray:
    return {"texture": canvas_texture, "grid": canvas_grid,
            "strict": canvas_strict_grid}[art](rng)


def baue_fall(name: str, ziel: Path) -> tuple[Path, dict]:
    """Erzeugt `<ziel>/<name>.mp4` und liefert (Pfad, Wahrheit).

    Wahrheit: {"dx": [...], "dy": [...]} mit einem Eintrag je Bildpaar;
    NaN heisst "hier gibt es keinen gueltigen Versatz" (Szenenwechsel).
    """
    spec = CASES[name]
    rng = np.random.default_rng(KEIM)
    leinwand = _leinwand(spec["leinwand"], rng)
    zweite = canvas_texture(np.random.default_rng(KEIM + 1)) if spec.get("hardcut_bei") else None

    x, y = float(X0), float(Y0)
    frames: list[np.ndarray] = []
    dxs: list[float] = []
    dys: list[float] = []
    aktuell = leinwand
    f = window(aktuell, x, y)
    frames.append(add_spinner(f, 0) if spec.get("spinner") else f)
    for i, (dx, dy) in enumerate(spec["steps"]):
        x += dx
        y += dy
        if spec.get("hardcut_bei") == i + 1:
            aktuell = zweite
            dxs.append(float("nan"))
        else:
            dxs.append(dx)
        dys.append(dy)
        f = window(aktuell, x, y)
        frames.append(add_spinner(f, i + 1) if spec.get("spinner") else f)

    pfad = ziel / f"{name}.mp4"
    encode(frames, pfad)
    wahrheit = {"fall": name, "w": W, "h": H, "fps": FPS,
                "inhalt": spec["leinwand"], "dx": dxs, "dy": dys}
    (ziel / f"{name}.truth.json").write_text(json.dumps(wahrheit, indent=1),
                                             encoding="utf-8")
    return pfad, wahrheit


# ------------------------------------------------------------------ Mutation
def _bilder_lesen(pfad: Path) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(pfad))
    aus = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        aus.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
    cap.release()
    return aus


MUTATIONEN = ("wiederholt3", "wiederholt5", "fehlt4", "vertauscht")


def mutiere(quelle: Path, art: str, ziel: Path) -> Path:
    """Macht ein fertiges Video absichtlich kaputt.

    wiederholtN  jedes N-te Bild wird durch seinen Vorgaenger ersetzt
                 (die Aufnahme haengt -- Bild steht, danach Nachsprung)
    fehltN       jedes N-te Bild wird geloescht, der Rest rueckt auf
                 (die Aufnahme verliert ein Bild -- doppelter Schritt)
    vertauscht   Bilder paarweise getauscht (Zeitachse lokal verdreht)

    Ein Messgeraet, das kaputtes Material weiter fuer gut erklaert, ist der
    Befund -- nicht das Material.
    """
    fr = _bilder_lesen(quelle)
    if art.startswith("wiederholt"):
        n = int(art.removeprefix("wiederholt"))
        m = [fr[i - 1] if (i and i % n == 0) else fr[i] for i in range(len(fr))]
    elif art.startswith("fehlt"):
        n = int(art.removeprefix("fehlt"))
        m = [f for i, f in enumerate(fr) if not (i and i % n == 0)]
    elif art == "vertauscht":
        m = list(fr)
        for i in range(1, len(m) - 1, 6):
            m[i], m[i + 1] = m[i + 1], m[i]
    else:
        raise ValueError(art)
    pfad = ziel / f"{quelle.stem}_{art}.mp4"
    encode(m, pfad)
    return pfad
