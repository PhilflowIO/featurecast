# featurecast

Aus einem Playwright-Skript wird ein Marketing-Video eines Features — in Desktop und Mobile, mit weicher, menschlich wirkender Cursor-Bewegung und automatischem Zoom auf das, was gerade passiert.

Der Kern der Idee: **die Aufnahme brennt nichts in die Pixel.** Es entstehen zwei Artefakte — ein sauberes Rohvideo und ein Ereignis-Log (wohin der Zeiger lief, was wann geklickt wurde, welches Element dabei getroffen wurde). Cursor, Zoom, Beschriftungen und Seitenverhältnis entstehen erst danach. Eine Änderung am Look ist deshalb ein neuer Render von zehn Sekunden, kein neuer Browser-Lauf.

Zielgruppe des Repos sind die eigenen Playwright-Skripte: ein bestehendes Skript wird zur Aufnahme, indem seine Interaktionen über einen Wrapper laufen, der Bewegung glättet und protokolliert.

```ts
import { record } from 'featurecast'

await record(
  { device: 'iPhone 15 Pro', out: 'dist/feature-xy' },
  async (page, demo) => {
    await page.goto('https://app.example.com/new-feature')
    await demo.point('#nav-settings') // weiche Anfahrt, kein Klick
    await demo.tap('#toggle-dark-mode') // Klick bzw. Tap, je nach Gerät
    await demo.hold(1200) // Wirkung zeigen
  },
)
```

Stand: M0 und M2 sind umgesetzt: TypeScript, Playwright, Formatierung, ein Smoke-Demo und der `demo`-Wrapper mit Ereignis-Log sind lauffähig. Die Aufnahme- und Render-Stufen folgen den weiteren Meilensteinen. [PLAN.md](PLAN.md) beschreibt Architektur und belegte Entscheidungen, [MILESTONES.md](MILESTONES.md) die Ziele in Reihenfolge, [docs/DEVICES.md](docs/DEVICES.md) das Geräte-Konzept.

Ein bestehendes Playwright-Skript wird in [docs/RECORDING-SCRIPTS.md](docs/RECORDING-SCRIPTS.md) zur Aufnahme umgebaut — samt der Rezepte für Anmeldung über gespeicherten Sitzungszustand, Cookie-Banner und eingefrorene Uhrzeiten.

## Ereignis-Log v1

`record({ device?, out, seed? }, async (page, demo) => ...)` legt einen `demo`-Wrapper (`point`, `click`, `tap`, `type`, `hold`, `scroll`) um Playwrights Seite und schreibt daneben ein kanonisches, versioniertes `events.jsonl`. Jede Zeile hat eine feste Feldreihenfolge; die Datei endet immer mit einem Zeilenumbruch. Zwei Läufe desselben Skripts mit demselben `seed` erzeugen bitidentische Dateien — bewiesen gegen einen echten headless Chromium in `tests/record.browser.test.ts`.

Jede Bewegung läuft über die übernommene Minimum-Jerk-Kurve aus `matinee` (Anfahren, Abbremsen, leichtes Überschwingen, Zittern) statt über lineare Interpolation, und wird der Seite bei echten 60 Bildern pro Sekunde vorgespielt: jede Zeigerprobe wartet auf ihren absoluten Zeitpunkt (Start + i/60 s), nicht auf eine aufaddierte Pause, damit sich kein Zeitfehler aufsummiert. Zwischen zwei benachbarten Zeigerproben liegen nie mehr als 20 Pixel — das ist eine Garantie, keine Wahrscheinlichkeit: `src/motion.ts` startet mit einer analytisch hergeleiteten Abtastanzahl und erhöht sie deterministisch weiter, bis die tatsächlich gerenderte, gerundete Kurve die Grenze einhält (gleicher Seed, gleiches Ergebnis). Bei langen Bewegungen kostet das spürbar Zeit — 1500 Pixel brauchen real rund 3,2–4,1 Sekunden, deutlich mehr als `matinee`s ungebremste 1,1 Sekunden, weil dessen Tempo nie für ein 20-Pixel-Limit ausgelegt war. `hold(ms)` legt die Seite für die angegebene Zeit wirklich still, statt nur das Protokoll weiterzuzählen. `type(target, text)` fährt das Feld mit dem Zeiger an, fokussiert es per Klick oder Tap (je nach Gerät) und tippt dann echte Tasten mit einer seed-abhängigen Verzögerung pro Zeichen.

Bevor ein `point`/`click`/`tap`/`type` ein Ziel anfährt, wird dessen Geometrie nicht aus einer einzelnen Momentaufnahme übernommen, sondern über ein Beobachtungsfenster hinweg Bild für Bild abgetastet (`requestAnimationFrame` in der Seite, ein Round-Trip pro Fenster — ein Browser berechnet den Wert einer CSS-Animation nur einmal pro Rendering-Takt neu, jede dichtere Abfrage liefert denselben eingefrorenen Wert). Aus den Bildern werden drei Fälle unterschieden, in der Reihenfolge, in der sie am billigsten zu erkennen sind.

