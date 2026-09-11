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

## Ereignis-Log v1

`record({ device?, out, seed? }, async (page, demo) => ...)` legt einen `demo`-Wrapper (`point`, `click`, `tap`, `type`, `hold`, `scroll`) um Playwrights Seite und schreibt daneben ein kanonisches, versioniertes `events.jsonl`. Jede Zeile hat eine feste Feldreihenfolge; die Datei endet immer mit einem Zeilenumbruch. Zwei Läufe desselben Skripts mit demselben `seed` erzeugen bitidentische Dateien — bewiesen gegen einen echten headless Chromium in `tests/record.browser.test.ts`.

Jede Bewegung läuft über die übernommene Minimum-Jerk-Kurve aus `matinee` (Anfahren, Abbremsen, leichtes Überschwingen, Zittern) statt über lineare Interpolation, und wird der Seite bei echten 60 Bildern pro Sekunde vorgespielt: jede Zeigerprobe wartet auf ihren absoluten Zeitpunkt (Start + i/60 s), nicht auf eine aufaddierte Pause, damit sich kein Zeitfehler aufsummiert. Zwischen zwei benachbarten Zeigerproben liegen nie mehr als 20 Pixel — das ist eine Garantie, keine Wahrscheinlichkeit: `src/motion.ts` startet mit einer analytisch hergeleiteten Abtastanzahl und erhöht sie deterministisch weiter, bis die tatsächlich gerenderte, gerundete Kurve die Grenze einhält (gleicher Seed, gleiches Ergebnis). Bei langen Bewegungen kostet das spürbar Zeit — 1500 Pixel brauchen real rund 3,2–4,1 Sekunden, deutlich mehr als `matinee`s ungebremste 1,1 Sekunden, weil dessen Tempo nie für ein 20-Pixel-Limit ausgelegt war. `hold(ms)` legt die Seite für die angegebene Zeit wirklich still, statt nur das Protokoll weiterzuzählen. `type(target, text)` fährt das Feld mit dem Zeiger an, fokussiert es per Klick oder Tap (je nach Gerät) und tippt dann echte Tasten mit einer seed-abhängigen Verzögerung pro Zeichen.

Bevor ein `point`/`click`/`tap`/`type` ein Ziel anfährt, wird dessen Bounding-Box erst dann übernommen, wenn sie ein durchgehendes Zeitfenster lang innerhalb einer kleinen Sub-Pixel-Toleranz stabil war — nicht nur ein paar Stichproben lang, sondern über die volle Fensterdauer, damit eine Drift, die langsamer ist als das Abtastintervall, nicht zufällig als "unverändert" durchrutscht. Das ist unabhängig davon, wodurch sich die Geometrie noch bewegt haben könnte: natives Fenster-Scrollen, ein `overflow:auto`-Container, oder ein per JavaScript animierter Transform (Lenis-artiges Scrollen), der `window.scrollX/Y` nie anfasst. `scroll(dx, dy)` selbst wartet nicht mehr darauf — es kennt sein Ziel nicht —, sondern die nächste Interaktion tut es, wodurch jeder Scroll-Mechanismus abgedeckt ist, nicht nur der Browser-eigene. Wartet die Geometrie zu lange nicht still (eine Seite, die endlos animiert), bricht `record` nach `settleTimeoutMs` (Standard 5000 ms — ausgelegt auf mehrsekündige CSS-Übergänge, wie sie auf echten Marketing-Seiten üblich sind; per `RecordOptions.settleTimeoutMs` einstellbar) mit einer Fehlermeldung ab, die die Option beim Namen nennt.

