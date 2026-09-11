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

## M1-Aufnahme wiederholen

Der folgende manuelle Befehl zeichnet eine öffentliche, dichte Testoberfläche
gut 20 Sekunden lang im festgelegten 2560×1600-Capture-Viewport auf. Er
speichert JPEG-Frames, `timestamps.json` und `capture-stats.json` unter dem
angegebenen Artefaktordner und rendert daraus `output.mp4`. Der Render
schneidet dabei mittig auf 16:9 (`2560×1440`, 80 Pixel oben und unten) und
verkleinert anschließend auf 1920×1080; es wird nie hochskaliert.

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
