"""Das Urteil je Fenster und der Gesamtbericht.

Zwei Regeln bestimmen diese Datei:

1. VERWEIGERN STATT BENOTEN. Ein Fenster, das eine aeussere Schranke reisst
   oder zu wenige gueltige Bildpaare hat, bekommt "NICHT MESSBAR" mit Grund
   und KEIN Glaette-Urteil. Ein Lauf ganz ohne auswertbares Fenster sagt
   ausdruecklich, dass das kein gutes Zeugnis ist.
2. JEDE QUOTE NENNT IHREN NENNER, je Fenster, in der Ausgabe. Erzwungen
   ueber den Typ `Quote` in hitches.py, nicht ueber Disziplin.

Links und rechts werden getrennt ausgewiesen und nie gemittelt: der Owner
berichtet Haker in beiden Richtungen, und ein Mittelwert haette sie
gegeneinander aufgehoben.
"""

from __future__ import annotations

import numpy as np

from .bounds import pruefe_60hz, pruefe_strecke
from .hitches import Quote, finde_haker
from .knobs import KNOBS, Knobs
from .pairs import STATUS_ALLE, STATUS_GUELTIG, Pair
from .windows import QUELLE_EIGENE, Fenster

__all__ = ["als_text", "beurteile_fenster"]

MIN_GUELTIGE_BILDPAARE = 3
"""Unter drei gueltigen Bildpaaren traegt kein Median und kein oertliches
Tempo. Kein Urteil ist dann die ehrliche Antwort."""


def beurteile_fenster(pairs: list[Pair], fenster: Fenster, fps: float,
                      k: Knobs = KNOBS) -> dict[str, object]:
    """Urteil ueber ein Fenster. Siehe Modul-Docstring fuer die zwei Regeln."""
    seg = [p for p in pairs if fenster.von_bildpaar <= p.i <= fenster.bis_bildpaar]
    n_pairs = len(seg)
    gueltig = [p for p in seg if p.status in STATUS_GUELTIG]
    n_ok = len(gueltig)
    verworfen = {s: sum(1 for p in seg if p.status == s)
                 for s in STATUS_ALLE if s not in STATUS_GUELTIG}

    achse = "x"
    if gueltig and sum(abs(p.dy) for p in gueltig) > sum(abs(p.dx) for p in gueltig):
        achse = "y"
    komp = np.array([(p.dx if achse == "x" else p.dy) for p in gueltig], dtype=float)
    gerichtete_summe = float(komp.sum()) if len(komp) else 0.0
    if fenster.richtung is not None:
        richtung, richtung_herkunft = fenster.richtung, "Fenstername"
    else:
        richtung = {"x": ("rechts", "links"), "y": ("runter", "hoch")}[achse][
            0 if gerichtete_summe >= 0 else 1]
        richtung_herkunft = "aus der Messung abgeleitet"

    res: dict[str, object] = {
        "fenster": fenster.name,
        "fenster_quelle": fenster.quelle,
        "achse": achse,
        "richtung": richtung,
        "richtung_herkunft": richtung_herkunft,
        "von_bildpaar": fenster.von_bildpaar,
        "bis_bildpaar": fenster.bis_bildpaar,
        "bildpaare": n_pairs,
        "messbarkeit": Quote(n_ok, n_pairs, "Bildpaare im Fenster").als_dict(),
        "verworfen": verworfen,
    }
    if fenster.quelle == QUELLE_EIGENE:
        res["hinweis_fenster"] = (
            "Fenstergrenzen stammen aus der Messung selbst, nicht aus "
            "motion-windows.json -- beide aeusseren Schranken bleiben damit "
            "ungeprueft.")

    res["schranke_60hz"] = pruefe_60hz(n_pairs + 1, fenster.dauer,
                                      fenster.bilder_extern,
                                      fenster.grenzen_aus_dauer, k)
    res["schranke_strecke"] = pruefe_strecke(gerichtete_summe, fenster.soll_px,
                                             fenster.soll_herkunft, k)

    if res["schranke_strecke"]["haelt"] is False:
        return {**res, "urteil": "NICHT MESSBAR", "grund": "Strecke verfehlt"}
    if res["schranke_60hz"]["haelt"] is False:
        return {**res, "urteil": "NICHT MESSBAR", "grund": "60-Hz-Schranke verletzt"}
    if n_ok < MIN_GUELTIGE_BILDPAARE:
        return {**res, "urteil": "NICHT MESSBAR",
                "grund": f"nur {n_ok} gueltige Bildpaare von {n_pairs}"}

    schritte = np.abs(komp)
    res["schritt_px"] = {
        "median": round(float(np.median(schritte)), 3),
        "p10": round(float(np.percentile(schritte, 10)), 3),
        "p90": round(float(np.percentile(schritte, 90)), 3),
        "groesster_einzelsprung": round(float(schritte.max()), 3),
        "summe_gerichtet": round(gerichtete_summe, 1),
        "einheit": "Pixel des gemessenen Ausschnitts",
    }
    # Eigener, schaetzer-unabhaengiger Nenner: gezaehlt wird ueber die rohe
    # Pixeldifferenz, nicht ueber den Versatz.
    res["wiederholte_bilder"] = Quote(sum(1 for p in seg if p.dup), n_pairs,
                                      "Bildpaare im Fenster").als_dict()

    befund = finde_haker(schritte, fenster.von_bildpaar, fps, k)
    res["stoerstellen"] = befund.stoerstellen
    res["stoerstellen_anzahl"] = len(befund.stoerstellen)
    res["haker_ereignisse"] = befund.ereignisse
    res["haker"] = Quote(len(befund.ereignisse), befund.reisestrecke_bildpaare,
                         "Bildpaare der Reisestrecke (ohne Anlauf/Auslauf)").als_dict()
    res["mikro_aussetzer"] = befund.mikro.als_dict()
    res["stillstands_histogramm"] = befund.stillstands_histogramm
    res["reisestrecke_bildpaare"] = befund.reisestrecke_bildpaare

    mq = befund.mikro.quote or 0.0
    if befund.stoerstellen:
        zusatz = (f" ({len(befund.ereignisse)} Einzelereignisse)"
                  if len(befund.ereignisse) != len(befund.stoerstellen) else "")
        res["urteil"] = f"{len(befund.stoerstellen)} Haker{zusatz}"
    elif mq > k.mikro_quote_max:
        res["urteil"] = f"unruhig ({befund.mikro.zaehler} Mikro-Aussetzer, {mq * 100:.1f} %)"
    else:
        res["urteil"] = "glatt"
    return res


