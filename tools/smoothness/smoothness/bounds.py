"""Die beiden aeusseren Schranken.

Aeusserlich heisst: das Kriterium stammt NICHT aus der Rechnung, die es
prueft. Das ist der ganze Zweck. Zwei Messgeraete dieses Projekts waren um
die Haelfte falsch und sahen beide plausibel aus, weil sie sich an sich
selbst gemessen haben -- `src/paint-rate.ts` und die erste Fassung von
`src/presented.ts`. Auch die erste Fassung der 60-Hz-Schranke in diesem
Werkzeug hatte den Fehler: sie berechnete die Fensterdauer aus der eigenen
Bildzaehlung und konnte deshalb nie anschlagen.

Deshalb ist die Dauer hier ein eigener Typ mit Herkunft (`Dauer`), und die
Schranke lehnt eine Dauer, die aus der Bildzaehlung stammt, ausdruecklich
ab. Der Fehler ist damit ausdrueckbar -- und genau deswegen pruefbar:
tests/test_schranken.py baut ihn absichtlich und zeigt zweierlei, dass die
Schranke ihn zurueckweist UND dass sie mit so einer Dauer ueber den ganzen
Wertebereich nie haette anschlagen koennen.

Damit war es nicht getan. Derselbe Zirkelschluss kam eine Ebene hoeher
zurueck: werden die Fenstergrenzen aus der Dauer abgeleitet, ist auch die
Zahl der AUSGABEBILDER im Fenster per Konstruktion hoechstens 60*d+1.
Gezaehlt wird deshalb eine unabhaengig erhobene Bildzahl (`bilder_extern`,
im Produktpfad die Aufnahmebilder aus `timestamps.json`); fehlt sie, meldet
die Schranke "tautologisch" statt "bestanden". Siehe `pruefe_60hz`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .knobs import KNOBS, Knobs

__all__ = ["Dauer", "HERKUNFT_EIGENE_ZAEHLUNG", "pruefe_60hz", "pruefe_strecke"]

HERKUNFT_EIGENE_ZAEHLUNG = "eigene-bildzaehlung"
"""Die eine Herkunft, die die 60-Hz-Schranke ablehnt."""


@dataclass(frozen=True)
class Dauer:
    """Eine Fensterdauer in Sekunden, mit Herkunft.

    Die Herkunft ist kein Kommentar, sie ist Teil der Pruefung. Ohne sie
    laesst sich von aussen nicht mehr unterscheiden, ob 0,333 s aus
    `motion-windows.json` stammt oder aus `bildpaare / 60`.
    """

    sekunden: float
    herkunft: str
    """z.B. "motion-windows.json:tasks:scroll-right:1" oder
    "--windows: dauer_s". Der Wert HERKUNFT_EIGENE_ZAEHLUNG ist verboten."""

    @classmethod
    def aus_bildzaehlung(cls, bildpaare: int, fps: float) -> Dauer:
        """Der VERBOTENE Weg -- existiert nur, damit der Fehler ausdrueckbar
        und damit testbar ist. `pruefe_60hz` lehnt das Ergebnis ab."""
        return cls(bildpaare / fps, HERKUNFT_EIGENE_ZAEHLUNG)


def pruefe_60hz(ausgabebilder: int, dauer: Dauer | None,
                bilder_extern: int | None = None, grenzen_aus_dauer: bool = False,
                k: Knobs = KNOBS) -> dict[str, object]:
    """In einem Fenster von d Sekunden koennen hoechstens 60*d+1 Bilder
    stecken. `d` MUSS von aussen kommen -- und die gezaehlten Bilder auch.

    Der zweite Halbsatz ist der Teil, den der Prototyp uebersehen hat.
    Werden die Fenstergrenzen aus derselben Dauer abgeleitet (genau das tut
    `windows.aus_lauf`: Videozeit -> Ausgabebild), dann ist die Zahl der
    Ausgabebilder im Fenster per Konstruktion hoechstens 60*d+1. Die
    Schranke haelt dann IMMER, egal wie kaputt das Material ist -- derselbe
    Zirkelschluss wie in `src/paint-rate.ts`, nur eine Ebene hoeher.
    Deshalb:

      `bilder_extern`      unabhaengig gezaehlte Bilder des Fensters, z.B.
                           die Aufnahmebilder aus `timestamps.json`. Das ist
                           die Zahl, die wirklich reissen kann.
      `grenzen_aus_dauer`  True, wenn die Fenstergrenzen aus dieser Dauer
                           stammen. Fehlt dann `bilder_extern`, meldet die
                           Schranke `haelt=None` mit dem Grund
                           "tautologisch" -- nicht "bestanden".

    Drei moegliche Ergebnisse, und alle drei sind verschieden:
      haelt=True   -- geprueft und bestanden
      haelt=False  -- geprueft und gerissen, das Fenster ist NICHT MESSBAR
      haelt=None   -- gar nicht geprueft. Das ist KEIN Bestehen.
    """
    if dauer is None:
        return {"quelle": "keine", "haelt": None, "hoechstens": None,
                "hinweis": "ohne externe Fensterdauer nicht pruefbar -- das ist "
                           "kein Bestehen, sondern eine Luecke"}
    if dauer.herkunft == HERKUNFT_EIGENE_ZAEHLUNG:
        return {"quelle": dauer.herkunft, "haelt": None, "hoechstens": None,
                "hinweis": "abgelehnt: eine Dauer aus der eigenen Bildzaehlung "
                           "kann diese Schranke nie reissen"}
    grenze = math.floor(k.fps_nominal * dauer.sekunden) + 1
    gemeinsam = {"quelle": dauer.herkunft, "dauer_extern_s": round(dauer.sekunden, 4),
                 "hoechstens": grenze, "ausgabebilder_im_fenster": ausgabebilder}
    if bilder_extern is None:
        if grenzen_aus_dauer:
            return {**gemeinsam, "haelt": None, "gezaehlt": None,
                    "hinweis": "tautologisch: die Fenstergrenzen stammen aus "
                               "genau dieser Dauer, die Ausgabebilder koennen "
                               "die Grenze deshalb nie ueberschreiten. Ohne eine "
                               "unabhaengig gezaehlte Bildzahl ist die Schranke "
                               "ungeprueft, nicht bestanden."}
        return {**gemeinsam, "gezaehlt": ausgabebilder,
                "gezaehlt_quelle": "Ausgabebilder des Fensters (Grenzen unabhaengig "
                                   "von der Dauer gesetzt)",
                "haelt": bool(ausgabebilder <= grenze)}
    return {**gemeinsam, "gezaehlt": bilder_extern,
            "gezaehlt_quelle": "unabhaengig gezaehlte Bilder (z.B. timestamps.json)",
            "haelt": bool(bilder_extern <= grenze)}


def pruefe_strecke(gemessen_px: float, soll_px: float | None, soll_herkunft: str | None,
                   k: Knobs = KNOBS) -> dict[str, object]:
    """Die Summe der gemessenen Einzelversaetze muss die unabhaengig bekannte
    Strecke treffen.

    Der Sollwert kommt aus `motion-windows.json` (Scrollweite des Elements)
    oder aus einer `--windows`-Datei, nie aus dieser Messung. Ein Fenster,
    das die Strecke verfehlt, gibt KEIN Glaette-Urteil ab: der gescheiterte
    Schaetzer dieses Projekts haette hier 24 statt 135 px geliefert und
    waere durchgefallen, ohne dass irgendein Zaehler in der Aufnahmekette
    etwas gemerkt haette.
    """
    if soll_px is None or soll_px <= 0:
        return {"soll_px": None, "haelt": None, "gemessen_px": round(gemessen_px, 1),
                "hinweis": "kein Sollwert bekannt -- nicht geprueft, nicht bestanden"}
    abw = abs(abs(gemessen_px) - soll_px) / soll_px
    return {"gemessen_px": round(abs(gemessen_px), 1), "soll_px": round(soll_px, 1),
            "soll_herkunft": soll_herkunft, "abweichung": round(abw, 3),
            "toleranz": k.path_tol, "haelt": bool(abw <= k.path_tol)}
