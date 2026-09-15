"""Das Urteil je Fenster und der Gesamtbericht.

Drei Regeln bestimmen diese Datei:

1. VERWEIGERN STATT BENOTEN. Ein Fenster, dessen aeussere Schranke reisst
   ODER NICHT GEPRUEFT WERDEN KONNTE, oder das zu wenige gueltige Bildpaare
   hat, bekommt "NICHT MESSBAR" mit Grund und KEIN Glaette-Urteil. "Nicht
   geprueft" ist nie "bestanden" -- die erste Fassung hat das nur fuer die
   gerissene Schranke durchgesetzt und Sortier-Fenster, in denen sich nichts
   bewegt, mit einem Haker benotet (Ticket 28). Ein Lauf ganz ohne auswertbares
   Fenster sagt ausdruecklich, dass das kein gutes Zeugnis ist.
2. JEDE QUOTE NENNT IHREN NENNER, je Fenster und in der Zusammenfassung.
   Erzwungen ueber den Typ `Quote` in hitches.py, nicht ueber Disziplin.
3. SCHWERE, NICHT NUR ANZAHL. Die Zahl der Haker allein sortiert einen
   Teleport ueber die ganze Strecke besser ein als zwei kleine Nachholer
   (Ticket 29). Jedes Urteil nennt deshalb den groessten Sprung, gemessen am
   GLEICHSCHRITT: Sollstrecke durch Bildpaare des Fensters. Beide Groessen
   kommen von aussen (motion-windows.json), nicht aus dieser Messung.

Links und rechts werden getrennt ausgewiesen und nie gemittelt: der Owner
berichtet Haker in beiden Richtungen, und ein Mittelwert haette sie
gegeneinander aufgehoben.
"""

from __future__ import annotations

from collections import Counter

import numpy as np

from .bounds import pruefe_60hz, pruefe_strecke
from .hitches import Quote, finde_haker
from .knobs import KNOBS, Knobs
from .pairs import STATUS_ALLE, STATUS_GUELTIG, Pair
from .windows import QUELLE_EIGENE, Fenster

__all__ = ["NICHT_MESSBAR", "als_text", "beurteile_fenster", "fasse_zusammen",
           "vergleiche_laeufe"]

NICHT_MESSBAR = "NICHT MESSBAR"

MIN_GUELTIGE_BILDPAARE = 3
"""Unter drei gueltigen Bildpaaren traegt kein Median und kein oertliches
Tempo. Kein Urteil ist dann die ehrliche Antwort."""

RICHTUNGEN = ("rechts", "links", "runter", "hoch")


def _verweigert(res: dict[str, object], code: str, grund: str) -> dict[str, object]:
    return {**res, "urteil": NICHT_MESSBAR, "grund_code": code, "grund": grund}


