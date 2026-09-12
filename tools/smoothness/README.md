# smoothness — Glättemessung am fertigen Video

Misst am fertigen MP4, wie glatt eine Bewegung von Bild zu Bild übergeht, und
zählt **Haker**. Verfahren, Definitionen und Grenzen: [`docs/SMOOTHNESS.md`](../../docs/SMOOTHNESS.md).

Dies ist Prüfwerkzeug. Nichts in `src/` importiert es, es läuft nie beim
Kunden, und es ändert an der Aufnahme nichts.

## Warum Python in einem TypeScript-Repo

Die Bildmathematik (Fourier-Phasenkorrelation, Lucas-Kanade-Pyramiden,
affines Rückschieben) bleibt erprobte Bibliothek — OpenCV und NumPy — statt
selbstgeschriebener Code. In diesem Projekt waren bereits zwei selbst
gerechnete Messgeräte um die Hälfte falsch (`src/paint-rate.ts`, die erste
Fassung von `src/efficiency.ts`). Ein drittes eigenes Zahlenwerk, diesmal
über Pixeln, wäre die dritte Gelegenheit zum selben Fehler.

## Aufruf

Abhängigkeiten einmalig einrichten (Python 3.11–3.13, `uv`, `ffmpeg`):

```sh
uv sync --project tools/smoothness
```

Ein Lauf gegen die Wahrheit des Produkts — das ist die empfohlene Form:

```sh
uv run --project tools/smoothness smoothness \
  dist/feature-xy/output.mp4 --lauf dist/feature-xy --json glaette.json
```

`--lauf` zeigt auf das Ausgabeverzeichnis eines Aufnahmelaufs. Dort liegen
`motion-windows.json` und `timestamps.json`; aus ihnen kommen die
Fenstergrenzen, die Sollstrecke und die Fensterdauer. **Erst damit tragen die
beiden äußeren Schranken.**

Ohne `--lauf` zerlegt das Werkzeug die Bewegung selbst. Das ist der Rückfall,
er steht als `fenster_quelle: eigene-zerlegung` in jeder Ausgabe, und beide
äußeren Schranken bleiben dabei ungeprüft:

```sh
uv run --project tools/smoothness smoothness compare3-full.mp4 --panel 3/3
```

Alle Stellschrauben mit Begründung ausdrucken:

```sh
uv run --project tools/smoothness smoothness --erklaere-schwelle
```

## Optionen

| Option                | Bedeutung                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--lauf DIR`          | Verzeichnis mit `motion-windows.json` + `timestamps.json`. Ohne das: eigene Zerlegung.                                  |
| `--panel k/M`         | Feld `k` eines Dreiervergleichs (960×540 unter 96 px Kopfzeile). Geometrie der `compare3`-Videos aus featurecast-bench. |
| `--crop x,y,w,h`      | Beliebiger Ausschnitt.                                                                                                  |
| `--fps`               | Bildrate des Ausgabevideos. Ohne Angabe `fps_nominal` aus `knobs.py`.                                                   |
| `--aufnahme-breite`   | Breite des Aufnahmefensters in CSS-Pixeln (Vorgabe 2560, siehe `CAPTURE_SIZE` in `src/capture.ts`).                     |
| `--px-skala`          | Ausschnittspixel je Aufnahmepixel, ausdrücklich. Ohne Angabe abgeleitet — die Herkunft steht in jeder Ausgabe.          |
| `--json DATEI`        | Vollständiger Bericht als JSON.                                                                                         |
| `--erklaere-schwelle` | Jede Stellschraube mit Wert und Begründung.                                                                             |

## Was herauskommt

Auf der Konsole ein lesbarer Bericht, mit `--json` derselbe Inhalt
maschinenlesbar. Je Fenster:

- **Urteil** — `glatt`, `N Haker`, `unruhig (…)` oder **`NICHT MESSBAR`** mit
  Grund. Ein Fenster, das eine äußere Schranke reißt, gibt kein Glätte-Urteil
  ab.
- **Beide äußeren Schranken** mit `haelt: true | false | null`. `null` heißt
  _nicht geprüft_ und ist kein Bestehen.
- **Jede Quote mit ihrem eigenen Nenner** und dessen Bedeutung in Worten. Die
  Wiederholungsquote teilt durch die Bildpaare des Fensters, die Haker-Quote
  durch die Bildpaare der Reisestrecke — das sind verschiedene Zahlen.
- **Richtung getrennt.** Links und rechts werden nie gemittelt.
- **Maßstab mit Herkunft**, damit „abgeleitet" nie wie „gemessen" aussieht.

Findet das Werkzeug gar kein auswertbares Fenster, sagt es das ausdrücklich —
Schweigen liest sich sonst wie ein Bestehen.

## Tests

```sh
uv run --project tools/smoothness pytest            # alles, rund 40 s bei warmem Zwischenlager
uv run --project tools/smoothness pytest -m "not langsam"   # ohne Videoerzeugung, unter 1 s
uv run --project tools/smoothness pytest -m langsam         # nur die Videofälle
```

Die Eichvideos werden beim ersten Lauf erzeugt (`ffmpeg` nötig) und in
`.eichvideos/` zwischengelagert. Neu bauen:
`FEATURECAST_EICHUNG_NEU=1 uv run pytest`.

Was die Tests belegen und woher ihre Eingaben stammen, steht im Kopf jeder
Testdatei — Mutation, Erreichbarkeit, Nenner, äußerer Anker,
Fixture-Herkunft.

## Grenzen

Kurz: keine Farbe, nur Verschiebung (keine Drehung, kein Zoom, keine
Überblendung), nur ein Bewegungsobjekt, Zeitlupendateien untauglich, und die
Haker-Schwelle ist **nicht** gegen das Auge des Owners geeicht. Vollständig
und begründet in [`docs/SMOOTHNESS.md`](../../docs/SMOOTHNESS.md), Abschnitt
„Grenzen".
