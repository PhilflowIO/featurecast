"""Woher die Bewegungsfenster kommen -- und warum das der wichtigste Teil ist.

Ein Fenster ist der Abschnitt, ueber den geurteilt wird. Wer die Grenzen aus
der Messung selbst ableitet, urteilt ueber einen Abschnitt, den die Messung
sich selbst ausgesucht hat. Das ist genau die Sorte Zirkelschluss, die in
diesem Projekt schon zweimal ein Messgeraet um die Haelfte danebenliegen
liess.

Deshalb gibt es zwei Quellen und sie sind in der Ausgabe nie zu verwechseln:

  "produkt"           Fenstergrenzen und Sollstrecke stammen aus dem Lauf
                      selbst -- `motion-windows.json` und `timestamps.json`,
                      geschrieben von demo/m1-capture.ts. Erst hier traegt
                      der Streckenabgleich.
  "eigene-zerlegung"  Rueckfall. Die Grenzen stammen aus der Messung. Keine
                      Sollstrecke, keine externe Dauer, beide aeusseren
                      Schranken ungeprueft. Steht so in der Ausgabe.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .bounds import Dauer
from .knobs import KNOBS, Knobs
from .pairs import STATUS_GUELTIG, Pair

__all__ = ["Fenster", "aus_lauf", "eigene_zerlegung"]

QUELLE_PRODUKT = "produkt"
QUELLE_EIGENE = "eigene-zerlegung"

_RANGE = re.compile(r"\((?P<achse>[xy]) range (?P<px>\d+(?:\.\d+)?)px\)")
_RICHTUNG = {"right": "rechts", "left": "links", "down": "runter", "up": "hoch"}


@dataclass(frozen=True)
class Fenster:
    """Ein Abschnitt des Videos, ueber den geurteilt wird."""

    name: str
    von_bildpaar: int
    """Erstes Bildpaar (einschliesslich). Bildpaar i ist der Uebergang von
    Ausgabebild i-1 nach i."""
    bis_bildpaar: int
    quelle: str
    """QUELLE_PRODUKT oder QUELLE_EIGENE -- wandert woertlich in die Ausgabe."""
    soll_px: float | None = None
    """Erwartete Gesamtstrecke in Pixeln DES GEMESSENEN AUSSCHNITTS, schon
    skaliert. None heisst: kein Streckenabgleich moeglich."""
    soll_herkunft: str | None = None
    dauer: Dauer | None = None
    """Externe Fensterdauer fuer die 60-Hz-Schranke. None heisst ungeprueft."""
    richtung: str | None = None
    """rechts | links | runter | hoch, aus dem Namen des Fensters. None
    heisst: aus der Messung abgeleitet und als solches gekennzeichnet."""
    bilder_extern: int | None = None
    """Unabhaengig gezaehlte Bilder dieses Fensters -- die Aufnahmebilder aus
    `timestamps.json`. Das ist die Zahl, an der die 60-Hz-Schranke wirklich
    reissen kann; die Ausgabebilder koennen es nicht, siehe bounds.py."""
    grenzen_aus_dauer: bool = False
    """True, wenn die Fenstergrenzen aus derselben Dauer abgeleitet wurden,
    gegen die die 60-Hz-Schranke prueft. Dann ist die Schranke ueber die
    Ausgabebilder tautologisch und meldet sich als ungeprueft."""


def _zeitanker(manifest: dict) -> float:
    """Nullpunkt der Videozeit, in ms.

    Nicht `frames[0].timestamp`: `buildCaptureTimeline` in src/assemble.ts
    verankert die Dauer des ersten Bildes an
    `min(session.startedAt, frames[0].timestamp)`, weil das erste Bild
    typischerweise einige Millisekunden nach dem Aufnahmestart eintrifft und
    diese Luecke seiner Standzeit zugeschlagen wird. Wer stattdessen
    `frames[0].timestamp` nimmt, verschiebt jede Fenstergrenze um genau
    diese Luecke -- bei 60 Hz sind das schnell mehrere Bilder.
    """
    return min(float(manifest["session"]["startedAt"]),
               float(manifest["frames"][0]["timestamp"]))


def aus_lauf(lauf_verzeichnis: str | Path, fps: float, px_faktor: float,
             anzahl_bildpaare: int) -> list[Fenster]:
    """Fenster aus der Wahrheit des Produkts.

    Erwartet `motion-windows.json` und `timestamps.json` eines echten Laufs
    im selben Verzeichnis (demo/m1-capture.ts schreibt beide dorthin).

    Die Sollstrecke steht im Feld `target`, z.B.
    "div.grid (x range 180px)" -- das ist die Scrollweite des Elements in
    CSS-Pixeln der Aufnahme. ACHTUNG, und deshalb steht es hier: das ist die
    volle Scrollweite des Behaelters, nicht notwendig die gefahrene Strecke.
    Sie stimmen ueberein, solange `scrollContainerToEdge` von Kante zu Kante
    faehrt (src/m1-benchmark.ts) -- laeuft ein Fenster anders, reisst der
    Streckenabgleich und das Fenster gilt als NICHT MESSBAR. Falsch-negativ
    ist hier die richtige Richtung.
    """
    d = Path(lauf_verzeichnis)
    fenster_datei = json.loads((d / "motion-windows.json").read_text(encoding="utf-8"))
    manifest = json.loads((d / "timestamps.json").read_text(encoding="utf-8"))
    anker = _zeitanker(manifest)

    aus: list[Fenster] = []
    for w in fenster_datei["windows"]:
        t0 = (float(w["start"]) - anker) / 1000.0
        t1 = (float(w["end"]) - anker) / 1000.0
        # Ausgabebild n zeigt die Videozeit [n/fps, (n+1)/fps). Bildpaar i
        # ist der Uebergang von n=i-1 nach n=i, liegt also genau dann im
        # Fenster, wenn beide Bilder darin liegen.
        erstes_bild = int(-(-t0 * fps // 1))          # ceil
        letztes_bild = int(t1 * fps // 1)             # floor
        von, bis = erstes_bild + 1, letztes_bild
        von = max(1, von)
        bis = min(anzahl_bildpaare, bis)
        if bis < von:
            continue
        treffer = _RANGE.search(str(w.get("target", "")))
        soll = None
        soll_herkunft = None
        if treffer:
            soll = float(treffer.group("px")) * px_faktor
            soll_herkunft = (f"motion-windows.json target "
                             f"{treffer.group('px')} Aufnahmepixel x {px_faktor:g}")
        richtung = next((v for k, v in _RICHTUNG.items() if k in str(w["label"])), None)
        # Unabhaengige Bildzahl: die Aufnahmebilder, die Chromium in diesem
        # Fenster geliefert hat. Sie stammt aus timestamps.json und damit aus
        # einer anderen Messung als die Fenstergrenzen -- deshalb kann die
        # 60-Hz-Schranke damit ueberhaupt reissen. Dieselbe Auswahl wie
        # `computeMotionWindowCadence` in src/cadence.ts.
        bilder_extern = sum(1 for f in manifest["frames"]
                            if float(w["start"]) <= float(f["timestamp"]) <= float(w["end"]))
        aus.append(Fenster(
            name=str(w["label"]),
            von_bildpaar=von,
            bis_bildpaar=bis,
            quelle=QUELLE_PRODUKT,
            soll_px=soll,
            soll_herkunft=soll_herkunft,
            dauer=Dauer(float(w["durationSeconds"]),
                        f"motion-windows.json:{w['label']}:durationSeconds"),
            richtung=richtung,
            bilder_extern=bilder_extern,
            grenzen_aus_dauer=True,
        ))
    return aus


def _etikett(p: Pair, k: Knobs) -> str:
    """Richtungsetikett eines Bildpaars.

    Links und rechts sind VERSCHIEDENE Etiketten. Damit kann eine
    Richtungsumkehr nie zu einem Fenster verschmelzen und nie gemittelt
    werden -- der Owner berichtet Haker in beiden Richtungen, ein
    gemittelter Wert haette sie gegeneinander aufgehoben.
    """
    if p.status not in STATUS_GUELTIG:
        return "unklar"
    if abs(p.dx) >= abs(p.dy):
        if p.dx > k.still_px:
            return "rechts"
        if p.dx < -k.still_px:
            return "links"
    else:
        if p.dy > k.still_px:
            return "runter"
        if p.dy < -k.still_px:
            return "hoch"
    return "still"


def eigene_zerlegung(pairs: list[Pair], k: Knobs = KNOBS) -> list[Fenster]:
    """Rueckfall: zusammenhaengende Laeufe gleicher Richtung aus der Messung.

    Kurze Stillstaende werden ueberbrueckt, ein Richtungswechsel beendet das
    Fenster hart. Ohne Sollstrecke und ohne externe Dauer -- beide aeusseren
    Schranken bleiben ungeprueft, und die Ausgabe sagt das.
    """
    lab = [_etikett(p, k) for p in pairs]
    aus: list[Fenster] = []
    i, n = 0, len(pairs)
    while i < n:
        if lab[i] in ("still", "unklar"):
            i += 1
            continue
        d = lab[i]
        j, letzter, luecke = i, i, 0
        while j + 1 < n:
            nxt = lab[j + 1]
            if nxt == d:
                letzter, luecke = j + 1, 0
            elif nxt in ("still", "unklar"):
                luecke += 1
                if luecke > k.gap_frames:
                    break
            else:
                break
            j += 1
        if letzter - i + 1 >= k.min_window_frames:
            von = pairs[i].i
            bis = pairs[letzter].i
            aus.append(Fenster(name=f"{von}-{bis}", von_bildpaar=von, bis_bildpaar=bis,
                               quelle=QUELLE_EIGENE, richtung=d))
        i = letzter + 1
    return aus


def richtungswechsel(pairs: list[Pair], k: Knobs = KNOBS) -> dict[str, object]:
    """Das Zappel-Mass ueber den ganzen Lauf.

    Faengt Material, das so zerstueckelt ist, dass gar kein Fenster
    zustandekommt. Ohne diese Zahl waere Schweigen das Urteil -- und
    Schweigen liest sich wie ein Bestehen.
    """
    lab = [_etikett(p, k) for p in pairs]
    bewegt = [x for x in lab if x not in ("still", "unklar")]
    wechsel = sum(1 for i in range(1, len(bewegt)) if bewegt[i] != bewegt[i - 1])
    return {"anzahl": wechsel, "von_bewegten_bildpaaren": len(bewegt),
            "nenner_bedeutung": "Bildpaare mit gueltigem, nicht stehendem Versatz",
            "quote": round(wechsel / len(bewegt), 4) if bewegt else None}