def beurteile_fenster(pairs: list[Pair], fenster: Fenster, fps: float,
                      k: Knobs = KNOBS) -> dict[str, object]:
    """Urteil ueber ein Fenster. Siehe Modul-Docstring fuer die drei Regeln."""
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
    # Translation heisst: mindestens ein gueltiges Bildpaar bewegt sich ueber
    # die Rauschgrenze hinaus. Eine Richtung aus einer Messung abzuleiten, die
    # identisch null ist, hiesse sie zu erfinden (Ticket 28).
    translation = bool(len(komp)) and bool(np.any(np.abs(komp) >= k.still_px))
    if fenster.richtung is not None:
        richtung, richtung_herkunft = fenster.richtung, "Fenstername"
    elif translation:
        richtung = {"x": ("rechts", "links"), "y": ("runter", "hoch")}[achse][
            0 if gerichtete_summe >= 0 else 1]
        richtung_herkunft = "aus der Messung abgeleitet"
    else:
        richtung, richtung_herkunft = None, "keine -- im Fenster wurde keine Translation gemessen"

    res: dict[str, object] = {
        "fenster": fenster.name,
        "fenster_quelle": fenster.quelle,
        "achse": achse,
        "richtung": richtung,
        "richtung_herkunft": richtung_herkunft,
        "translation_gemessen": translation,
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
            "ungeprueft, und ohne sie gibt es kein Urteil.")

    res["schranke_60hz"] = pruefe_60hz(n_pairs + 1, fenster.dauer,
                                      fenster.bilder_extern,
                                      fenster.grenzen_aus_dauer, k)
    res["schranke_strecke"] = pruefe_strecke(gerichtete_summe, fenster.soll_px,
                                             fenster.soll_herkunft, k)

    ohne_bewegung = "" if translation else " -- im Fenster wurde keine Translation gemessen"
    if res["schranke_strecke"]["haelt"] is False:
        return _verweigert(res, "strecke_verfehlt", "Strecke verfehlt" + ohne_bewegung)
    if res["schranke_strecke"]["haelt"] is None:
        return _verweigert(res, "strecke_ungeprueft",
                           "Streckenschranke ungeprueft (kein Sollwert)" + ohne_bewegung)
    if res["schranke_60hz"]["haelt"] is False:
        return _verweigert(res, "60hz_verletzt", "60-Hz-Schranke verletzt")
    if res["schranke_60hz"]["haelt"] is None:
        return _verweigert(res, "60hz_ungeprueft", "60-Hz-Schranke ungeprueft")
    if n_ok < MIN_GUELTIGE_BILDPAARE:
        return _verweigert(res, "zu_wenig_gueltig",
                           f"nur {n_ok} gueltige Bildpaare von {n_pairs}")

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

    # Die Streckenschranke haelt hier, also ist soll_px bekannt und positiv.
    soll = float(fenster.soll_px or 0.0)
    gleichschritt = soll / n_pairs
    groesster = float(schritte.max())
    for s in befund.stoerstellen:
        s["gleichschritte"] = round(s["groesster_schritt_px"] / gleichschritt, 2)
    teleport = groesster / soll >= k.teleport_anteil
    res["schwere"] = {
        "gleichschritt_px": round(gleichschritt, 3),
        "gleichschritt_herkunft": "Sollstrecke / Bildpaare im Fenster (beides von aussen)",
        "groesster_sprung_px": round(groesster, 3),
        "groesster_sprung_gleichschritte": round(groesster / gleichschritt, 2),
        "groesster_sprung_anteil_strecke": round(groesster / soll, 3),
        "teleport": bool(teleport),
        "teleport_ab_anteil": k.teleport_anteil,
    }

    res["stoerstellen"] = befund.stoerstellen
    res["stoerstellen_anzahl"] = len(befund.stoerstellen)
    res["haker_ereignisse"] = befund.ereignisse
    res["haker"] = Quote(len(befund.ereignisse), befund.reisestrecke_bildpaare,
                         "Bildpaare der Reisestrecke (ohne Anlauf/Auslauf)").als_dict()
    res["mikro_aussetzer"] = befund.mikro.als_dict()
    res["stillstands_histogramm"] = befund.stillstands_histogramm
    res["reisestrecke_bildpaare"] = befund.reisestrecke_bildpaare

    mq = befund.mikro.quote or 0.0
    if teleport:
        res["urteil"] = (f"Teleport: {groesster / soll * 100:.0f} % der Strecke in einem Bild "
                         f"({groesster / gleichschritt:.1f} Gleichschritte)")
    elif befund.stoerstellen:
        zusatz = (f" ({len(befund.ereignisse)} Einzelereignisse)"
                  if len(befund.ereignisse) != len(befund.stoerstellen) else "")
        schwerste = max(befund.stoerstellen,
                        key=lambda s: (s["gleichschritte"], s["stillstand_ms"]))
        res["urteil"] = (f"{len(befund.stoerstellen)} Haker{zusatz}; schwerste Stelle: "
                         f"Sprung {schwerste['gleichschritte']:.1f} Gleichschritte, "
                         f"Stillstand {schwerste['stillstand_ms']:.0f} ms")
    elif mq > k.mikro_quote_max:
        res["urteil"] = f"unruhig ({befund.mikro.zaehler} Mikro-Aussetzer, {mq * 100:.1f} %)"
    else:
        res["urteil"] = "glatt"
    return res


def _schwerstes(urteile: list[dict]) -> dict[str, object] | None:
    if not urteile:
        return None
    w = max(urteile, key=lambda u: u["schwere"]["groesster_sprung_gleichschritte"])
    return {"fenster": w["fenster"],
            "gleichschritte": w["schwere"]["groesster_sprung_gleichschritte"],
            "anteil_strecke": w["schwere"]["groesster_sprung_anteil_strecke"],
            "urteil": w["urteil"]}


def fasse_zusammen(urteile: list[dict]) -> dict[str, object]:
    """Der Lauf in einem Blick -- mit Nenner, und je Richtung getrennt.

    Gezaehlt werden nur BEURTEILTE Fenster; wie viele zurueckgehalten wurden
    und warum, steht daneben. Eine Haker-Summe ohne diese Zahl liest sich wie
    ein Urteil ueber den ganzen Lauf, obwohl sie womoeglich nur einen Bruchteil
    davon abdeckt.
    """
    beurteilt = [u for u in urteile if u["urteil"] != NICHT_MESSBAR]
    zurueck = Counter(str(u["grund_code"]) for u in urteile if u["urteil"] == NICHT_MESSBAR)

    je_richtung: dict[str, object] = {}
    for r in (*RICHTUNGEN, None):
        alle = [u for u in urteile if u["richtung"] == r]
        if not alle:
            continue
        drin = [u for u in alle if u["urteil"] != NICHT_MESSBAR]
        je_richtung[r if r is not None else "ohne Richtung"] = {
            "beurteilt": Quote(len(drin), len(alle), "Fenster dieser Richtung").als_dict(),
            "haker": sum(int(u["stoerstellen_anzahl"]) for u in drin),
            "teleporte": sum(1 for u in drin if u["schwere"]["teleport"]),
            "schwerstes_fenster": _schwerstes(drin),
        }

    return {
        "beurteilt": Quote(len(beurteilt), len(urteile), "Fenster des Laufs").als_dict(),
        "zurueckgehalten": dict(sorted(zurueck.items())),
        "haker": sum(int(u["stoerstellen_anzahl"]) for u in beurteilt),
        "haker_bedeutung": "Stoerstellen in den beurteilten Fenstern",
        "teleporte": [u["fenster"] for u in beurteilt if u["schwere"]["teleport"]],
        "schwerstes_fenster": _schwerstes(beurteilt),
        "je_richtung": je_richtung,
    }


