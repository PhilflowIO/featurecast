/*
  The corpus builds itself, from a fixed seed.

  Every cell holds real text with real word boundaries — not a repeated
  filler glyph — because a browser lays out and rasterises the two very
  differently, and the number this fixture exists to produce is a rasterising
  number. Nothing here is random across runs: the same seed yields the same
  3,000-odd cells in the same order, so two recordings a week apart are
  comparable.
*/

const COLUMNS = [
  'Ref',
  'Title',
  'Owner',
  'Status',
  'Priority',
  'Team',
  'Stage',
  'Client',
  'Region',
  'Created',
  'Updated',
  'Due',
  'Budget',
  'Spent',
  'Remaining',
  'Hours',
  'Tags',
  'Source',
  'Channel',
  'Risk',
  'Score',
  'Notes',
]

/**
 * Five collections, each dense enough to clear the benchmark's ten-record
 * floor. The row counts differ so a run that visits the wrong collection is
 * visible in the record count rather than silently plausible.
 */
const COLLECTIONS = [
  { id: 'projects', label: 'Projects', rows: 42, seed: 11 },
  { id: 'tasks', label: 'Tasks', rows: 58, seed: 23 },
  { id: 'invoices', label: 'Invoices', rows: 47, seed: 37 },
  { id: 'users', label: 'Users', rows: 36, seed: 51 },
  { id: 'expenses', label: 'Expenses', rows: 51, seed: 67 },
]

const SUBJECTS = [
  'Web relaunch',
  'Billing migration',
  'Partner portal',
  'Mobile checkout',
  'Data warehouse',
  'Support inbox',
  'Contract review',
  'Pricing update',
  'Onboarding flow',
  'Invoice export',
  'Access audit',
  'Search rewrite',
]
const QUALIFIERS = [
  'phase two',
  'rollout',
  'hardening',
  'pilot',
  'cleanup',
  'handover',
  'north region',
  'second wave',
]
const FIRST = [
  'Anna',
  'Bernd',
  'Carla',
  'Dario',
  'Elif',
  'Frank',
  'Greta',
  'Hakan',
  'Ines',
  'Jonas',
  'Katja',
  'Lasse',
]
const LAST = [
  'Brandt',
  'Cordes',
  'Dahl',
  'Engel',
  'Fischer',
  'Gruber',
  'Hansen',
  'Ivanov',
  'Jansen',
  'Kaiser',
  'Lorenz',
  'Meier',
]
const STATUS = ['Open', 'In review', 'Blocked', 'Scheduled', 'Done', 'Draft']
const PRIORITY = ['Low', 'Normal', 'High', 'Critical']
const TEAM = ['Platform', 'Billing', 'Growth', 'Support', 'Data', 'Design']
const STAGE = ['Discovery', 'Build', 'Verify', 'Ship', 'Measure']
const CLIENT = [
  'Nordwind AG',
  'Kestrel Ltd',
  'Vela Group',
  'Hafen & Co',
  'Brightlane',
  'Maris Werke',
]
const REGION = ['DE North', 'DE South', 'AT', 'CH', 'NL', 'DK']
const TAGS = [
  'web, billing',
  'mobile, pilot',
  'data, export',
  'support, sla',
  'design, audit',
  'infra, cost',
]
const SOURCE = ['Inbound', 'Referral', 'Renewal', 'Campaign', 'Partner']
const CHANNEL = ['Email', 'Phone', 'Portal', 'Chat', 'Field']
const RISK = ['None', 'Watch', 'Elevated', 'Severe']

/** A linear congruential generator: same seed, same corpus, every run. */
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length]
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

function date(random, year) {
  return `${String(year)}-${pad(1 + Math.floor(random() * 12), 2)}-${pad(
    1 + Math.floor(random() * 28),
    2,
  )}`
}

function money(random, scale) {
  return `€ ${String(Math.floor(random() * scale) + 120).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    '.',
  )}`
}

function buildRows(collection) {
  const random = makeRandom(collection.seed)
  const rows = []
  for (let index = 0; index < collection.rows; index += 1) {
    const owner = `${pick(FIRST, random)} ${pick(LAST, random)}`
    const budget = Math.floor(random() * 90_000) + 4_000
    const spent = Math.floor(budget * (0.2 + random() * 0.7))
    rows.push({
      cells: [
        `${collection.id.slice(0, 3).toUpperCase()}-${pad(1040 + index * 7, 4)}`,
        `${pick(SUBJECTS, random)} ${pick(QUALIFIERS, random)}`,
        owner,
        pick(STATUS, random),
        pick(PRIORITY, random),
        pick(TEAM, random),
        pick(STAGE, random),
        pick(CLIENT, random),
        pick(REGION, random),
        date(random, 2025),
        date(random, 2026),
        date(random, 2026),
        `€ ${String(budget)}`,
        `€ ${String(spent)}`,
        `€ ${String(budget - spent)}`,
        `${String(Math.floor(random() * 320) + 12)} h`,
        pick(TAGS, random),
        pick(SOURCE, random),
        pick(CHANNEL, random),
        pick(RISK, random),
        String(Math.floor(random() * 100)),
        `${pick(SUBJECTS, random)} — ${pick(QUALIFIERS, random)}, ${money(
          random,
          40_000,
        )} committed`,
      ],
      owner,
    })
  }
  return rows
}

