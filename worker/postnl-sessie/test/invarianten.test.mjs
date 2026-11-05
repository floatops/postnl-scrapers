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
import { fileURLToPath } from 'node:url'
import { TAKEN } from '../src/taken.js'
import { STANDAARD, waakhondMs } from '../src/instellingen.js'

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('elke taak heeft een eigen tijdslimiet (geen stille standaard)', () => {
  for (const t of TAKEN) assert.ok(Number.isFinite(STANDAARD.taakLimietSec[t.naam]), `taak ${t.naam} heeft geen taakLimietSec`)
})

test('het slot overleeft twee gemiste hartslagen, en verloopt na een crash binnen een paar minuten', () => {
  assert.ok(STANDAARD.slotHartslagSec * 2 < STANDAARD.slotLeaseSec, 'lease moet minstens twee hartslagen overbruggen')
  assert.ok(STANDAARD.slotLeaseSec <= 300, 'na een crash moet het vangnet binnen 5 min kunnen overnemen')
})

test('de waakhond schiet een gezonde lange taak (plus login) niet af', () => {
  const langste = Math.max(...Object.values(STANDAARD.taakLimietSec))
  assert.ok(waakhondMs(STANDAARD) > (langste + 180) * 1000, 'waakhond korter dan langste taak + login')
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
const RISICO = [/Promise\.(all|allSettled)\(/, /await\s+[\w.]+\.(json|text|body)\(\)/]

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