**Unbewegt.** Alle Bilder eines 80-ms-Fensters melden exakt dieselben Kanten — bitgleich, ohne Toleranz. Das ist der Normalfall und kostet genau ein Fenster. Die fehlende Toleranz ist Absicht: `getBoundingClientRect()` liefert Sub-Pixel-Werte, ein Ziel, das sich noch bewegt, meldet also von Bild zu Bild andere Zahlen, und eine Schwelle von einem halben Pixel hat genau deshalb eine Verbreiterung von 0,05 px pro Bild als „steht still“ durchgewunken. Die Grenze ist jetzt nicht mehr ein gewählter Wert, sondern die Sub-Pixel-Quantisierung des Browsers selbst (Chromium: 1/64 px) über die Fensterdauer — rechnerisch rund 0,2 px/s bei 80 ms. **Nachgewiesen ist 3 px/s** (`tests/settle-criterion.browser.test.ts`): ein Ziel, das drei Sekunden lang genau so langsam wächst, wird ausgewartet und mit seiner Endbreite protokolliert. Die rechnerische Untergrenze darunter ist nicht durch einen Test belegt.

**Endliche Animation.** Sie endet irgendwann und hinterlässt ein wirklich unbewegtes Element, also wird einfach Fenster für Fenster weiter beobachtet, bis eines unbewegt ist. Eine Animation der Dauer D braucht damit rund D, nicht ein Vielfaches davon — eine gewöhnliche 4-Sekunden-Transition bleibt innerhalb des 5000-ms-Standardbudgets, für das dieser Wert gewählt wurde.

**Dauerhafte, begrenzte Animation.** Eine pulsierende CTA, ein Bounce, ein Wackeln um einen beliebigen `transform-origin`, eine Drehung: sie hört nie auf, Warten würde also zwangsläufig ins Timeout laufen. Stattdessen wird ihre Periode bestimmt — über die Web-Animations-API gelesen, nie gesetzt, und zwar am Element, an seinem Teilbaum **und an allen Vorfahren** (eine Animation am Elternknoten bewegt das Ziel, taucht aber in dessen eigener `getAnimations()` nicht auf); bei `alternate` zählt die doppelte Iterationsdauer, bei mehreren Animationen deren kleinstes gemeinsames Vielfaches. Jede so gewonnene Periode wird anschließend **gegen die gemessene Geometrie verifiziert**: was die Seite deklariert, ist ein Vorschlag, was die Box tatsächlich tut, ist die Entscheidung. Findet sich keine haltbare Periode, wird sie aus den Messwerten selbst geschätzt; bleibt auch das ergebnislos, bricht `record` nach `settleTimeoutMs` mit einer Meldung ab, die genau das sagt (das Ziel bewegt sich begrenzt, aber ohne messbare Periode), statt still über ein beliebig langes Fenster zu mitteln.

Gemessen wird dann über eine **ganzzahlige Anzahl von Perioden**, und diese Anzahl ist eine reine Funktion der Periode (`ceil(480 ms / Periode)`) — nicht der verstrichenen Zeit, nicht des Restbudgets, nicht der Anzahl vorheriger Fenster. Genau diese Abhängigkeit war die Ursache dafür, dass zwei Läufe desselben Skripts unterschiedliche Boxen protokollierten: ein Lauf, der eine Beobachtungsrunde mehr brauchte, mittelte über ein anders phasiertes Fenster. Jedes Bild geht mit der Zeit bis zum nächsten gewichtet ein, das letzte nur mit der im Fenster verbleibenden Zeit — das Ergebnis ist ein echtes Zeitintegral über die Periodenanzahl und nicht ein Mittel über so viele Bilder, wie die Maschine gerade geschafft hat. Unter Last, wo `requestAnimationFrame` von 60 Hz auf eine Handvoll Bilder einbricht, ist das der Unterschied zwischen einer stabilen Antwort und einer, die der Last folgt.

Die protokollierte Box ist die **am längsten gehaltene** (am häufigsten bewohnte) Box, sofern eine deutlich dominiert — „Ruhegeometrie“ heißt bei einer Animation mit Ruhephase die Box, in der das Element wirklich sitzt, nicht der Mittelwert aus Ruhe und kurzem Ausschlag. Eine Animation, die 70 % jedes Zyklus bei `scale(1)` verharrt und kurz auf 1,6 ausschlägt, würde gemittelt eine Box liefern, die das Element nie einnimmt, und M4 würde genau die heranzoomen. Gibt es keine dominierende Box (eine gleichmäßig durchlaufende Bewegung ohne Ruhelage), ist der periodengenaue Zeitmittelwert die Antwort. Der Interaktionspunkt ist der Mittelpunkt dieser Ruhebox, hineingezogen in den Bereich, den das Ziel in **jeder** beobachteten Phase bedeckte — ein Klick trifft damit zu jedem Zeitpunkt der Animation. Der Mittelpunkt jenes Schnittbereichs selbst wäre dafür ungeeignet: seine Kanten sind die Extrema der Animation, und ein Extremum kann ein Prozess prinzipiell nur bis auf ein Rendering-Bild genau treffen — genau daher kam der verbliebene Ein-Pixel-Unterschied zwischen zwei Prozessen.

