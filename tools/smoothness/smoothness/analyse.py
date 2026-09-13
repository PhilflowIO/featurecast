"""Ein Lauf von vorne bis hinten: Video lesen, messen, Fenster bestimmen,
urteilen. Die CLI ist nur eine Huelle um diese Funktionen, damit die Tests
denselben Weg nehmen wie der Aufruf von Hand.

Zweigeteilt, weil Messen und Urteilen verschieden teuer sind: `analysiere`
liest das Video und misst die Bildpaare (Minuten fuer einen ganzen Lauf),
`werte_aus` urteilt ueber schon gemessene Bildpaare (Millisekunden). Der
Regressionstest ueber die drei Browser-Arme nimmt `werte_aus` mit den
Bildpaaren der echten Laeufe -- denselben Weg, nur ohne das Video erneut zu
dekodieren.
"""

from __future__ import annotations

from dataclasses import asdict
from itertools import chain
from pathlib import Path

from .frames import Ausschnitt, Skalierung, lies_graustufen, skalierung_bestimmen
from .knobs import KNOBS, Knobs, erklaere
from .pairs import STATUS_ALLE, STATUS_GUELTIG, Pair, messe_bildpaare
from .report import beurteile_fenster, fasse_zusammen
from .windows import QUELLE_EIGENE, QUELLE_PRODUKT, aus_lauf, eigene_zerlegung, richtungswechsel

__all__ = ["analysiere", "werte_aus"]


def analysiere(video: str, ausschnitt: Ausschnitt | None = None, fps: float | None = None,
               lauf_verzeichnis: str | Path | None = None,
               aufnahme_breite: int = 2560, px_faktor: float | None = None,
               k: Knobs = KNOBS) -> dict[str, object]:
    """Misst ein Video und liefert den vollstaendigen Bericht als dict.

    `lauf_verzeichnis` zeigt auf das Ausgabeverzeichnis eines echten
    Aufnahmelaufs (`motion-windows.json` + `timestamps.json`). Fehlt es,
    faellt das Werkzeug auf die eigene Zerlegung zurueck -- und schreibt das
    in jedes Fenster.
    """
    bilder = lies_graustufen(video, ausschnitt)
    erstes = next(bilder)
    skal = skalierung_bestimmen(erstes.shape[1], aufnahme_breite, px_faktor)
    pairs = messe_bildpaare(chain([erstes], bilder), k)
    bericht = werte_aus(pairs, skal, fps, lauf_verzeichnis, k)
    return {"video": video,
            "ausschnitt": ausschnitt.als_tupel() if ausschnitt else None,
            **bericht}


def werte_aus(pairs: list[Pair], skal: Skalierung, fps: float | None = None,
              lauf_verzeichnis: str | Path | None = None,
              k: Knobs = KNOBS) -> dict[str, object]:
    """Urteil ueber gemessene Bildpaare. Siehe Modul-Docstring."""
    # Ohne Angabe die nominale Bildrate aus knobs.py -- die 60 steht dort und
    # nirgends sonst. src/assemble.ts erzeugt das Ausgabevideo mit genau
    # dieser konstanten Rate (`FRAME_RATE`).
    fps = k.fps_nominal if fps is None else fps
    if lauf_verzeichnis is not None:
        fenster = aus_lauf(lauf_verzeichnis, fps, skal.faktor, len(pairs))
        quelle = QUELLE_PRODUKT
    else:
        fenster = eigene_zerlegung(pairs, k)
        quelle = QUELLE_EIGENE

    n = len(pairs)
    gueltig = sum(1 for p in pairs if p.status in STATUS_GUELTIG)
    urteile = [beurteile_fenster(pairs, f, fps, k) for f in fenster]
    return {
        "bilder": n + 1,
        "bildpaare": n,
        "fps": fps,
        "skalierung": {"faktor": skal.faktor, "herkunft": skal.herkunft},
        "fenster_quelle": quelle,
        "knobs": asdict(k),
        "stellschrauben": erklaere(k),
        "messbarkeit": {"anzahl": gueltig, "von": n,
                        "nenner_bedeutung": "Bildpaare des ganzen Videos",
                        "quote": round(gueltig / n, 4) if n else None},
        "verworfen": {s: sum(1 for p in pairs if p.status == s)
                      for s in STATUS_ALLE if s not in STATUS_GUELTIG},
        "richtungswechsel": richtungswechsel(pairs, k),
        "zusammenfassung": fasse_zusammen(urteile),
        "fenster": urteile,
        "paare": [asdict(p) for p in pairs],
    }
