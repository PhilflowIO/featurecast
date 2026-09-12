"""Jede Stellschraube dieses Werkzeugs, genau einmal, an genau dieser Stelle.

Warum eine eigene Datei: verstreute Zahlen sind nicht diskutierbar. Wer die
Haker-Schwelle fuer falsch haelt, soll genau einen Ort aendern muessen und
genau einen Ort lesen muessen. `smoothness --erklaere-schwelle` druckt den
Inhalt dieser Datei vollstaendig aus, mit Begruendung je Wert.

KEINE dieser Zahlen ist gegen das Auge des Owners geeicht. Eine solche
Eichreihe ("ab hier nennt er es hakelig") hat es in diesem Projekt nie
gegeben. Die Werte sind aus 60-Hz-Physik und aus dem Material begruendet.
Siehe docs/SMOOTHNESS.md, Abschnitt "Grenzen".
"""

from __future__ import annotations

import ast
from dataclasses import asdict, dataclass, fields
from pathlib import Path

__all__ = ["KNOBS", "Knobs", "erklaere"]


@dataclass(frozen=True)
class Knobs:
    """Die Stellschrauben. Reihenfolge = Reihenfolge der Wirkung im Lauf."""

    # --- Gueltigkeit einer Einzelmessung ---------------------------------
    amb_ratio: float = 0.55
    """Verhaeltnis bestes Nebenmaximum zu Gipfel der Phasenkorrelation.
    Darueber gilt der Versatz als mehrdeutig und wird verweigert. Das ist
    das Tor gegen die Verhakung am Spaltenraster (111 px), an der der erste
    Schaetzer dieses Projekts gestorben ist."""

    agree_px: float = 0.60
    """Zulaessiger Abstand zwischen Phasenkorrelation und Lucas-Kanade, in
    Pixeln des gemessenen Ausschnitts. Darueber entscheidet der
    Schiedsrichter am Bild, nicht der groessere Korrelationsgipfel."""

    residual_max: float = 0.50
    """Schiedsspruch: das Zurueckschieben um den behaupteten Versatz muss
    den Restunterschied dort, wo sich etwas geaendert hat, mindestens
    halbieren. Sonst erklaert kein Vorschlag die Aenderung und beide
    werden verworfen."""

    # --- Wiederholte Bilder ---------------------------------------------
    dup_mad: float = 0.05
    """Mittlere absolute Pixeldifferenz, unter der zwei aufeinanderfolgende
    Bilder als dasselbe Bild gelten. Schaetzer-unabhaengig gemessen, damit
    die Wiederholungsquote nicht vom Verfahren abhaengt, das sie erklaeren
    soll."""

    # --- Bewegungsfenster (nur fuer die eigene Zerlegung) ----------------
    still_px: float = 0.25
    """Darunter gilt ein Bildpaar als stehend. Ein Viertelpixel liegt
    ueber dem Sub-Pixel-Fehler des Verfahrens (gemessen 0,085 px im
    Eichfall c3) und weit unter jedem echten Reisetempo, trennt also
    Messrauschen von Bewegung, ohne eine langsame Bewegung zu verschlucken."""

    min_window_frames: int = 8
    """Kuerzere Bewegungslaeufe sind kein Fenster. Unter acht Bildpaaren
    traegt kein Median und kein oertliches Tempo."""

    gap_frames: int = 4
    """So viele stehende Bildpaare ueberbrueckt ein Fenster, ohne zu enden.
    Vier Bilder sind 67 ms: kurz genug, dass eine haengende Aufnahme das
    Fenster nicht zerreisst, lang genug, dass eine echte Pause zwischen zwei
    Scrollbewegungen zwei Fenster bleibt und nicht zu einem verschmilzt."""

    # --- Definition "Haker" ----------------------------------------------
    stall_frac: float = 0.25
    """Ein Bildpaar unter diesem Anteil des oertlichen Tempos gilt als
    Stillstand."""

    stall_min_frames: int = 2
    """So viele Stillstands-Bildpaare hintereinander sind sichtbar:
    2/60 s = 33 ms, die gebraeuchliche Sichtbarkeitsgrenze fuer Aussetzer
    bei 60 Hz. Literaturwert, hier nicht nachgemessen."""

    jump_factor: float = 2.00
    """Ein Einzelschritt ueber diesem Vielfachen des oertlichen Tempos ist
    ein Nachholsprung: das Bild ueberspringt mehr als die Strecke zweier
    Bilder, also fehlt mindestens ein Bild."""

    mikro_quote_max: float = 0.02
    """Ein-Bild-Aussetzer sind einzeln unsichtbar, in Menge nicht. Ueber
    diesem Anteil der Reisestrecke lautet das Urteil "unruhig"."""

    cruise_frac: float = 0.50
    """Anlauf und Auslauf gehoeren nicht zur Reisestrecke: Bildpaare unter
    diesem Anteil des Fenster-Tempos am Anfang und Ende sind Rampe."""

    local_halfwin: int = 3
    """Nachbarn je Seite, aus denen das oertliche Tempo gebildet wird (das
    Bild selbst ausgenommen). Das Produkt scrollt mit Anlauf- und
    Bremskurve; ein fester Fenster-Massstab zaehlte jede Beschleunigung als
    Sprung -- erste Fassung: 33 Haker in einem 47-Bild-Fenster."""

    merge_gap: int = 4
    """Haker, die naeher als so viele Bildpaare beieinander liegen, sind
    EINE Stoerstelle. Das Auge trennt zwei Stolperer 50 ms auseinander
    nicht. Offenlegung zur Reihenfolge: dieser Wert wurde NACH dem ersten
    Lauf am echten Material eingefuehrt, weil dort fuenf bis sechs
    Einzelereignisse in 0,3 s auftraten. Begruendet ist er mit der
    Fusionsgrenze der Wahrnehmung, nicht mit dem Ergebnis."""

    # --- Aeussere Schranken ----------------------------------------------
    path_tol: float = 0.10
    """Zulaessige Abweichung der gemessenen Gesamtstrecke von der
    unabhaengig bekannten Strecke. Ein Fenster, das sie reisst, gibt KEIN
    Glaette-Urteil ab."""

    fps_nominal: float = 60.0
    """Bildwiederholrate, gegen die die Anzahl Bilder in einem Fenster
    geschrankt wird. In einem Fenster von d Sekunden koennen hoechstens
    60*d+1 Bilder stecken."""


