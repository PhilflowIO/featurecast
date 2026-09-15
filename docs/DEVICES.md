# Geräte

Ein Gerät ist ein Name im Aufruf. Alles andere — Fenstergröße, Pixeldichte, Touch statt Maus, Seitenverhältnis des Videos, Zeigerdarstellung — leitet sich daraus ab.

```ts
await record({ device: 'iPhone 15 Pro' }, script) // Preset
await record({ device: 'Pixel 7', aspect: '9:16' }, script) // Preset, Format überschrieben
await record(
  {
    device: {
      extends: 'Desktop Chrome HiDPI',
      capture: { width: 3200, height: 2000 },
    },
  },
  script,
)
```

## Woher die Werte kommen

Playwright bringt **143 Geräteprofile** mit (gemessen am ausgecheckten `playwright-core`). Die liefern den unteren, harten Teil: Viewport, Pixeldichte, `isMobile`, `hasTouch`, User-Agent und die passende Browser-Engine. Diese Liste schreiben wir nicht ab — sie wird zur Laufzeit aus Playwright gelesen, damit sie mit jedem Update aktuell bleibt.

Was Playwright nicht weiß, weil es ums Testen geht und nicht ums Filmen, legen wir darüber:

| Ebene       | Felder                                                                                     | Quelle                  |
| ----------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| Gerät       | `viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`, `defaultBrowserType` | Playwright, unverändert |
| Aufnahme    | `capture.width/height` (die tatsächlich aufgenommene Fläche), `fps`, `quality`, `strategy` | eigene Ebene            |
| Ausgabe     | `aspect` (16:9 / 9:16 / 1:1), `output.width/height`, `crf` bzw. NVENC-Stufe                | eigene Ebene            |
| Darstellung | `pointer` (`arrow` \| `touch` \| `none`), Zeigergröße, Ripple-Farbe                        | eigene Ebene            |

**Desktop wird absichtlich größer aufgenommen als ausgegeben.** Alle drei Desktop-Presets nehmen 2560×1600 auf — mehr, als jedes ihrer Ausgabeformate braucht. Der Rand ist kein Puffer, sondern die Voraussetzung für zwei Dinge, die ohne ihn nicht existieren können: M4 schneidet mehrere Formate aus **demselben** Rohmaterial, ohne den Browser ein zweites Mal laufen zu lassen, und die Zoomfeder rahmt bei jedem Klick das getroffene Element — sie fährt in der Aufnahme umher, statt hochzuskalieren. Aus einer Aufnahme, die schon die Ausgabegröße hat, lässt sich beides nicht holen. Dieselbe Entscheidung steht in [PLAN.md](../PLAN.md).

Was aus 2560×1600 ohne Hochskalieren herausfällt: 16:10 (1920×1200) mit 1,33-facher Reserve, 16:9 (1920×1080) mit 1,33-fach in der Breite und 1,48-fach in der Höhe, 1:1 (1080×1080) mit 1,48-fach. Was **nicht** herausfällt: **9:16 (1080×1920).** Der höchste 9:16-Ausschnitt aus einem 1600 Pixel hohen Bild ist 900×1600 und müsste um das 1,2-fache vergrößert werden — genau das, was diese Kette nirgends tut. Hochkant-Ausgabe ist Sache der mobilen Presets.

Der Grund für die getrennte Aufnahme-Ebene ist der zentrale Befund der Recherche: **die Aufnahme liefert CSS-Pixel und ignoriert die Pixeldichte.** Ein Geräteprofil allein bestimmt also nicht die Videoauflösung — bei einem iPhone-Profil wären es 393 Pixel Breite. Die Aufnahme-Ebene ist die Stelle, an der das korrigiert wird.

**Mobil wird deshalb anders aufgenommen als Desktop, nicht nur kleiner.** Ein Touch-Profil wird durch eine Hülle gefilmt: das aufgenommene Dokument hat die Größe des Videos, die Anwendung darin liegt in der Breite des Geräts und wird per CSS-Transformation vergrößert gezeichnet — und dabei neu gerastert, also scharf. Die Hülle wird vom Ursprung der Anwendung selbst ausgeliefert, sonst verliert die Anwendung ihren Speicher und zeichnet nichts. Aufnahme- und Ausgabefläche sind hier **gleich groß**, ohne die Desktop-Reserve; beides gemessen und begründet in [M3-VERDICT.md](M3-VERDICT.md).

## Kuratierte Vorauswahl

Werte direkt aus Playwrights Registry gezogen. `Aufnahme` und `Ausgabe` sind unsere Vorgaben; beide sind inzwischen erprobt (M1 für Desktop, M3 für mobil).

