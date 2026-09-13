"""Die Reihenfolge der drei Browser-Arme -- am echten Material festgenagelt.

Das ist die Abnahmepruefung aus #29 (Kriterium 1 und 5) und #30
(Kriterium 3): das Geraet muss die drei Arme so ordnen, wie der Owner sie am
2026-09-12 unaufgefordert beurteilt hat.

  gepatcht    "top", Links-Scroll "nahezu perfekt, sehr smooth"
  ungepatcht  "da sind beim Seitenscroll diese Riesensprünge drinne"
  Standard    "noch extremer"

Bedingungen:
  MUTATION         die erste Fassung des Geraets ordnete genau diese Daten
                   falsch herum (#29); der Test prueft, dass die blosse
                   Haker-Zahl es weiterhin taete (Erreichbarkeit), und die
                   Mutationsprobe der PR baut die Schwere zurueck.
  ERREICHBARKEIT   `werte_aus` ist derselbe Weg, den `analysiere` nach dem
                   Dekodieren nimmt; Fenster, Sollstrecke und externe Bildzahl
                   kommen ueber `windows.aus_lauf` aus den Laufdateien.
  NENNER           verglichen wird ueber die in allen Laeufen beurteilten
                   Fenster, und deren Zahl wird zugesichert.
  AEUSSERER ANKER  die Reihenfolge stammt vom Auge des Owners, nicht aus der
                   Messung.
  FIXTURE-HERKUNFT echte Aufnahmelaeufe, siehe tests/browser_arme/erzeuge.py;
                   Pruefsummen der Quelldateien stehen in jeder Fixture.

GRENZE, offen ausgewiesen: Dass der Standard-Browser hinter dem ungepatchten
landet, haengt an EINEM Fenster (`tasks:scroll-right:2`, 128 gegen 111 px
Einzelsprung). Die Trennung gepatcht gegen beide ungepatchten ist dagegen
breit (Faktor > 3).
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from smoothness.analyse import werte_aus
from smoothness.frames import Skalierung
from smoothness.pairs import Pair
from smoothness.report import NICHT_MESSBAR, vergleiche_laeufe

HIER = Path(__file__).resolve().parent / "browser_arme"
ARME = ("cSTOCK", "cUNP", "cPAT")


def _bericht(arm: str, ziel: Path) -> dict:
    with gzip.open(HIER / f"{arm}.json.gz", "rt", encoding="utf-8") as fh:
        fx = json.load(fh)
    assert fx["herkunft"]["arm"] == arm
    assert set(fx["herkunft"]["sha256"]) == {"output.mp4", "motion-windows.json",
                                             "timestamps.json"}
    lauf = ziel / arm
    lauf.mkdir()
    (lauf / "motion-windows.json").write_text(json.dumps(fx["motion_windows"]), encoding="utf-8")
    (lauf / "timestamps.json").write_text(json.dumps(fx["timestamps"]), encoding="utf-8")
    sp = fx["paare"]
    pairs = [Pair(i, dx, dy, st, 0.0, 0.0, dup)
             for i, dx, dy, st, dup in zip(sp["i"], sp["dx"], sp["dy"], sp["status"], sp["dup"],
                                           strict=True)]
    skal = Skalierung(fx["skalierung"]["faktor"], fx["skalierung"]["herkunft"])
    return werte_aus(pairs, skal, lauf_verzeichnis=lauf)


@pytest.fixture(scope="module")
def berichte(tmp_path_factory) -> dict[str, dict]:
    ziel = tmp_path_factory.mktemp("arme")
    return {arm: _bericht(arm, ziel) for arm in ARME}


def _fenster(bericht: dict, name: str) -> dict:
    (w,) = [w for w in bericht["fenster"] if w["fenster"] == name]
    return w


def test_die_drei_arme_stammen_aus_verschiedenem_material(berichte):
    """Fixture-Herkunft: drei verschiedene Videos, nicht dreimal dasselbe."""
    summen = set()
    for arm in ARME:
        with gzip.open(HIER / f"{arm}.json.gz", "rt", encoding="utf-8") as fh:
            summen.add(json.load(fh)["herkunft"]["sha256"]["output.mp4"])
    assert len(summen) == 3


def test_das_geraet_ordnet_die_arme_wie_das_auge(berichte):
    vergleich = vergleiche_laeufe(berichte)
    reihenfolge = [r["lauf"] for r in vergleich["reihenfolge_glatt_nach_hakelig"]]
    assert reihenfolge == ["cPAT", "cUNP", "cSTOCK"], vergleich

    g = vergleich["gemeinsam_beurteilt"]
    assert g["nenner_bedeutung"] == "Fenster, die in allen Laeufen beurteilt wurden"
    assert g["anzahl"] >= 8, f"zu wenige gemeinsame Fenster fuer ein Urteil: {g}"
    assert "tasks:scroll-right:1" in vergleich["fenster"]
    assert "tasks:scroll-right:2" in vergleich["fenster"]

    rang = {r["lauf"]: r for r in vergleich["reihenfolge_glatt_nach_hakelig"]}
    assert (rang["cUNP"]["groesster_sprung_gleichschritte"]
            > 3 * rang["cPAT"]["groesster_sprung_gleichschritte"])


def test_die_blosse_haker_zahl_ordnet_diese_daten_falsch(berichte):
    """Erreichbarkeit: der Defekt aus #29 steckt wirklich in diesem Material.
    Auf den Rechts-Scrolls hat der gepatchte Arm MEHR Haker als der
    Standard-Browser -- ein Urteil nach Anzahl kaeme falsch herum heraus."""
    def haker_rechts(arm: str) -> int:
        return sum(int(_fenster(berichte[arm], f"tasks:scroll-right:{n}")["stoerstellen_anzahl"])
                   for n in (1, 2))

    assert haker_rechts("cPAT") > haker_rechts("cSTOCK")


def test_die_riesenspruenge_heissen_teleport_und_nur_dort(berichte):
    """Der Owner hat die ungepatchten Arme an "Riesenspruengen" erkannt."""
    for arm in ("cSTOCK", "cUNP"):
        for n in (1, 2):
            w = _fenster(berichte[arm], f"tasks:scroll-right:{n}")
            assert w["schwere"]["teleport"] is True, (arm, n, w["urteil"])
    assert berichte["cPAT"]["zusammenfassung"]["teleporte"] == []


def test_sortier_fenster_bekommen_am_echten_material_kein_urteil(berichte):
    """#28 am echten Material: jedes Sortier-Fenster wird zurueckgehalten, und
    kein zurueckgehaltenes Fenster traegt eine Haker-Zahl."""
    for arm, b in berichte.items():
        sortier = [w for w in b["fenster"] if ":sort-" in w["fenster"]]
        assert sortier, f"{arm}: keine Sortier-Fenster -- dann prueft der Test nichts"
        for w in sortier:
            assert w["urteil"] == NICHT_MESSBAR, (arm, w["fenster"], w["urteil"])
            assert w["grund_code"] == "strecke_ungeprueft"
        for w in b["fenster"]:
            if w["urteil"] == NICHT_MESSBAR:
                assert "stoerstellen_anzahl" not in w

        zf = b["zusammenfassung"]
        verweigert = sum(zf["zurueckgehalten"].values())
        assert zf["beurteilt"]["anzahl"] + verweigert == zf["beurteilt"]["von"]
        assert zf["beurteilt"]["von"] == len(b["fenster"])
