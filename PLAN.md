# Plan

Alles hier Behauptete ist markiert als **gemessen** (ein Kommando lief, die Ausgabe steht im Recherche-Bericht) oder **angenommen** (aus Quelltext gelesen oder gefolgert, noch nicht ausgeführt). Der Bericht dazu liegt unter `~/Dokumente/coding/research/web-feature-recording-sota-2026-09.md`.

---

## Die Entscheidung in einem Absatz

Kein fertiges Open-Source-Werkzeug erfüllt Aufnahmequalität, weiche Maus und Mobile gleichzeitig — alle brennen Cursor und Zoom in die Pixel und nehmen zu niedrig auf (gemessen 215 kbit/s beim meistgelobten Kandidaten). Deshalb bauen wir keine neue Anwendung, sondern eine dünne Schicht um Playwright und übernehmen aus vier Fremdrepos genau die Teile, die dort belegt gut sind: die Bewegungsmathematik, die Zoom-Feder, das Ereignis-Format und die Idee der zwei getrennten Artefakte. Der Rest — Geräte-Auflösung, Render, Garage — ist eigener Code, weil er in keinem der Repos existiert.

---

## Architektur

```
Playwright-Skript (deins)
        │  Interaktionen laufen über den demo-Wrapper
        ▼
┌─ Aufnahme ─────────────────────────────────────────────┐
│  page.screencast  →  frames/*.jpg + timestamps          │
│  demo-Wrapper     →  events.jsonl                       │
│     (Zeigerbahn 60 Hz, Klicks, Bounding-Box des Ziels)  │
└─────────────────────────────────────────────────────────┘
        │   zwei Artefakte, nichts eingebrannt
        ▼
┌─ Nachbearbeitung (parametrisiert, ohne Browser) ───────┐
│  Zoomkurve   Feder aus den Ereignissen → Crop je Frame  │
│  Zeiger      Pfeil oder Touch-Ripple, post-gerendert    │
│  Tempo       Leerlauf-Passagen werden gerafft           │
│  Format      16:9 / 9:16 / 1:1 aus demselben Material   │
│  Encode      ffmpeg, NVENC auf der 3090-Box             │
└─────────────────────────────────────────────────────────┘
        ▼
   Garage (S3-kompatibel)  →  URL
```

Jede Stufe ist einzeln aufrufbar. Aufnehmen und Rendern sind getrennte Kommandos, damit ein Look-Wechsel keinen neuen Browser-Lauf kostet.

---

## Die drei offenen Fragen aus dem Gespräch

### 1. Was macht die Mausbewegung weich?

Zwei Dinge, die man auseinanderhalten muss.

**Wie sich der echte Zeiger bewegt** (das steuert, was die App erlebt — Hover-Zustände, Drag, `mousemove`-Handler): Playwrights `mouse.move(x, y, {steps})` interpoliert linear, das sieht mechanisch aus. Wir ersetzen die Bahn durch eine Kurve mit Anfahren und Abbremsen, leichtem Überschwingen kurz vor dem Ziel und minimalem Zittern. Die beste gefundene Umsetzung ist `matinee/src/motion.ts` (MIT): Minimum-Jerk-Geschwindigkeitsprofil, Zwei-Phasen-Anflug, Tremor aus zwei nicht-kommensurablen Sinus, und der Zufall ist aus einem Startwert abgeleitet — zwei Läufe erzeugen also dasselbe Video, was für Wiederholbarkeit bei jedem Release zählt. Das ist gelesen, nicht gemessen.

**Wie der Zeiger im Video aussieht**: gar nicht über den Browser. Headless-Chromium rendert überhaupt keinen Zeiger (gemessen), und ein ins DOM injizierter Fake-Cursor lebt im Stapel der fremden Seite — er verschwindet hinter Overlays, in Canvas-Flächen und iframes. Wir zeichnen den Zeiger deshalb in der Nachbearbeitung aus dem Ereignis-Log. Vorteil nebenbei: Zeigergröße, Form, Klick-Ripple und Hervorhebung sind Render-Parameter, keine Aufnahme-Eigenschaften.

Verworfen: `ghost-cursor`, die bekannteste Bibliothek. Ihre Kurve ist gut, aber sie liefert im Standard nur rund 33 Stützpunkte mit Sprüngen bis 167 Pixel (gemessen) und wartet zwischen den Punkten nie — die Dauer einer Bewegung hängt an der Netzwerklatenz zum Browser und ist nicht kontrollierbar. Für Video unbrauchbar.

### 2. Mobile — ohne Maus, mit Touch

Ja, der Browser emuliert das vollständig, und zwar mehr als nur die Fenstergröße: Playwright setzt pro Gerät auch `isMobile`, `hasTouch`, den Pixeldichte-Faktor und den User-Agent, sodass Media-Queries, Touch-Events und `@media (hover: none)` echt greifen. Statt `click()` läuft die Interaktion über `page.touchscreen.tap()`, und im Video ersetzt ein aufblühender Touch-Ripple den Pfeil. Der `demo`-Wrapper entscheidet das automatisch am Geräteprofil — dasselbe Skript läuft Desktop und Mobile, ohne Verzweigung im Skript.

**Der ungelöste Teil, ehrlich benannt:** die Aufnahme liefert CSS-Pixel und ignoriert die Pixeldichte (gemessen — bei angeforderter Pixeldichte 2 kamen trotzdem 1280×800 heraus). Ein iPhone 15 Pro hat 393 CSS-Pixel Breite. Eine unbehandelte Aufnahme wäre also 393 Pixel breit und damit für Social-Video unbrauchbar. Drei Wege, alle noch ungeprüft, deshalb ein eigener Meilenstein:

- **Rahmen-Trick**: die App in einem 393 Pixel breiten Rahmen innerhalb einer großen Seite laden und den Rahmen per CSS um Faktor 3 vergrößert darstellen. Die App sieht weiterhin 393 Pixel Layout-Breite, die Rasterung passiert aber in 1179 Pixeln — Text bliebe scharf. Risiko: Eingabe-Koordinaten müssen umgerechnet werden, und Seiten mit `X-Frame-Options` sperren sich.
- **Einzelbild-Aufnahme**: `Page.captureScreenshot` berücksichtigt die Pixeldichte (gemessen, 3840×2160). Ist aber nicht echtzeitfähig — für ruhige Mobile-Demos vielleicht trotzdem gut genug.
- **Hochskalieren im Render**: billig, aber weich. Der Rückfallweg, wenn beides scheitert.

### 3. Geräte als Parameter

Wir erfinden keine Tabelle, sondern nutzen die eingebaute: Playwright liefert **143 Geräteprofile** (gemessen) mit Viewport, Pixeldichte, Touch-Fähigkeit und Browser-Engine. Darüber legen wir eine eigene, kleine Ebene — was zum Aufnehmen fehlt: Aufnahme-Auflösung, Ausgabeformat, Zeiger-Art, Bildrate, Encoder-Qualität. Ein Gerät ist damit ein Name im Aufruf, eine Zeile in einer Konfigurationsdatei, und später ohne weitere Arbeit ein Eintrag in einem Dropdown. Details und die kuratierte Vorauswahl in [docs/DEVICES.md](docs/DEVICES.md).

---

## Was wir übernehmen statt zu bauen

Alle vier sind MIT-lizenziert, also übernehmbar. Übernommene Dateien behalten ihren Lizenz-Header und werden in `THIRD-PARTY.md` mit Quelle und Commit geführt.

| Von wo | Was genau | Warum nicht selbst |
|---|---|---|
| `benhowdle89/matinee` | `src/motion.ts` — Minimum-Jerk-Bewegung, Überschwingen, Tremor, seeded | Beste gefundene Bewegungsmathematik, rahmenwerk-frei und bereits bildraten-parametrisiert |
| `pythonlearner1025/Screen-Studio-Effects` | `spring.ts`, `zoom.ts`, `auto-zoom.ts` — Zoomfeder, Ruhe-Erkennung | Gemessen glatte Kurve (max. 0,024 Änderung pro Bild bei 60 fps), analytisch gelöst statt integriert, also bildraten-unabhängig reproduzierbar. **Achtung:** fest verdrahteter Faktor 2 in `cursor.ts:45-46`, muss beim Übernehmen parametrisiert werden; keine Tests im Repo |
| `connerkward/screenstudio-alt-skill` | Ereignis-Schema inkl. `bbox`, Idle-Raffung, 9:16-Logik | Das `bbox`-Feld rahmt den Zoom auf das echte Element statt auf einen Punkt — und Playwright liefert diese Box gratis mit |
| `smallstack/playwright-marketing-videos` | Muster für den Einstieg in `page.screencast` | Einziges Repo, das die neue Aufnahme-Schnittstelle überhaupt nutzt |

Aus `45ck/demo-machine` übernehmen wir nur das Muster der sauberen Trennung von Rohvideo und Ereignisdatei, keinen Code — dessen Aufnahmequalität ist der Ausschlussgrund.

---

## Festgelegte technische Entscheidungen

**Aufnahme über `page.screencast`**, nicht über `recordVideo`. Gemessen: 60,0 Bilder pro Sekunde bei frei wählbarer Qualität, gegenüber `recordVideo` mit 25 Bildern, von denen nur 121 von 173 überhaupt unterschiedlich waren.

**Desktop wird übergroß aufgenommen** (2560×1600 CSS-Pixel) und im Render auf 1920 verkleinert. Das ist der einzige Weg zu scharfem Text, weil die Aufnahme die Pixeldichte ignoriert, und schenkt nebenbei 1,33-fache Zoom-Reserve bei voller Schärfe.

**Zoom ist ein Ausschnitt aus dem Original, nie eine Vergrößerung.** Jedes geprüfte Werkzeug macht hier denselben Fehler und skaliert hoch.

**Keine virtuelle Zeit.** Der `timecut`-Ansatz friert die Uhr ein und bricht dabei an CSS-Übergängen und Backend-Latenz (gemessen: eine Ein-Sekunden-Animation lief über 0,37 Sekunden ab). Für eine moderne App unbrauchbar.

**Encode auf der 3090-Box.** Die geprüfte Nachbearbeitungskette braucht 1 Minute 45 für 8 Sekunden 1080p60 auf CPU (gemessen). Das ist der Grund für NVENC, nicht Bequemlichkeit.

**Garage von Anfang an**, nicht nachgereicht: Upload als eigene Stufe mit Zugangsdaten aus der Umgebung, Ausgabe ist eine URL. Kein geprüftes Werkzeug bringt das mit.

---

## Offene Risiken

- Die empfohlene Kette ist in zwei Hälften gemessen, nie als Ganzes. Der Übergang von den Aufnahme-Ereignissen in die Zoom-Stufe ist die wahrscheinlichste Bruchstelle.
- Keine einzige Aufnahme wurde bisher **angesehen**. Alle Qualitätsaussagen stützen sich auf Messwerte. Ob 2560 verkleinert auf 1920 wirklich hochwertig aussieht, entscheidet M1.
- Alle Messungen liefen gegen Testseiten, nie gegen eine echte, dichte Anwendungsoberfläche. Bitraten an weißem Hintergrund sagen wenig.
- Mobile in Schärfe ist ungelöst (siehe oben) und kann im schlechtesten Fall auf Hochskalieren hinauslaufen.
