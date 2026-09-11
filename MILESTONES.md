# Meilensteine

Jeder Meilenstein hat ein Abnahmekriterium, das man **ausführen** kann. Kein Meilenstein gilt als erreicht, weil der Code existiert — nur, weil das Kriterium nachweislich erfüllt ist. Die ersten beiden klären Risiken, bevor gebaut wird; alles danach ist Aufbau.

---

## M0 — Fundament

Repository, TypeScript, Playwright, Formatierung, ein Beispiel-Skript, das nichts tut außer eine Seite zu öffnen.

**Abnahme:** `pnpm demo:hello` öffnet eine Seite und beendet sich mit Code 0.

---

## M1 — Die Aufnahme steht, und sie sieht gut aus

Aufnahme über `page.screencast`, Einzelbilder mit echten Zeitstempeln, Zusammenbau zu konstanten 60 Bildern pro Sekunde über ffmpeg.

Das hier ist der Risiko-Meilenstein: alle bisherigen Qualitätsaussagen sind Messwerte, **niemand hat ein Ergebnis angesehen**. Wenn eine 2560er-Aufnahme nach Verkleinerung auf 1920 nicht überzeugend scharf aussieht, ändert das den ganzen Plan — deshalb steht das vor allem anderen.

**Abnahme:** Aufnahme einer echten, dichten Anwendungsoberfläche (nicht `example.com`), 20 Sekunden mit Scrollen und Übergängen. `ffprobe` meldet 1920×1080, konstant 60 Bilder pro Sekunde, keine doppelten Bilder. Das Ergebnis wird **angesehen** und mit einer Screen-Studio-Aufnahme derselben Oberfläche verglichen. Urteil wird schriftlich festgehalten.

---

## M2 — Der Wrapper: weiche Bewegung und Ereignis-Log

Der `demo`-Wrapper um Playwrights Seite: `point`, `click`, `tap`, `type`, `hold`, `scroll`. Jede Bewegung läuft über die übernommene Bewegungsmathematik statt über lineare Interpolation. Parallel entsteht `events.jsonl` mit Zeigerbahn in 60 Hertz, Klicks und der Bounding-Box des getroffenen Elements.

**Abnahme:** zwei Läufe desselben Skripts erzeugen bit-identische `events.jsonl` (Wiederholbarkeit). Die Zeigerbahn hat keinen Sprung über 20 Pixel zwischen zwei Abtastpunkten. Jeder Klick trägt eine Bounding-Box, die zum sichtbaren Element passt.

---

## M3 — Mobile scharf bekommen

Der Erkundungs-Meilenstein. Die drei in [PLAN.md](PLAN.md) beschriebenen Wege werden gebaut, gemessen und angesehen; einer gewinnt, die anderen werden mit Grund verworfen.

Dazu: Touch statt Maus im Wrapper (`page.touchscreen.tap`), Touch-Ripple statt Pfeil im Render, und die Frage, ob die Aufnahme unter WebKit funktioniert oder ob die iPhone-Profile unter Chromium gefahren werden müssen.

**Abnahme:** ein Hochformat-Video 1080×1920 einer echten mobilen Oberfläche, angesehen und für Social-Media-tauglich befunden. Text in normaler Fließtextgröße ist lesbar. Kein Mauszeiger im Bild. Die Entscheidung samt verworfener Wege steht schriftlich im Repo.

---

## M4 — Nachbearbeitung: Zoom, Zeiger, Tempo

Zoomfeder und Ruhe-Erkennung übernommen und parametrisiert, Zeiger aus dem Ereignis-Log gerendert, Leerlauf-Passagen gerafft. Ausgabe in 16:9, 9:16 und 1:1 aus demselben Rohmaterial.

**Abnahme:** ein Rohvideo ergibt ohne erneuten Browser-Lauf drei Formate. Der Zoom rahmt bei jedem Klick das getroffene Element und nicht einen Punkt daneben. Ein Look-Parameter wird geändert und das Ergebnis liegt in unter zwei Minuten neu vor.

---

## M5 — Geräte-Ebene und Konfiguration

Die in [docs/DEVICES.md](docs/DEVICES.md) beschriebene Schichtung: Playwrights Registry zur Laufzeit gelesen, eigene Aufnahme- und Ausgabe-Ebene darüber, elf Presets, Überschreiben einzelner Felder möglich.

**Abnahme:** dasselbe unveränderte Skript läuft über vier Presets — Desktop, iPhone, Android, Tablet — und erzeugt vier korrekt formatierte Videos. Ein unbekannter Gerätename bricht mit einer Fehlermeldung ab, die die verfügbaren Namen nennt.

---

## M6 — Garage-Upload und ein Kommando für alles

Upload in den S3-kompatiblen Speicher, Zugangsdaten aus der Umgebung, Rückgabe einer URL. Ein `featurecast`-Kommando, das Skript, Geräte und Ziel entgegennimmt und die Kette durchläuft. NVENC statt CPU im Encode.

**Abnahme:** `featurecast run demo/feature-xy.ts --devices desktop,iphone --upload` liefert zwei abrufbare URLs. Der Encode läuft auf der 3090-Box; die Laufzeit für 30 Sekunden 1080p60 wird gemessen und notiert.

---

## M7 — Benutzbar für andere

Dokumentation, wie ein bestehendes Playwright-Skript zum Aufnahme-Skript wird. Rezepte für die üblichen Stolpersteine: Anmeldung über gespeicherten Sitzungszustand, Cookie-Banner wegblenden, Uhrzeiten und Zufallsdaten einfrieren, damit zwei Aufnahmen identisch aussehen.

**Abnahme:** ein vorhandenes Playwright-Skript aus einem anderen Projekt wird in unter 30 Minuten in eine Aufnahme überführt, ohne dass dabei am Wrapper selbst etwas geändert werden muss.

---

## Nicht im Plan

Bewusst weggelassen, damit klar ist, dass es nicht vergessen wurde: eine Bedienoberfläche (das Dropdown ist vorbereitet, wird aber nicht gebaut), Sprachausgabe und Untertitel (macht die bestehende Video-Pipeline), Musik, Mehrsprachigkeit der Aufnahmen, und das automatische Erkennen neuer Features aus Pull Requests — das ist eine eigene Idee für später.
