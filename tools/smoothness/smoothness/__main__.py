"""Aufruf von Hand. Siehe README.md."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .analyse import analysiere
from .frames import AUFNAHME_BREITE_PX, Ausschnitt, panel_ausschnitt
from .knobs import erklaere
from .report import als_text, vergleiche_laeufe


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="smoothness",
        description="Misst am fertigen Video, wie glatt eine Bewegung uebergeht.")
    ap.add_argument("video", nargs="?", help="Pfad zum MP4")
    ap.add_argument("--lauf", help="Verzeichnis eines Aufnahmelaufs mit "
                                   "motion-windows.json und timestamps.json")
    ap.add_argument("--panel", help="k/M -- Feld k eines Dreiervergleichs (960x540)")
    ap.add_argument("--crop", help="x,y,w,h")
    ap.add_argument("--fps", type=float, default=None,
                    help="Bildrate des Ausgabevideos; ohne Angabe fps_nominal aus knobs.py")
    ap.add_argument("--aufnahme-breite", type=int, default=AUFNAHME_BREITE_PX,
                    help="Breite des Aufnahmefensters in CSS-Pixeln (src/capture.ts)")
    ap.add_argument("--px-skala", type=float,
                    help="Ausschnittspixel je Aufnahmepixel. Ohne Angabe abgeleitet.")
    ap.add_argument("--json", help="Bericht als JSON hierhin schreiben")
    ap.add_argument("--erklaere-schwelle", action="store_true",
                    help="Alle Stellschrauben mit Wert und Begruendung ausgeben")
    ap.add_argument("--vergleiche", nargs="+", metavar="BERICHT.json",
                    help="Schon geschriebene Berichte desselben Aufnahmeskripts von "
                         "glatt nach hakelig ordnen")
    a = ap.parse_args(argv)

    if a.vergleiche:
        berichte = {pfad: json.loads(Path(pfad).read_text(encoding="utf-8"))
                    for pfad in a.vergleiche}
        print(json.dumps(vergleiche_laeufe(berichte), indent=2, ensure_ascii=False))
        return 0

    if a.erklaere_schwelle:
        print(json.dumps(erklaere(), indent=2, ensure_ascii=False))
        if a.video is None:
            return 0
    if a.video is None:
        ap.error("video fehlt")

    ausschnitt = None
    if a.crop:
        ausschnitt = Ausschnitt.parse(a.crop)
    elif a.panel:
        ausschnitt = panel_ausschnitt(a.panel)

    bericht = analysiere(a.video, ausschnitt, a.fps, a.lauf,
                         a.aufnahme_breite, a.px_skala)
    print(als_text(bericht))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(bericht, fh, indent=1, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
