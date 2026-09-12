"""Ein ganzer Lauf, wie ihn die Aufrufzeile in README.md nimmt.

Hier laufen alle Teile zusammen: Video lesen, Massstab ableiten, Fenster aus
`motion-windows.json` + `timestamps.json` holen, beide aeusseren Schranken
pruefen, urteilen, ausgeben.

FIXTURE-HERKUNFT: das Video ist synthetisch (c14_scroll_rampe aus
tests/synth_fixtures.py). Die beiden Laufdateien haben die Form, die
demo/m1-capture.ts schreibt, und ihre ZAHLEN stammen aus dem Erzeuger des
Videos -- die Sollstrecke wird aus der Wahrheitsdatei zurueckgerechnet, nicht
aus der Messung. Ein echter Aufnahmelauf kann diese Fixture ersetzen, sobald
der Aufnahmerechner wieder erreichbar ist; bis dahin ist der Streckenabgleich
am ECHTEN Material ungeprueft (siehe docs/SMOOTHNESS.md, "Grenzen").
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from smoothness.analyse import analysiere
from smoothness.report import als_text

STARTED_AT = 2_000_000.0
ERSTES_BILD = STARTED_AT + 50.0
PX_FAKTOR = 960 / 2560          # Ausschnittsbreite / Aufnahmebreite = 0,375


@pytest.fixture
def lauf_zu_c14(tmp_path: Path, eichfall) -> tuple[Path, Path]:
    mp4, wahrheit = eichfall("c14_scroll_rampe")
    (tmp_path / "timestamps.json").write_text(json.dumps({
        "captureSize": {"height": 1600, "width": 2560},
        "frames": [{"file": f"frame-{i:05d}.jpg",
                    "timestamp": ERSTES_BILD + i * (1000 / 60),
                    "viewport": {"height": 1600, "width": 2560}} for i in range(60)],
        "session": {"duration": 1100, "endedAt": STARTED_AT + 1100,
                    "startedAt": STARTED_AT},
        "version": 1}), encoding="utf-8")
    # Bildpaare 7..36 -> Wahrheits-Indizes 6..35. Die Sollstrecke kommt aus
    # dem ERZEUGER des Videos, umgerechnet in Aufnahmepixel.
    strecke_ausschnitt = sum(wahrheit["dx"][6:36])
    strecke_aufnahme = round(strecke_ausschnitt / PX_FAKTOR)
    (tmp_path / "motion-windows.json").write_text(json.dumps({
        "windows": [{"label": "tasks:scroll-right:1",
                     "start": STARTED_AT + 100, "end": STARTED_AT + 600,
                     "durationSeconds": 0.5,
                     "target": f"div.MuiDataGrid-virtualScroller "
                               f"(x range {strecke_aufnahme}px)"}]}),
        encoding="utf-8")
    return mp4, tmp_path


@pytest.mark.langsam
def test_ganzer_lauf_gegen_die_wahrheit_des_produkts(lauf_zu_c14):
    mp4, lauf = lauf_zu_c14
    bericht = analysiere(str(mp4), lauf_verzeichnis=lauf)

    assert bericht["fenster_quelle"] == "produkt"
    assert bericht["skalierung"]["faktor"] == pytest.approx(PX_FAKTOR)
    assert "abgeleitet" in bericht["skalierung"]["herkunft"]

    (fenster,) = bericht["fenster"]
    assert fenster["fenster"] == "tasks:scroll-right:1"
    assert fenster["richtung"] == "rechts"
    assert fenster["richtung_herkunft"] == "Fenstername"
    assert (fenster["von_bildpaar"], fenster["bis_bildpaar"]) == (7, 36)

    assert fenster["schranke_strecke"]["haelt"] is True
    assert fenster["schranke_strecke"]["abweichung"] < 0.02
    assert fenster["schranke_60hz"]["haelt"] is True
    assert fenster["schranke_60hz"]["gezaehlt"] == 31
    assert "unabhaengig" in str(fenster["schranke_60hz"]["gezaehlt_quelle"])
    assert fenster["urteil"] == "glatt"

    text = als_text(bericht)
    assert "Fensterquelle: produkt" in text
    assert "Massstab: 0.3750" in text


@pytest.mark.langsam
def test_cli_schreibt_denselben_bericht_als_json(lauf_zu_c14, tmp_path):
    """Erreichbarkeit: die Aufrufzeile aus README.md nimmt denselben Weg."""
    mp4, lauf = lauf_zu_c14
    ziel = tmp_path / "glaette.json"
    ergebnis = subprocess.run(
        [sys.executable, "-m", "smoothness", str(mp4), "--lauf", str(lauf),
         "--json", str(ziel)],
        capture_output=True, text=True, check=True,
        cwd=str(Path(__file__).resolve().parent.parent))
    assert "URTEIL: glatt" in ergebnis.stdout
    bericht = json.loads(ziel.read_text(encoding="utf-8"))
    assert bericht["fenster"][0]["urteil"] == "glatt"
    assert bericht["stellschrauben"], "die Stellschrauben gehoeren in den Bericht"