Zwei separate Prozesse protokollieren dadurch dieselbe Box und denselben Punkt: `tests/settle-determinism.test.ts` startet pro Fall drei eigene Prozesse und vergleicht `sha256(events.jsonl)` — **und zwar unter Last** (32 Rechenschleifen im selben Container, per `FEATURECAST_LOAD_WORKERS` einstellbar), weil die Garantie auf einer unbelasteten Maschine auch dann grün aussah, wenn sie nicht galt. Auf dem Messrechner: zehn Wiederholungen, drei Prozesse je Fall, drei Fälle (Puls, Bounce, asymmetrische Ruhephase) — jeder Lauf grün, und die Hashes über alle Wiederholungen hinweg identisch, nicht nur innerhalb eines Laufs. Die gemessene Grenze liegt darüber: bei 96 Rechenschleifen auf 32 Kernen (dreifache Überbuchung) liefert der Browser so wenige Rendering-Takte, dass keine Periode mehr verifizierbar ist — dann **bricht die Aufnahme mit der `settleTimeoutMs`-Meldung ab**, in drei Läufen ausnahmslos so und nie mit abweichenden Hashes. Das ist der richtige Ausgang: lieber kein Protokoll als ein falsches. Das kostet etwas, und zwar genau benennbar: ein einzelner Klick auf eine statische Seite 1479 ms gegenüber 1362 ms auf `main` (+8,6 %), zehn Interaktionen 7038 ms gegenüber 6026 ms (+16,8 %, also rund 101 ms je Interaktion), je Mittel aus drei Läufen auf dem Messrechner (`demo/settle-cost.ts`). Der Aufschlag ist fast vollständig das zweite Beobachtungsfenster nach der Ankunft — der Preis dafür, dass die protokollierte Box bei der Ankunft _gemessen_ und nicht einmal abgelesen wird.

Das alles ist unabhängig davon, wodurch sich die Geometrie bewegt haben könnte: natives Fenster-Scrollen, ein `overflow:auto`-Container, oder ein per JavaScript animierter Transform (Lenis-artiges Scrollen), der `window.scrollX/Y` nie anfasst. `scroll(dx, dy)` selbst wartet nicht darauf — es kennt sein Ziel nicht —, sondern die nächste Interaktion tut es. Wartet die Geometrie zu lange nicht still, bricht `record` nach `settleTimeoutMs` (Standard 5000 ms, per `RecordOptions.settleTimeoutMs` einstellbar) mit einer Fehlermeldung ab, die die Option beim Namen nennt. Dieses Budget gilt pro Interaktion, nicht pro Messung: jede Interaktion löst die Geometrie zweimal auf (vor der Anfahrt und nach der Ankunft), und beide teilen sich dieselbe Frist — vorher konnte eine einzelne Interaktion das doppelte Budget verbrauchen, gemessen 125 s bei einer Einstellung von 60 s.