def als_text(bericht: dict) -> str:
    """Derselbe Bericht fuer Menschen. Enthaelt nichts, was im JSON fehlt."""
    z: list[str] = []
    z.append(f"{bericht['video']}  Ausschnitt {bericht['ausschnitt']}  "
             f"{bericht['bilder']} Bilder, {bericht['fps']} fps")
    s = bericht["skalierung"]
    z.append(f"Massstab: {s['faktor']:.4f} Ausschnittspixel je Aufnahmepixel "
             f"({s['herkunft']})")
    z.append(f"Fensterquelle: {bericht['fenster_quelle']}")
    mb = bericht["messbarkeit"]
    z.append(f"Messbarkeit gesamt: {mb['anzahl']}/{mb['von']} {mb['nenner_bedeutung']} "
             f"-- verworfen {bericht['verworfen']}")
    rw = bericht["richtungswechsel"]
    z.append(f"Richtungswechsel: {rw['anzahl']}/{rw['von_bewegten_bildpaaren']} "
             f"{rw['nenner_bedeutung']} = "
             f"{(rw['quote'] or 0) * 100:.1f} %")

    if not bericht["fenster"]:
        z.append("")
        z.append("!! KEIN auswertbares Bewegungsfenster gefunden -- das ist KEIN "
                 "gutes Zeugnis, sondern eine Verweigerung.")
        return "\n".join(z)

    messbar = [w for w in bericht["fenster"] if w["urteil"] != "NICHT MESSBAR"]
    if not messbar:
        z.append("")
        z.append("!! KEIN Fenster war messbar -- das ist KEIN gutes Zeugnis, "
                 "sondern eine Verweigerung. Gruende siehe unten.")

    for w in bericht["fenster"]:
        z.append("")
        z.append(f"-- Fenster {w['fenster']} [{w['von_bildpaar']}..{w['bis_bildpaar']}]  "
                 f"Richtung {w['richtung']} ({w['richtung_herkunft']})  "
                 f"Quelle {w['fenster_quelle']}")
        m = w["messbarkeit"]
        z.append(f"   gueltig {m['anzahl']}/{m['von']} {m['nenner_bedeutung']}, "
                 f"verworfen {w['verworfen']}")
        z.append(f"   60-Hz-Schranke:   {w['schranke_60hz']}")
        z.append(f"   Streckenabgleich: {w['schranke_strecke']}")
        if w["urteil"] == "NICHT MESSBAR":
            z.append(f"   URTEIL: NICHT MESSBAR ({w['grund']})")
            continue
        sp = w["schritt_px"]
        z.append(f"   Schritt je Bild ({sp['einheit']}): Median {sp['median']}, "
                 f"p10 {sp['p10']}, p90 {sp['p90']}, "
                 f"groesster Einzelsprung {sp['groesster_einzelsprung']}")
        d = w["wiederholte_bilder"]
        z.append(f"   Wiederholte Bilder: {d['anzahl']}/{d['von']} {d['nenner_bedeutung']} "
                 f"= {(d['quote'] or 0) * 100:.1f} %")
        mi = w["mikro_aussetzer"]
        z.append(f"   Mikro-Aussetzer (1 Bild): {mi['anzahl']}/{mi['von']} "
                 f"{mi['nenner_bedeutung']}   Stillstands-Laeufe "
                 f"{w['stillstands_histogramm']}")
        z.append(f"   URTEIL: {w['urteil']}")
        for e in w["haker_ereignisse"]:
            z.append(f"      * {e}")
    return "\n".join(z)
