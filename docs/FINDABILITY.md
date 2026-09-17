# Findability of featurecast

The internal basis for deciding the public launch on GitHub. Answers three
questions with measured numbers: the language of the README, the repository's
topics, and the headline and `description`.

As of 2026-09-15. Every number's provenance is in section 6.

---

## 1. Language recommendation

**English. No German README, not even as a second file.**

The entire measurable demand is in English: the leading terms reach 22,200
("screen recording software"), 320 ("open source screen recorder") and 260
("screen studio alternative") searches a month in the US, while the German
equivalents sit at 40 to 90 and "produktvideo software" at 10 effectively does
not exist — a ratio of roughly 70:1 on the head term and 3:1 even on the
weakest English niche terms. On top of that there is a harder signal than
volume: across the whole GitHub neighbourhood examined (22 repositories, 1
million cumulative stars), **not a single** repository carries a German README,
and the German Google results page for the core concept returns no hits from
this field at all, only generic AI video generators — the German-language niche
is not small, it is empty.

**The counter-check, so that the recommendation stays testable:** a
German-language niche would be viable if German terms existed with over ~500
searches a month, or if German developer repositories in this field measurably
attracted stars. Neither is the case. Should that change, the cheapest test is
a German-language blog post pointing at the English repository — not a second
README.

**A side finding with consequences for the audience:** the audience is not
"German searcher" anyway, but "developer with a Playwright script". The term
field `playwright screen recording` has only 20 searches a month in the US —
findability for this product runs **not** through Google but through GitHub
topics and AI answers (see section 2 and the GEO finding below). A German
README would move exactly nothing there.

### The GEO finding that makes the topic question more important than the language question

For "open source screen studio alternative", the **first organic result is a
GitHub repository** (`siddharthvaddem/openscreen`), Google's AI Overview cites
the same repository first, and ChatGPT names three GitHub repositories ahead of
any commercial provider. In all three cases the passage that gets quoted is
**the repository's `description` line**, in places verbatim ("Free,
open-source screen recorder & editor with intelligent cursor tracking, zoom
effects, and cinematic output. A Screen Studio alternative.").

It follows that in this field the `description` is not an accessory but the
artifact that ends up in AI answers. It has to contain the words people ask
with — "open source", "Screen Studio alternative", "product demo video",
"Playwright".

---

## 2. Recommended topics

GitHub allows 20 topics. Eleven are recommended, to be set in this order (the
first topics are shown first in the repository view and are the way into
topic browsing).

| #   | Topic                       | Why                                                                                                                   |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | `playwright`                | The only distinguishing feature; nobody in the field occupies it except `qawolf/playwright-video` (199 stars)         |
| 2   | `product-demo`              | Carried by `Alexwtlf/agentic-product-demo` (257 stars), the nearest competing repository                              |
| 3   | `screen-recording`          | The most common topic in the field: `screen-recorder` 7×, `screen-recording` 2×, `screencast` 2× in the neighbourhood |
| 4   | `screen-studio-alternative` | The term with the clearest commercial intent (0.906) and KD 0 — practically unoccupied as a topic                     |
| 5   | `demo-video`                | Covers `demo video maker` (90/month, KD 17) and `saas demo video` (KD 1)                                              |
| 6   | `video-generation`          | Marks us off from capture tools; occupied by `snapcndev/snapcn`                                                       |
| 7   | `open-source`               | Second most common topic in the field (6×) and part of the strongest search term                                      |
| 8   | `ffmpeg`                    | 4× in the field; the way in for everyone searching by render technique                                                |
| 9   | `typescript`                | The repository's language; 2× in the field, a standard filter when browsing repositories                              |
| 10  | `automation`                | The actual category — video from code, repeatable; occupied by `better-shot` (2,300 stars)                            |
| 11  | `motion-design`             | 2× in the field (`agentic-product-demo`, `snapcn`); matches the minimum-jerk pointer and the zoom                     |

**Deliberately not set:** `macos` (6× in the field, but featurecast is
platform-independent — a false promise costs stars), `cleanshot-alternative`
and `loom-alternative` (3× and 1× respectively, but both describe capture apps
for humans, not code), `swift`/`swiftui` (a foreign stack), `remotion` (2×, but
we do not use it — topic squatting gets noticed).