Weil das Anfahren selbst 0,4 bis über 4 Sekunden dauern kann, reicht "die Geometrie war beim Start stabil" allein nicht: das Ziel kann sich währenddessen bewegen, neu gerendert werden, in der Größe ändern oder von etwas anderem verdeckt werden. Deshalb ist die Interaktion selbstverifizierend. Vor der Bewegung wird der tatsächliche Interaktionspunkt gegen die lebende Seite geprüft — welches Element liegt wirklich an diesen Koordinaten (`document.elementFromPoint`)? Geprüft wird zuerst genau der oben bestimmte Punkt, der Mittelpunkt der Ruhebox: ist er frei, ist er der Interaktionspunkt — der häufige, günstige Fall, eine einzige Prüfung. Ist er verdeckt (ein Sticky-Header, oder zwei Overlays von gegenüberliegenden Seiten), sucht ein deterministisches Raster von Prüfpunkten über die ganze sichtbare Fläche die größte zusammenhängende freie Region und wählt darin den Punkt nächst ihrem Schwerpunkt — nicht neun feste Stellen an Rändern und Ecken, die eine freie Zone irgendwo dazwischen (etwa zwischen zwei Overlays) systematisch verfehlt haben. Der Abstand zwischen zwei Prüfpunkten ist ein fester, größenunabhängiger Wert (6 px) statt eines Durchschnitts, der mit der Zielgröße gröber wird: die _Anzahl_ der Prüfpunkte wächst mit dem Ziel, nicht ihr Abstand, sodass ein 6 px schmaler freier Streifen auf einem 300-px-Ziel genauso zuverlässig gefunden wird wie ein 30-px-Streifen auf einem 1200 px hohen Hero. Zwei Läufe gegen dieselbe Verdeckung wählen denselben Punkt — über drei separate Prozesse per `sha256(events.jsonl)` nachgewiesen (`tests/occluded-target-determinism.test.ts`). Das kostet etwas, und zwar nur im verdeckten Fall: auf einem bildschirmfüllenden Hero (1280×720 sichtbare Fläche, rund 26 000 Prüfpunkte in einem Round-Trip) wurden auf dem Messrechner 1,86 s pro Interaktion gemessen (4,28 s gegenüber 2,43 s für denselben Hero ohne Verdeckung, je Mittel aus drei Läufen); ist dieser erste Punkt frei, fällt das Raster komplett weg. Nach der Ankunft wird die Geometrie vollständig neu aufgelöst — nicht nur wenn etwas auffällig war, denn ein Ziel kann um denselben Mittelpunkt wachsen und den Treffertest dabei nie verlieren. Ob dafür ein zweiter, ebenso Pixel-limitierter Bewegungsabschnitt nötig ist, entscheidet allein ein Treffertest an der aktuellen Zeigerposition: „würde ein Klick hier jetzt das Ziel treffen“ ist eine Ja/Nein-Frage, die ein Pixel Messrauschen nicht kippen kann — deshalb braucht es dafür keine Toleranzkonstante mehr. Die geloggte Bounding-Box ist die bei der Ankunft bestimmte Ruhegeometrie, nie ein einzelner roher Lesewert unmittelbar vor dem Klick: ein solcher Lesewert liefert bei einem animierten Ziel genau die Phase, die dieser eine Round-Trip zufällig erwischt hat — die falsche Box und in jedem Prozess eine andere. Bemerkt der Treffertest nach der Ankunft eine Veränderung, wird komplett neu aufgelöst. Schlägt die Verifikation fehl, bricht `record` mit einer Fehlermeldung ab, statt zu raten. Das ist eine sehr starke, aber keine absolute Garantie: zwischen der letzten Prüfung und dem tatsächlichen `page.mouse.click` liegt noch ein einzelner Netzwerk-Umlauf, in dem sich die Seite theoretisch ein letztes Mal ändern könnte — dieses Fenster ist absichtlich klein gehalten (ein Evaluate-Aufruf statt der vollen 0,4–4 Sekunden Anfahrt), aber nicht auf null reduziert. Ein plausibel aussehender, aber nie ausgeführter Klick ist trotzdem der schlimmste Fehlerfall dieses Werkzeugs: Meilenstein M4 würde später auf ein Ereignis zoomen, das nie passiert ist.

`tick` ist der geplante 60-Hz-Zeitschlitz-Index, nicht Echtzeit, aber ein durchgängiger Zeitmaßstab: alles, was geplante Zeit verbraucht, zählt ihn weiter. Zeigerproben erhöhen ihn um eins pro Probe — auch eine Probe, die auf demselben Pixel wie ihr Vorgänger landet (der Zeiger "hält" kurz), wird protokolliert und zählt einen Schlitz. `hold(ms)` zählt `ceil(ms / 1000 * 60)` weiter, `scroll` einen Schlitz pro 60-Hz-Rad-Inkrement, und `type` die Summe der (seed-abhängigen, also deterministischen) Zeichenverzögerungen in Schlitzen. **Was `tick` nicht kennt:** alles, was echte Zeit kostet, aber nicht selbst geplant ist — `page.goto`, jede `boundingBox()`-Messung samt der Warteschleife auf stabile Geometrie und der Verifikations-Hit-Tests, die Round-Trip-Zeit eines Klicks. Dadurch laufen `tick` und die Wanduhr auseinander: in dieser Session gemessen rund +14–15 % bei einem gewöhnlichen Skript (Klick, Tippen, Hold, Scroll, Klick), und rund das 1,3-Fache bei einem Skript mit einem langsam animierenden inneren Scroll-Container — je nach Animation der Seite kann das deutlich mehr sein. Die Selbstverifikation oben hat diesen Wert in dieser Session nicht spürbar verschlechtert (die zusätzlichen Prüfungen sind klein gegen die ohnehin mehrhundert Millisekunden lange Zeigerbewegung). Das ist kein Bug, sondern der offene Rand dieses Meilensteins: die Abbildung von `tick` auf die echte Capture-Uhr ist Sache von Issue #9, das genau deshalb diese Gleichförmigkeit von `tick` braucht.

Ein Ziel, dessen Bounding-Box gar keine sichtbare Überschneidung mit dem Viewport hat, lässt `record` mit einer Fehlermeldung abbrechen, die auf `demo.scroll` verweist — ein automatisches Scrollen würde einen unsichtbaren Sprung ins Video einbauen. Ist die Box größer als der Viewport (ein hoher Hero-Bereich, ein Overlay) oder teilweise von etwas anderem verdeckt (ein Sticky-Header), wird nicht abgebrochen: der oben beschriebene Punktetest findet die sichtbare, tatsächlich klickbare Stelle, und die volle Bounding-Box bleibt trotzdem im Log stehen. Erst wenn keiner der Prüfpunkte trifft, bricht `record` ab.

