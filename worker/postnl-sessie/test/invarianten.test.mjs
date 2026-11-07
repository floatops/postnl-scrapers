// node --test — regels tússen onderdelen van de sessiehouder (floatops/matransport#599).
//
// Waarom: de losse onderdelen hadden elk hun tests, maar niemand controleerde of ze bij elkaar
// pasten. Zo was het sessie-slot 180 s geldig en alleen tussen taken verlengd, terwijl er taken van
// 300–1500 s bijkwamen (05-11: 7 extra logins, #598). Een nieuwe taak, limiet of instelling die
// zo'n regel breekt, maakt deze tests rood, en dan gaat hij niet live (auto-deploy-scrapers draait
// de tests vóór elke update).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TAKEN } from '../src/taken.js'
import { STANDAARD, waakhondMs } from '../src/instellingen.js'
import { LOGIN_MAX_SEC } from '../../credentials-shared/src/postnl/login.js'

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('elke taak heeft een eigen tijdslimiet (geen stille standaard)', () => {
  for (const t of TAKEN) assert.ok(Number.isFinite(STANDAARD.taakLimietSec[t.naam]), `taak ${t.naam} heeft geen taakLimietSec`)
})

test('het slot overleeft twee gemiste hartslagen, en verloopt na een crash binnen een paar minuten', () => {
  assert.ok(STANDAARD.slotHartslagSec * 2 < STANDAARD.slotLeaseSec, 'lease moet minstens twee hartslagen overbruggen')
  assert.ok(STANDAARD.slotLeaseSec <= 300, 'na een crash moet het vangnet binnen 5 min kunnen overnemen')
})

test('de waakhond schiet een gezonde lange taak (plus twee logins) niet af', () => {
  const langste = Math.max(...Object.values(STANDAARD.taakLimietSec))
  assert.ok(waakhondMs(STANDAARD) > (langste + 2 * LOGIN_MAX_SEC) * 1000, 'waakhond korter dan langste taak + logins')
})

test('de pauze na te veel logins is korter dan een uur (anders telt het venster van maxLoginsPerUur niet meer)', () => {
  assert.ok(STANDAARD.pauzeMin < 60)
})

test('de rem per taak komt na de nieuwe login, niet ervoor', () => {
  assert.ok(STANDAARD.taakFoutenRem > STANDAARD.maxFoutenAchtereen)
  assert.ok(STANDAARD.taakRemMaxMin <= 30, 'een geremde taak moet binnen een half uur weer een kans krijgen')
})

