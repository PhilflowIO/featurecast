# Auffindbarkeit von featurecast

Interne Entscheidungsgrundlage für den Public-Launch auf GitHub. Beantwortet drei Fragen mit
gemessenen Zahlen: Sprache des README, Topics am Repo, Titelzeile und `description`.

Stand: 2026-09-15. Alle Zahlen mit Herkunft in Abschnitt 6.

---

## 1. Empfehlung Sprache

**Englisch. Kein deutsches README, auch nicht als Zweitdatei.**

Das gesamte messbare Nachfrage-Volumen liegt auf Englisch: die Leitbegriffe erreichen in den USA
22.200 ("screen recording software"), 320 ("open source screen recorder") und 260
("screen studio alternative") Suchen im Monat, während die deutschen Entsprechungen bei 40 bis 90
liegen und "produktvideo software" mit 10 faktisch nicht existiert — ein Verhältnis von grob 70:1
beim Kopfbegriff und 3:1 selbst bei den schwächsten englischen Nischenbegriffen. Dazu kommt ein
härteres Signal als Volumen: in der gesamten untersuchten GitHub-Nachbarschaft (22 Repos,
1 Mio. kumulierte Sterne) trägt **kein einziges** Repo ein deutsches README, und die deutsche
Google-Ergebnisseite zum Kernkonzept liefert überhaupt keine Treffer aus diesem Feld, sondern
generische KI-Videogeneratoren — die deutschsprachige Nische ist nicht klein, sie ist leer.

**Gegenprobe, damit die Empfehlung überprüfbar bleibt:** Eine deutschsprachige Nische wäre
tragfähig, wenn deutsche Begriffe mit über ~500 Suchen/Monat existierten oder wenn deutsche
Entwickler-Repos in diesem Feld messbar Sterne zögen. Beides ist nicht der Fall. Sollte sich das
ändern, ist der günstigste Test ein deutschsprachiger Blogpost, der auf das englische Repo zeigt —
nicht ein zweites README.

