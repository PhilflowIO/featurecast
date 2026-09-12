# Bewegungsglätte am fertigen Video

Gemessen und gebaut 2026-09-12. Werkzeug: `tools/smoothness/`.

**Sprache dieses Dokuments:** Deutsch, abweichend von den übrigen Dateien in
`docs/`. Grund: das Werkzeug selbst spricht Deutsch — seine Ausgabe kennt
„Haker", „Störstelle", „Nachholsprung", „NICHT MESSBAR". Ein englisches
Dokument müsste die Etiketten seines eigenen Gegenstands übersetzen und
würde damit eine zweite Benennung erzeugen, die sofort driftet.

## Warum es dieses Werkzeug gibt

Jede Zahl, die dieses Projekt bisher berichtet, ist ein Zähler **innerhalb**
der Aufnahmekette: `src/efficiency.ts` zählt, wie viel von dem, was Chromium
auf den Schirm gebracht hat, auch angekommen ist; `src/presented.ts` liefert
den Nenner dazu; `src/cadence.ts` misst die Lieferabstände der Quelle. Keine
davon sieht das fertige MP4 jemals an.

Der Owner sieht genau das an, und sein Urteil zum `compare3`-Lauf (gepatchtes
Chromium, beide Fixes, 98,2 % Aufnahme-Effizienz) war: _deutlich besser, aber
nicht ruckelfrei — zwei Haker, in beide Richtungen._ 98,2 % und ein sichtbarer
Haker sind kein Widerspruch. Sie messen Verschiedenes. Dieses Werkzeug misst
das Erzeugnis.

## Was gemessen wird

Der Versatz von Bild zu Bild, in Pixeln, für jedes Paar aufeinanderfolgender
Ausgabebilder — und daraus, je Bewegungsfenster, wie gleichmäßig diese
Versätze verteilt sind.

Der Versatz wird mit **Phasenkorrelation über FFT** bestimmt, die einen Wert
nur gelten lässt, wenn ihr Korrelationsgipfel deutlich besser ist als ihr
bestes Nebenmaximum. Als zweite, anders gebaute Meinung läuft **blockweiser
Lucas-Kanade-Fluss**. Widersprechen sich beide, entscheidet ein dritter Test
direkt am Bild: ob das Zurückschieben um den behaupteten Versatz den
Restunterschied dort halbiert, wo sich überhaupt etwas geändert hat.

**Warum nicht einfacher.** Während der Fehlersuche entstand ein Schätzer nach
dem Prinzip „kleinste mittlere Differenz". Er verhakte sich am Spaltenraster
der Tabelle und meldete konstant 111 px für Bilder, die sich kaum bewegt
hatten — zuversichtlich, ohne Zweifel. Auf senkrechter Bewegung ist er blind,
weil er nur über waagerechten Versätzen sucht, und er weist diese Annahme
nirgends aus. Beide Fehler sind in `tests/test_naiver_schaetzer.py`
festgehalten, damit der Grund für den Aufwand nicht verloren geht.

**Warum nicht ffmpeg-Bordmittel.** `scdet` findet Szenenwechsel sauber,
`signalstats.YDIF` zählt wiederholte Bilder gut (18 gefunden bei 19 wahren,
Nenner 60 Bilder), `freezedetect` und `mpdecimate` liefern nur Ja/Nein je
Bild. Keines davon gibt einen Versatz in Pixeln aus, also kann keines sagen,
_wie_ glatt eine Bewegung ist. Die Bewegungsvektoren des Codecs sind über
`ffprobe` nicht numerisch lesbar — `side_data_list` enthält nur den Eintrag
`{"side_data_type": "Motion vectors"}` ohne Werte — und sie sind ohnehin eine
Entscheidung des Kodierers, keine Bewegungswahrheit.

## Die Definition „Haker"

> Ein **Haker** ist eine Stelle innerhalb der Reisestrecke einer
> gleichgerichteten Bewegung, an der der Bild-zu-Bild-Versatz vom Tempo
> seiner unmittelbaren Nachbarn abweicht: entweder **mindestens zwei
> aufeinanderfolgende Bilder unter 25 % des örtlichen Tempos**
> (Stillstand ≥ 33 ms), oder **ein Einzelschritt über dem Doppelten des
> örtlichen Tempos** (Nachholsprung). Ereignisse, die weniger als vier
> Bilder auseinander liegen, sind **eine** Störstelle — das Auge kann zwei
> Stolperer 50 ms auseinander nicht trennen. Gezählt werden Störstellen.

## Die Stellschrauben und ihre Begründung

Alle stehen in `tools/smoothness/smoothness/knobs.py`, jede genau einmal, und
`smoothness --erklaere-schwelle` druckt sie samt Begründung aus. Die vier,
die die Definition oben tragen:

