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

Der Grund für die getrennte Aufnahme-Ebene ist der zentrale Befund der Recherche: **die Aufnahme liefert CSS-Pixel und ignoriert die Pixeldichte.** Ein Geräteprofil allein bestimmt also nicht die Videoauflösung — bei einem iPhone-Profil wären es 393 Pixel Breite. Die Aufnahme-Ebene ist die Stelle, an der das korrigiert wird.

## Kuratierte Vorauswahl

Werte direkt aus Playwrights Registry gezogen. `Aufnahme` und `Ausgabe` sind unsere Vorgaben und noch nicht erprobt — sie sind der Gegenstand von M1 und M3.

| Preset                                  | Viewport (CSS) | Dichte | Touch | Engine   | Aufnahme   | Ausgabe   | Zeiger |
| --------------------------------------- | -------------- | ------ | ----- | -------- | ---------- | --------- | ------ |
| `desktop` → Desktop Chrome HiDPI        | 1280×720       | 2      | –     | chromium | 2560×1440  | 1920×1080 | Pfeil  |
| `desktop-wide` → Desktop Chrome         | 1280×720       | 1      | –     | chromium | 2560×1600  | 1920×1200 | Pfeil  |
| `safari` → Desktop Safari               | 1280×720       | 2      | –     | webkit   | 2560×1440  | 1920×1080 | Pfeil  |
| `iphone` → iPhone 15 Pro                | 393×659        | 3      | ja    | webkit   | offen (M3) | 1080×1920 | Touch  |
| `iphone-max` → iPhone 15 Pro Max        | 430×739        | 3      | ja    | webkit   | offen (M3) | 1080×1920 | Touch  |
| `iphone-small` → iPhone SE              | 320×568        | 2      | ja    | webkit   | offen (M3) | 1080×1920 | Touch  |
| `iphone-quer` → iPhone 15 Pro landscape | 734×343        | 3      | ja    | webkit   | offen (M3) | 1920×1080 | Touch  |
| `android` → Pixel 7                     | 412×839        | 2,625  | ja    | chromium | offen (M3) | 1080×1920 | Touch  |
| `android-small` → Galaxy S24            | 360×780        | 3      | ja    | chromium | offen (M3) | 1080×1920 | Touch  |
| `tablet` → iPad Pro 11                  | 834×1194       | 2      | ja    | webkit   | offen (M3) | 1200×1600 | Touch  |
| `tablet-small` → iPad Mini              | 768×1024       | 2      | ja    | webkit   | offen (M3) | 1200×1600 | Touch  |

Jeder der 143 Playwright-Namen funktioniert zusätzlich direkt, auch ohne Preset. Die Vorauswahl existiert nur, damit ein späteres Dropdown elf sinnvolle Einträge hat statt 143.

## Engine-Hinweis

Die iPhone- und iPad-Profile laufen laut Registry unter WebKit. Ob die Aufnahme-Schnittstelle dort ebenso funktioniert wie unter Chromium, ist **ungeprüft** — sie ist eine Playwright-Funktion, aber der darunterliegende Mechanismus ist Chromium-nah. Falls WebKit ausfällt, bleibt der Weg, dieselben Geräte-Kennwerte unter Chromium zu fahren: das Layout stimmt dann, die Engine-Eigenheiten von Safari fehlen. Für Marketing-Material ist das vertretbar, für Tests wäre es das nicht. Wird in M3 entschieden.