| Preset                                  | Viewport (CSS) | Dichte | Touch | Engine   | Aufnahme    | Ausgabe   | Zeiger |
| --------------------------------------- | -------------- | ------ | ----- | -------- | ----------- | --------- | ------ |
| `desktop` → Desktop Chrome HiDPI        | 1280×720       | 2      | –     | chromium | 2560×1600   | 1920×1080 | Pfeil  |
| `desktop-wide` → Desktop Chrome         | 1280×720       | 1      | –     | chromium | 2560×1600   | 1920×1200 | Pfeil  |
| `safari` → Desktop Safari               | 1280×720       | 2      | –     | webkit   | 2560×1600   | 1920×1080 | Pfeil  |
| `iphone` → iPhone 15 Pro                | 393×659        | 3      | ja    | webkit   | 1080×1920 R | 1080×1920 | Touch  |
| `iphone-max` → iPhone 15 Pro Max        | 430×739        | 3      | ja    | webkit   | 1080×1920 R | 1080×1920 | Touch  |
| `iphone-small` → iPhone SE              | 320×568        | 2      | ja    | webkit   | 1080×1920 R | 1080×1920 | Touch  |
| `iphone-quer` → iPhone 15 Pro landscape | 734×343        | 3      | ja    | webkit   | 1920×1080 R | 1920×1080 | Touch  |
| `android` → Pixel 7                     | 412×839        | 2,625  | ja    | chromium | 1080×1920 R | 1080×1920 | Touch  |
| `android-small` → Galaxy S24            | 360×780        | 3      | ja    | chromium | 1080×1920 R | 1080×1920 | Touch  |
| `tablet` → iPad Pro 11                  | 834×1194       | 2      | ja    | webkit   | 1200×1600 R | 1200×1600 | Touch  |
| `tablet-small` → iPad Mini              | 768×1024       | 2      | ja    | webkit   | 1200×1600 R | 1200×1600 | Touch  |

`R` markiert die Aufnahmen, die durch die Hülle laufen (Strategie `framed-scale`) — genau die Touch-Profile. Jeder der 143 Playwright-Namen funktioniert zusätzlich direkt, auch ohne Preset. Die Vorauswahl existiert nur, damit ein späteres Dropdown elf sinnvolle Einträge hat statt 143.

## Engine-Hinweis

Die iPhone- und iPad-Profile laufen laut Registry unter WebKit. Ob die Aufnahme-Schnittstelle dort ebenso funktioniert wie unter Chromium, ist **weiterhin ungeprüft**: M3 hat alles unter Chromium mit dem iPhone-Profil gemessen. Das ist genau der Weg, der offenstand — dieselben Geräte-Kennwerte unter Chromium fahren: das Layout stimmt, die Engine-Eigenheiten von Safari fehlen. Für Marketing-Material ist das vertretbar, für Tests wäre es das nicht.

## Umsetzung (M5)

Der Code steht in [`src/devices.ts`](../src/devices.ts); Einstiegspunkt ist `resolveDevice(spec)`, das aus einem Namen, einem Preset oder einem Preset samt Überschreibungen die vollständige Beschreibung erzeugt. Die Anbindung an `record()` ist noch nicht gezogen — wie sie gedacht ist, steht im Modul-Kopfkommentar.

Vier Punkte, die beim Bauen konkret entschieden werden mussten:

**Die Registry ist größer als hier notiert.** Das ausgecheckte `playwright` 1.63.0 liefert **207** Namen (107 Geräte plus 100 `… landscape`-Varianten), nicht die oben notierten 143. Die elf kuratierten Namen und alle Kennwerte der Tabelle stimmen weiterhin exakt mit der Registry überein — geprüft im Test. Genau diese Abweichung ist der Grund, die Liste zur Laufzeit zu lesen.

**`aspect` ist Eingabe-Abkürzung und abgeleitetes Etikett, kein gespeichertes Feld.** Zwei Presets tragen Ausgabegrößen, die zu keinem der drei Seitenverhältnisse passen: `desktop-wide` mit 1920×1200 (16:10) und `tablet`/`tablet-small` mit 1200×1600 (3:4). Gespeichert wird deshalb nur `output.width`/`height`; `aspect: '9:16'` im Aufruf setzt beide aus einer festen Tabelle (1920×1080 / 1080×1920 / 1080×1080), und `aspectOf()` liefert das Etikett zurück oder `null`. Ein zusätzlich gespeichertes `aspect` würde bei diesen beiden Presets der gespeicherten Pixelgröße widersprechen.

**„Aufnahme: offen (M3)" gibt es nicht mehr.** Bis zum 2026-09-15 trugen die acht mobilen Presets einen eigenen Zustand `pending`, der bei Benutzung mit Nennung des Meilensteins abbrach. M3 hat die Frage beantwortet, also ist der Zustand entfallen — mitsamt den beiden Strategien, die gemessen und verworfen wurden. Was offen war, steht jetzt als Ergebnis in [M3-VERDICT.md](M3-VERDICT.md) und nicht als toter Zweig im Code.

**Zeiger folgt `hasTouch`.** Die Zeiger-Spalte der Tabelle ist genau die Touch-Fähigkeit des Profils (Pfeil auf den drei Desktop-Profilen, Touch auf den acht mobilen), also wird sie abgeleitet statt ein zweites Mal aufgeschrieben. Zeigergröße (24 px) und Ripple-Farbe sind überschreibbare Platzhalter und gehören M4; `crf 23` ist keine neue Wahl, sondern der Vorgabewert von libx264 und damit das, was die bestehende Zusammenbau-Stufe ohnehin schon erzeugt.
