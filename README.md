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

Stand: M0 ist umgesetzt: TypeScript, Playwright, Formatierung und ein Smoke-Demo sind lauffähig. Die Aufnahme-, Wrapper- und Render-Stufen folgen den Meilensteinen. [PLAN.md](PLAN.md) beschreibt Architektur und belegte Entscheidungen, [MILESTONES.md](MILESTONES.md) die Ziele in Reihenfolge, [docs/DEVICES.md](docs/DEVICES.md) das Geräte-Konzept.

## Entwicklung

```sh
pnpm install
pnpm browsers:install
pnpm demo:hello
```

Vorarbeit: `research/web-feature-recording-sota-2026-09.md` im Research-Repo — 24 Kandidaten, 18 im Quelltext geprüft, 9 durchgemessen.
