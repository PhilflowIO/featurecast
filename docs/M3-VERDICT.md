# M3 — Hochformat: was gemessen wurde und was gewonnen hat

Date: 2026-09-15. Alle Läufe auf der AI-Box (RTX 3090, GPU1, Container `featurecast-box:1`, gepatchtes Chromium 153.0.8010.12), gegen die echte Anwendung `app.onlydash.io`.

Die Frage von [Ticket #4](https://forgejo.philflow.me/Phil/featurecast/issues/4): ein 1080×1920-Video einer echten mobilen Oberfläche, Fließtext in normaler Größe lesbar, kein Mauszeiger im Bild.

## Die Ursache, in einem Satz

Die Aufnahme liest die Zeichenfläche des Browsers und bemisst sie in **CSS-Pixeln**. Ein mobiles Layout ist 393 CSS-Pixel breit. Also ist eine unbehandelte mobile Aufnahme 393 Pixel breit — nicht weil die Pixeldichte fehlte, sondern weil Layoutbreite und Aufnahmebreite dieselbe Zahl sind.

**Damit ist die Lösung auch benannt:** die beiden Zahlen dürfen nicht zu demselben Dokument gehören. Es sind zwei. Das Dokument, das aufgenommen wird, ist 1080 breit; die Anwendung darin ist 393 breit und wird per CSS-Transformation vergrößert gezeichnet. Eine transformierte Ebene wird bei ihrem effektiven Maßstab neu gerastert — 16-Pixel-Text kommt als 44 Pixel scharfer Buchstabe an, nicht als vergrößertes 16-Pixel-Bild.

## Fünf Wege, vier Messungen, ein Gewinner

| Weg                                                                                               | Gemessen                                                                                                                                                                      | Urteil                                          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Rahmen-Trick** (Weg 1 im Ticket) — Anwendung in einem 393 px breiten Rahmen, per CSS vergrößert | 1080×1920, gestochen scharf, 30,6 Bilder/s an der echten Anwendung, 59 an einer leichten Seite                                                                                | **gewonnen**                                    |
| **Einzelbild-Aufnahme** (Weg 2) — `Page.captureScreenshot` mit `clip.scale`                       | 1080×1811, ebenso scharf — aber **8,8 Bilder/s**, sobald sich auf der Seite etwas bewegt (116 ms pro Bild, p95 122 ms)                                                        | verworfen: kein Video                           |
| **Hochskalieren im Render** (Weg 3)                                                               | nicht gemessen                                                                                                                                                                | verworfen: weich, und nach Weg 1 gegenstandslos |
| **`Emulation.setDeviceMetricsOverride` mit `scale`** — im Ticket nicht genannt                    | liefert 393×699 statt 1080×1920: das Feld ändert die Layouthöhe und sonst nichts                                                                                              | verworfen: wirkungslos                          |
| **`--force-device-scale-factor`** — im Ticket nicht genannt                                       | die Pixeldichte wird echt (DPR 2,75), aber das CSS-Fenster lässt sich nicht auf 393 verkleinern: Chromium erzwingt eine Mindestfensterbreite (393 angefordert → 502 bekommen) | verworfen: unerreichbar                         |

Die Zahl, die Weg 2 erledigt, verdient einen eigenen Satz: die erste Messung ergab 30 Bilder/s und sah brauchbar aus — sie lief aber gegen eine **stehende** Seite, auf der `scrollBy` ins Leere ging. Sobald sich pro Bild wirklich etwas ändert, sind es 8,8. Ein Einzelbild erzwingt jedes Mal einen vollständigen Durchlauf mit Rücklesen; die Aufnahme bekommt ihre Bilder dagegen von der Zeichenmaschine geliefert.

## Der Fallstrick am Rahmen-Weg, und warum er keiner mehr ist

Die naheliegende Schreibweise — Hülle per `setContent` bauen, Rahmen auf die Anwendung zeigen — **scheitert lautlos**. Die Hülle hat dann keinen echten Ursprung, die Anwendung ist darin Dritt-Inhalt, und Dritt-Inhalt hat keinen Speicher. OnlyDash warf `SecurityError: Failed to read the 'localStorage' property` und zeichnete eine leere Fläche: ein Video in korrekter Auflösung, das nichts zeigt. Mit abgeschalteter Web-Sicherheit verschwindet die Meldung und das Problem bleibt.

Die Hülle wird deshalb **vom Ursprung der Anwendung selbst ausgeliefert** — eine abgefangene Adresse unter `<ursprung>/__featurecast_frame__`. Damit sind Hülle und Rahmen gleichen Ursprungs: der Speicher der Anwendung ist wieder Erst-Inhalt, `X-Frame-Options: SAMEORIGIN` (genau das schickt OnlyDash) ist erfüllt, `frame-ancestors 'self'` ebenfalls. Nichts muss entfernt und keine Sicherheitsstufe gesenkt werden.

## Die Aufnahmefläche ist die Ausgabefläche — anders als beim Desktop

Desktop nimmt mit 1,33-facher Reserve auf, damit M4 mehrere Formate aus demselben Material schneiden und die Zoomfeder umherfahren kann. Für Hochformat wurde dieselbe Reserve gemessen und **verworfen**: dieselbe Aufnahme derselben Anwendung lieferte 30,6 Bilder/s bei 1080×1920 und **14,8 bei 1440×2560**. Die Bildrate eines Social-Videos zu halbieren, um Zoom-Spielraum zu kaufen, ist der falsche Tausch — und ein telefonförmiges Bild hat ohnehin keinen Rand, in den es fahren könnte.

Was das kostet, offen gesagt: ein Zoom in eine mobile Aufnahme schneidet in ein 1:1 abgetastetes Bild hinein und wird weich, wo die Desktop-Presets Reserve haben.

## Zum Ansehen

**Die beiden Standbilder dieses Abschnitts sind aus der Versionierung entfernt**, weil sie die Oberfläche der gefilmten Fremdanwendung zeigten. Das erste war ein Ausschnitt in Originalgröße aus dem fertigen Video: 16-Pixel-Fließtext der Anwendung, gezeichnet in 1080 Bildpunkten Breite — der Bildbeleg für die Schärfe-Aussage weiter oben. Das zweite zeigte das fertige Hochformat im dunklen Modus nach drei Fingertipps. Die gemessenen Aussagen stehen unverändert; ihr Bildbeleg wird aus dem eigenen Messkorpus nachgereicht.

Das fertige Video und der direkte Vergleich mit dem abgelehnten Versuch (links der 9:16-Ausschnitt aus der Desktop-Aufnahme, rechts das echte Hochformat) liegen unter `artifacts/m3-acceptance/iphone/output.mp4` und `artifacts/m3-vergleich/vorher-nachher.mp4`.

## Was das im Code heißt

- `src/framed.ts` — die Hülle, ihre Geometrie und das Argument dahinter.
- `src/surface.ts` — die Naht zwischen „das gefilmte Dokument" und „die aufgenommene Seite". Elementkästen und Eingabekoordinaten liefert Playwright bereits im Bildraum; **Rad-Beträge sind die einzige Umrechnung**, weil ein Rad-Ereignis das Dokument in dessen eigenen Pixeln scrollt und die Transformation diese Strecke danach vergrößert.
- `src/devices.ts` — die acht Touch-Presets tragen keine offene Aufnahme mehr. Der Zustand „offen (M3)" und die Strategien `screenshot` und `render-upscale` sind entfallen; was gemessen und verworfen wurde, steht hier und nicht als toter Zweig im Code.
- `demo/m3-acceptance.ts` — dieselbe Anwendung und fast dieselbe Reise wie die M4-Abnahme, an einem Telefon.

Zwei Fehler im Wrapper kamen dabei ans Licht, beide erst an einem echten Telefon sichtbar und beide an der Wurzel behoben:

- **`demo.click` klickte auf Touch-Geräten mit der Maus.** Die Schublade hinter dem Menüknopf ging nie auf, weil sie auf einen Fingertipp hört. Jetzt entscheidet der Wrapper am Gerät — und schreibt `tap` statt `click` ins Ereignis-Protokoll, woran die Render-Stufe ohnehin schon den Ripple statt des Pfeils festmacht. Damit hält PLAN.md sein Versprechen, dass dasselbe Skript Desktop und Mobile fährt.
- **Der Rekorder mischte zwei Koordinatensysteme.** `boundingBox()` antwortet im Bild, `getBoundingClientRect()` und `elementFromPoint()` antworten im Dokument — solange beides dasselbe Dokument ist, fällt das nicht auf. Im Rahmen tippte der erste Lauf auf 35,28 statt auf 97,76. Beide Seitenmessungen rechnen sich jetzt selbst um: die Anwendung liest ihren eigenen Sitz im Bild über `window.frameElement`, was nur geht, weil die Hülle gleichen Ursprungs ist. Ohne Rahmen ist die Umrechnung die Identität, der Desktop-Pfad also unverändert.
- Nebenbei: auf einem Touch-Gerät wird der echte Mauszeiger gar nicht mehr bewegt. Die Strecke bleibt im Protokoll und wird gezeichnet — aber ein Telefon zeigt keine Hover-Zustände, und eine über den Bildschirm fahrende Maus hätte sie ausgelöst.

## Offen geblieben

- **WebKit ist weiterhin ungeprüft.** Die iPhone- und iPad-Profile laufen laut Registry unter WebKit; gemessen wurde alles unter Chromium mit dem iPhone-Profil. Der Rahmen-Weg ist nicht Chromium-spezifisch, aber bewiesen ist das nicht.
- **30,6 Bilder/s ist die Zahl dieser Anwendung**, nicht die des Weges: dieselbe Hülle mit einer leichten Seite darin lieferte 59. Was die echte Bildrate einer anderen Anwendung ist, sagt nur deren eigene Aufnahme.