KNOBS = Knobs()


def _begruendungen() -> dict[str, str]:
    """Liest die Docstrings, die unter jedem Knobs-Feld stehen.

    Warum geparst statt von Hand gepflegt: eine zweite Liste "Name ->
    Begruendung" waere eine zweite Wahrheit, die sofort driftet. So steht
    Wert und Begruendung an genau EINER Stelle, und eine neue Stellschraube
    ohne Begruendung faellt in `erklaere` als leerer Text auf.
    """
    quelle = Path(__file__).read_text(encoding="utf-8")
    klasse = next(
        k
        for k in ast.parse(quelle).body
        if isinstance(k, ast.ClassDef) and k.name == "Knobs"
    )
    docs: dict[str, str] = {}
    letztes: str | None = None
    for knoten in klasse.body:
        if isinstance(knoten, ast.AnnAssign) and isinstance(knoten.target, ast.Name):
            letztes = knoten.target.id
        elif (
            isinstance(knoten, ast.Expr)
            and isinstance(knoten.value, ast.Constant)
            and isinstance(knoten.value.value, str)
            and letztes is not None
        ):
            docs[letztes] = " ".join(knoten.value.value.split())
            letztes = None
    return docs


def erklaere(knobs: Knobs = KNOBS) -> list[dict[str, object]]:
    """Jede Stellschraube mit Wert und Begruendung, maschinenlesbar.

    Die Liste wird aus den Feldern der Dataclass erzeugt, nicht von Hand
    gepflegt -- sie ist damit per Konstruktion vollstaendig.
    """
    werte = asdict(knobs)
    docs = _begruendungen()
    return [
        {"name": f.name, "wert": werte[f.name], "begruendung": docs.get(f.name, "")}
        for f in fields(knobs)
    ]
