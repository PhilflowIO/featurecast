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

Jede Bewegung läuft über die übernommene Minimum-Jerk-Kurve aus `matinee` (Anfahren, Abbremsen, leichtes Überschwingen, Zittern) statt über lineare Interpolation, und wird der Seite bei echten 60 Bildern pro Sekunde vorgespielt: jede Zeigerprobe wartet auf ihren absoluten Zeitpunkt (Start + i/60 s), nicht auf eine aufaddierte Pause, damit sich kein Zeitfehler aufsummiert. Zwischen zwei benachbarten Zeigerproben liegen nie mehr als 20 Pixel; die Kurvendauer wird dafür analytisch aus der Distanz hergeleitet (`src/motion.ts`), nicht geschätzt. `hold(ms)` legt die Seite für die angegebene Zeit wirklich still, statt nur das Protokoll weiterzuzählen. `type(target, text)` fährt das Feld mit dem Zeiger an, fokussiert es per Klick oder Tap (je nach Gerät) und tippt dann echte Tasten mit einer seed-abhängigen Verzögerung pro Zeichen.

`tick` bleibt die deterministische Renderer-Zeitbasis bei 60 fps (Stichproben-Index, nicht Echtzeit): Zeigerproben erhöhen ihn um eins, `hold(ms)` um `ceil(ms / 1000 * 60)`. Die Korrelation mit der echten Capture-Uhr ist Sache eines späteren Capture-Meilensteins (#9).

Ein Ziel, dessen Bounding-Box außerhalb des Viewports liegt, lässt `record` mit einer Fehlermeldung abbrechen, die auf `demo.scroll` verweist — ein automatisches Scrollen würde einen unsichtbaren Sprung ins Video einbauen.

`device` wird bereits gegen Playwrights Geräteregistrierung aufgelöst, unter anderem für `hasTouch`, damit `tap` in einem echten Touch-Kontext läuft statt abzustürzen. Ein unbekannter Name bricht mit einer Fehlermeldung ab, die ähnliche oder verfügbare Namen nennt. Die kuratierte Voreinstellungs-Ebene darüber (Aufnahme-/Ausgabeformat, Zeiger-Art) folgt in M5.

## Entwicklung

```sh
pnpm install
pnpm browsers:install
pnpm demo:hello
```

Vorarbeit: `research/web-feature-recording-sota-2026-09.md` im Research-Repo — 24 Kandidaten, 18 im Quelltext geprüft, 9 durchgemessen.