`device` wird bereits gegen Playwrights Geräteregistrierung aufgelöst, unter anderem für `hasTouch`, damit `tap` in einem echten Touch-Kontext läuft statt abzustürzen. Ein unbekannter Name bricht mit einer Fehlermeldung ab, die ähnliche oder verfügbare Namen nennt. Die kuratierte Voreinstellungs-Ebene darüber (Aufnahme-/Ausgabeformat, Zeiger-Art) folgt in M5.

## Nachbearbeitung: Zoom, Zeiger, Tempo, Formate

`pnpm render <aufnahme-ordner> <ziel-ordner>` macht aus einer Rohaufnahme
fertige Videos. Es startet keinen Browser und kann keinen starten: die Eingabe
sind die Einzelbilder, die die Aufnahme geschrieben hat, und das Ereignis-Log
daneben. Ein anderer Zeiger, ein anderer Zoom, ein anderes Seitenverhältnis ist
deshalb ein erneuter Lauf dieses Kommandos, kein erneuter Lauf des Skripts.

```sh
pnpm render artifacts/m1-008 dist/feature-xy
pnpm render artifacts/m1-008 dist/feature-xy --padding 40 --cursor-size 32
```

Aus demselben Rohmaterial entstehen 16:9, 9:16 und 1:1. **Zoom ist immer ein
Ausschnitt aus dem Original, nie eine Vergrößerung** — und das hat eine Folge,
die die meisten Werkzeuge verschweigen: in einer 2560×1600-Desktop-Aufnahme
steckt kein scharfes 1080×1920-Hochformat. Das größte 9:16-Rechteck darin ist
900×1600. Der Renderer liefert dann 900×1600 in voller Schärfe und sagt es in
der Ausgabe, statt hochzuskalieren. Ein scharfes Hochformat entsteht durch eine
Aufnahme im Hochformat, das ist M3.

Kein Zoom heißt aber nicht kein Schwenk. Ein 900 Pixel breites Fenster kann
überall in einer 2560 Pixel breiten Aufnahme stehen, und dieses Verschieben
kostet nichts — es ist immer noch derselbe Ausschnitt aus dem Original. Das
Hochformat folgt dem angeklickten Element deshalb seitlich, mit derselben Feder
wie alles andere, statt als eingefrorener Mittelstreifen 65 % der Oberfläche nie
zu zeigen. Für 1:1 gilt dasselbe. 16:9 füllt die Breite der Aufnahme ohnehin
schon aus und ändert sich dadurch nicht; dass dort oben angeschnitten wird und
nicht mittig, bleibt eine bewusste Entscheidung — Navigationsleisten und
Werkzeugleisten wohnen genau dort.

Der Zoom rahmt beim Klick die Bounding-Box des getroffenen Elements. Diese Box
ist die **Ruhelage** des Elements, nicht seine Geometrie im Bild, in dem der
Klick landete: bei einem Element, das einblendet oder pulsiert, die Geometrie,
in der es sich am längsten aufhält — nicht der Mittelwert seiner Extreme, denn
bei einer unsymmetrischen Animation ist der Mittelwert eine Größe, die das
Element in keinem einzigen Bild hat. Der Ausschnitt steht deshalb still, während
das Element atmet, und wird nie nachträglich aufgeweitet.

Folgen zwei Interaktionen dichter aufeinander, als die Kamera zum Anfahren
braucht, gibt die **spätere** nach: ihre Anfahrt beginnt später und legt
denselben Weg schneller zurück. Die frühere Einstellung wird dagegen nie vor
ihrem eigenen Klick beendet — sonst zeigte das Bild im Moment des Klicks einen
Punkt auf dem Weg zum nächsten Element statt das Element, das geklickt wurde,
und bei zwei Zielen auf gegenüberliegenden Seiten wäre das geklickte Element
überhaupt nicht im Bild. Liegen zwei Interaktionen so dicht beieinander, dass
zwischen ihnen keine ehrliche Kamerabewegung mehr passt — weniger als zwei
Bilder —, bricht der Renderer mit einer Meldung ab, statt leise danebenzuzielen.

Zeiger und Klick-Ripple werden hier gezeichnet, nicht aufgenommen: Headless
Chromium rendert überhaupt keinen Zeiger, das Log ist die einzige Quelle. Größe,
Form und Ripple-Dauer sind Parameter.

Leerlauf wird gerafft. Das Signal dafür sind die Zeitstempel der Aufnahme
selbst: die Aufnahme faltet bitgleiche Folgebilder bereits zusammen, eine große
Lücke zwischen zwei überlebenden Bildern ist also eine Strecke, in der sich das
Bild nicht geändert hat — nicht bloß ein Animationstakt ohne Neuzeichnung.
Gerafft wird über eine einzige, streng monotone Zeitabbildung, durch die Bilder
und Ereignisse gemeinsam laufen; sie können deshalb nicht auseinanderdriften.