| Stellschraube      | Wert | Warum dieser Wert                                                                                                                                                                                                                                                       |
| ------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stall_frac`       | 0,25 | Verglichen wird gegen das **örtliche** Tempo, nicht gegen den Fenster-Median. Das Produkt scrollt mit Anlauf- und Bremskurve; ein fester Maßstab zählte jede Beschleunigung als Sprung — erste Fassung: 33 Haker in einem 47-Bild-Fenster.                              |
| `stall_min_frames` | 2    | Zwei Bilder sind 33 ms, die gebräuchliche Sichtbarkeitsgrenze für Aussetzer bei 60 Hz. Ein-Bild-Aussetzer werden nicht verschwiegen, sondern getrennt als _Mikro-Aussetzer_ mit eigenem Nenner ausgewiesen.                                                             |
| `jump_factor`      | 2,0  | Der Punkt, an dem ein Bild mehr als die Strecke zweier Bilder überspringt — also mindestens ein Bild fehlt.                                                                                                                                                             |
| `merge_gap`        | 4    | Die Fusionsgrenze der Wahrnehmung. **Offenlegung zur Reihenfolge:** dieser Wert wurde _nach_ dem ersten Lauf am echten Material eingeführt, weil dort fünf bis sechs Einzelereignisse in 0,3 s auftraten. Begründet ist er mit der Wahrnehmung, nicht mit dem Ergebnis. |

## Die beiden äußeren Schranken

Beides sind Kriterien, die **nicht** aus der Rechnung stammen, die sie
prüfen. Ein Fenster, das eine von beiden reißt, bekommt **kein**
Glätte-Urteil, sondern `NICHT MESSBAR` mit Grund.

**Streckenabgleich.** Die Summe der gemessenen Einzelversätze muss die
unabhängig bekannte Strecke treffen (Toleranz 10 %). Die Sollstrecke steht im
Feld `target` der `motion-windows.json` (`src/m1-benchmark.ts` schreibt dort
die Scrollweite des Elements hinein) und wird mit dem Maßstab in
Ausschnittspixel umgerechnet. Der gescheiterte Schätzer hätte hier 24 statt
135 px geliefert und wäre durchgefallen.

**60-Hz-Schranke.** In einem Fenster, das laut unabhängiger Quelle _d_
Sekunden dauert, können höchstens 60·_d_+1 Bilder stecken.

## Was an dieser Schranke zweimal falsch war

Diese beiden Absätze bleiben stehen, weil derselbe Fehler in diesem Projekt
inzwischen viermal aufgetreten ist und jedes Mal plausibel aussah.

**Erster Fehler (Prototyp, behoben vor dem Einzug ins Repo).** Die erste
Fassung berechnete die Fensterdauer aus der eigenen Bildzählung. `n` Bilder
ergeben `n/60` Sekunden ergeben eine Obergrenze von `n` Bildern — die
Schranke konnte deshalb **nie** anschlagen. Derselbe Zirkelschluss wie in
`src/paint-rate.ts` und in der ersten Fassung von `src/presented.ts`.
Behoben, indem die Dauer ein eigener Typ mit Herkunft wurde
(`bounds.Dauer`); eine Dauer aus der eigenen Bildzählung wird ausdrücklich
abgelehnt.

**Zweiter Fehler (beim Einzug ins Repo gefunden, 2026-09-12).** Damit war es
nicht getan. Sobald die Fenstergrenzen aus derselben Dauer abgeleitet werden
— und genau das tut `windows.aus_lauf`, indem es Videozeit in Ausgabebilder
umrechnet —, ist die Zahl der **Ausgabebilder** im Fenster per Konstruktion
wieder höchstens 60·_d_+1. Der Zirkelschluss war eine Ebene höher
zurückgekehrt. Gezählt werden deshalb jetzt die **Aufnahmebilder** aus
`timestamps.json`: sie stammen aus einer anderen Messung als die
Fenstergrenzen und können sehr wohl zu viele sein. Fehlt eine solche
unabhängige Zahl, meldet die Schranke `haelt: null` mit dem Grund
„tautologisch" — nicht „bestanden".

## Verweigern statt benoten

Drei Ergebnisse sind zu unterscheiden, und das Werkzeug unterscheidet sie:
geprüft und bestanden, geprüft und gerissen, **gar nicht geprüft**. Das
dritte ist kein Bestehen. Ein Lauf, in dem kein Fenster auswertbar war, sagt
wörtlich: „KEIN auswertbares Bewegungsfenster gefunden — das ist KEIN gutes
Zeugnis, sondern eine Verweigerung", und meldet dazu das Zappel-Maß (wie oft
die Bewegung die Richtung wechselt).

Links und rechts werden getrennt ausgewiesen und nie gemittelt. Der Owner
berichtet Haker in beiden Richtungen; ein Mittelwert hätte sie gegeneinander
aufgehoben.

## Grenzen

Was dieses Werkzeug **nicht** kann und was an ihm **nicht** geprüft ist. Die
Liste ist der ehrliche Teil der Messung und wird nicht gekürzt.

- **Keine Farbe.** Alles wird auf Graustufen gemessen. Eine Bewegung, die
  sich nur im Farbkanal zeigt, sieht das Werkzeug nicht.
- **Nur Verschiebung.** Geprüft sind Translationen. Drehung, Skalierung
  (Zoom), Überblendung und Deckkraft-Animationen sind nicht modelliert. Der
  Eichfall c8 zeigt lediglich, dass eine _lokale_ Nebenanimation (drehendes
  Symbol, einblendender Tooltip) nicht stört.
- **Nur ein Bewegungsobjekt.** Scrollen zwei Bereiche gleichzeitig
  verschieden schnell, misst das Werkzeug den Mehrheitsversatz. Dieser Fall
  ist nicht geprüft.
- **Die Schwelle ist nicht gegen das Auge geeicht.** Eine Eichreihe „ab hier
  nennt der Owner es hakelig" hat es in diesem Projekt nie gegeben. Die Werte
  sind aus 60-Hz-Physik und aus dem Material begründet. Der Abgleich mit dem
  Urteil des Owners (Akzeptanzkriterium 6 in Issue #24) steht aus und braucht
  einen erreichbaren Aufnahmerechner.
- **Die Grenze des Verfahrens ist der Alias-Fall.** Bei exakt periodischem
  Inhalt und großem Versatz je Bild sind zwei verschiedene Versätze dieselbe
  Bildinformation (bei Rasterperiode 111 px: +70 und −41). Aus zwei Bildern
  ist das prinzipiell nicht entscheidbar. Das Werkzeug verweigert dort die
  Mehrheit der Bildpaare und nimmt einen Rest falsch an; aufgefangen wird das
  erst von der Streckenschranke. Eichfall `c12`, festgehalten in
  `tests/test_eichung.py`.
- **Viertelgeschwindigkeits-Videos taugen nicht.** In den Zeitlupendateien
  des Vergleichslaufs sind 61–71 % der Bilder Wiederholungen der Zeitlupe
  selbst. Gemessen, nicht angenommen.
- **Die echten Laufdaten fehlen bislang.** `motion-windows.json`,
  `timestamps.json` und `capture-efficiency.json` eines echten Laufs waren
  beim Bau nicht erreichbar (der Aufnahmerechner war ausgefallen). Alle Tests
  gegen die „Wahrheit des Produkts" laufen deshalb gegen nachgebaute
  Laufdateien in der Form, die `demo/m1-capture.ts` schreibt — nicht gegen
  einen echten Lauf. Der Streckenabgleich am echten Material ist damit
  **ungeprüft**.
- **Nur ein Vergleichsvideo.** Alle Aussagen des Prototyps zum echten
  Material stammen aus einem einzigen Lauf. Wiederholbarkeit über mehrere
  Aufnahmeläufe ist nicht gezeigt.
- **Laufzeit.** Rund 80 s je Feld für ein Video von 2354 Bildern. Für CI ist
  das nicht erprobt.

## Was der Prototyp am echten Material gemessen hat

Diese Zahlen stammen aus dem Vorlauf (`.claude/handoffs/messtechnik-glaette.md`,
2026-09-12) und sind hier **nicht** nachgestellt — das Vergleichsvideo liegt
nicht im Repo. Sie stehen hier, weil sie die Frage des Owners beantworten,
und sie gelten als ungeprüft, bis ein Lauf sie wiederholt.

| Lauf                           | Bildpaare | Median-Schritt | größter Einzelsprung | wiederholte Bilder | Urteil       |
| ------------------------------ | --------- | -------------- | -------------------- | ------------------ | ------------ |
| Feld 1, Standard-Browser       | 8         | 1,70 px        | **55,49 px**         | 3/8 = 37,5 %       | 1 Störstelle |
| Feld 2, eigener Bau ungepatcht | 8         | 1,70 px        | **55,51 px**         | 3/8 = 37,5 %       | 1 Störstelle |
| Feld 3, gepatcht               | 17        | 3,68 px        | 13,87 px             | 3/17 = 17,6 %      | **2 Haker**  |
| Feld 3, gepatcht (2. Fenster)  | 20        | 2,27 px        | 13,87 px             | 4/20 = 20,0 %      | **2 Haker**  |

Der Standard-Browser scrollt nicht, er springt: 55,5 von 67,4 px Gesamtstrecke,
also 82 %, passieren in einem einzigen Bild. Der gepatchte Bau verteilt
dieselbe Strecke auf 17 bis 20 Bilder. Das ist der Gewinn der Patches,
erstmals am Erzeugnis gemessen — und die zwei verbleibenden Störstellen sind
der Größenordnung nach das, was der Owner gesehen hat.