const DATA = new Map(
  COLLECTIONS.map((collection) => [collection.id, buildRows(collection)]),
)

const nav = document.getElementById('nav')
const head = document.getElementById('head')
const body = document.getElementById('body')
const title = document.getElementById('title')
const count = document.getElementById('count')
const notes = document.getElementById('notes')
const search = document.getElementById('search')
const theme = document.getElementById('theme')
const page = document.getElementById('page')
const gridScroller = document.getElementById('gridscroller')

let current = COLLECTIONS[0]
let sortColumn = -1
let sortDirection = 1

for (const collection of COLLECTIONS) {
  const link = document.createElement('a')
  link.href = `#/collections/${collection.id}`
  link.title = collection.id
  link.textContent = collection.label
  nav.append(link)
}

{
  const row = document.createElement('tr')
  for (const [index, column] of COLUMNS.entries()) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = column
    cell.addEventListener('click', () => {
      sortDirection = sortColumn === index ? -sortDirection : 1
      sortColumn = index
      renderRows()
    })
    row.append(cell)
  }
  head.append(row)
}

for (let index = 0; index < 12; index += 1) {
  const article = document.createElement('article')
  const heading = document.createElement('h2')
  heading.textContent = `${SUBJECTS[index % SUBJECTS.length]} — note ${String(
    index + 1,
  )}`
  const paragraph = document.createElement('p')
  paragraph.textContent =
    'Recorded for the capture benchmark. This block exists so the page ' +
    'container has a scroll range of its own below the grid, which is what ' +
    'makes the grid a scroll container inside a scroll container rather ' +
    'than a scroll container inside a static page.'
  article.append(heading, paragraph)
  notes.append(article)
}

function renderRows() {
  const query = search.value.trim().toLowerCase()
  const rows = [...DATA.get(current.id)]
  if (sortColumn >= 0) {
    rows.sort((left, right) => {
      const a = left.cells[sortColumn]
      const b = right.cells[sortColumn]
      return a === b ? 0 : (a < b ? -1 : 1) * sortDirection
    })
  }
  body.replaceChildren()
  for (const row of rows) {
    if (query !== '' && !row.cells.join(' ').toLowerCase().includes(query)) {
      continue
    }
    const element = document.createElement('tr')
    for (const [index, value] of row.cells.entries()) {
      const cell = document.createElement('td')
      if (index === 2) {
        const wrapper = document.createElement('span')
        wrapper.className = 'owner'
        const label = document.createElement('span')
        label.textContent = value
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = '+'
        button.setAttribute('aria-label', 'Expand Owner')
        button.addEventListener('click', (event) => {
          event.stopPropagation()
          toggleDetail(element, row)
        })
        wrapper.append(label, button)
        cell.append(wrapper)
      } else {
        cell.textContent = value
      }
      element.append(cell)
    }
    body.append(element)
  }
}

function toggleDetail(rowElement, row) {
  const next = rowElement.nextElementSibling
  if (next !== null && next.classList.contains('detail')) {
    next.remove()
    return
  }
  const detail = document.createElement('tr')
  detail.className = 'detail'
  const cell = document.createElement('td')
  cell.colSpan = COLUMNS.length
  cell.textContent =
    `${row.owner} owns ${row.cells[1]} for ${row.cells[7]} ` +
    `(${row.cells[8]}). Budget ${row.cells[12]}, spent ${row.cells[13]}, ` +
    `${row.cells[15]} logged against ${row.cells[6]}.`
  detail.append(cell)
  rowElement.after(detail)
}

function show(id) {
  current = COLLECTIONS.find((collection) => collection.id === id) ?? current
  sortColumn = -1
  sortDirection = 1
  title.textContent = current.label
  count.textContent = `${String(current.rows)} records`
  document.title = `${current.label} — Bench Corpus`
  for (const link of nav.querySelectorAll('a')) {
    link.classList.toggle('active', link.title === current.id)
  }
  renderRows()
  page.scrollTo(0, 0)
  gridScroller.scrollTo(0, 0)
}

function applyRoute() {
  const match = /#\/collections\/([a-z]+)/.exec(location.hash)
  show(match === null ? COLLECTIONS[0].id : match[1])
}

function applyTheme(dark) {
  document.body.classList.toggle('dark', dark)
  theme.textContent = dark ? 'Light' : 'Dark'
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode'
  theme.setAttribute('aria-label', label)
  theme.title = label
  // Deliberately unguarded: first-party storage is exactly what a shell
  // served from a foreign origin would take away, and a fixture that
  // swallowed that error would hide the failure the framed capture exists
  // to avoid (see src/framed.ts).
  localStorage.setItem('bench-theme', dark ? 'dark' : 'light')
}

theme.addEventListener('click', () => {
  applyTheme(!document.body.classList.contains('dark'))
})
search.addEventListener('input', renderRows)
window.addEventListener('hashchange', applyRoute)

applyTheme(localStorage.getItem('bench-theme') === 'dark')
applyRoute()