Das Kernstück ist eine reine Funktion von (Ereignissen mit einer Zeit in
Millisekunden, Bild-Zeitstempeln in Millisekunden) auf Ausschnitt-Rechteck und
Zeiger-Zeichenliste je Bild. Diese Entscheidungsdaten landen als
`decisions.json` neben dem Video.

**Gleiche Entscheidungsdaten, gleiches Video — Byte für Byte.** Das Zuschneiden,
Skalieren und Zeichnen des Zeigers passiert Bild für Bild in eigenem Code, nicht
in ffmpegs Filtergraph. ffmpeg behält die Aufgaben, die es gut kann — dekodieren,
kodieren, Zeitbasis — und verliert die, bei der es unzuverlässig war: pro Bild
eine andere Geometrie zu setzen. Über einen zeitgesteuerten Kommandokanal
(`sendcmd`) war das nicht reproduzierbar: sechs identische Läufe über dieselbe
Kommandodatei erzeugten vier verschiedene Videos, mit falsch gerahmten
Einzelbildern und einem Zeiger, der nicht dem folgte, was in `decisions.json`
steht. Jetzt ist zwischen Entscheidung und Pixel nichts mehr, das von Lauf zu
Lauf anders ausfallen könnte; sechs Läufe in sechs Prozessen ergeben pro Format
genau eine Prüfsumme.

Die fertigen Dateien sagen auch, welche Farben sie meinen: `tv`-Bereich,
bt709. Ohne diese Beschriftung liest jede nachgelagerte Kette ein `yuv420p` im
Zweifel als Vollbereich und zieht die Pegel auseinander — die Pixel wären
richtig und das Bild trotzdem falsch. Geprüft wird das an `ffprobe` auf einem
echten Encode, nicht an der ffmpeg-Kommandozeile: ein Argument ist eine Absicht,
die Datei ist das Ergebnis.

Das Hochformat zahlt dafür nicht mit Schärfe, im Gegenteil: ein 9:16-Ausschnitt
ist genauso groß wie das Ausgabebild, wird also gar nicht skaliert, sondern
1:1 aus dem Original kopiert.

### Der Filter, der verkleinert

Aufgenommen wird in 2560×1600 und ausgeliefert in 1920×1080, weil das der
einzige Weg zu scharfem Text ist. Der Filter, der diese Verkleinerung macht, ist
deshalb kein Implementierungsdetail, sondern genau das Merkmal, für das die
hohe Aufnahmeauflösung existiert. Verkleinert wird mit einem Lanczos-3-Kern —
gefensterte Sinc, separabel, am Maßstab gestreckt —, demselben Verfahren, das
M1 über ffmpeg benutzt hat. Gemessen an vier echten Aufnahmebildern, Ausschnitt
2560×1440 → 1920×1080, also exakt der 1,33× Reserve:

| Filter                      | Kantenenergie (Laplace-RMS) | Rundlauf-PSNR |
| --------------------------- | --------------------------- | ------------- |
| **featurecast (Lanczos-3)** | **39,3**                    | **31,60 dB**  |
| ffmpeg Lanczos (M1)         | 39,3                        | 31,60 dB      |
| ffmpeg bicubic              | 35,7                        | 31,24 dB      |
| bilinear (Runde 2)          | 35,4                        | 30,72 dB      |
| ffmpeg area                 | 32,4                        | 30,61 dB      |
| ffmpeg bilinear             | 26,9                        | 30,02 dB      |

Das kostet Rechenzeit, und zwar erheblich: ein 16:9-Bild aus dem vollen Raster
braucht 179 ms statt 17,6 ms, ein 1:1-Bild 109 ms statt 10,7 ms — rund das
Zehnfache. Der Ausschnitt, der genauso groß ist wie das Ausgabebild, wird nach
wie vor gar nicht gefiltert, sondern zeilenweise kopiert (0,18 ms), und das
bleibt so: Hochformat lebt von dieser 1:1-Kopie.

### Was das Rendern kostet, und auf welcher Maschine

Das Zuschneiden und Skalieren ist die gesamte Rechenarbeit des Renderers und
läuft deshalb auf mehreren Threads: aufgeteilt nach Bildzeilen über alle Formate
hinweg, gewichtet nach der gemessenen Arbeit je Zeile — ein Format ohne
Zoomreserve wird kopiert statt gefiltert und zählt entsprechend wenig, sonst
warten die Threads, die es gezeichnet haben, auf den Rest. Zusätzlich wird kein
Bild zweimal gerechnet: eine Aufnahme liefert weniger Einzelbilder als das Video
Bilder hat (m1-008: 1332 gegen 2873), und solange Quellbild und Ausschnitt
gleich bleiben, ist das fertige Bild dasselbe — der Zeiger kommt danach darauf.

Gemessen auf der Workstation (16 Threads, unter Last), 300 echte Aufnahmebilder
aus `artifacts/m1-008`, 11,8 Sekunden Video, 709 Ausgabebilder, drei Formate:

