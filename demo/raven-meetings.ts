import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import type { RecordPage } from '../src/record.js'

import { recordWithRecipes } from './recipe-authenticated.js'

/**
 * Die erste Aufnahme, die das eigene Produkt filmt statt eines fremden.
 *
 * Zwei Schritte, absichtlich getrennt:
 *
 *   `prepare` meldet sich einmal an und schreibt den Sitzungszustand nach
 *   `auth/state.json`. Das ist derselbe Zustand, den
 *   `docs/RECORDING-SCRIPTS.md` sonst von Hand über
 *   `playwright codegen --save-storage` erzeugen lässt — nur ohne Hand,
 *   weil dieses Ziel ein Anmeldeformular mit zwei Feldern hat und sich
 *   deshalb niemand vor einen sichtbaren Browser setzen muss.
 *
 *   `record` fährt die Aufnahme über `recordWithRecipes` aus
 *   `demo/recipe-authenticated.ts`. Dort hängen die drei Rezepte
 *   (gespeicherte Sitzung, ausgeblendetes Banner, eingefrorene Uhr) schon
 *   am `RecordRuntime`-Nahtpunkt; hier wird nichts davon nachgebaut.
 *
 * WARUM DIE PERSÖNLICHE-RAUM-KARTE PER SELEKTOR VERSCHWINDET UND NICHT PER
 * FREISCHALTUNG. Die Karte zeigt in jedem Listenbild die interne
 * Vorproduktions-Adresse und darf deshalb nicht ins öffentliche Video. Sie
 * lässt sich für das Aufnahmekonto aber nicht wegschalten: sie hängt nicht
 * an einer Zuteilung pro Konto, sondern am Not-Schalter der ganzen
 * Auslieferung (`FEATURE_PERMANENT_ROOMS`,
 * `api/app/services/personal_room.py:38-55` im Repository `flow.raven`),
 * und die Aufrufstelle `ui/src/app/meetings/page.tsx:151` rendert sie ohne
 * jede Feature-Bedingung. Ein Entzug von
 * `FEATURE_PERMANENT_ROOMS_SURFACE` tut hier nichts — das wurde bereits
 * erfolglos versucht. Solange das so ist, ist das Ausblenden vor dem ersten
 * Skript der Seite der einzige Weg, der nicht die Auslieferung für alle
 * verändert.
 *
 * WARUM DER ZUSTAND NICHT INS REPOSITORY GEHÖRT. `auth/` ist per
 * `.gitignore` ausgenommen, und das ist kein Formalismus: eine
 * `storageState`-Datei IST der Zugang. Die Zugangsdaten kommen deshalb aus
 * der Umgebung und stehen in keiner Zeile dieser Datei.
 *
 * AUFRUF::
 *
 *     RAVEN_DEMO_EMAIL=… RAVEN_DEMO_PW=… \
 *         pnpm exec tsx demo/raven-meetings.ts prepare
 *     pnpm exec tsx demo/raven-meetings.ts record
 *
 * Läuft die Sitzung ab, filmt die Aufnahme die Anmeldeseite statt der
 * Liste. Dann ist nicht das Skript kaputt, sondern die Datei alt: `prepare`
 * noch einmal.
 */

const BASIS = process.env.RAVEN_DEMO_URL ?? 'https://staging.raven.ceo'
const ZUSTAND = process.env.RAVEN_DEMO_STATE ?? 'auth/state.json'

/** Das Wort, auf das die Liste im Video zusammenschnurrt. */
const SUCHWORT = 'Steinkauz'

/**
 * Die erste Zeile der Liste.
 *
 * Das `nth=0` ist nicht Kosmetik: `a[href^="/meetings/"]` trifft jede
 * sichtbare Zeile, und Playwright verweigert einem mehrdeutigen Locator die
 * Auskunft über Geometrie. Der Rekorder braucht aber genau die, um den
 * Zeiger dorthin zu fahren — ohne die Einschränkung bricht die Aufnahme mit
 * einer Zeitüberschreitung ab, die wie ein Ladeproblem aussieht und keines
 * ist.
 */
const ERSTE_ZEILE = 'a[href^="/meetings/"] >> nth=0'

/**
 * Wartet, bis ein Knoten wirklich Fläche hat.
 *
 * `RecordPage` ist absichtlich eine schmale Oberfläche und kennt kein
 * `waitFor` — sie reicht genau so weit, wie der Rekorder sie braucht. Ein
 * `boundingBox()`, das nicht mehr `null` liefert, beantwortet hier aber
 * ohnehin die bessere Frage: nicht "ist der Knoten im Dokument", sondern
 * "ist er sichtbar" — und nur ein sichtbarer Knoten kann angeklickt oder
 * angezeigt werden.
 */