def vergleiche_laeufe(berichte: dict[str, dict]) -> dict[str, object]:
    """Ordnet Laeufe desselben Aufnahmeskripts von glatt nach hakelig.

    Verglichen wird nur ueber Fenster, die in JEDEM Lauf beurteilt wurden --
    sonst gewinnt der Lauf, dessen schlimmstes Fenster zufaellig verweigert
    wurde. Massstab je Lauf ist der groesste Sprung in Gleichschritten ueber
    diese gemeinsamen Fenster: die Schwere der schlimmsten Stelle, nicht die
    Zahl der Stellen (Ticket 29).
    """
    urteile = {name: {u["fenster"]: u for u in b["fenster"]} for name, b in berichte.items()}
    alle_namen = set().union(*(set(u) for u in urteile.values())) if urteile else set()
    gemeinsam = sorted(
        n for n in alle_namen
        if all(n in u and u[n]["urteil"] != NICHT_MESSBAR for u in urteile.values()))

    rang = []
    for name, u in urteile.items():
        drin = [u[n] for n in gemeinsam]
        s = _schwerstes(drin)
        rang.append({"lauf": name,
                     "groesster_sprung_gleichschritte": s["gleichschritte"] if s else None,
                     "schwerstes_fenster": s["fenster"] if s else None,
                     "haker": sum(int(w["stoerstellen_anzahl"]) for w in drin),
                     "teleporte": sum(1 for w in drin if w["schwere"]["teleport"])})
    rang.sort(key=lambda r: (r["groesster_sprung_gleichschritte"] is None,
                             r["groesster_sprung_gleichschritte"] or 0.0))
    return {
        "gemeinsam_beurteilt": Quote(len(gemeinsam), len(alle_namen),
                                     "Fenster, die in allen Laeufen beurteilt wurden").als_dict(),
        "fenster": gemeinsam,
        "reihenfolge_glatt_nach_hakelig": rang,
    }


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

    zf = bericht["zusammenfassung"]
    b = zf["beurteilt"]
    z.append("")
    z.append(f"ZUSAMMENFASSUNG: beurteilt {b['anzahl']}/{b['von']} {b['nenner_bedeutung']}, "
             f"zurueckgehalten {zf['zurueckgehalten']}")
    if b["anzahl"] == 0:
        z.append("!! KEIN Fenster war messbar -- das ist KEIN gutes Zeugnis, "
                 "sondern eine Verweigerung. Gruende siehe unten.")
    else:
        z.append(f"   {zf['haker']} {zf['haker_bedeutung']}; "
                 f"Teleporte: {zf['teleporte'] or 'keine'}")
        sw = zf["schwerstes_fenster"]
        z.append(f"   schwerstes Fenster: {sw['fenster']} -- groesster Sprung "
                 f"{sw['gleichschritte']} Gleichschritte ({sw['anteil_strecke'] * 100:.0f} % "
                 f"der Strecke)")
        for r, jr in zf["je_richtung"].items():
            q = jr["beurteilt"]
            sw = jr["schwerstes_fenster"]
            schwer = f", groesster Sprung {sw['gleichschritte']} Gleichschritte" if sw else ""
            z.append(f"   {r}: beurteilt {q['anzahl']}/{q['von']}, {jr['haker']} Haker, "
                     f"{jr['teleporte']} Teleporte{schwer}")

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
        if w["urteil"] == NICHT_MESSBAR:
            z.append(f"   URTEIL: {NICHT_MESSBAR} ({w['grund']})")
            continue
        sp = w["schritt_px"]
        z.append(f"   Schritt je Bild ({sp['einheit']}): Median {sp['median']}, "
                 f"p10 {sp['p10']}, p90 {sp['p90']}, "
                 f"groesster Einzelsprung {sp['groesster_einzelsprung']}")
        sv = w["schwere"]
        z.append(f"   Schwere: Gleichschritt {sv['gleichschritt_px']} px "
                 f"({sv['gleichschritt_herkunft']}); groesster Sprung "
                 f"{sv['groesster_sprung_gleichschritte']} Gleichschritte = "
                 f"{sv['groesster_sprung_anteil_strecke'] * 100:.1f} % der Strecke")
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