|                                     | 1 Thread | 6 Threads | 14 Threads |
| ----------------------------------- | -------- | --------- | ---------- |
| bilinear (Runde 2)                  | —        | 18,2 s    | 16,2 s     |
| Lanczos-3, naiv                     | 190,2 s  | 82,2 s    | 67,3 s     |
| **Lanczos-3, mit Wiederverwendung** | —        | 43,4 s    | **38,3 s** |

Die volle Aufnahme, nicht hochgerechnet sondern gemessen: `artifacts/m1-008`,
47,9 Sekunden Video, 2873 Ausgabebilder, drei Formate, 14 Threads —
**136,7 Sekunden**, also 2,9 Sekunden Rechenzeit pro Sekunde Video, gegen 79
Sekunden mit der bilinearen Variante. Die Zwei-Minuten-Grenze des Meilensteins
hält damit für Material bis rund 42 Sekunden und wird von dieser Aufnahme um
14 % überschritten. **Das ist der bewusst bezahlte Preis für die Schärfe** — nicht ein Versehen: die hohe
Aufnahmeauflösung existiert genau für diesen Filter, und ein weicheres Bild
wäre ein Verlust am Produkt, während eine längere Wartezeit Bequemlichkeit
kostet. Wer das anders gewichtet, hat mit ffmpeg-bicubic (31,24 dB gegen 31,60)
eine messbar benannte Alternative, die etwa halb so lange braucht.

Die Hardware-Annahme steht damit ausdrücklich hier statt implizit im Code:
**gerechnet wird mit einer Maschine, die mindestens acht Kerne hat.** Der
Standard ist „alle Kerne minus zwei" — zwei bleiben für diesen Thread, der den
Dekoder leerzieht und drei Encoder füttert. Auf einer Drei-Kern-Maschine
komponiert der Renderer auf einem einzigen Thread und ist rund fünfmal langsamer
als hier gemessen; die Zwei-Minuten-Grenze hält dort für keine
nennenswerte Aufnahme.

Bildzeilen sind voneinander unabhängig, deshalb hängt das Ergebnis nicht an der
Kernzahl: derselbe Lauf mit einem und mit sechs Threads erzeugt dieselbe Datei,
Byte für Byte. `--threads <n>` stellt es ein, ändert aber nur die Dauer.

### Cursor- und Zoom-Zeitpunkte sind noch falsch — bis Issue #9

Das Ereignis-Log trägt heute **keine Uhrzeit**, sondern einen Zähler: er läuft
weiter für alles, was das Skript selbst tut (Zeigerbewegung, Tippen, `hold`), und
bleibt stehen für alles, was echte Zeit kostet, ohne geplant zu sein — Seiten
laden, auf stabile Geometrie warten, der Umlauf eines Klicks. **Zeiger und Zoom
sitzen deshalb nur bei Aufnahmen richtig, in denen nirgends gewartet wird.**

Der Fehler ist keine gleichmäßige Abweichung, die man mit einem Faktor
geradeziehen könnte, sondern eine Treppe: innerhalb eines Blocks geplanter
Aktionen liegt er bei 11–15 %, zwischen zwei Blöcken springt er in Stufen. In der
Aufnahme `m1-008` sind das nacheinander +25,8 s, +3,2 s, +8,6 s und +2,9 s — nach
62 Sekunden Aufnahme summiert sich der Versatz auf **42,6 Sekunden**. Sichtbar
wird das so: der einzige Zoom dieser Aufnahme rahmt ein leeres Suchfeld 1,64
Sekunden bevor dort etwas passiert, und ist wieder herausgefahren, bevor der
getippte Text erscheint.