async function warteAuf(
  page: RecordPage,
  selector: string,
  fristMs = 30_000,
): Promise<void> {
  const ende = Date.now() + fristMs
  for (;;) {
    const box = await page.locator(selector).boundingBox()
    if (box !== null) return
    if (Date.now() > ende) {
      throw new Error(
        `Nicht sichtbar geworden binnen ${fristMs} ms: ${selector}`,
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

/**
 * Meldet sich am Formular an und schreibt den Sitzungszustand.
 *
 * Über das Formular und nicht über die Anmelde-Schnittstelle: Better-Auth
 * setzt seine Sitzungs-Cookies auf demselben Weg, aber die Oberfläche legt
 * zusätzlich Zustand im Browser ab (zuletzt gewählter Bereich, Hinweise,
 * die einmal weggeklickt wurden). Wer nur das Cookie holt, filmt beim
 * ersten Lauf einen Zustand, den ein Mensch so nie sieht.
 */
async function prepare(): Promise<void> {
  const email = process.env.RAVEN_DEMO_EMAIL
  const passwort = process.env.RAVEN_DEMO_PW
  if (email === undefined || passwort === undefined) {
    throw new Error(
      'RAVEN_DEMO_EMAIL und RAVEN_DEMO_PW müssen gesetzt sein. Sie stehen ' +
        'im Secret-Store, nicht in diesem Repository.',
    )
  }

  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      viewport: { height: 720, width: 1280 },
    })
    const page = await context.newPage()
    await page.goto(`${BASIS}/login`)
    await page.locator('#email').fill(email)
    await page.locator('#password').fill(passwort)
    await page.getByRole('button', { exact: true, name: 'Anmelden' }).click()
    await page.waitForURL('**/meetings', { timeout: 60_000 })
    // Die Überschrift, nicht die Adresse, ist der Beweis: die Adresse
    // wechselt, bevor die Liste geladen hat, und ein Zustand, der vor dem
    // ersten gelungenen Abruf gespeichert wird, kann einen halben Login
    // enthalten.
    await page
      .getByRole('heading', { name: 'Meetings' })
      .waitFor({ timeout: 30_000 })

    await mkdir(dirname(ZUSTAND), { recursive: true })
    const state = await context.storageState()
    await writeFile(ZUSTAND, JSON.stringify(state, null, 2))
    await context.close()
  } finally {
    await browser.close()
  }
  console.log(`Sitzungszustand geschrieben: ${ZUSTAND}`)
}

/**
 * Nimmt die Liste auf: ankommen, lesen lassen, suchen, das Ergebnis öffnen.
 *
 * Die Zustandsänderung IST der Inhalt — die Kopfzeile zählt von "N Meetings"
 * auf "N Treffer" um. Deshalb steht vor dem Tippen ein `hold`: wer die Zahl
 * vorher nicht gelesen hat, sieht nachher keine Änderung.
 */
async function record(ausgabe: string): Promise<void> {
  await recordWithRecipes(
    {
      // Feste Uhr, damit zwei Aufnahmen dieselben relativen Zeitangaben
      // zeigen ("vor 3 Tagen" wandert sonst zwischen zwei Läufen).
      fixedTime: '2026-09-16T09:00:00Z',
      // Zwei Flächen, die kein Zuschauer sehen soll: der Cookie-Hinweis
      // (Lärm) und die Persönliche-Raum-Karte (interne Adresse, siehe
      // Kopfkommentar).
      hideSelectors: ['#cookie-banner', '[data-testid="personal-room-card"]'],
      out: ausgabe,
      seed: 1,
      storageStatePath: ZUSTAND,
    },
    async (page, demo) => {
      await page.goto(`${BASIS}/meetings`)
      // Auf die erste Zeile warten, nicht auf die Kopfzeile: die Kopfzeile
      // steht sofort im Dokument und sagt eine Sekunde lang "0 Meetings",
      // weil die Liste ihre Zahl erst vom Server holt. Wer auf sie wartet,
      // filmt die Null.
      await warteAuf(page, ERSTE_ZEILE)
      await demo.point('[data-testid="meeting-count"]')
      await demo.hold(1400)

      await demo.type('input[placeholder*="durchsuchen"]', SUCHWORT)
      // Die Liste holt das Ergebnis erst 300 ms nach dem letzten Anschlag
      // vom Server (`useDebounce` in der Oberfläche). Ein kürzeres Halten
      // filmt die alte Zahl.
      await demo.hold(1800)
      await demo.point('[data-testid="meeting-count"]')
      await demo.hold(1200)

      await demo.click(ERSTE_ZEILE)
      await warteAuf(page, 'h1')
      await demo.hold(1200)
      await demo.scroll(0, 900)
      await demo.hold(900)
      await demo.scroll(0, 900)
      await demo.hold(1200)
    },
  )
  console.log(`Aufnahme geschrieben: ${ausgabe}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [schritt, ausgabe] = process.argv.slice(2)
  if (schritt === 'prepare') {
    await prepare()
  } else if (schritt === 'record') {
    await record(ausgabe ?? 'artifacts/raven-meetings')
  } else {
    throw new Error(
      'Aufruf: tsx demo/raven-meetings.ts prepare | record [ausgabe-verzeichnis]',
    )
  }
}