**Comparison with `PhilflowIO/dav-mcp` (33 stars, 11 topics):** `ai-agents,
caldav, calendar, carddav, claude, contacts, mcp, model-context-protocol, n8n,
tasks, vtodo`. The pattern there is threefold — protocol/technique (`caldav`,
`carddav`, `vtodo`), ecosystem connection points (`claude`, `n8n`, `mcp`,
`model-context-protocol`) and benefit language (`calendar`, `contacts`,
`tasks`). The recommendation above mirrors exactly that division: technique
(`playwright`, `ffmpeg`, `typescript`), connection points
(`screen-studio-alternative`, `open-source`, `automation`), benefit language
(`product-demo`, `demo-video`, `screen-recording`, `video-generation`,
`motion-design`).

---

## 3. Three proposals for the headline and the description

The headline is the bold benefit sentence at the very top of the README. The
description is the repository's `description` field — it is also the text AI
answers quote (section 1), and it has to stay under 120 characters.

### Proposal A — the difference first (recommended)

> **Turn your Playwright script into a product demo video. Nothing is burned into the recording —
> cursor, zoom and captions are rendered afterwards, from a log.**

`description` (113 characters):

```
Turn Playwright scripts into polished product demo videos. Cursor, zoom and captions render after the recording.
```

Why: the second sentence is exactly the distinction no competitor can claim,
and it is quotable in one piece — the format that ChatGPT and AI Overviews
demonstrably pick up in this field. Contains "Playwright" and "product demo
video" as exact terms.

### Proposal B — the category first

> **An open-source Screen Studio for code: repeatable, versionable product demo videos generated
> from a Playwright script instead of recorded by hand.**

`description` (108 characters):

```
Open-source Screen Studio alternative for developers: product demo videos generated from Playwright scripts.
```

Why: serves "screen studio alternative" directly (260 searches/month,
commercial intent at 0.906, KD 0) and "open source screen recorder"
(320/month). Stronger in search, weaker on what makes us unique — it positions
us as a variant of a known thing rather than as an idea of our own.

### Proposal C — the pain first

> **Change the look of your demo video without re-recording it. One browser run produces raw footage
> plus an event log; cursor, zoom, captions and aspect ratio are a ten-second re-render.**

`description` (117 characters):

```
Product demo videos from Playwright scripts. Restyle, rezoom and reframe in seconds without re-running the browser.
```

Why: speaks to the concrete frustration (every change = another recording) and
mentions the 16:9/9:16/1:1 argument with "reframe". Weaker on the search terms
— "screen" and "open source" are missing.

**Recommendation: A.** By Phil's criteria A wins, because it describes the
product in its own language rather than as a derivative of somebody else's
product (sovereignty), and because the sentence will still be true in six
months even if Screen Studio disappears from the market (maintainability). B
rejected: it wins search volume in the short term but ties our identity to a
foreign product name. The Screen Studio reference goes into the topic
(`screen-studio-alternative`) and into a comparison section further down the
README instead — there it costs nothing.

---

## 4. Keyword table

Volume = average monthly Google searches. KD = keyword difficulty (0–100).
Empty cells mean DataForSEO returns no data for that combination — not "zero".

### English (US)

| Term                        | Volume | Intent (probability)  |  KD | Trend, 12 months         |
| --------------------------- | -----: | --------------------- | --: | ------------------------ |
| screen recording software   | 22,200 | informational (0.589) |  60 | falling (90,500 → 8,100) |
| open source screen recorder |    320 | informational (0.514) |  35 | steady 260–390           |
| screen studio alternative   |    260 | commercial (0.906)    |   0 | rising (170 → 320)       |
| product demo video          |    170 | navigational (0.463)  |  18 | falling                  |
| demo video maker            |     90 | commercial (0.625)    |  17 | steady                   |
| product demo software       |     70 | commercial (0.967)    |  29 | steady                   |
| product tour software       |     70 | commercial (0.920)    |   0 | steady                   |
| interactive product demo    |     40 | navigational (0.604)  |  16 | falling                  |
| playwright screen recording |     20 | navigational (0.599)  |   – | rising (10 → 30)         |
| saas demo video             |      – | informational (0.880) |   1 | –                        |
| automated product demo      |      – | navigational (0.435)  |   – | –                        |
| demo automation tool        |      – | transactional (0.652) |   – | –                        |
| automated screen recording  |      – | –                     |   – | –                        |

