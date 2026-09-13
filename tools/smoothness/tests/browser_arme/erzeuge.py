"""Erzeugt die Fixture eines echten Browser-Arms aus einem Aufnahmelauf.

FIXTURE-HERKUNFT, woertlich: drei Laeufe desselben Aufnahmeskripts
(demo/m1-capture.ts), gleicher Quellstand, auf der AI-Box aufgenommen am
2026-09-12 unter `~/featurecast-bench/verify-r3/wt/artifacts/`. Nur der Browser
variiert:

  cSTOCK  Playwright-Bundle (Standard-Chromium)
  cUNP    selbst gebaut 153.0.8010.12, ungepatcht
  cPAT    selbst gebaut 153.0.8010.12, beide Patches (#17)

Die Zuordnung Lauf -> Browser stammt aus dem Lauf selbst und ist in #23 und
docs/JOURNEY.md belegt (Aufnahme-Ausbeute 84,4 / 79,1 / 98,2 %).

Was hier passiert: das fertige `output.mp4` wird mit DIESEM Werkzeug
vermessen (derselbe Weg wie die CLI), und gespeichert werden die gemessenen
Bildpaare zusammen mit genau den Teilen von `motion-windows.json` und
`timestamps.json`, die `windows.aus_lauf` liest. Die Videos selbst gehoeren
nicht ins Repo (.gitignore); ihre Pruefsummen stehen in der Fixture, damit
jeder Nachbau pruefen kann, ob er dasselbe Material vor sich hat.

Aufruf (Minuten je Lauf):

    uv run python tests/browser_arme/erzeuge.py <lauf-verzeichnis> <arm> "<browser>"
"""

from __future__ import annotations

import gzip
import hashlib
import json
import subprocess
import sys
from dataclasses import asdict
from itertools import chain
from pathlib import Path

from smoothness.frames import lies_graustufen, skalierung_bestimmen
from smoothness.pairs import messe_bildpaare

HIER = Path(__file__).resolve().parent


def _sha256(pfad: Path) -> str:
    return hashlib.sha256(pfad.read_bytes()).hexdigest()


def main(lauf: str, arm: str, browser: str) -> None:
    d = Path(lauf)
    video = d / "output.mp4"
    bilder = lies_graustufen(str(video))
    erstes = next(bilder)
    skal = skalierung_bestimmen(erstes.shape[1])
    pairs = messe_bildpaare(chain([erstes], bilder))

    fenster = json.loads((d / "motion-windows.json").read_text(encoding="utf-8"))
    manifest = json.loads((d / "timestamps.json").read_text(encoding="utf-8"))
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                            cwd=HIER).stdout.strip()
    spalten = ("i", "dx", "dy", "status", "dup")
    fixture = {
        "herkunft": {
            "arm": arm,
            "browser": browser,
            "aufgenommen": "AI-Box, 2026-09-12, ~/featurecast-bench/verify-r3/wt/artifacts/",
            "sha256": {n: _sha256(d / n) for n in
                       ("output.mp4", "motion-windows.json", "timestamps.json")},
            "vermessen_mit_commit": commit,
            "erzeuger": "tools/smoothness/tests/browser_arme/erzeuge.py",
        },
        "skalierung": {"faktor": skal.faktor, "herkunft": skal.herkunft},
        "motion_windows": {"windows": [
            {s: w[s] for s in ("label", "start", "end", "durationSeconds", "target") if s in w}
            for w in fenster["windows"]]},
        "timestamps": {"session": {"startedAt": manifest["session"]["startedAt"]},
                       "frames": [{"timestamp": f["timestamp"]} for f in manifest["frames"]]},
        "paare": {s: [asdict(p)[s] for p in pairs] for s in spalten},
    }
    ziel = HIER / f"{arm}.json.gz"
    # mtime=0: dieselben Bildpaare ergeben byte-gleich dieselbe Datei.
    roh = json.dumps(fixture, separators=(",", ":")).encode("utf-8")
    with open(ziel, "wb") as fh, gzip.GzipFile(filename="", mode="wb", fileobj=fh,
                                               mtime=0) as gz:
        gz.write(roh)
    print(f"{ziel}: {len(pairs)} Bildpaare, {len(fixture['motion_windows']['windows'])} Fenster")


if __name__ == "__main__":
    main(*sys.argv[1:4])
