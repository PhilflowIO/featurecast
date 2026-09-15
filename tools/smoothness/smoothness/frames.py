"""Bild-Zulieferung: Video lesen, Ausschnitt waehlen, Massstab festlegen.

Der Massstab ist hier, weil er sonst geraten wird. Das Werkzeug misst in
Pixeln DES GEMESSENEN AUSSCHNITTS. Die Sollstrecke aus `motion-windows.json`
steht dagegen in CSS-Pixeln der Aufnahme (2560 px breites Fenster). Zwischen
beiden liegt mindestens die Ausgabe-Skalierung (1920/2560 = 0,75) und, wenn
ein Vergleichsvideo gemessen wird, noch dessen Feldbreite. Der Prototyp hat
den Faktor 2 aus uebereinstimmenden Messwerten erschlossen -- das ist kein
Beleg. Hier ist er entweder ausdrueckliche Eingabe oder er wird aus den
Videomassen abgeleitet, und in beiden Faellen steht er samt Herkunft in der
Ausgabe.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import cv2
import numpy as np

__all__ = ["Ausschnitt", "Skalierung", "lies_graustufen", "panel_ausschnitt",
           "skalierung_bestimmen"]

# Die Aufnahmebreite des Produkts, in CSS-Pixeln: `CAPTURE_SIZE` in
# src/capture.ts. Nur der Vorgabewert -- ueberschreibbar per --aufnahme-breite,
# damit eine Aenderung dort hier nicht stillschweigend falsch wird.
AUFNAHME_BREITE_PX = 2560


@dataclass(frozen=True)
class Ausschnitt:
    """Bildausschnitt in Pixeln des gelesenen Videos."""

    x: int
    y: int
    w: int
    h: int

    @classmethod
    def parse(cls, text: str) -> Ausschnitt:
        x, y, w, h = (int(v) for v in text.split(","))
        return cls(x, y, w, h)

    def als_tupel(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.w, self.h)


def panel_ausschnitt(spec: str) -> Ausschnitt:
    """Feld k von M eines Dreiervergleichs (`compare3`): 960x540 unter der
    96 px hohen Kopfzeile. Das ist die Geometrie der Vergleichsvideos aus der
    Messumgebung, kein Format des Produkts."""
    k, _m = (int(v) for v in spec.split("/"))
    return Ausschnitt(x=(k - 1) * 960, y=96, w=960, h=540)


@dataclass(frozen=True)
class Skalierung:
    """Wieviele Ausschnittspixel entsprechen einem Aufnahme-(CSS-)Pixel."""

    faktor: float
    herkunft: str
    """Wie der Faktor zustande kam -- wandert woertlich in die Ausgabe, damit
    "abgeleitet" nie wie "gemessen" aussieht."""

    def aufnahme_zu_ausschnitt(self, px: float) -> float:
        return px * self.faktor


def skalierung_bestimmen(ausschnitt_breite: int, aufnahme_breite: int = AUFNAHME_BREITE_PX,
                         faktor: float | None = None) -> Skalierung:
    """Vorrang hat die ausdrueckliche Angabe; sonst wird abgeleitet.

    Die Ableitung setzt voraus, dass der gemessene Ausschnitt die VOLLE
    Breite des Aufnahmefensters zeigt (ganzes Ausgabebild oder ein
    vollbreites Feld eines Vergleichsvideos). Fuer einen Ausschnitt mitten
    im Bild ist sie falsch -- deshalb steht die Annahme im Herkunftstext und
    damit in der Ausgabe.
    """
    if faktor is not None:
        return Skalierung(float(faktor), f"angegeben: --px-skala {faktor}")
    return Skalierung(
        ausschnitt_breite / aufnahme_breite,
        f"abgeleitet: {ausschnitt_breite} Ausschnittspixel / {aufnahme_breite} "
        f"Aufnahmepixel (setzt voraus, dass der Ausschnitt die volle "
        f"Aufnahmebreite zeigt)",
    )


def lies_graustufen(pfad: str, ausschnitt: Ausschnitt | None = None) -> Iterator[np.ndarray]:
    """Die Bilder des Videos als Graustufen, eines nach dem anderen.

    Graustufen ist eine Grenze, keine Vereinfachung: eine Bewegung, die sich
    nur im Farbkanal zeigt, sieht dieses Werkzeug nicht (docs/SMOOTHNESS.md,
    "Grenzen").

    Ein Strom und keine Liste, weil die Messung nie mehr als zwei Bilder
    zugleich braucht. Ein ganzer Aufnahmelauf sind rund 4400 Bilder zu
    1920x1080 -- als Liste gut 9 GB, und genau diese Laeufe sind das Material,
    an dem das Geraet sich bewaehren muss.
    """
    cap = cv2.VideoCapture(pfad)
    if not cap.isOpened():
        raise SystemExit(f"Video nicht lesbar: {pfad}")
    gelesen = 0
    try:
        while True:
            ok, f = cap.read()
            if not ok:
                break
            g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
            if ausschnitt is not None:
                x, y, w, h = ausschnitt.als_tupel()
                g = g[y : y + h, x : x + w]
            gelesen += 1
            yield np.ascontiguousarray(g)
    finally:
        cap.release()
    if gelesen < 2:
        raise SystemExit(f"Zu wenige Bilder in {pfad}: {gelesen}")
