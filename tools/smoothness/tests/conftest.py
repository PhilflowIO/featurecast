"""Gemeinsame Fixtures.

Die Eichvideos werden EINMAL erzeugt und in `.eichvideos/` zwischengelagert
(nicht im Repo, siehe tools/smoothness/.gitignore). Wer sie neu bauen will:
`FEATURECAST_EICHUNG_NEU=1 uv run pytest`. Erzeugt werden sie mit dem in
`synth_fixtures.py` festgenagelten ffmpeg, nicht mit dem des Systems --
sonst haengt der Grenzfall c12 an der Maschine (Ticket 158).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from synth_fixtures import CASES, baue_fall, ffmpeg_vorhanden, mutiere  # noqa: E402

CACHE = Path(__file__).resolve().parent.parent / ".eichvideos"


@pytest.fixture(scope="session")
def eichcache() -> Path:
    if not ffmpeg_vorhanden():
        pytest.skip(
            "Festgenagelter ffmpeg weder vorhanden noch ladbar -- ohne genau "
            "diesen Kodierer gibt es keine Eichvideos")
    CACHE.mkdir(exist_ok=True)
    return CACHE


@pytest.fixture(scope="session")
def eichfall(eichcache: Path):
    """fall_name -> (mp4, wahrheit). Baut nur, was noch fehlt."""
    import json

    gebaut: dict[str, tuple[Path, dict]] = {}

    def hole(name: str) -> tuple[Path, dict]:
        if name in gebaut:
            return gebaut[name]
        mp4 = eichcache / f"{name}.mp4"
        truth = eichcache / f"{name}.truth.json"
        if mp4.exists() and truth.exists() and not os.environ.get("FEATURECAST_EICHUNG_NEU"):
            gebaut[name] = (mp4, json.loads(truth.read_text(encoding="utf-8")))
        else:
            gebaut[name] = baue_fall(name, eichcache)
        return gebaut[name]

    assert set(CASES) >= {"c12_streng_alias_70px"}, "c12 darf nie wegfallen"
    return hole


@pytest.fixture(scope="session")
def mutant(eichcache: Path, eichfall):
    """(fall_name, art) -> mp4 des absichtlich kaputt gemachten Videos."""
    gebaut: dict[tuple[str, str], Path] = {}

    def hole(name: str, art: str) -> Path:
        if (name, art) not in gebaut:
            quelle, _ = eichfall(name)
            ziel = eichcache / f"{quelle.stem}_{art}.mp4"
            gebaut[(name, art)] = ziel if ziel.exists() and not os.environ.get(
                "FEATURECAST_EICHUNG_NEU") else mutiere(quelle, art, eichcache)
        return gebaut[(name, art)]

    return hole
