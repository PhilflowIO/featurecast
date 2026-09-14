"""Fenster aus der Wahrheit des Produkts -- und der Rueckfall, der sich als
solcher zu erkennen gibt.

Warum diese Datei existiert: ein Urteil gilt immer nur fuer den Abschnitt,
ueber den geurteilt wurde. Wer die Grenzen aus der Messung selbst ableitet,
laesst das Messgeraet sich seinen Pruefling aussuchen. Im Prototyp war das
unvermeidlich (der Rechner mit den Laufdaten war nicht erreichbar); hier ist
es der ausdruecklich gekennzeichnete Rueckfall.

FIXTURE-HERKUNFT: `motion-windows.json` und `timestamps.json` sind hier von
Hand gebaut, aber NICHT frei erfunden -- sie haben genau die Form, die
demo/m1-capture.ts schreibt: `windows[]` aus `computeMotionWindowCadence`
(src/cadence.ts) mit `label`, `start`, `end`, `durationSeconds`, `target`
und -- seit #31 -- `travelPx`/`scrollStartPx`/`scrollEndPx`,
und ein `TimestampManifest` (src/capture.ts) mit `session.startedAt` und
`frames[].timestamp` in Millisekunden der `Date.now()`-Zeitachse. Ein echter
Lauf kann diese Fixture ersetzen, sobald der Aufnahmerechner wieder
erreichbar ist.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from smoothness.pairs import Pair
from smoothness.windows import (
    QUELLE_EIGENE,
    QUELLE_PRODUKT,
    aus_lauf,
    eigene_zerlegung,
)

STARTED_AT = 1_000_000.0
ERSTES_BILD = STARTED_AT + 50.0
"""50 ms Anlauf, bevor das erste Bild eintrifft -- realistisch (nichts ist
malbar, bevor die Seite steht) und gross genug, dass die beiden moeglichen
Zeitanker drei Bilder auseinanderliegen. Genau daran haengt dieser Test."""


@pytest.fixture
def lauf(tmp_path: Path) -> Path:
    frames = [{"file": f"frame-{i:05d}.jpg",
               "timestamp": ERSTES_BILD + i * (1000 / 60),
               "viewport": {"height": 1600, "width": 2560}}
              for i in range(120)]
    (tmp_path / "timestamps.json").write_text(json.dumps({
        "captureSize": {"height": 1600, "width": 2560},
        "frames": frames,
        "session": {"duration": 2000, "endedAt": STARTED_AT + 2000,
                    "startedAt": STARTED_AT},
        "version": 1}), encoding="utf-8")
    (tmp_path / "motion-windows.json").write_text(json.dumps({
        "windows": [
            {"label": "tasks:scroll-right:1", "start": STARTED_AT + 100,
             "end": STARTED_AT + 600, "durationSeconds": 0.5,
             "target": "div.MuiDataGrid-virtualScroller (x range 180px)"},
            {"label": "tasks:scroll-left:1", "start": STARTED_AT + 800,
             "end": STARTED_AT + 1300, "durationSeconds": 0.5,
             "target": "div.MuiDataGrid-virtualScroller (x range 180px)"},
        ]}), encoding="utf-8")
    return tmp_path


def test_fenstergrenzen_haengen_am_aufnahmestart_nicht_am_ersten_bild(lauf):
    """src/assemble.ts verankert die Videozeit an
    `min(session.startedAt, frames[0].timestamp)`, weil die Luecke bis zum
    ersten Bild dessen Standzeit zugeschlagen wird. Wer stattdessen
    `frames[0].timestamp` nimmt, verschiebt jede Fenstergrenze um diese
    Luecke -- bei 50 ms sind das drei Bilder bei 60 Hz.

    Der Test pruefen BEIDE Rechnungen und verlangt, dass sie verschieden
    sind. Waeren sie gleich, koennte er den Fehler nicht sehen und waere
    kein Beleg.
    """
    fenster = aus_lauf(lauf, fps=60.0, px_faktor=0.375, anzahl_bildpaare=119)
    rechts = fenster[0]
    assert rechts.von_bildpaar == 7 and rechts.bis_bildpaar == 36

    # Was herauskaeme, wenn der Anker `frames[0].timestamp` waere:
    t0_falsch = (100 - 50) / 1000
    falsch_von = int(-(-t0_falsch * 60 // 1)) + 1
    assert falsch_von == 4
    assert falsch_von != rechts.von_bildpaar, (
        "die beiden Anker liefern dasselbe Ergebnis -- dann prueft dieser "
        "Test nichts")


def test_sollstrecke_kommt_aus_dem_lauf_und_traegt_ihre_herkunft(lauf):
    fenster = aus_lauf(lauf, fps=60.0, px_faktor=0.375, anzahl_bildpaare=119)
    rechts = fenster[0]
    # 180 CSS-Pixel der Aufnahme x 0,375 = 67,5 Pixel eines 960 px breiten
    # Vergleichsfeldes. Das ist derselbe Sollwert, gegen den der Prototyp am
    # echten Material 67,0-67,4 px gemessen hat.
    assert rechts.soll_px == pytest.approx(67.5)
    assert "motion-windows.json" in str(rechts.soll_herkunft)
    assert "180" in str(rechts.soll_herkunft)
    assert rechts.dauer is not None
    assert rechts.dauer.sekunden == 0.5
    assert "durationSeconds" in rechts.dauer.herkunft


def test_richtungen_bleiben_getrennt(lauf):
    """Links und rechts werden nie zusammengefasst und nie gemittelt -- der
    Owner berichtet Haker in beiden Richtungen."""
    fenster = aus_lauf(lauf, fps=60.0, px_faktor=0.375, anzahl_bildpaare=119)
    assert [f.richtung for f in fenster] == ["rechts", "links"]
    assert len({f.name for f in fenster}) == 2
    assert all(f.quelle == QUELLE_PRODUKT for f in fenster)


def test_eigene_zerlegung_ist_als_rueckfall_gekennzeichnet():
    """Der Rueckfall darf nie wie die Wahrheit des Produkts aussehen: keine
    Sollstrecke, keine externe Dauer, und beides steht in der Ausgabe."""
    pairs = [Pair(i, 4.0, 0.0, "ok", 0.0, 9.0, False) for i in range(1, 21)]
    (fenster,) = eigene_zerlegung(pairs)
    assert fenster.quelle == QUELLE_EIGENE
    assert fenster.soll_px is None
    assert fenster.dauer is None

    from smoothness.report import beurteile_fenster
    urteil = beurteile_fenster(pairs, fenster, 60.0)
    assert urteil["fenster_quelle"] == QUELLE_EIGENE
    assert "nicht aus motion-windows.json" in str(urteil["hinweis_fenster"])
    assert urteil["schranke_strecke"]["haelt"] is None
    assert urteil["schranke_60hz"]["haelt"] is None


def _manifest(tmp_path: Path, bildabstand_ms: float, n: int = 200) -> None:
    (tmp_path / "timestamps.json").write_text(json.dumps({
        "captureSize": {"height": 1600, "width": 2560},
        "frames": [{"file": f"frame-{i:05d}.jpg",
                    "timestamp": ERSTES_BILD + i * bildabstand_ms,
                    "viewport": {"height": 1600, "width": 2560}} for i in range(n)],
        "session": {"duration": 2000, "endedAt": STARTED_AT + 2000,
                    "startedAt": STARTED_AT},
        "version": 1}), encoding="utf-8")


def test_60hz_schranke_nutzt_im_produktpfad_die_unabhaengige_bildzahl(lauf):
    """Der Befund, den der Prototyp nicht hatte.

    Werden die Fenstergrenzen aus der Fensterdauer abgeleitet -- genau das
    tut `aus_lauf` --, dann kann die Zahl der AUSGABEbilder im Fenster die
    Grenze 60*d+1 per Konstruktion nie ueberschreiten. Eine Schranke, die
    ueber diese Zahl urteilt, haelt immer: derselbe Zirkelschluss wie in
    `src/paint-rate.ts`.

    Gezaehlt werden deshalb die AUFNAHMEbilder aus `timestamps.json`. Die
    stammen aus einer anderen Messung als die Fenstergrenzen und koennen
    sehr wohl zu viele sein. Der Test zeigt beides: dass die Schranke im
    Normalfall haelt, und dass sie bei doppelter Lieferrate reisst.
    """
    from smoothness.bounds import pruefe_60hz

    fenster = aus_lauf(lauf, fps=60.0, px_faktor=0.375, anzahl_bildpaare=119)[0]
    assert fenster.grenzen_aus_dauer is True
    assert fenster.bilder_extern == 31        # 500 ms bei 60 Hz
    b = pruefe_60hz(fenster.bis_bildpaar - fenster.von_bildpaar + 2, fenster.dauer,
                    fenster.bilder_extern, fenster.grenzen_aus_dauer)
    assert b["hoechstens"] == 31 and b["haelt"] is True

    _manifest(lauf, bildabstand_ms=1000 / 120)     # doppelte Lieferrate
    zu_viele = aus_lauf(lauf, fps=60.0, px_faktor=0.375, anzahl_bildpaare=119)[0]
    assert zu_viele.bilder_extern == 61
    b2 = pruefe_60hz(zu_viele.bis_bildpaar - zu_viele.von_bildpaar + 2, zu_viele.dauer,
                     zu_viele.bilder_extern, zu_viele.grenzen_aus_dauer)
    assert b2["haelt"] is False, "die Schranke muss im Produktpfad reissen koennen"


def test_ohne_unabhaengige_bildzahl_meldet_die_schranke_tautologisch():
    """Fehlt die unabhaengige Bildzahl, ist "haelt" nicht True und nicht
    False, sondern None mit Grund. Ein stilles True waere die Luege."""
    from smoothness.bounds import Dauer, pruefe_60hz

    b = pruefe_60hz(21, Dauer(0.5, "Test"), bilder_extern=None, grenzen_aus_dauer=True)
    assert b["haelt"] is None
    assert "tautologisch" in str(b["hinweis"])


# --------------------------------------------------------------------------
# Gefahrene Strecke gegen volle Scrollweite (#31)
# --------------------------------------------------------------------------

def _lauf_mit(tmp_path: Path, fenster: list[dict]) -> Path:
    """Ein Lauf mit frei gewaehlten Fenstern, sonst wie `lauf`.

    FIXTURE-HERKUNFT: dieselbe Form, die demo/m1-capture.ts schreibt --
    `computeMotionWindowCadence` (src/cadence.ts) reicht `travelPx`,
    `scrollStartPx` und `scrollEndPx` aus dem Fenster durch, das
    `scrollContainerToEdge` (src/m1-benchmark.ts) gefuellt hat.
    """
    tmp_path.mkdir(parents=True, exist_ok=True)
    _manifest(tmp_path, bildabstand_ms=1000 / 60, n=200)
    (tmp_path / "motion-windows.json").write_text(
        json.dumps({"windows": fenster}), encoding="utf-8")
    return tmp_path


def _invoices_hoch(**extra) -> dict:
    """Das Fenster aus #31, mit den echten Zahlen des Laufs vom 2026-09-12:
    volle Scrollweite 342 px, gefahren wurden 275 -- der Behaelter stand
    beim Oeffnen 67 px unter der Kante (#47, nicht hier zu beheben)."""
    return {"label": "invoices:scroll-up:1", "start": STARTED_AT + 100,
            "end": STARTED_AT + 600, "durationSeconds": 0.5,
            "target": "div.MuiDataGrid-virtualScroller (y range 342px)", **extra}


def test_sollstrecke_ist_die_gefahrene_strecke_nicht_die_scrollweite(tmp_path):
    """Der Kern von #31. Beide Zahlen stehen im selben Fenster und sind
    verschieden; das Geraet muss die gefahrene nehmen.

    ERREICHBARKEIT: der Test zeigt zuerst, dass die falsche Wahl hier
    wirklich etwas anderes ergaebe (342 != 275) -- waeren sie gleich,
    pruefte er nichts.
    """
    lauf = _lauf_mit(tmp_path, [_invoices_hoch(travelPx=275, scrollStartPx=342,
                                               scrollEndPx=67)])
    (f,) = aus_lauf(lauf, fps=60.0, px_faktor=1.0, anzahl_bildpaare=119)
    assert f.soll_px == pytest.approx(275.0)
    assert f.soll_px != pytest.approx(342.0), "Scrollweite und Strecke sind hier gleich"
    assert "travelPx" in str(f.soll_herkunft)
    assert "gefahrene Strecke" in str(f.soll_herkunft)


def test_der_streckenabgleich_haelt_erst_mit_der_gefahrenen_strecke(tmp_path):
    """AEUSSERER ANKER: 274,5 px ist der Messwert, den das Geraet an diesem
    Fenster in allen sechs Laeufen geliefert hat. Gegen die Scrollweite
    reisst die 10-%-Schranke (20 % Abweichung), gegen die gefahrene Strecke
    haelt sie mit 0,2 % Rest. Die Toleranz ist in beiden Faellen dieselbe.
    """
    from smoothness.bounds import pruefe_strecke

    gemessen = 274.5
    ohne = aus_lauf(_lauf_mit(tmp_path / "a", [_invoices_hoch()]),
                    fps=60.0, px_faktor=1.0, anzahl_bildpaare=119)[0]
    mit = aus_lauf(_lauf_mit(tmp_path / "b", [_invoices_hoch(travelPx=275)]),
                   fps=60.0, px_faktor=1.0, anzahl_bildpaare=119)[0]

    alt = pruefe_strecke(gemessen, ohne.soll_px, ohne.soll_herkunft)
    neu = pruefe_strecke(gemessen, mit.soll_px, mit.soll_herkunft)
    assert alt["haelt"] is False and alt["abweichung"] > 0.1
    assert neu["haelt"] is True and neu["abweichung"] < 0.01
    assert alt["toleranz"] == neu["toleranz"] == 0.10, "die Schranke wurde aufgeweicht"


def test_lauf_ohne_travelpx_faellt_auf_die_scrollweite_zurueck(tmp_path):
    """Rueckfallpfad fuer Laeufe von vor #31. Er bleibt erlaubt, gibt sich
    aber in der Herkunft als Rueckfall zu erkennen."""
    lauf = _lauf_mit(tmp_path, [_invoices_hoch()])
    (f,) = aus_lauf(lauf, fps=60.0, px_faktor=1.0, anzahl_bildpaare=119)
    assert f.soll_px == pytest.approx(342.0)
    assert "Rueckfall" in str(f.soll_herkunft)
    assert "travelPx" not in str(f.soll_herkunft).split("Rueckfall")[0]


def test_ein_unbrauchbares_travelpx_gilt_nicht_als_sollstrecke(tmp_path):
    """0 oder ein Nicht-Wert ist keine Strecke. Dann greift der Rueckfall,
    nicht eine stille Null -- eine Null wuerde den Abgleich abschalten."""
    for kaputt in (0, None, False, "275"):
        lauf = _lauf_mit(tmp_path / f"w{kaputt!r}", [_invoices_hoch(travelPx=kaputt)])
        (f,) = aus_lauf(lauf, fps=60.0, px_faktor=1.0, anzahl_bildpaare=119)
        assert f.soll_px == pytest.approx(342.0), kaputt
        assert "Rueckfall" in str(f.soll_herkunft), kaputt
