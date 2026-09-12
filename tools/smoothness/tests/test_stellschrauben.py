"""Die Stellschrauben stehen an genau EINER Stelle -- geprueft.

Verstreute Schwellen sind nicht diskutierbar: wer die Haker-Definition fuer
falsch haelt, muss genau einen Ort aendern koennen. Dieser Test sucht
deshalb im Quelltext des Messpfads nach Gleitkommazahlen, die einem
Knobs-Wert entsprechen -- eine Kopie einer Schwelle faellt damit auf, auch
wenn sie sich richtig verhaelt.

FIXTURE-HERKUNFT: keine Daten, nur der Quelltext dieses Pakets.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from dataclasses import asdict, fields
from pathlib import Path

from smoothness.knobs import KNOBS, Knobs, erklaere

PAKET = Path(__file__).resolve().parent.parent / "smoothness"
MESSPFAD = ["pairs.py", "windows.py", "hitches.py", "bounds.py", "report.py", "analyse.py"]


def test_erklaere_deckt_jede_stellschraube_mit_begruendung_ab():
    eintraege = erklaere()
    assert {e["name"] for e in eintraege} == {f.name for f in fields(Knobs)}
    for e in eintraege:
        assert e["begruendung"], f"{e['name']} hat keine Begruendung"
        assert len(str(e["begruendung"]).split()) >= 8, (
            f"{e['name']}: Begruendung zu duenn -- eine Zahl ohne Begruendung "
            f"ist eine Zahl, die niemand pruefen kann")


def test_cli_druckt_alle_stellschrauben():
    ergebnis = subprocess.run(
        [sys.executable, "-m", "smoothness", "--erklaere-schwelle"],
        capture_output=True, text=True, check=True,
        cwd=str(PAKET.parent))
    eintraege = json.loads(ergebnis.stdout)
    assert {e["name"] for e in eintraege} == {f.name for f in fields(Knobs)}


def test_keine_schwelle_steht_ein_zweites_mal_im_messpfad():
    werte = {v for v in asdict(KNOBS).values() if isinstance(v, float)}
    treffer = []
    for name in MESSPFAD:
        quelle = (PAKET / name).read_text(encoding="utf-8")
        for knoten in ast.walk(ast.parse(quelle)):
            if (isinstance(knoten, ast.Constant)
                    and isinstance(knoten.value, float)
                    and knoten.value in werte):
                treffer.append(f"{name}:{knoten.lineno} -> {knoten.value}")
    assert not treffer, (
        "Schwellenwerte doppelt im Quelltext -- sie gehoeren nach knobs.py: "
        + ", ".join(treffer))


def test_der_test_wuerde_eine_kopierte_schwelle_finden():
    """Erreichbarkeit: der Scan oben muss ausschlagen koennen. Hier wird eine
    Kopie absichtlich gebaut und gefunden -- ein Scan, der nie etwas findet,
    ist von einem kaputten Scan nicht zu unterscheiden."""
    werte = {v for v in asdict(KNOBS).values() if isinstance(v, float)}
    quelle = f"schwelle = {KNOBS.stall_frac}\n"
    gefunden = [k.value for k in ast.walk(ast.parse(quelle))
                if isinstance(k, ast.Constant) and isinstance(k.value, float)
                and k.value in werte]
    assert gefunden == [KNOBS.stall_frac]