**Nebenbefund mit Konsequenz für die Zielgruppe:** Die Zielgruppe ist ohnehin nicht "deutscher
Suchender", sondern "Entwickler mit Playwright-Skript". Das Begriffsfeld `playwright screen
recording` hat in den USA nur 20 Suchen/Monat — die Auffindbarkeit läuft für dieses Produkt
**nicht** über Google, sondern über GitHub-Topics und AI-Antworten (siehe Abschnitt 2 und der
GEO-Befund unten). Ein deutsches README würde dort exakt nichts bewegen.

### Der GEO-Befund, der die Topic-Frage wichtiger macht als die Sprachfrage

Für "open source screen studio alternative" ist der **organische Platz 1 ein GitHub-Repo**
(`siddharthvaddem/openscreen`), Googles AI Overview zitiert an erster Stelle dasselbe Repo, und
ChatGPT nennt in seiner Antwort drei GitHub-Repos vor jedem kommerziellen Anbieter. In allen drei
Fällen ist das zitierte Textstück **die `description`-Zeile des Repos**, teils wörtlich
("Free, open-source screen recorder & editor with intelligent cursor tracking, zoom effects, and
cinematic output. A Screen Studio alternative.").

Daraus folgt: Die `description` ist in diesem Feld kein Beiwerk, sondern das Artefakt, das in
AI-Antworten landet. Sie muss die Wörter enthalten, nach denen gefragt wird — "open source",
"Screen Studio alternative", "product demo video", "Playwright".

---

## 2. Empfohlene Topics

GitHub erlaubt 20 Topics. Empfohlen sind 11, in dieser Reihenfolge zu setzen (die ersten Topics
werden in der Repo-Ansicht zuerst gezeigt und sind der Einstieg für Themen-Browsing).

| #   | Topic                       | Warum                                                                                                      |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | `playwright`                | Das einzige Unterscheidungsmerkmal; niemand im Feld belegt es außer `qawolf/playwright-video` (199 Sterne) |
| 2   | `product-demo`              | Trägt `Alexwtlf/agentic-product-demo` (257 Sterne), das nächstliegende Konkurrenzrepo                      |
| 3   | `screen-recording`          | Häufigstes Feldthema: `screen-recorder` 7×, `screen-recording` 2×, `screencast` 2× in der Nachbarschaft    |
| 4   | `screen-studio-alternative` | Der Begriff mit der klarsten kommerziellen Absicht (0,906) und KD 0 — praktisch unbesetzt als Topic        |
| 5   | `demo-video`                | Deckt `demo video maker` (90/Mon., KD 17) und `saas demo video` (KD 1) ab                                  |
| 6   | `video-generation`          | Grenzt gegen Aufnahme-Tools ab; belegt von `snapcndev/snapcn`                                              |
| 7   | `open-source`               | Zweithäufigstes Topic im Feld (6×) und Bestandteil des stärksten Suchbegriffs                              |
| 8   | `ffmpeg`                    | 4× im Feld; Einstieg für alle, die über die Render-Technik suchen                                          |
| 9   | `typescript`                | Sprache des Repos; 2× im Feld, Standard-Filter beim Repo-Browsing                                          |
| 10  | `automation`                | Die eigentliche Kategorie — Video aus Code, wiederholbar; belegt von `better-shot` (2.300 Sterne)          |
| 11  | `motion-design`             | 2× im Feld (`agentic-product-demo`, `snapcn`); trifft Minimum-Jerk-Zeiger und Zoom                         |

**Bewusst nicht gesetzt:** `macos` (6× im Feld, aber featurecast ist plattformunabhängig — ein
falsches Versprechen kostet Sterne), `cleanshot-alternative` und `loom-alternative` (3× bzw. 1×,
aber beide beschreiben Aufnahme-Apps für Menschen, nicht Code), `swift`/`swiftui` (fremder Stack),
`remotion` (2×, aber wir nutzen es nicht — Topic-Squatting fällt auf).

**Vergleich `PhilflowIO/dav-mcp` (33 Sterne, 11 Topics):** `ai-agents, caldav, calendar, carddav,
claude, contacts, mcp, model-context-protocol, n8n, tasks, vtodo`. Das Muster dort ist
dreiteilig — Protokoll/Technik (`caldav`, `carddav`, `vtodo`), Ökosystem-Andockpunkte (`claude`,
`n8n`, `mcp`, `model-context-protocol`) und Nutzensprache (`calendar`, `contacts`, `tasks`).
Die Empfehlung oben spiegelt genau diese Dreiteilung: Technik (`playwright`, `ffmpeg`,
`typescript`), Andockpunkte (`screen-studio-alternative`, `open-source`, `automation`),
Nutzensprache (`product-demo`, `demo-video`, `screen-recording`, `video-generation`,
`motion-design`).

---

## 3. Drei Vorschläge für Titelzeile und Beschreibung

Die Titelzeile ist der fette Nutzensatz ganz oben im README. Die Beschreibung ist das
`description`-Feld am Repo — sie ist zugleich der Text, den AI-Antworten zitieren (Abschnitt 1),
und muss unter 120 Zeichen bleiben.

### Vorschlag A — der Unterschied zuerst (empfohlen)

> **Turn your Playwright script into a product demo video. Nothing is burned into the recording —
> cursor, zoom and captions are rendered afterwards, from a log.**

`description` (113 Zeichen):

```
Turn Playwright scripts into polished product demo videos. Cursor, zoom and captions render after the recording.
```

Warum: Der zweite Satz ist genau die Unterscheidung, die kein Konkurrent behaupten kann, und er ist
in einem Stück zitierbar — das Format, das ChatGPT und AI Overviews in diesem Feld nachweislich
übernehmen. Enthält "Playwright" und "product demo video" als exakte Begriffe.

### Vorschlag B — die Kategorie zuerst

> **An open-source Screen Studio for code: repeatable, versionable product demo videos generated
> from a Playwright script instead of recorded by hand.**

`description` (108 Zeichen):

```
Open-source Screen Studio alternative for developers: product demo videos generated from Playwright scripts.
```

Warum: Bedient direkt "screen studio alternative" (260 Suchen/Mon., Absicht kommerziell mit 0,906,
KD 0) und "open source screen recorder" (320/Mon.). Stärker in der Suche, schwächer im
Alleinstellungsmerkmal — positioniert uns als Variante eines bekannten Dings statt als eigene Idee.

### Vorschlag C — der Schmerz zuerst

> **Change the look of your demo video without re-recording it. One browser run produces raw footage
> plus an event log; cursor, zoom, captions and aspect ratio are a ten-second re-render.**

`description` (117 Zeichen):

```
Product demo videos from Playwright scripts. Restyle, rezoom and reframe in seconds without re-running the browser.
```

Warum: Spricht den konkreten Frust an (jede Änderung = neue Aufnahme) und erwähnt mit "reframe" das
16:9/9:16/1:1-Argument. Schwächer bei den Suchbegriffen — "screen" und "open source" fehlen.

**Empfehlung: A.** Nach Phils Raster gewinnt A, weil es das Produkt in seiner eigenen Sprache
beschreibt statt als Ableitung eines Fremdprodukts (Souveränität), und weil der Satz in sechs
Monaten noch stimmt, auch wenn Screen Studio vom Markt verschwindet (Wartbarkeit). B verworfen:
gewinnt kurzfristig Suchvolumen, bindet die Identität aber an einen fremden Produktnamen.
Der Screen-Studio-Bezug landet stattdessen im Topic (`screen-studio-alternative`) und in einem
Vergleichsabschnitt weiter unten im README — dort kostet er nichts.

---

## 4. Keyword-Tabelle

Volumen = durchschnittliche monatliche Google-Suchen. KD = Keyword Difficulty (0–100).
Leerfelder bedeuten: DataForSEO liefert für diese Kombination keine Daten — nicht "null".

### Englisch (USA)

| Begriff                     | Volumen | Absicht (Wahrsch.)    |  KD | Trend 12 Mon.            |
| --------------------------- | ------: | --------------------- | --: | ------------------------ |
| screen recording software   |  22.200 | informational (0,589) |  60 | fallend (90.500 → 8.100) |
| open source screen recorder |     320 | informational (0,514) |  35 | stabil 260–390           |
| screen studio alternative   |     260 | commercial (0,906)    |   0 | steigend (170 → 320)     |
| product demo video          |     170 | navigational (0,463)  |  18 | fallend                  |
| demo video maker            |      90 | commercial (0,625)    |  17 | stabil                   |
| product demo software       |      70 | commercial (0,967)    |  29 | stabil                   |
| product tour software       |      70 | commercial (0,920)    |   0 | stabil                   |
| interactive product demo    |      40 | navigational (0,604)  |  16 | fallend                  |
| playwright screen recording |      20 | navigational (0,599)  |   – | steigend (10 → 30)       |
| saas demo video             |       – | informational (0,880) |   1 | –                        |
| automated product demo      |       – | navigational (0,435)  |   – | –                        |
| demo automation tool        |       – | transactional (0,652) |   – | –                        |
| automated screen recording  |       – | –                     |   – | –                        |

### Deutsch (Deutschland)

| Begriff                           | Volumen |  KD | Trend 12 Mon.      |
| --------------------------------- | ------: | --: | ------------------ |
| produktvideo erstellen            |     110 |   0 | fallend (260 → 50) |
| screen recorder kostenlos         |      90 |   0 | fallend            |
| erklärvideo software              |      50 |  28 | fallend            |
| bildschirmaufnahme tool           |      50 |   0 | fallend            |
| bildschirmaufnahme software       |      40 |  16 | fallend (50 → 10)  |
| demo video erstellen              |      10 |   – | flach bei 10       |
| software demo video               |      10 |   – | flach bei 10       |
| produktvideo software             |      10 |   – | flach bei 10       |
| produktdemo software              |       – |   – | –                  |
| screen studio alternative deutsch |       – |   – | –                  |

**Lesart:** Kein deutscher Begriff im Feld liegt über 110. Alle mit Daten fallen über zwölf Monate.
Zwei zentrale deutsche Begriffe ("produktdemo software", "screen studio alternative deutsch")
existieren in der Datenbank überhaupt nicht.

### AI-Suchvolumen (Nachfrage innerhalb von LLM-Antworten)

| Begriff                          | AI-Volumen | Trend             |
| -------------------------------- | ---------: | ----------------- |
| open source screen recorder      |         12 | steigend (2 → 12) |
| screen studio alternative        |          8 | steigend (1 → 8)  |
| product demo video tool          |          4 | steigend          |
| playwright screen recording      |          1 | flach             |
| produktvideo erstellen (DE)      |          – | keine Daten       |
| bildschirmaufnahme software (DE) |          – | keine Daten       |

Die absoluten Zahlen sind klein, die Richtung ist eindeutig: Die englischen Begriffe wachsen in
AI-Antworten, für die deutschen liefert die API gar keine Daten.

---

## 5. Nachbarschafts-Tabelle

Top-15 nach Sternen aus dem Feld Bildschirmaufnahme/Produktvideo, darunter die für featurecast
inhaltlich näheren Repos mit weniger Sternen. README-Sprache: **alle englisch**, zwei zusätzlich
chinesisch. Kein deutsches README im gesamten Sample.

| Repo                          | Sterne | Topics                                                                                                                                                                                                                                                   | Beschreibung                                                                                               |
| ----------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| obsproject/obs-studio         | 76.246 | c, c-plus-plus, directshow, facebook-live, ffmpeg, game-capture, live-streaming, screen-capture, twitch-tv, video-recording, youtube-live                                                                                                                | OBS Studio - Free and open source software for live streaming and screen recording                         |
| webadderallorg/Recordly       | 29.001 | electron, free, linux, macos, open-source, screen-recorder, screen-studio, windows                                                                                                                                                                       | Create polished demo videos without editing skills. Mac/Windows/Linux                                      |
| CapSoftware/Cap               | 22.257 | app, cap, coss, loom, mac, nextjs, open-source, oss, react, record, rust, screen-capture, screen-recorder, screenshot, solidjs, tauri, typescript, vite                                                                                                  | Open source Loom alternative. Beautiful, shareable screen recordings.                                      |
| wulkano/Kap                   | 19.354 | aperture, app, capture, communication, electron, javascript, kap, mac, macos, nextjs, open-source, oss, productivity, record, screen-capture, screen-recorder                                                                                            | An open-source screen recorder built with web technology                                                   |
| alyssaxuu/screenity           | 18.692 | annotation, annotation-tool, audio, camera, chrome-extension, design, editor, ffmpeg, javascript, productivity, recorder, screen-capture, screen-recorder, screencast, tensorflow, video                                                                 | The free and privacy-friendly screen recorder with no limits                                               |
| phw/peek                      | 10.552 | apng, gif, gif-recorder, gnome, gtk3, linux, screencast, vala, wayland, webm                                                                                                                                                                             | Simple animated GIF screen recorder with an easy to use interface                                          |
| lihaoyun6/QuickRecorder       |  8.650 | _(keine)_                                                                                                                                                                                                                                                | A lightweight screen recorder based on ScreenCapture Kit for macOS                                         |
| duongductrong/Snapzy          |  3.131 | capture, cleanshot-alternative, recording-app, screenshot, screenshot-capture, swiftui                                                                                                                                                                   | An open-source native macOS screenshot and screen recording app. A CleanShot X alternative.                |
| MaartenBaert/ssr              |  2.892 | _(keine)_                                                                                                                                                                                                                                                | SimpleScreenRecorder, a screen recorder for Linux                                                          |
| KartikLabhshetwar/better-shot |  2.300 | annotation-tool, automation, capture-tool, cleanshot-alternative, cloudflare-r2, loom-alternative, macos, native-macos, ocr, open-source, privacy, raycast, screen-recorder, screencapturekit, screenshot-tool, swift, swiftui, url-scheme, video-editor | Screenshot, screen recording, and video editor for macOS. Open-source alternative to CleanShot X and Loom. |
| fayazara/Screendrop           |  2.030 | cloudflare, macos, swift                                                                                                                                                                                                                                 | A beautiful screenshot + screen recording + Loom alternative - all native, self hostable and free.         |
| jsattler/BetterCapture        |  1.641 | apple, audiorecorder, hevc, macos, prores, screen-capture, screen-recorder, screenrecorder, utility                                                                                                                                                      | The macOS screen recorder for the rest of us - always free and open source                                 |
| lzhgus/Capso                  |  1.329 | annotation, cleanshot-alternative, macos, ocr, open-source, screen-recording, screenshot, swift, swiftui                                                                                                                                                 | Open-source screenshot and screen recording for macOS. The free, native alternative to CleanShot X.        |
| ronaldo-avalos/Maya           |  1.027 | iphone-screen-recordings, macos-app, screen-recordings                                                                                                                                                                                                   | Wrap your iPhone screen recordings in a beautiful device frame, add cinematic zoom moments                 |
| MarconLP/snapify              |  1.016 | _(keine)_                                                                                                                                                                                                                                                | Screen recording sharing for absolutely everyone.                                                          |

### Die inhaltlich nächsten Nachbarn (unter 1.000 Sterne, aber gleiche Idee)

| Repo                                | Sterne | Topics                                                                                                                                                                                                             | Beschreibung                                                                                                    |
| ----------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| tamnguyenvan/screenarc              |    716 | cinematic-video, content-creation, cross-platform, desktop-app, electron-app, ffmpeg, open-source, productivity, react, screen-recorder, screen-recording, tailwindcss, tutorial-videos, typescript, video-editing | Cross-platform screen recorder & editor with automatic cinematic zooms, mouse tracking                          |
| tolmasky/demokit                    |    432 | _(keine)_                                                                                                                                                                                                          | DemoKit is a Library and Electron app for building product demos and tutorials using web technologies           |
| Alexwtlf/agentic-product-demo       |    257 | agent-skills, agentic, claude-code, ffmpeg, motion-design, product-demo, react, remotion, video                                                                                                                    | Create polished product demo videos with AI coding agents and Remotion. The UI is code, not a screen recording. |
| qawolf/playwright-video             |    199 | e2e, e2e-testing, playwright, video-capture                                                                                                                                                                        | Save a video of a Playwright page                                                                               |
| snapcndev/snapcn                    |    192 | library, motion-design, remotion, remotion-video, shadcn, ui, video-generation, videos                                                                                                                             | A shadcn registry of Remotion components for product demo videos                                                |
| greentfrapp/testreel                |     88 | _(keine)_                                                                                                                                                                                                          | Let your LLM agent generate polished product demo videos for web apps, powered by Playwright.                   |
| shreyaskarnik/argo                  |     41 | _(keine)_                                                                                                                                                                                                          | Turn Playwright scripts into polished product demo videos with AI voiceover                                     |
| **PhilflowIO/dav-mcp** _(Referenz)_ |     33 | ai-agents, caldav, calendar, carddav, claude, contacts, mcp, model-context-protocol, n8n, tasks, vtodo                                                                                                             | Transform AI agents into orchestrating assistants managing calendars, contacts, and tasks                       |

**Topic-Häufigkeit über das Sample** (nur Repos mit Topics, absteigend):
`screen-recorder` 7, `open-source` 6, `macos` 6, `screen-capture` 5, `ffmpeg` 4,
`swift`/`swiftui`/`screenshot`/`react`/`productivity`/`cleanshot-alternative` je 3,
`video`/`typescript`/`screen-recording`/`screencast`/`remotion`/`motion-design`/`linux`/
`electron`/`annotation-tool`/`capture`/`app`/`oss`/`ocr`/`nextjs`/`mac`/`javascript`/
`record`/`screenrecorder`/`macos-app` je 2.

**Drei Beobachtungen, die in die Empfehlung eingeflossen sind:**

1. Vier der 15 größten Repos (QuickRecorder 8.650, ssr 2.892, snapify 1.016, demokit 432) tragen
   **gar keine Topics**. Sterne kommen dort über Reddit und Hacker News, nicht über GitHub-Suche.
   Topics sind ein Hebel, kein Garant.
2. Die Beschreibungen der erfolgreichen Repos folgen alle demselben Muster: **Kategorie + freies
   Attribut + Referenzprodukt** ("Open source Loom alternative", "A CleanShot X alternative",
   "The free and privacy-friendly screen recorder"). Vorschlag B in Abschnitt 3 bedient dieses
   Muster; Vorschlag A bricht es bewusst.
3. Die vier Repos, die featurecast inhaltlich am nächsten sind (`testreel` 88, `argo` 41,
   `agentic-product-demo` 257, `snapcn` 192), liegen alle unter 300 Sternen und drei davon haben
   **keine Topics**. Das Feld "Produktvideo aus Code" ist als GitHub-Themenraum praktisch
   unbesetzt — `playwright` + `product-demo` gemeinsam belegt derzeit **kein** Repo.

---

## 6. Herkunft jeder Zahl

Alle Abfragen am **2026-09-15** ausgeführt.

| Datensatz                                                  | Werkzeug                                                    | Abfrage                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Englische Suchvolumina, CPC, Wettbewerb, 12-Monats-Verlauf | DataForSEO MCP `kw_data_google_ads_search_volume`           | 15 Begriffe, `location_name="United States"`, `language_code="en"`                                                                   |
| Deutsche Suchvolumina, 12-Monats-Verlauf                   | DataForSEO MCP `kw_data_google_ads_search_volume`           | 15 Begriffe, `location_name="Germany"`, `language_code="de"`                                                                         |
| Absicht + Wahrscheinlichkeit (englisch)                    | DataForSEO MCP `dataforseo_labs_search_intent`              | 12 Begriffe, `language_code="en"`                                                                                                    |
| Keyword Difficulty englisch                                | DataForSEO MCP `dataforseo_labs_bulk_keyword_difficulty`    | 12 Begriffe, `location_name="United States"`, `language_code="en"`                                                                   |
| Keyword Difficulty deutsch                                 | DataForSEO MCP `dataforseo_labs_bulk_keyword_difficulty`    | 7 Begriffe, `location_name="Germany"`, `language_code="de"`                                                                          |
| AI-Suchvolumen                                             | DataForSEO MCP `ai_optimization_keyword_data_search_volume` | 8 Begriffe, `location_name="United States"`, `language_code="en"`                                                                    |
| GEO: was ChatGPT antwortet und zitiert                     | DataForSEO MCP `ai_optimization_chat_gpt_scraper`           | `"best open source alternative to Screen Studio for product demo videos"`, US/en                                                     |
| GEO: Google AI Overview + organische Ergebnisse (englisch) | DataForSEO MCP `serp_organic_live_advanced`                 | `"open source screen studio alternative"`, US/en, depth 20                                                                           |
| GEO: deutsche Ergebnisseite zum Kernkonzept                | DataForSEO MCP `serp_organic_live_advanced`                 | `"open source produktvideo aus code erstellen"`, DE/de, depth 10                                                                     |
| Repo-Kandidaten des Felds                                  | `gh search repos`                                           | fünf Abfragen: `screen recorder`, `product demo`, `screen recording`, `demo video`, `playwright video`, je `--limit 15 --sort stars` |
| Sterne, Topics, Beschreibung je Repo                       | `gh api repos/<owner>/<name>`                               | 23 Repos einzeln, Felder `stargazers_count`, `topics`, `description`                                                                 |
| Topic-Häufigkeit                                           | lokal ausgezählt                                            | `tr ',' '\n' … \| sort \| uniq -c \| sort -rn` über die 16 Repos mit Topics                                                          |
| Sprache und Stack von featurecast                          | lokal                                                       | `/home/philflow/Dokumente/coding/featurecast/package.json` — TypeScript, Node ≥ 22, pnpm, Playwright                                 |

### Nicht beschaffbare Zahlen

- **README-Sprache maschinell ausgezählt.** Die Sprache wurde aus den `description`-Feldern und
  Repo-Namen abgeleitet, nicht durch Abruf und Spracherkennung jedes README. Der Befund
  "kein deutsches README" ist über 23 Repos belastbar, aber nicht formal gemessen.
- **LLM-Mentions für das Feld.** `ai_opt_llm_ment_top_domains` für `"product demo video"` lieferte
  33 Erwähnungen mit 211 AI-Suchvolumen, die Top-Domains waren jedoch Lebensmittelblogs
  (`grocerslist.com`, `foodbloggerpro.com`, `yumtonight.com`). Der Datensatz ist für dieses Feld
  unbrauchbar und wurde **nicht** in die Empfehlung übernommen. Belastbar ist stattdessen der
  direkte ChatGPT-Abruf und das AI Overview.
- **Deutsches AI-Suchvolumen.** Für alle deutschen Begriffe gibt
  `ai_optimization_keyword_data_search_volume` keine Werte zurück. Ob das Abwesenheit von Nachfrage
  oder fehlende Abdeckung der Datenbank bedeutet, lässt sich aus der API nicht entscheiden.
- **KD für vier englische Begriffe** (`playwright screen recording`, `automated product demo`,
  `demo automation tool`, `automated screen recording`) und drei deutsche
  (`demo video erstellen`, `produktvideo software`, `produktdemo software`) — keine Daten.
