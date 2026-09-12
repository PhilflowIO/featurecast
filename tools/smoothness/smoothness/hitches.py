"""Die Definition "Haker" -- als Code, nicht als Augenmass.

    Ein HAKER ist eine Stelle innerhalb der Reisestrecke einer
    gleichgerichteten Bewegung, an der der Bild-zu-Bild-Versatz vom Tempo
    seiner unmittelbaren Nachbarn abweicht: entweder mindestens zwei
    aufeinanderfolgende Bilder unter 25 % des oertlichen Tempos
    (Stillstand >= 33 ms), oder ein Einzelschritt ueber dem Doppelten des
    oertlichen Tempos (Nachholsprung). Ereignisse, die weniger als vier
    Bilder auseinander liegen, sind EINE Stoerstelle -- das Auge kann zwei
    Stolperer 50 ms auseinander nicht trennen. Gezaehlt werden Stoerstellen.

Alle Zahlen dieser Definition stehen in knobs.py und nirgends sonst.
Keine davon ist gegen das Auge des Owners geeicht (docs/SMOOTHNESS.md,
"Grenzen").
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .knobs import KNOBS, Knobs

__all__ = ["HakerBefund", "Quote", "finde_haker"]


@dataclass(frozen=True)
class Quote:
    """Ein Verhaeltnis, das seinen eigenen Nenner mitfuehrt.

    Warum es diesen Typ gibt: in diesem Projekt waren zwei Messgeraete um
    die Haelfte falsch, beide sahen plausibel aus, und beide hatten einen
    unbenannten Nenner. Eine nackte Zahl "0,176" laesst sich nicht pruefen.
    "3 von 17 Bildpaaren des Fensters" laesst sich pruefen.
    """

    zaehler: int
    nenner: int
    nenner_bedeutung: str
    """Woraus der Nenner besteht, in Worten. Wandert in die Ausgabe."""

    @property
    def quote(self) -> float | None:
        return self.zaehler / self.nenner if self.nenner else None

    def als_dict(self) -> dict[str, object]:
        return {"anzahl": self.zaehler, "von": self.nenner,
                "nenner_bedeutung": self.nenner_bedeutung,
                "quote": round(self.quote, 4) if self.quote is not None else None}


@dataclass(frozen=True)
class HakerBefund:
    stoerstellen: list[dict]
    """Die gezaehlte Groesse. Zusammengefasste Einzelereignisse."""
    ereignisse: list[dict]
    """Die Einzelereignisse davor -- nicht verschwiegen, nur nicht gezaehlt."""
    mikro: Quote
    """Ein-Bild-Aussetzer, eigener Nenner (Reisestrecke)."""
    reisestrecke_bildpaare: int
    """Nenner der Haker-Quote: das Fenster OHNE Anlauf- und Bremsrampe."""
    stillstands_histogramm: dict[str, int]
    von_bildpaar_reise: int
    """Index des ersten Reise-Bildpaars, damit jede Stelle im Video
    wiederzufinden ist."""


def finde_haker(schritte: np.ndarray, erstes_bildpaar: int, fps: float,
                k: Knobs = KNOBS) -> HakerBefund:
    """Haker in einer Folge von Schrittweiten (Betrag, ein Wert je Bildpaar).

    `erstes_bildpaar` ist der Index des ersten Eintrags im Gesamtvideo, damit
    jede gemeldete Stelle wiederzufinden ist.
    """
    tempo = float(np.median(schritte)) if len(schritte) else 0.0
    verhaeltnis = schritte / tempo if tempo > 0 else schritte * 0.0

    # Anlauf und Auslauf gehoeren nicht zur Reisestrecke: das Produkt scrollt
    # mit Beschleunigungs- und Bremskurve, und eine Rampe ist kein Haker.
    drin = np.where(verhaeltnis >= k.cruise_frac)[0]
    c0, c1 = (int(drin[0]), int(drin[-1])) if len(drin) else (0, len(schritte) - 1)
    reise = schritte[c0 : c1 + 1]
    n_reise = len(reise)

    # Oertliches Tempo: Median der Nachbarn je Seite, das Bildpaar selbst
    # ausgenommen. Ein fester Fenster-Massstab wuerde jede Beschleunigung als
    # Sprung zaehlen -- erste Fassung: 33 Haker in einem 47-Bild-Fenster.
    hw = k.local_halfwin
    lokal = np.empty(n_reise)
    for i in range(n_reise):
        nb = np.concatenate([reise[max(0, i - hw) : i], reise[i + 1 : i + 1 + hw]])
        lokal[i] = np.median(nb) if len(nb) else reise[i]
    lokal = np.maximum(lokal, 1e-6)
    rel = reise / lokal

    ereignisse: list[dict] = []
    mikro: list[dict] = []
    hist: dict[int, int] = {}
    basis = erstes_bildpaar + c0
    i = 0
    while i < n_reise:
        if rel[i] < k.stall_frac:
            j = i
            while j + 1 < n_reise and rel[j + 1] < k.stall_frac:
                j += 1
            laenge = j - i + 1
            hist[laenge] = hist.get(laenge, 0) + 1
            nach = float(rel[j + 1]) if j + 1 < n_reise else 0.0
            e = {"art": "Stillstand" + ("+Nachsprung" if nach > k.jump_factor else ""),
                 "bildpaar": int(basis + i), "bilder": int(laenge),
                 "ms": round(1000 * laenge / fps, 1), "nachsprung_x": round(nach, 2)}
            ziel = ereignisse if (laenge >= k.stall_min_frames or nach > k.jump_factor) else mikro
            ziel.append(e)
            # Der Nachsprung gehoert zum selben Haker und wird nicht noch
            # einmal als eigener Sprung gezaehlt.
            i = j + 2 if nach > k.jump_factor else j + 1
            continue
        if rel[i] > k.jump_factor:
            ereignisse.append({"art": "Sprung", "bildpaar": int(basis + i), "bilder": 1,
                               "ms": round(1000 / fps, 1), "sprung_x": round(float(rel[i]), 2)})
        i += 1

    stellen: list[dict] = []
    for e in ereignisse:
        if stellen and e["bildpaar"] - stellen[-1]["bis"] <= k.merge_gap:
            stellen[-1]["bis"] = e["bildpaar"] + e["bilder"] - 1
            stellen[-1]["ereignisse"] += 1
        else:
            stellen.append({"von": e["bildpaar"], "bis": e["bildpaar"] + e["bilder"] - 1,
                            "ereignisse": 1, "art": e["art"]})

    return HakerBefund(
        stoerstellen=stellen,
        ereignisse=ereignisse,
        mikro=Quote(len(mikro), n_reise, "Bildpaare der Reisestrecke (ohne Anlauf/Auslauf)"),
        reisestrecke_bildpaare=n_reise,
        stillstands_histogramm={f"{laenge}_Bilder": c for laenge, c in sorted(hist.items())},
        von_bildpaar_reise=basis,
    )