Weil das Anfahren selbst 0,4 bis über 4 Sekunden dauern kann, reicht "die Geometrie war beim Start stabil" allein nicht: das Ziel kann sich währenddessen bewegen, neu gerendert werden, in der Größe ändern oder von etwas anderem verdeckt werden. Deshalb ist die Interaktion selbstverifizierend. Vor der Bewegung wird der tatsächliche Interaktionspunkt gegen die lebende Seite geprüft — welches Element liegt wirklich an diesen Koordinaten (`document.elementFromPoint`)? —, ist die Bildmitte verdeckt (ein Sticky-Header über dem oberen Teil eines Ziels), probiert eine kleine, feste Reihe weiterer Punkte nahe den Rändern und Ecken der sichtbaren Fläche. Nach der Ankunft wird dieselbe Prüfung wiederholt; hat sich das Ziel währenddessen bewegt, korrigiert ein zweiter, ebenso Pixel-limitierter Bewegungsabschnitt den Rest des Wegs, bevor überhaupt geklickt wird — und die geloggte Bounding-Box wird in jedem Fall unmittelbar vor dem Klick frisch gelesen, nicht nur wenn eine Korrektur gelaufen ist, denn ein Ziel kann um denselben Mittelpunkt wachsen oder sich verschieben, ohne dass der Interaktionspunkt je den Treffertest verliert. Schlägt die Verifikation fehl, bricht `record` mit einer Fehlermeldung ab, statt zu raten. Das ist eine sehr starke, aber keine absolute Garantie: zwischen der letzten Prüfung und dem tatsächlichen `page.mouse.click` liegt noch ein einzelner Netzwerk-Umlauf, in dem sich die Seite theoretisch ein letztes Mal ändern könnte — dieses Fenster ist absichtlich klein gehalten (ein Evaluate-Aufruf statt der vollen 0,4–4 Sekunden Anfahrt), aber nicht auf null reduziert. Ein plausibel aussehender, aber nie ausgeführter Klick ist trotzdem der schlimmste Fehlerfall dieses Werkzeugs: Meilenstein M4 würde später auf ein Ereignis zoomen, das nie passiert ist.

`tick` ist der geplante 60-Hz-Zeitschlitz-Index, nicht Echtzeit, aber ein durchgängiger Zeitmaßstab: alles, was geplante Zeit verbraucht, zählt ihn weiter. Zeigerproben erhöhen ihn um eins pro Probe — auch eine Probe, die auf demselben Pixel wie ihr Vorgänger landet (der Zeiger "hält" kurz), wird protokolliert und zählt einen Schlitz. `hold(ms)` zählt `ceil(ms / 1000 * 60)` weiter, `scroll` einen Schlitz pro 60-Hz-Rad-Inkrement, und `type` die Summe der (seed-abhängigen, also deterministischen) Zeichenverzögerungen in Schlitzen. **Was `tick` nicht kennt:** alles, was echte Zeit kostet, aber nicht selbst geplant ist — `page.goto`, jede `boundingBox()`-Messung samt der Warteschleife auf stabile Geometrie und der Verifikations-Hit-Tests, die Round-Trip-Zeit eines Klicks. Dadurch laufen `tick` und die Wanduhr auseinander: in dieser Session gemessen rund +14–15 % bei einem gewöhnlichen Skript (Klick, Tippen, Hold, Scroll, Klick), und rund das 1,3-Fache bei einem Skript mit einem langsam animierenden inneren Scroll-Container — je nach Animation der Seite kann das deutlich mehr sein. Die Selbstverifikation oben hat diesen Wert in dieser Session nicht spürbar verschlechtert (die zusätzlichen Prüfungen sind klein gegen die ohnehin mehrhundert Millisekunden lange Zeigerbewegung). Das ist kein Bug, sondern der offene Rand dieses Meilensteins: die Abbildung von `tick` auf die echte Capture-Uhr ist Sache von Issue #9, das genau deshalb diese Gleichförmigkeit von `tick` braucht.

Ein Ziel, dessen Bounding-Box gar keine sichtbare Überschneidung mit dem Viewport hat, lässt `record` mit einer Fehlermeldung abbrechen, die auf `demo.scroll` verweist — ein automatisches Scrollen würde einen unsichtbaren Sprung ins Video einbauen. Ist die Box größer als der Viewport (ein hoher Hero-Bereich, ein Overlay) oder teilweise von etwas anderem verdeckt (ein Sticky-Header), wird nicht abgebrochen: der oben beschriebene Punktetest findet die sichtbare, tatsächlich klickbare Stelle, und die volle Bounding-Box bleibt trotzdem im Log stehen. Erst wenn keiner der Prüfpunkte trifft, bricht `record` ab.

`device` wird bereits gegen Playwrights Geräteregistrierung aufgelöst, unter anderem für `hasTouch`, damit `tap` in einem echten Touch-Kontext läuft statt abzustürzen. Ein unbekannter Name bricht mit einer Fehlermeldung ab, die ähnliche oder verfügbare Namen nennt. Die kuratierte Voreinstellungs-Ebene darüber (Aufnahme-/Ausgabeformat, Zeiger-Art) folgt in M5.

## Entwicklung

```sh
pnpm install
pnpm browsers:install
pnpm demo:hello
```

Vorarbeit: `research/web-feature-recording-sota-2026-09.md` im Research-Repo — 24 Kandidaten, 18 im Quelltext geprüft, 9 durchgemessen.