Wer ein gerendertes Video sieht und den Zoom an der falschen Stelle findet: das
ist kein Fehler im Zoom, sondern diese fehlende Uhr. [Issue
#9](https://forgejo.philflow.me/Phil/featurecast/issues/9) legt das Log auf die
Uhr der Einzelbilder und räumt es aus dem Weg; die Umrechnung steckt bis dahin in
genau einem kleinen Modul am Rand (`src/render/clock.ts`), das dabei ersatzlos
verschwindet. Die zwei Stellschrauben darin (`originMs`, `rateScale`) verschieben
und kippen eine Gerade — gegen eine Treppe hilft keine von beiden, und eine
dritte kommt nicht dazu.

## Ein Kommando für die ganze Kette

```sh
pnpm featurecast run demo/feature-xy.ts --devices desktop-wide --upload
```

`featurecast run` spielt ein Aufnahme-Skript einmal pro Gerät ab, nimmt die
Einzelbilder auf, rendert sie zu MP4 und lädt sie auf Wunsch in den
S3-kompatiblen Speicher. Ein Skript exportiert dafür den Rumpf der Aufnahme
statt `record()` selbst aufzurufen; Aufbau, Schalter und das vollständige
Beispiel stehen in
[docs/RECORDING-SCRIPTS.md](docs/RECORDING-SCRIPTS.md#ein-kommando-für-die-ganze-kette).

Welches Gerät aufgenommen wird, entscheidet allein sein Name: das aufgelöste
Gerät bringt seine Aufnahmefläche, seine Ausgabegröße und seine
Encoder-Einstellung mit bis in den ffmpeg-Aufruf. Alle drei Desktop-Presets
laufen durch; die mobilen warten weiter auf die Entscheidung über ihre
Aufnahmefläche (M3) und sagen das beim Namen, statt still eine Zahl zu
wählen.

## Entwicklung

```sh
pnpm install
pnpm browsers:install
pnpm demo:hello
```

## M1-Aufnahme wiederholen

Der folgende manuelle Befehl zeichnet eine öffentliche, dichte Testoberfläche
gut 20 Sekunden lang im festgelegten 2560×1600-Capture-Viewport auf. Er
speichert JPEG-Frames, `timestamps.json`, `capture-stats.json` und `browser.json` unter dem
angegebenen Artefaktordner und rendert daraus `output.mp4`. Der Render
schneidet dabei auf 16:9 (`2560×1440`, 160 Pixel unten — oben wird nichts
weggenommen, dort sitzt die Kopfleiste der App) und verkleinert anschließend
auf 1920×1080; es wird nie hochskaliert.

```sh
pnpm demo:m1-capture
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration \
  -of json artifacts/m1-capture/output.mp4
```

Der Befehl ist kein automatisierter Test. Er verwendet standardmäßig
`https://app.onlydash.io/` als öffentliche, zugangsfrei erreichbare OnlyDash-
Gastoberfläche für den dichten UI-Benchmark. Eine abweichende öffentliche URL
und ein Artefaktordner können als erstes und zweites Argument angegeben werden.
Der Artefaktordner muss bei jedem Lauf neu sein oder vorher bewusst gelöscht
werden; die Aufnahme überschreibt bestehende Artefakte nicht. Verwende dafür
einen eindeutigen Pfad als zweites Argument, etwa
`pnpm demo:m1-capture https://app.onlydash.io/ artifacts/m1-capture-001`.

**Welcher Browser aufnimmt.** Ohne weitere Angabe startet Playwrights
mitgelieferter Chromium. Ein anderes Binär — etwa der selbst gebaute,
gepatchte Chromium aus #17 — wird über `CHROME_BIN` gewählt:

```sh
CHROME_BIN=/pfad/zu/chromium/src/out/Release/chrome \
  pnpm demo:m1-capture https://app.onlydash.io/ artifacts/m1-capture-002
```

Ein `CHROME_BIN`, das leer ist oder kein ausführbares Binär benennt, bricht
vor dem Start ab. Nach dem Start wird das tatsächlich laufende Binär beim
Betriebssystem nachgefragt (`/proc`, deshalb nur unter Linux); weicht es vom
angeforderten ab, bricht der Lauf ab. Jeder Lauf schreibt `browser.json` mit
absolutem Pfad, `--version` und SHA-256 des laufenden Binärs in den
Artefaktordner, ebenso `record()` in seinen `out`-Ordner. Der Hash ist das
einzige Feld, das zwei Builds auseinanderhält, die an derselben Stelle
eingehängt sind und dieselbe Versionszeile melden — genau der Fall im
Messplatz, wo jeder Arm seinen Build nach `/crbuild` mountet (#36). Hintergrund: drei Tage Messungen
wurden dem falschen Browser zugeschrieben, weil ein gesetztes `CHROME_BIN`
still ignoriert wurde (#23, [docs/JOURNEY.md](docs/JOURNEY.md)).

Frame-Erfassung und Festplatten-Schreiben sind entkoppelt: `onFrame` reiht nur
synchron ein, ein separater Writer schreibt im Hintergrund, damit ein
langsamer Schreibvorgang die Quellbildrate nicht drosselt (Playwright ackt den
nächsten Screencast-Frame erst, wenn `onFrame` zurückkehrt, und verschluckt
dabei jeden Fehler). Vor dem Zusammenbau werden aufeinanderfolgende
JPEG-Quellframes per SHA-256 auf Duplikate geprüft, und `capture-stats.json`
hält Median- und p95-Bildabstand sowie den Anteil der Abstände ≤ 20 ms fest.
Danach prüft `ffprobe` Auflösung, konstante 60 fps, Dauer gegen die
Aufnahme-Zeitspanne und Frameanzahl gegen eine echte 60-fps-Kodierung dieser
Dauer. Für die M1-Abnahme wird das Ergebnis dennoch angesehen und mit einer
Screen-Studio-Aufnahme verglichen; Aufnahme und Vergleichsmaterial werden vor
dem Teilen auf private Daten geprüft.

Vorarbeit: `research/web-feature-recording-sota-2026-09.md` im Research-Repo — 24 Kandidaten, 18 im Quelltext geprüft, 9 durchgemessen.
