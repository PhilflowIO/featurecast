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

**Ein Video entsteht dabei nicht.** `record()` selbst schreibt nur das
Ereignis-Log. Wer ein Video will, ruft nicht `record()` auf, sondern
`featurecast run` — siehe [Ein Kommando für die ganze
Kette](#ein-kommando-für-die-ganze-kette) weiter unten.

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
— unter `featurecast run` — in einen `prepare`-Schritt, der die volle
Playwright-Seite bekommt und außerhalb des Aufnahmefensters läuft.

Und eine Eigenheit, die schnell beißt: `page.evaluate` nimmt hier eine
Funktion **ohne Argumente**. Werte aus dem Skript kommen nicht als Parameter
in die Seite, sie müssen in den Text der Funktion hinein.

## Ein Kommando für die ganze Kette

`featurecast run` nimmt ein Aufnahme-Skript, spielt es einmal pro Gerät ab,
nimmt dabei die Einzelbilder auf, schickt sie durch die Nachbearbeitung —
Zoom, Zeiger, Leerlauf-Raffung — und lädt das Ergebnis auf Wunsch hoch.

Geliefert wird die eine Größe, die das Gerät verspricht; `--all-formats`
macht daraus 16:9, 9:16 und 1:1 aus derselben Aufnahme. Neben dem
Aufnahme-Ordner entsteht ein zweiter mit den Videos und `decisions.json`.

```sh
pnpm featurecast run demo/feature-xy.ts --devices desktop-wide --upload
```

Dafür sieht ein Skript anders aus als oben: es **exportiert den Rumpf der
Aufnahme, statt `record()` selbst aufzurufen**. Browser, Gerät und die
Bildaufnahme drumherum gehören dem Kommando; ein Modul, das beim Laden
`record()` aufruft, würde einen zweiten, nicht aufgenommenen Browser öffnen.

```ts
import type { Demo, RecordPage } from '../src/record.js'

export default async function featureXy(page: RecordPage, demo: Demo) {
  await page.goto('https://app.example.com/feature')
  await demo.click('#nav-settings')
  await demo.scroll(0, 900)
}
```

Ein vollständiges Beispiel liegt in
[`demo/feature-xy.ts`](../demo/feature-xy.ts). Statt `default` geht auch ein
Export namens `recording`.

Ein drittes, optionales Export: **`url` nennt die Anwendung**, die gefilmt
wird. Für ein Zeigergerät ist das freiwillig — das Skript navigiert selbst
dorthin —, für ein Touch-Gerät ist es Pflicht, weil die Hülle, in der die
Anwendung gefilmt wird, von deren eigenem Ursprung ausgeliefert wird
([`src/framed.ts`](../src/framed.ts)). Fehlt sie, bricht die Kette ab, bevor
ein Browser startet.

### Was ein Skript über den Browser-Kontext sagen darf

Drei weitere Exporte beschreiben nicht die Aufnahme, sondern den Kontext,
in dem sie stattfindet. Sie stehen im Vertrag, weil ein Skript sie gar
nicht selbst setzen _kann_: es bekommt eine bereits geöffnete Seite, und
alle drei müssen gelten, bevor diese Seite existiert.

| Export             | Typ        | Bedeutung                                                                   |
| ------------------ | ---------- | --------------------------------------------------------------------------- |
| `storageStatePath` | `string`   | Pfad zu einer gespeicherten Anmeldung (`storageState`) — nie ihr Inhalt     |
| `hideSelectors`    | `string[]` | Flächen, die verschwinden, bevor die Seite ihre eigenen Skripte fährt       |
| `fixedTime`        | `string`   | Zeitpunkt, den jede Aufnahme behauptet; friert zusätzlich `Math.random` ein |

```ts
import type { Demo, RecordPage } from '../src/record.js'

export const url = 'https://app.example.com'
export const storageStatePath = 'auth/state.json'
export const hideSelectors = ['#cookie-banner', '#internal-address-card']
export const fixedTime = '2026-01-15T09:00:00Z'

export default async function liste(page: RecordPage, demo: Demo) {
  await page.goto('https://app.example.com/meetings')
  await demo.click('#row-3')
}
```

```sh
pnpm featurecast run demo/meine-aufnahme.ts --devices desktop-wide
```

Falsch geschriebene Werte werden abgelehnt, bevor ein Browser startet, und
die Meldung nennt Datei und Export. Das ist kein Formalismus: ein
`hideSelectors`, das versehentlich eine einzelne Zeichenkette ist, würde im
Browser anstandslos angenommen, nichts ausblenden — und die Aufnahme wäre
tadellos bis auf die Karte, die nicht hinein durfte.

Ein vollständiges Beispiel, das gegen die echte Anwendung läuft, ist
[`demo/raven-meetings.ts`](../demo/raven-meetings.ts).

| Schalter    | Bedeutung                                                                  |
| ----------- | -------------------------------------------------------------------------- |
| `--devices` | Kommaliste aus Presets und Playwright-Namen. Pflichtangabe.                |
| `--out`     | Wurzelordner; je Gerät ein Unterordner. Standard `artifacts/<Skriptname>`. |
| `--upload`  | Lädt jedes fertige Video hoch und gibt die URL aus.                        |
| `--encoder` | `x264` (Standard), `nvenc-h264`, `nvenc-hevc`.                             |
| `--seed`    | Startwert für Bewegung und Tippverzögerung. Standard `1`.                  |

Die Zugangsdaten für `--upload` kommen ausschließlich aus der Umgebung
(`.env.example` nennt die Variablen). Fehlt eine, bricht der Lauf ab, **bevor**
der erste Browser startet — ein Fehler, der zu Beginn erkennbar ist, soll
nicht erst nach Aufnahme und Encode auffallen.

**Ein Gerät, das abbricht, stoppt die anderen nicht.** Jeder Fehler wird
gesammelt und am Ende mit der Stufe genannt, die ihn abgelehnt hat; der
Rückgabewert des Kommandos ist dann ungleich null. Eine Aufnahme sind
Minuten Arbeit, und eine fertige wegzuwerfen, um das Problem eines anderen
Geräts früher zu melden, hilft niemandem.

**Was heute wirklich durchläuft.** Nur `desktop-wide`. Jedes mobile Preset
bricht mit dem M3-Hinweis ab (die Aufnahmefläche ist dort nicht entschieden),
und `desktop` wie `safari` verlangen eine Aufnahmefläche von 2560×1440,
während `src/capture.ts` fest 2560×1600 aufnimmt. Welche der beiden Zahlen
gilt, ist zwischen [PLAN.md](../PLAN.md) und [DEVICES.md](DEVICES.md) offen
(siehe [CAPTURE-CADENCE.md](CAPTURE-CADENCE.md)) — das Kommando nennt den
Konflikt, statt still eine der beiden Zahlen zu wählen. Das M6-Abnahmebeispiel
`--devices desktop,iphone` ist deshalb heute nicht erfüllbar.

## Rezept: angemeldet aufnehmen

Eine angemeldete Aufnahme ist ein gewöhnliches Skript der Hauptkette: es
nennt die gespeicherte Sitzung, und `featurecast run` stellt den Kontext
her, filmt und rendert.

```ts
export const storageStatePath = 'auth/state.json'
export const hideSelectors = ['#cookie-banner', '#internal-address-card']
export const fixedTime = '2026-01-15T09:00:00Z'

export default async function featureXy(page: RecordPage, demo: Demo) {
  await page.goto('https://app.example.com/feature')
  await demo.click('#nav-settings')
}
```

Bis diese drei Exporte zum Vertrag gehörten, lag daneben ein zweiter
Aufnahmeweg in `demo/`, der seinen Browser selbst aufmachte, um sie zu
setzen — und der schrieb ein Ereignis-Log und kein einziges Bild. Es gibt
ihn nicht mehr; für eine angemeldete Aufnahme gibt es keinen Grund mehr, an
der Hauptkette vorbeizuarbeiten.

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

### Oder die Sitzung in einem eigenen Anmeldeschritt

Ein Ziel mit einem gewöhnlichen Anmeldeformular braucht dafür keinen
Menschen. `demo/raven-meetings.ts` trennt das in zwei Aufrufe: die
Anmeldung meldet sich kopflos an und schreibt `auth/state.json`, danach
läuft die Aufnahme wie jede andere über `featurecast run`.

```sh
RAVEN_DEMO_EMAIL=… RAVEN_DEMO_PW=… pnpm exec tsx demo/raven-meetings.ts anmelden
pnpm featurecast run demo/raven-meetings.ts --devices desktop-wide
```

Die Anmeldung ist bewusst **kein** `prepare`-Export. Der Vertrag kennt
einen Schritt dieses Namens, aber der läuft gegen die schon geöffnete Seite
kurz vor der Aufnahme; die Anmeldung hier ist ein eigener Vorgang mit
eigenem Browser, der Wochen vorher laufen darf und dessen Ergebnis eine
Datei ist.

Zwei Entscheidungen darin sind Absicht und nicht Geschmack.

**Über das Formular, nicht über die Anmelde-Schnittstelle.** Ein
HTTP-Aufruf gäbe dasselbe Sitzungs-Cookie in einem Bruchteil der Zeit, aber
die Oberfläche legt beim Anmelden zusätzlich Zustand im Browser ab. Wer nur
das Cookie holt, filmt beim ersten Lauf einen Zustand, den ein Mensch so nie
zu sehen bekommt.

**Gewartet wird auf die Überschrift, nicht auf die Adresse.** Die Adresse
wechselt, bevor die Liste geladen hat. Ein Zustand, der in diesem Moment
gespeichert wird, kann einen halben Login enthalten — und der Fehler zeigt
sich dann erst in der Aufnahme.

Die Zugangsdaten stehen in keiner Zeile des Skripts. Sie kommen aus der
Umgebung, und sie gehören in einen Secret-Store — aus demselben Grund, aus
dem `auth/` nicht versioniert ist.

## Rezept: Cookie-Banner wegblenden

Zwei Wege, und der erste ist meistens der bessere.

**Über die Sitzung.** Wer beim Erzeugen von `auth/state.json` das Banner
wegklickt, hat den Zustimmungs-Cookie in der Datei. Das Banner erscheint
dann gar nicht erst — nichts muss unterdrückt werden, weil nichts da ist.

**Über ein Init-Skript.** Wenn das nicht greift (Zustimmung serverseitig,
neue Domain, Banner in einem Frame), blendet ein Init-Skript den Knoten aus,
bevor die Seite ihre eigenen Skripte ausführt. Genau das tut der Export
`hideSelectors`: die Kette hängt daraufhin ein `<style>` an jedes Dokument
des Kontexts (`hideOverlay` in [`src/recipes.ts`](../src/recipes.ts)), mit
einer eigenen `display:none !important`-Regel je Selektor.

`hideSelectors` nimmt beliebig viele Selektoren, weil selten nur das Banner
stört — die Produktkarte mit der internen Adresse muss genauso weg. Jeder
Selektor bekommt eine eigene Regel statt eines kommagetrennten
Gruppenselektors: eine Gruppe wird als Einheit geparst, ein einziger
unverstandener Selektor darin lässt den Browser die ganze Regel verwerfen
und nimmt die gültigen Selektoren stillschweigend mit.

Ausblenden statt wegklicken ist Absicht. Ein Klick auf „Akzeptieren“ ist
eine Interaktion, die im Video und im Ereignis-Log steht, und für jede
Aufnahme zwei Sekunden Zeigerbewegung kostet, die niemand sehen will.

## Rezept: Uhrzeit und Zufall einfrieren

Zwei Aufnahmen sehen nur dann identisch aus, wenn die Oberfläche identisch
aussieht. Zwei Dinge sorgen dafür, dass sie es nicht tut: relative
Zeitangaben („vor 3 Minuten“) und alles, was aus `Math.random()` kommt.
Der Export `fixedTime` nagelt beides fest — die Uhr über Playwrights
`clock.setFixedTime`, den Zufall über einen Ersatz für `Math.random` mit
festem Startwert (`freezeTimeAndRandomness` in
[`src/recipes.ts`](../src/recipes.ts)).

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
  kompiliert. So macht es `hideOverlay` in `src/recipes.ts`.

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
- **Mobile über das Kommando** — `featurecast run` gibt es, aber jedes
  mobile Preset bricht mit dem M3-Hinweis ab, und `desktop`/`safari` mit dem
  ungeklärten Streit über die Aufnahmefläche. Aufnehmbar ist heute
  `desktop-wide`.
