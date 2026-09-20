#!/usr/bin/env python3
"""Find red spellcheck squiggles in a finished video.

Why this exists. A squiggle is a compositor-drawn marker: it is absent from
`page.screenshot` even in a take whose frames carry it, so the only place it
can be caught is the rendered video. And it cannot be caught by eye — scene M2
was signed off on three sighted stills on 2026-09-19 and carried two squiggles
in 25 of 1082 landscape frames and 52 of 1074 portrait frames. Three stills out
of a thousand frames miss a defect that shows in two per cent of them.

So the check is a detector over every n-th frame, and it is colour-and-shape,
never OCR: a squiggle is a run of near-saturated red pixels, far wider than it
is tall, whose vertical extent is a few pixels. Text, buttons and Raven's own
red recording notice are excluded by the aspect and height bounds — the notice
is a ring around the whole stage, hundreds of pixels tall.

    python3 tools/rote-welle/detect.py <video.mp4> [--step 2] [--out <dir>]

Exit code 1 if anything was found, so it can gate a delivery.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy import ndimage

# A squiggle sits between these bounds, measured on the known-positive take
# (artifacts/raven-auf-zuruf, 2026-09-19): 186x11 px on the phone, narrower on
# the desktop. The upper height bound keeps Raven's own red recording ring out.
MIN_BREITE = 24
MAX_HOEHE = 22
MIN_SEITENVERHAELTNIS = 3.0
MIN_PIXEL = 30

# How far apart two red marks may sit and still be one squiggle.
#
# This is the whole difference between a detector that works and one that
# reports zero on a take that carries the defect. At phone scale the wave is a
# continuous stroke; at desktop scale the same wave is drawn as 2x2 dots six
# pixels apart, and connected-component labelling splits it into two dozen
# specks that every size filter then throws away. Measured on the old M1
# desktop take (2560x1600): 23 marks from x=1270 to x=1338, none of them
# touching. Closing the gaps along x first makes it one run of 68 px.
LUECKE = 9

# A squiggle sits under a word, never across half the screen. The bound keeps
# Raven's own recording notice out: that ring's top edge is a red line four
# pixels tall and nearly the full frame wide, which every other rule here would
# happily call a squiggle (scene M3 films it on purpose).
MAX_BREITE_ANTEIL = 0.35

# How densely the box has to be filled with red before it counts.
#
# The bound that separates a squiggle from red LETTERING, which is the only
# other thing in this product shaped like a wide thin red run: Raven's
# "Verlassen" in the meeting bar reads 76x11 px and tripped every frame of
# scene M3 before this. A squiggle is a continuous stroke and fills its own box;
# a word is mostly the gaps between its letters. Measured on the three known
# positives: 0.39, 0.39 and 0.34. Measured on "Verlassen": 0.15.
MIN_FUELLUNG = 0.25


def rote_maske(bild: np.ndarray) -> np.ndarray:
    """Near-saturated red: red clearly dominant, the other two channels low."""
    r = bild[:, :, 0].astype(np.int16)
    g = bild[:, :, 1].astype(np.int16)
    b = bild[:, :, 2].astype(np.int16)
    return (r > 130) & (r - g > 60) & (r - b > 60) & (g < 140) & (b < 140)


def wellen(bild: np.ndarray) -> list[dict[str, int]]:
    maske = rote_maske(bild)
    if not maske.any():
        return []
    geschlossen = ndimage.binary_dilation(
        maske, structure=np.ones((1, LUECKE), dtype=bool)
    )
    markiert, anzahl = ndimage.label(geschlossen)
    treffer: list[dict[str, int]] = []
    breite_grenze = bild.shape[1] * MAX_BREITE_ANTEIL
    for y_schlitz, x_schlitz in ndimage.find_objects(markiert):
        hoehe = y_schlitz.stop - y_schlitz.start
        breite = x_schlitz.stop - x_schlitz.start
        if hoehe > MAX_HOEHE or breite < MIN_BREITE or breite > breite_grenze:
            continue
        if breite < MIN_SEITENVERHAELTNIS * hoehe:
            continue
        # Counted on the raw mask, so a wide dilation cannot inflate it.
        flaeche = int(maske[y_schlitz, x_schlitz].sum())
        if flaeche < MIN_PIXEL:
            continue
        if flaeche < MIN_FUELLUNG * breite * hoehe:
            continue
        # A squiggle sits under a word inside the page and never bleeds off the
        # picture. What does is Raven's recording notice: the camera pushes in,
        # its red banner and ring get cut by the frame, and the remainder is a
        # red bar 296x16 px at y=0 that satisfies every other rule here. Nine
        # frames of scene M3 matched on exactly that.
        if y_schlitz.start <= 0 or y_schlitz.stop >= bild.shape[0]:
            continue
        treffer.append(
            {
                "breite": int(breite),
                "hoehe": int(hoehe),
                "pixel": flaeche,
                "x": int(x_schlitz.start),
                "y": int(y_schlitz.start),
            }
        )
    del anzahl
    return treffer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--step", type=int, default=2)
    parser.add_argument("--out", default=None, help="where to keep hit frames")
    args = parser.parse_args()

    video = Path(args.video)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(video),
                "-vf",
                f"select=not(mod(n\\,{args.step}))",
                "-fps_mode",
                "passthrough",
                "-start_number",
                "0",
                f"{tmp}/f-%06d.png",
            ],
            check=True,
        )
        bilder = sorted(Path(tmp).glob("f-*.png"))
        gesamt = len(bilder)
        treffer_bilder: list[dict[str, object]] = []
        for index, pfad in enumerate(bilder):
            bild = np.asarray(_lesen(pfad))
            gefunden = wellen(bild)
            if gefunden:
                treffer_bilder.append(
                    {
                        "bild": index * args.step,
                        "datei": pfad.name,
                        "wellen": gefunden,
                    }
                )
                if args.out is not None:
                    ziel = Path(args.out)
                    ziel.mkdir(parents=True, exist_ok=True)
                    subprocess.run(
                        ["cp", str(pfad), str(ziel / f"treffer-{index * args.step:06d}.png")],
                        check=True,
                    )

    bericht = {
        "geprueft": gesamt,
        "schritt": args.step,
        "treffer": len(treffer_bilder),
        "video": str(video),
        "erste": treffer_bilder[:8],
    }
    print(json.dumps(bericht, ensure_ascii=False, indent=1))
    return 1 if treffer_bilder else 0


def _lesen(pfad: Path):
    from PIL import Image

    with Image.open(pfad) as bild:
        return bild.convert("RGB")


if __name__ == "__main__":
    sys.exit(main())
