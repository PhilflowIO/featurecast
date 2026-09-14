# Ein bestehendes Playwright-Skript zur Aufnahme machen

Diese Anleitung nimmt ein Skript, das es schon gibt — eines aus einer
Test-Suite, eines aus `playwright codegen` — und macht daraus eine
featurecast-Aufnahme. Am Wrapper selbst wird dabei nichts geändert; alles
hier läuft über die öffentlichen Schnittstellen aus `src/record.ts`.

Alles, was hier steht, gilt für den heutigen Stand (M0 und M2). Was noch
nicht entschieden ist, steht am Ende unter [Was es noch nicht
gibt](#was-es-noch-nicht-gibt) — und nicht als Rezept getarnt dazwischen.

## Was dabei herauskommt

`record()` schreibt in den `out`-Ordner zwei Dateien:

- `events.jsonl` — das Ereignis-Log v1: Kopfzeile mit `fps` und `seed`,
  danach die Zeigerbahn in 60 Hertz, Klicks, Taps, Holds, Scrolls und
  Tipp-Ereignisse, jeweils mit der Bounding-Box des getroffenen Elements.
  Aufbau und Garantien: [README.md](../README.md#ereignis-log-v1).
- `browser.json` — welcher Chromium tatsächlich gelaufen ist (Pfad,
  Version, SHA-256 des Binärs).

**Ein Video entsteht dabei nicht.** Die Aufnahme der Einzelbilder
(`src/capture.ts`) und der Zusammenbau zu 60 Bildern pro Sekunde
(`src/assemble.ts`) existieren, sind aber bisher nur in
[`demo/m1-capture.ts`](../demo/m1-capture.ts) von Hand mit dem Wrapper
verdrahtet. Ein Kommando, das Skript, Gerät, Aufnahme, Render und Upload in
einem Zug durchläuft, ist M6.

## Der Umbau

Ein Playwright-Skript wird zur Aufnahme, indem seine Interaktionen statt
über `page` über `demo` laufen. Nur die Interaktionen — Navigation,
Warten und alles Nicht-Sichtbare bleiben, wie sie sind.

```ts
import { record } from '../src/record.js'

await record({ out: 'artifacts/feature-xy', seed: 1 }, async (page, demo) => {
  await page.goto('https://app.example.com/feature')
  await demo.click('#nav-settings')
  await demo.type('#search', 'Rechnung 2026')
  await demo.hold(1200)
  await demo.scroll(0, 900)
  await demo.click('#row-3')
})
```

Die Übersetzung Zeile für Zeile:

| Playwright                 | featurecast            | Unterschied                                              |
| -------------------------- | ---------------------- | -------------------------------------------------------- |
| `page.click(sel)`          | `demo.click(sel)`      | weiche Anfahrt vorher, Klick wird protokolliert          |
| `page.tap(sel)`            | `demo.tap(sel)`        | braucht einen Touch-Kontext                              |
| `page.hover(sel)`          | `demo.point(sel)`      | fährt an, klickt nicht                                   |
| `page.fill(sel, text)`     | `demo.type(sel, text)` | fährt an, fokussiert, tippt echte Tasten mit Verzögerung |
| `page.mouse.wheel(dx, dy)` | `demo.scroll(dx, dy)`  | geglättet auf 60 Hertz, Standardtempo 700 px/s           |
| `page.waitForTimeout(ms)`  | `demo.hold(ms)`        | wartet genauso, zählt aber den Zeitmaßstab weiter        |
| `page.goto(url)`           | `page.goto(url)`       | unverändert                                              |

`demo.scroll` nimmt optional ein Tempo — `demo.scroll(0, 900, { speedPxPerSecond: 400 })` für eine langsamere Enthüllung.

Ein Ziel ist entweder ein CSS-Selektor als Zeichenkette oder ein fertiger
Playwright-Locator. Beides geht überall dort, wo oben `sel` steht.

### Die Optionen, die es gibt

`record()` kennt genau vier:

| Option            | Standard | Bedeutung                                                     |
| ----------------- | -------- | ------------------------------------------------------------- |
| `out`             | —        | Zielordner, Pflichtangabe                                     |
| `seed`            | `1`      | Startwert für Bewegung und Tippverzögerung                    |
| `device`          | keines   | Name aus Playwrights Geräteregistrierung, zur Laufzeit gelöst |
| `settleTimeoutMs` | `5000`   | Budget je Interaktion, bis die Geometrie stillsteht           |

Mehr nicht. Aufnahme- und Ausgabeformat, Zeigerdarstellung und die
kuratierten Presets aus [DEVICES.md](DEVICES.md) sind M5 — was dort in den
Beispielen neben `device` steht, ist Entwurf, nicht Schnittstelle.

### Was `page` im Skript kann — und was nicht

Das `page`, das der Wrapper übergibt, ist bewusst ein schmaler Ausschnitt
der echten Playwright-Seite: `goto`, `locator`, `evaluate`, `keyboard.type`,
`mouse`, `touchscreen`, `viewportSize`, `waitForTimeout`, `hasTouch`.

Alles andere — `waitForSelector`, `waitForResponse`, `expect`, `route`,
`screenshot` — steht dort nicht zur Verfügung. Ein Testskript, das solche
Aufrufe enthält, hat zwei Wege: sie vor den Aufruf von `record()` ziehen
(Einrichten, Aufräumen, Zusicherungen gehören ohnehin nicht ins Video), oder
die echte Seite über eine eigene Laufzeitumgebung mitgeben — genau das tut
das Rezept unten.

Und eine Eigenheit, die schnell beißt: `page.evaluate` nimmt hier eine
Funktion **ohne Argumente**. Werte aus dem Skript kommen nicht als Parameter
in die Seite, sie müssen in den Text der Funktion hinein.

## Rezept: angemeldet aufnehmen

`record()` baut seinen Browser-Kontext selbst und bietet dafür keinen
Parameter an. Eine gespeicherte Sitzung, ein Init-Skript oder eine
eingefrorene Uhr kommen deshalb über die dokumentierte Naht darunter:
`createRecorder(runtime)` nimmt eine eigene Laufzeitumgebung entgegen, die
den Kontext baut und dem Wrapper eine fertige Seite reicht. Dieselbe Naht
benutzt `demo/m1-capture.ts`, um den Wrapper an die Seite zu hängen, die
gerade aufgenommen wird.

Fertig verdrahtet liegt das in
[`demo/recipe-authenticated.ts`](../demo/recipe-authenticated.ts) — Sitzung,
Banner und Uhr in einer Datei, zum Kopieren gedacht:

```ts
import { recordWithRecipes } from './recipe-authenticated.js'

await recordWithRecipes(
  {
    bannerSelector: '#cookie-banner',
    fixedTime: '2026-01-15T09:00:00Z',
    out: 'artifacts/feature-xy',
    storageStatePath: 'auth/state.json',
  },
  async (page, demo) => {
    await page.goto('https://app.example.com/feature')
    await demo.click('#nav-settings')
  },
)
```

### Die Sitzung einmal aufnehmen

Der Sitzungszustand entsteht einmal von Hand, im sichtbaren Browser, und
wird danach wiederverwendet:

```sh
pnpm exec playwright codegen --save-storage=auth/state.json https://app.example.com/login
```

Anmelden, Cookie-Banner wegklicken, Fenster schließen — die Datei enthält
danach Cookies und `localStorage` des angemeldeten Zustands.

`auth/` ist genau dafür reserviert und **absichtlich nicht versioniert**:
`.gitignore` nimmt `auth/*` aus (nur `auth/.gitkeep` bleibt stehen, damit
der Ordner existiert), `.prettierignore` fasst ihn ebenfalls nicht an, und
[AGENTS.md](../AGENTS.md) sagt dasselbe in Worten. Zugangsdaten und
gespeicherte Sitzungen gehören nicht ins Repository. Eine
`storageState`-Datei ist ein Anmeldezustand, kein Konfigurationsartefakt —
wer sie weitergibt, gibt den Zugang weiter.

Sitzungen laufen ab. Wenn eine Aufnahme plötzlich die Anmeldeseite filmt,
ist nicht das Skript kaputt, sondern die Datei alt: den Befehl oben
wiederholen.

## Rezept: Cookie-Banner wegblenden

Zwei Wege, und der erste ist meistens der bessere.

**Über die Sitzung.** Wer beim Erzeugen von `auth/state.json` das Banner
wegklickt, hat den Zustimmungs-Cookie in der Datei. Das Banner erscheint
dann gar nicht erst — nichts muss unterdrückt werden, weil nichts da ist.

**Über ein Init-Skript.** Wenn das nicht greift (Zustimmung serverseitig,
neue Domain, Banner in einem Frame), blendet ein Init-Skript den Knoten aus,
bevor die Seite ihre eigenen Skripte ausführt. `hideOverlay` im Rezept oben
tut genau das: es hängt ein `<style>` mit `display:none !important` für den
übergebenen Selektor an jedes Dokument des Kontexts.

Ausblenden statt wegklicken ist Absicht. Ein Klick auf „Akzeptieren“ ist
eine Interaktion, die im Video und im Ereignis-Log steht, und für jede
Aufnahme zwei Sekunden Zeigerbewegung kostet, die niemand sehen will.

## Rezept: Uhrzeit und Zufall einfrieren

Zwei Aufnahmen sehen nur dann identisch aus, wenn die Oberfläche identisch
aussieht. Zwei Dinge sorgen dafür, dass sie es nicht tut: relative
Zeitangaben („vor 3 Minuten“) und alles, was aus `Math.random()` kommt.
`freezeTimeAndRandomness` im Rezept oben nagelt beides fest — die Uhr über
Playwrights `clock.setFixedTime`, den Zufall über einen Ersatz für
`Math.random` mit festem Startwert.

**Nicht `clock.install()` verwenden.** Das fälscht laut Playwrights eigener
Beschreibung neben `Date` auch `requestAnimationFrame` und `performance` —
und genau diese beiden treiben in der Seite die Messung, mit der der Wrapper
vor jeder Interaktion prüft, ob die Geometrie des Ziels stillsteht
(`observeFrames` in `src/record.ts`). Eine gefälschte Bildschleife liefert
dieser Messung keine Bilder mehr; die Interaktion läuft dann in
`settleTimeoutMs` statt in einen Klick. `setFixedTime` fasst nur `Date` an
und lässt die Bildschleife in Ruhe.

Der eigene Startwert von `record()` (`seed`) deckt etwas anderes ab: die
Zufälligkeit der Zeigerbewegung und der Tippverzögerungen. Gleicher `seed`,
gleiche Bahn. Die Zufälligkeit **der Seite** erreicht er nicht — dafür ist
das Init-Skript da.

## Die Falle, die jedes eingespritzte Skript trifft

Alle Demo-Skripte dieses Repos laufen über `tsx`, und `tsx` kompiliert mit
esbuilds `keepNames`. Das umhüllt jede **benannte** Funktion mit einem
eingefügten `__name(...)`-Aufruf. Playwright serialisiert den Quelltext
einer Nutzlast für `page.evaluate` oder `addInitScript` in die Seite — und
dort gibt es kein `__name`. Ergebnis: `ReferenceError: __name is not
defined`, und zwar nur im echten Lauf, nie in der Vitest-Suite, weil die
ohne `keepNames` übersetzt. `tests/tsx-pipeline.test.ts` fängt genau das ab,
indem es `demo/record-smoke.ts` als echten Unterprozess startet.

Für eigene Nutzlasten heißt das:

- Funktionen anonym halten — `function () { … }` direkt als Argument
  übergeben, nicht `function tick() { … }` und nicht `const tick = () => …`
  (esbuild leitet den Namen auch aus der Zuweisung ab).
- Zuweisung an eine **Eigenschaft** eines bestehenden Objekts ist die eine
  Form, die die Namensableitung nicht erfasst — `Math.random = () => …` ist
  deshalb sicher, und `src/record.ts` nutzt denselben Kniff.
- Am sichersten ist eine Nutzlast als Zeichenkette: die wird nie
  kompiliert. So macht es `hideOverlay`.

## Wenn es abbricht

| Meldung (Auszug)                                        | Ursache und Abhilfe                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `has no visible intersection with the … viewport`       | Das Ziel liegt außerhalb des Bildes. Es wird nicht automatisch gescrollt — ein `demo.scroll` davor. |
| `Target moved during pointer travel …`                  | Das Ziel ist während der Anfahrt weggewandert. Lieber Abbruch als ein Klick, der nie stattfand.     |
| `Unknown device "…". Close names: …`                    | Gerätename nicht in Playwrights Registrierung; die Meldung nennt ähnliche.                          |
| `Target geometry did not settle within settleTimeoutMs` | Die Seite kommt nicht zur Ruhe. Budget erhöhen, oder die Dauer-Animation im Hintergrund abstellen.  |

## Was es noch nicht gibt

Damit niemand danach sucht:

- **Mobile Aufnahmen** — `device` löst zwar schon Playwrights Profile auf,
  aber Hochformat-Video, Touch-Darstellung und die Frage WebKit gegen
  Chromium sind M3.
- **Zoom, gerenderter Zeiger, Raffung, Seitenverhältnisse** — die
  Nachbearbeitung aus dem Ereignis-Log ist M4.
- **Presets und eigene Aufnahme-/Ausgabefelder** — M5.
- **Upload und ein `featurecast`-Kommando** — M6. Bis dahin wird ein
  Aufnahme-Skript direkt über `tsx` gestartet.