### German (Germany)

| Term                              | Volume |  KD | Trend, 12 months   |
| --------------------------------- | -----: | --: | ------------------ |
| produktvideo erstellen            |    110 |   0 | falling (260 → 50) |
| screen recorder kostenlos         |     90 |   0 | falling            |
| erklärvideo software              |     50 |  28 | falling            |
| bildschirmaufnahme tool           |     50 |   0 | falling            |
| bildschirmaufnahme software       |     40 |  16 | falling (50 → 10)  |
| demo video erstellen              |     10 |   – | flat at 10         |
| software demo video               |     10 |   – | flat at 10         |
| produktvideo software             |     10 |   – | flat at 10         |
| produktdemo software              |      – |   – | –                  |
| screen studio alternative deutsch |      – |   – | –                  |

**How to read this:** no German term in the field is above 110. Every one with
data is falling over twelve months. Two central German terms ("produktdemo
software", "screen studio alternative deutsch") do not exist in the database at
all.

### AI search volume (demand inside LLM answers)

| Term                             | AI volume | Trend           |
| -------------------------------- | --------: | --------------- |
| open source screen recorder      |        12 | rising (2 → 12) |
| screen studio alternative        |         8 | rising (1 → 8)  |
| product demo video tool          |         4 | rising          |
| playwright screen recording      |         1 | flat            |
| produktvideo erstellen (DE)      |         – | no data         |
| bildschirmaufnahme software (DE) |         – | no data         |

The absolute numbers are small, the direction is unambiguous: the English terms
are growing in AI answers, and for the German ones the API returns no data at
all.

---

## 5. Neighbourhood table

The top 15 by stars from the screen-recording / product-video field, and below
them the repositories closer to featurecast in substance with fewer stars.
README language: **all English**, two additionally Chinese. No German README in
the whole sample.

| Repo                          |  Stars | Topics                                                                                                                                                                                                                                                   | Description                                                                                                |
| ----------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| obsproject/obs-studio         | 76,246 | c, c-plus-plus, directshow, facebook-live, ffmpeg, game-capture, live-streaming, screen-capture, twitch-tv, video-recording, youtube-live                                                                                                                | OBS Studio - Free and open source software for live streaming and screen recording                         |
| webadderallorg/Recordly       | 29,001 | electron, free, linux, macos, open-source, screen-recorder, screen-studio, windows                                                                                                                                                                       | Create polished demo videos without editing skills. Mac/Windows/Linux                                      |
| CapSoftware/Cap               | 22,257 | app, cap, coss, loom, mac, nextjs, open-source, oss, react, record, rust, screen-capture, screen-recorder, screenshot, solidjs, tauri, typescript, vite                                                                                                  | Open source Loom alternative. Beautiful, shareable screen recordings.                                      |
| wulkano/Kap                   | 19,354 | aperture, app, capture, communication, electron, javascript, kap, mac, macos, nextjs, open-source, oss, productivity, record, screen-capture, screen-recorder                                                                                            | An open-source screen recorder built with web technology                                                   |
| alyssaxuu/screenity           | 18,692 | annotation, annotation-tool, audio, camera, chrome-extension, design, editor, ffmpeg, javascript, productivity, recorder, screen-capture, screen-recorder, screencast, tensorflow, video                                                                 | The free and privacy-friendly screen recorder with no limits                                               |
| phw/peek                      | 10,552 | apng, gif, gif-recorder, gnome, gtk3, linux, screencast, vala, wayland, webm                                                                                                                                                                             | Simple animated GIF screen recorder with an easy to use interface                                          |
| lihaoyun6/QuickRecorder       |  8,650 | _(none)_                                                                                                                                                                                                                                                 | A lightweight screen recorder based on ScreenCapture Kit for macOS                                         |
| duongductrong/Snapzy          |  3,131 | capture, cleanshot-alternative, recording-app, screenshot, screenshot-capture, swiftui                                                                                                                                                                   | An open-source native macOS screenshot and screen recording app. A CleanShot X alternative.                |
| MaartenBaert/ssr              |  2,892 | _(none)_                                                                                                                                                                                                                                                 | SimpleScreenRecorder, a screen recorder for Linux                                                          |
| KartikLabhshetwar/better-shot |  2,300 | annotation-tool, automation, capture-tool, cleanshot-alternative, cloudflare-r2, loom-alternative, macos, native-macos, ocr, open-source, privacy, raycast, screen-recorder, screencapturekit, screenshot-tool, swift, swiftui, url-scheme, video-editor | Screenshot, screen recording, and video editor for macOS. Open-source alternative to CleanShot X and Loom. |
| fayazara/Screendrop           |  2,030 | cloudflare, macos, swift                                                                                                                                                                                                                                 | A beautiful screenshot + screen recording + Loom alternative - all native, self hostable and free.         |
| jsattler/BetterCapture        |  1,641 | apple, audiorecorder, hevc, macos, prores, screen-capture, screen-recorder, screenrecorder, utility                                                                                                                                                      | The macOS screen recorder for the rest of us - always free and open source                                 |
| lzhgus/Capso                  |  1,329 | annotation, cleanshot-alternative, macos, ocr, open-source, screen-recording, screenshot, swift, swiftui                                                                                                                                                 | Open-source screenshot and screen recording for macOS. The free, native alternative to CleanShot X.        |
| ronaldo-avalos/Maya           |  1,027 | iphone-screen-recordings, macos-app, screen-recordings                                                                                                                                                                                                   | Wrap your iPhone screen recordings in a beautiful device frame, add cinematic zoom moments                 |
| MarconLP/snapify              |  1,016 | _(none)_                                                                                                                                                                                                                                                 | Screen recording sharing for absolutely everyone.                                                          |

### The closest neighbours in substance (under 1,000 stars, but the same idea)

| Repo                                 | Stars | Topics                                                                                                                                                                                                             | Description                                                                                                     |
| ------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| tamnguyenvan/screenarc               |   716 | cinematic-video, content-creation, cross-platform, desktop-app, electron-app, ffmpeg, open-source, productivity, react, screen-recorder, screen-recording, tailwindcss, tutorial-videos, typescript, video-editing | Cross-platform screen recorder & editor with automatic cinematic zooms, mouse tracking                          |
| tolmasky/demokit                     |   432 | _(none)_                                                                                                                                                                                                           | DemoKit is a Library and Electron app for building product demos and tutorials using web technologies           |
| Alexwtlf/agentic-product-demo        |   257 | agent-skills, agentic, claude-code, ffmpeg, motion-design, product-demo, react, remotion, video                                                                                                                    | Create polished product demo videos with AI coding agents and Remotion. The UI is code, not a screen recording. |
| qawolf/playwright-video              |   199 | e2e, e2e-testing, playwright, video-capture                                                                                                                                                                        | Save a video of a Playwright page                                                                               |
| snapcndev/snapcn                     |   192 | library, motion-design, remotion, remotion-video, shadcn, ui, video-generation, videos                                                                                                                             | A shadcn registry of Remotion components for product demo videos                                                |
| greentfrapp/testreel                 |    88 | _(none)_                                                                                                                                                                                                           | Let your LLM agent generate polished product demo videos for web apps, powered by Playwright.                   |
| shreyaskarnik/argo                   |    41 | _(none)_                                                                                                                                                                                                           | Turn Playwright scripts into polished product demo videos with AI voiceover                                     |
| **PhilflowIO/dav-mcp** _(reference)_ |    33 | ai-agents, caldav, calendar, carddav, claude, contacts, mcp, model-context-protocol, n8n, tasks, vtodo                                                                                                             | Transform AI agents into orchestrating assistants managing calendars, contacts, and tasks                       |

**Topic frequency across the sample** (repositories with topics only,
descending): `screen-recorder` 7, `open-source` 6, `macos` 6, `screen-capture`
5, `ffmpeg` 4,
`swift`/`swiftui`/`screenshot`/`react`/`productivity`/`cleanshot-alternative`
3 each,
`video`/`typescript`/`screen-recording`/`screencast`/`remotion`/`motion-design`/`linux`/
`electron`/`annotation-tool`/`capture`/`app`/`oss`/`ocr`/`nextjs`/`mac`/`javascript`/
`record`/`screenrecorder`/`macos-app` 2 each.

**Three observations that went into the recommendation:**

1. Four of the 15 largest repositories (QuickRecorder 8,650, ssr 2,892, snapify
   1,016, demokit 432) carry **no topics at all**. Stars come to them through
   Reddit and Hacker News, not through GitHub search. Topics are a lever, not a
   guarantee.
2. The descriptions of the successful repositories all follow the same pattern:
   **category + free attribute + reference product** ("Open source Loom
   alternative", "A CleanShot X alternative", "The free and privacy-friendly
   screen recorder"). Proposal B in section 3 serves that pattern; proposal A
   deliberately breaks it.
3. The four repositories closest to featurecast in substance (`testreel` 88,
   `argo` 41, `agentic-product-demo` 257, `snapcn` 192) are all under 300 stars
   and three of them have **no topics**. The field of "product video from code"
   is practically unoccupied as a GitHub topic space — `playwright` and
   `product-demo` together are currently held by **no** repository.

---

## 6. Provenance of every number

All queries were run on **2026-09-15**.

| Data set                                                   | Tool                                                        | Query                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| English search volumes, CPC, competition, 12-month history | DataForSEO MCP `kw_data_google_ads_search_volume`           | 15 terms, `location_name="United States"`, `language_code="en"`                                                                       |
| German search volumes, 12-month history                    | DataForSEO MCP `kw_data_google_ads_search_volume`           | 15 terms, `location_name="Germany"`, `language_code="de"`                                                                             |
| Intent and probability (English)                           | DataForSEO MCP `dataforseo_labs_search_intent`              | 12 terms, `language_code="en"`                                                                                                        |
| Keyword difficulty, English                                | DataForSEO MCP `dataforseo_labs_bulk_keyword_difficulty`    | 12 terms, `location_name="United States"`, `language_code="en"`                                                                       |
| Keyword difficulty, German                                 | DataForSEO MCP `dataforseo_labs_bulk_keyword_difficulty`    | 7 terms, `location_name="Germany"`, `language_code="de"`                                                                              |
| AI search volume                                           | DataForSEO MCP `ai_optimization_keyword_data_search_volume` | 8 terms, `location_name="United States"`, `language_code="en"`                                                                        |
| GEO: what ChatGPT answers and cites                        | DataForSEO MCP `ai_optimization_chat_gpt_scraper`           | `"best open source alternative to Screen Studio for product demo videos"`, US/en                                                      |
| GEO: Google AI Overview and organic results (English)      | DataForSEO MCP `serp_organic_live_advanced`                 | `"open source screen studio alternative"`, US/en, depth 20                                                                            |
| GEO: German results page for the core concept              | DataForSEO MCP `serp_organic_live_advanced`                 | `"open source produktvideo aus code erstellen"`, DE/de, depth 10                                                                      |
| Candidate repositories in the field                        | `gh search repos`                                           | five queries: `screen recorder`, `product demo`, `screen recording`, `demo video`, `playwright video`, each `--limit 15 --sort stars` |
| Stars, topics, description per repository                  | `gh api repos/<owner>/<name>`                               | 23 repositories individually, fields `stargazers_count`, `topics`, `description`                                                      |
| Topic frequency                                            | counted locally                                             | `tr ',' '\n' … \| sort \| uniq -c \| sort -rn` over the 16 repositories with topics                                                   |
| featurecast's language and stack                           | locally                                                     | `/home/philflow/Dokumente/coding/featurecast/package.json` — TypeScript, Node ≥ 22, pnpm, Playwright                                  |

### Numbers that could not be obtained

- **README language counted mechanically.** The language was inferred from the
  `description` fields and repository names, not by fetching each README and
  running language detection. The finding "no German README" is solid across 23
  repositories, but it is not formally measured.
- **LLM mentions for the field.** `ai_opt_llm_ment_top_domains` for
  `"product demo video"` returned 33 mentions with an AI search volume of 211,
  but the top domains were food blogs (`grocerslist.com`,
  `foodbloggerpro.com`, `yumtonight.com`). The data set is unusable for this
  field and was **not** carried into the recommendation. What is solid instead
  is the direct ChatGPT retrieval and the AI Overview.
- **German AI search volume.** For every German term,
  `ai_optimization_keyword_data_search_volume` returns no values. Whether that
  means an absence of demand or a gap in the database's coverage cannot be
  decided from the API.
- **KD for four English terms** (`playwright screen recording`,
  `automated product demo`, `demo automation tool`,
  `automated screen recording`) and three German ones
  (`demo video erstellen`, `produktvideo software`, `produktdemo software`) —
  no data.
