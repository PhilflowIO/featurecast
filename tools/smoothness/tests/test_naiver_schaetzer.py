"""Gegenprobe: der Schaetzer, der dieses Werkzeug noetig gemacht hat.

Waehrend der Fehlersuche wurde ein Versatz-Schaetzer nach dem Prinzip
"kleinste mittlere Differenz" geschrieben. Er verhakte sich am Spaltenraster
der Tabelle und meldete konstant 111 px fuer Bilder, die sich kaum bewegt
hatten -- zuversichtlich, ohne jeden Zweifel. Genau diese Fehlerklasse ist
der Grund fuer das Mehrdeutigkeits-Tor.

Dieser Test haelt beide nebeneinander. Er ist der einzige, der zeigt, WOFUER
die Verweigerung gut ist: nicht fuer einen kleineren Fehler, sondern dafuer,
dass eine unbeantwortbare Frage unbeantwortet bleibt.

FIXTURE-HERKUNFT: c10 und c12 aus tests/synth_fixtures.py -- streng
periodischer Inhalt mit Kachelbreite 111 px, derselben Groessenordnung wie
das Spaltenraster der echten Oberflaeche.
"""

from __future__ import annotations

import numpy as np
import pytest

from smoothness.estimators import naive_mad
from smoothness.frames import lies_graustufen
from smoothness.pairs import STATUS_GUELTIG, messe_bildpaare


@pytest.mark.langsam
def test_naiver_schaetzer_ist_blind_wo_das_werkzeug_richtig_liegt(eichfall):
    """c7: die Bewegung laeuft SENKRECHT (Wahrheit dy = +7 px je Bild).

    Der naive Schaetzer sucht nur ueber waagerechten Versaetzen -- eine
    Annahme, die er nirgends ausweist. Er meldet deshalb in jedem einzelnen
    Bildpaar einen Versatz nahe null, mit voller Zuversicht, und liegt um
    volle 7 px daneben. Das Werkzeug misst beide Achsen und trifft.

    Das ist die andere Haelfte derselben Fehlerklasse: nicht "falscher Wert",
    sondern "falsche Frage, ohne es zu merken".
    """
    mp4, wahrheit = eichfall("c7_senkrecht")
    frames = lies_graustufen(str(mp4))
    assert all(dy == 7.0 for dy in wahrheit["dy"])

    naiv = [naive_mad(frames[i - 1], frames[i]) for i in range(1, 11)]
    fehler = [abs(e.dy - 7.0) for e in naiv]
    assert all(f > 5.0 for f in fehler), (
        f"naiv nicht mehr blind auf senkrechter Bewegung: {fehler}")
    assert all(e.conf == 1.0 for e in naiv), "und zwar ohne jeden Zweifel"

    pairs = messe_bildpaare(frames)[:10]
    assert all(p.status in STATUS_GUELTIG for p in pairs)
    assert max(abs(p.dy - 7.0) for p in pairs) < 0.05


@pytest.mark.langsam
def test_werkzeug_verweigert_wo_der_naive_schaetzer_zuversichtlich_falsch_ist(eichfall):
    """c12: 70 px je Bild auf streng periodischem Inhalt. +70 und -41 sind
    dieselbe Bildinformation. Der naive Schaetzer waehlt trotzdem einen Wert
    und nennt ihn sicher; das Werkzeug verweigert die Mehrheit."""
    mp4, wahrheit = eichfall("c12_streng_alias_70px")
    frames = lies_graustufen(str(mp4))
    wahr = np.array(wahrheit["dx"][:12], dtype=float)

    naiv = np.array([naive_mad(frames[i - 1], frames[i]).dx for i in range(1, 13)])
    grob_falsch = int((np.abs(naiv - wahr) > 1.0).sum())
    assert grob_falsch >= 10, (
        f"naiv nur {grob_falsch}/12 grob falsch -- Gegenstand des Tests verloren")

    pairs = messe_bildpaare(frames)[:12]
    verweigert = [p for p in pairs if p.status not in STATUS_GUELTIG]
    assert len(verweigert) >= 6, (
        f"nur {len(verweigert)}/12 verweigert: das Mehrdeutigkeits-Tor greift nicht")
    assert all(p.status == "mehrdeutig" for p in verweigert)