// ---- Nooit wachten zonder grens ----
// 05-11 (#592, #598): twee keer bleef de sessiehouder hangen op een belofte die nooit klaar kwam.
// Elke Promise.all/allSettled en elk uitlezen van een antwoord (json/text/body) moet een grens
// hebben (Promise.race met een timer), of hieronder staan met de reden waarom het begrensd is.
const MAPPEN = ['postnl-sessie/src', 'postnl-planner/src', 'postnl-ritmonitor/src', 'postnl-rva/src', 'credentials-shared/src', 'postnl-dagplanning/src']
const TOEGESTAAN = [
  { bestand: 'postnl-sessie/src/handlers.js', regel: /Promise\.all\(\[/, reden: 'twee databasevragen in rvaBijlezen; de taak zelf heeft een limiet (metLimiet)' },
  { bestand: 'postnl-ritmonitor/src/index.js', regel: /Promise\.allSettled\(DEPOTS/, reden: 'los script: elk depot heeft eigen time-outs, de VPS stopt het proces na zijn timeout' },
  { bestand: 'postnl-ritmonitor/src/ritmonitor.js', regel: /Promise\.all\(\[/, reden: 'databaseschrijfacties; binnen de ritmonitor-taak met limiet' },
]
const RISICO = [
  /Promise\.(all|allSettled|any)\(/,
  /await\s+[\w.?]+\.(json|text|body)\(\)/,
  /evaluate\(\s*\(?[^)]*\)?\s*=>\s*new Promise/,   // page.evaluate heeft geen time-out
  /\btimeout:\s*0\b/,
  /setDefault(Navigation)?Timeout\(\s*0\s*\)/,
]

function bestanden(map) {
  const uit = []
  const loop = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) { if (n.name !== 'node_modules') loop(p) } else if (/\.(m?js)$/.test(n.name)) uit.push(p)
    }
  }
  if (fs.existsSync(map)) loop(map)
  return uit
}

test('nooit wachten zonder grens: Promise.all/allSettled en antwoord-uitlezen alleen met een grens of met reden', () => {
  const fout = []
  for (const map of MAPPEN) {
    for (const f of bestanden(path.join(WORKER, map))) {
      const rel = path.relative(WORKER, f).split(path.sep).join('/')
      fs.readFileSync(f, 'utf8').split('\n').forEach((regel, i) => {
        if (/^\s*\/\//.test(regel)) return
        if (!RISICO.some(r => r.test(regel))) return
        if (/Promise\.race\(/.test(regel)) return
        if (TOEGESTAAN.some(t => t.bestand === rel && t.regel.test(regel))) return
        fout.push(`${rel}:${i + 1}: ${regel.trim()}`)
      })
    }
  }
  assert.deepEqual(fout, [], 'zet er een grens op (Promise.race met een timer), of zet de regel met reden in TOEGESTAAN')
})

// Elk bronbestand van elke worker is geldige JavaScript (matransport#608). De sessiehouder laadt
// postnl-planner/src/index.js pas bij een Plannen-taak (import()), en geen test importeert dat
// bestand: een syntaxfout erin ging op 06-11 door de tests en de proefperiode heen, en elke
// Plannen-ronde faalde daarna met "Unexpected token '.'".
test('elk bronbestand van elke worker is geldige JavaScript (node --check)', () => {
  const fout = []
  for (const w of fs.readdirSync(WORKER, { withFileTypes: true }).filter(d => d.isDirectory())) {
    for (const sub of ['src', 'scripts']) {
      for (const f of bestanden(path.join(WORKER, w.name, sub))) {
        const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 30_000 })
        if (r.status !== 0) {
          const regels = (r.stderr || r.error?.message || '').split(/\r?\n/)
          const plek = regels.find(l => /:\d+$/.test(l.trim()))?.trim().split(/[\\/]/).pop() ?? ''
          fout.push(`${path.relative(WORKER, f).split(path.sep).join('/')} (${plek}): ${regels.find(l => /Error/.test(l)) ?? 'node --check faalde'}`)
        }
      }
    }
  }
  assert.deepEqual(fout, [])
})

// node --check ziet geen koppelfouten (een import van een naam die niet geëxporteerd wordt, een
// verkeerd pad). De bestanden die de sessiehouder pas bij een taak via import() laadt
// (src/handlers.js), worden daarom echt geladen, in een kindproces met een nep-omgeving: hun main()
// draait alleen als ze zelf het startscript zijn, dus er gaat niets naar buiten. Zonder node_modules
// van die worker (lokaal soms) slaat de test hem over; in de werkmap van de deploy zijn ze er.
const LATER_GELADEN = ['postnl-planner/src/index.js', 'postnl-rva/src/index.js']
test('wat de sessiehouder pas bij een taak laadt (import()), laadt ook echt', (t) => {
  const handlers = fs.readFileSync(path.join(WORKER, 'postnl-sessie/src/handlers.js'), 'utf8')
  const doelen = [...handlers.matchAll(/import\('\.\.\/\.\.\/([^']+)'\)/g)].map(m => m[1])
  assert.deepEqual([...doelen].sort(), [...LATER_GELADEN].sort(), 'nieuw import()-doel in handlers.js: zet het in LATER_GELADEN')
  for (const doel of LATER_GELADEN) {
    if (!fs.existsSync(path.join(WORKER, doel.split('/')[0], 'node_modules'))) {
      // In de deploy (auto-deploy-scrapers.sh zet INVARIANTEN_STRENG) is overslaan rood: daar
      // betekent het dat npm install mislukte, en dan zou de bescherming stil uit staan.
      assert.ok(!process.env.INVARIANTEN_STRENG, `${doel}: geen node_modules, de laadtest kan niet draaien`)
      t.diagnostic(`${doel}: geen node_modules, overgeslagen`)
      continue
    }
    const url = pathToFileURL(path.join(WORKER, doel)).href
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
      encoding: 'utf8', timeout: 60_000, cwd: os.tmpdir(),
      env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'x', KLANT_ID: '00000000-0000-0000-0000-000000000000' },
    })
    assert.equal(r.status, 0, `${doel} laadt niet: ${(r.stderr || r.error?.message || '').split(/\r?\n/).find(l => /Error/.test(l))}`)
  }
})

// ---- Niets stapelt zich op zolang de browser open blijft (#600) ----
test('de sessiehouder gebruikt geen trace-chunks en houdt zijn tijdelijke bestanden in de eigen werkmap', () => {
  const code = fs.readFileSync(path.join(WORKER, 'postnl-sessie/src/sessie.js'), 'utf8').split('\n').filter(r => !/^\s*\/\//.test(r)).join('\n')
  assert.ok(!/stopChunk|startChunk/.test(code), 'stopChunk kopieert het hele netwerklog en ruimt niets op tot de browser sluit: 6-7 GB per uur per depot')
  assert.match(code, /tracesDir: this\.tracesDir/, 'zonder tracesDir komt alles in playwright-artifacts-*, tot de browser sluit')
  assert.ok(!/os\.tmpdir\(\), 'postnl-sessie-'\)/.test(code), 'videomappen in de werkmap: die ruimt de volgende start op na een crash')
})

test('een taak over zijn limiet is binnen de slot-lease afgehandeld', () => {
  assert.ok(STANDAARD.taakAfbouwSec * 2 < STANDAARD.slotLeaseSec)
  assert.ok(STANDAARD.taakAfbouwSchrijfSec <= 120, 'tijdens de afbouw loopt de hartslag door, maar de waakhond wacht niet eindeloos')
})

test('de reservering per depot ligt boven wat er gemeten is, en herstarten ruim daarboven', () => {
  assert.ok(STANDAARD.geheugenReserveBasisMb + STANDAARD.geheugenReserveMbPerDepot * 2 > 4303, 'piek M&A (2 depots) op 06-11')
  assert.ok(STANDAARD.geheugenTotaalHerstartDeel >= 1.25)
})

test('browseraanroepen op het noodpad hebben een grens (#600)', () => {
  const depot = fs.readFileSync(path.join(WORKER, 'postnl-sessie/src/depot.js'), 'utf8')
  assert.match(depot, /metLimiet\(sessie\.nieuwSegment\(\)/, 'nieuwSegment alleen met een limiet')
  assert.ok(!/await sessie\.nieuwSegment\(\)/.test(depot))
  const code = fs.readFileSync(path.join(WORKER, 'postnl-sessie/src/sessie.js'), 'utf8')
  assert.ok(!/await (this|oud)\.(context|browser)\??\.(close|tracing\.stop)\(/.test(code), 'sluiten en stoppen altijd via grens()')
})

test('losse scripts hebben een korte lease: het vangnet neemt na een crash binnen 5 min over (#600)', () => {
  for (const f of ['postnl-dagplanning/src/index.js', 'postnl-ritmonitor/src/index.js', 'postnl-planner/src/index.js']) {
    const m = /pakSessieSlot\(supabase, \{[\s\S]*?seconden: (\d+)/.exec(fs.readFileSync(path.join(WORKER, f), 'utf8'))
    assert.ok(m && Number(m[1]) <= 300, `${f}: lease ${m?.[1]}; de hartslag houdt het slot vast`)
  }
})

test('planning_stops wordt in stukken gelezen: een antwoord is hooguit 1000 rijen, een shift heeft er 2000 (#600)', () => {
  const code = fs.readFileSync(path.join(WORKER, 'postnl-planner/src/index.js'), 'utf8')
  const lezen = [...code.matchAll(/from\('planning_stops'\)\.select\(\['stop_id'[\s\S]{0,260}/g)].map(m => m[0])
  assert.ok(lezen.length >= 1)
  for (const l of lezen) assert.match(l, /\.range\(/, 'zonder range mist hij stops, en dan zijn stops die weg zijn niet te zien')
})

test('sluiten van een context krijgt de tijd om de video af te maken, binnen wat de hartslag dekt (#600)', async () => {
  const { CONTEXT_SLUIT_MS } = await import('../src/sessie.js')
  assert.ok(CONTEXT_SLUIT_MS >= 120_000, '06-11: 30 s was te kort, elk videosegment gaf een nieuwe login')
  const depot = fs.readFileSync(path.join(WORKER, 'postnl-sessie/src/depot.js'), 'utf8')
  assert.ok(!/levend\(120_000\)/.test(depot), 'de hartslag moet het sluiten dekken')
  assert.ok(CONTEXT_SLUIT_MS + 30_000 * 2 <= 240_000)
})
