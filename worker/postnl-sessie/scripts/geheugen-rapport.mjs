// Rapport van de geheugenmeting van de sessiehouder (matransport#668). Op de VPS:
//
//   cd /opt/postnl-scrapers/worker/postnl-sessie
//   node scripts/geheugen-rapport.mjs /var/log/workers/postnl/geheugen-46064b3a-2026-11-11.jsonl
//   node scripts/geheugen-rapport.mjs /var/log/workers-b/postnl/geheugen-*.jsonl     (Stack B, alle dagen)
//   ... --json   (ruwe uitkomst, voor verder rekenen)
//
// Leest alleen; per uur het hoogste totaal en de verdeling, per taak wat die gemiddeld en in totaal
// aan geheugen toevoegt, en de grootste sprongen. Uitleg van de velden: POSTNL_SESSIE.md § Geheugen.
import fs from 'node:fs'
import { maakRapport } from '../src/geheugenRapport.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const bestanden = args.filter(a => a !== '--json')
if (!bestanden.length) { console.error('Gebruik: node scripts/geheugen-rapport.mjs <geheugen-….jsonl> [...] [--json]'); process.exit(2) }

const regels = []
let kapot = 0
for (const b of bestanden) {
  for (const l of fs.readFileSync(b, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try { regels.push(JSON.parse(l)) } catch { kapot++ }
  }
}
const r = maakRapport(regels)
if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }

const kol = (x, n = 6) => String(x ?? '-').padStart(n)
console.log(`${r.minuten} minuutregels, ${r.taakregels} taakregels${kapot ? `, ${kapot} onleesbaar` : ''}\n`)
console.log('PER UUR (MB)   totaal  proces   heap buitenV8  video  | per browser: max (tabbladen max, aantal, gpu)')
for (const u of r.uren) {
  const b = Object.entries(u.browsers).map(([d, x]) => `${d} ${x.maxMb} (${x.tabbladMaxMb}, ${x.tabbladenMax}x, gpu ${x.gpuMaxMb})`).join('  ')
  console.log(`${u.uur.slice(5)} ${kol(u.totaalMaxMb, 7)} ${kol(u.procesGemMb, 7)} ${kol(u.heapGemMb)} ${kol(u.buitenV8GemMb, 8)} ${kol(u.videoMaxMb)}  | ${b}`)
}
console.log('\nPER TAAK (MB, verschil voor/na)   aantal login    som   gem   max  browser tabblad proces  duur(s)')
for (const t of r.taken) {
  console.log(`${`${t.depot} ${t.taak}`.padEnd(32)} ${kol(t.aantal)} ${kol(t.metLogin, 5)} ${kol(t.somMb)} ${kol(t.gemMb, 5)} ${kol(t.maxMb, 5)} ${kol(t.browserGemMb, 8)} ${kol(t.tabbladGemMb, 7)} ${kol(t.procesGemMb, 6)} ${kol(t.duurGemSec, 8)}`)
}
console.log('\nGROOTSTE SPRONGEN')
for (const s of r.sprongen) {
  const tijd = new Date(s.t).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' })
  console.log(`${tijd} ${s.depot} ${s.taak}${s.login ? ' (login)' : ''}: +${s.totaalMb} MB in ${s.duurSec} s (browser ${s.browserMb}, tabbladen ${s.tabbladMb}, proces ${s.procesMb}, heap ${s.heapMb}) → ${s.naMb} MB`)
}
