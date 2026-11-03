// Eén handeling op één rit-dag uitvoeren, bijvoorbeeld om iets met de hand te herstellen
// (floatops/matransport#569). Zichtbare browser; hergebruikt de sessie van de proef
// (opnames/.sessie.json), anders log je zelf in. Draai buiten werktijd (na 23:00).
//
//   node scripts/handeling.mjs --rit "<ritnaam>" --dag Za --soort onderbreking_weg --regel 2 [--echt]
//   soorten: volgorde (--nummer), richting (--richting), knip (--tm), samenvoegen (--naar),
//            onderbreking (--minuten), onderbreking_weg
// --regel is het volgnummer zoals RVA het nu toont. Zonder --echt: alles Annuleer.
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { volgMendix } from '../../postnl-planner/src/mendix.js'
import * as rva from '../src/index.js'
import { regelSleutel } from '../src/plan.js'

const { values: a } = parseArgs({ options: {
  rit: { type: 'string' }, dag: { type: 'string' }, soort: { type: 'string' }, regel: { type: 'string' },
  nummer: { type: 'string' }, richting: { type: 'string' }, tm: { type: 'string' }, naar: { type: 'string' }, minuten: { type: 'string' },
  echt: { type: 'boolean', default: false },
} })
if (!a.rit || !a.dag || !a.soort || !a.regel) {
  console.error('Gebruik: node scripts/handeling.mjs --rit "<ritnaam>" --dag Za --soort <soort> --regel <nr> [opties] [--echt]')
  process.exit(2)
}

const SESSIE = path.resolve('opnames', '.sessie.json')
const vorige = await fs.access(SESSIE).then(() => SESSIE, () => undefined)
const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: vorige })
const page = await context.newPage()
const mendix = volgMendix(page)
try {
  await rva.openRva(page, { maxMs: 5 * 60_000 })
  await context.storageState({ path: SESSIE }).catch(() => {})
  await rva.openRitDag(page, mendix, a.rit, a.dag)
  const regels = await rva.leesRegels(page)
  const regel = regels[Number(a.regel) - 1]
  if (!regel) throw new Error(`Regel ${a.regel} bestaat niet (rit-dag heeft ${regels.length} regels)`)
  const h = { soort: a.soort, regel: regelSleutel(regel) }
  if (a.nummer) h.nummer = Number(a.nummer)
  if (a.richting) h.richting = a.richting
  if (a.tm) h.tm = Number(a.tm)
  if (a.naar) h.naar = a.naar
  if (a.soort === 'onderbreking') h.minuten = a.minuten ?? null
  const uit = await rva.voerUit(page, mendix, { rit: a.rit, dag: a.dag, handelingen: [h] }, { echt: a.echt })
  console.log(`✔ ${a.soort} op regel ${a.regel}: ${a.echt ? 'opgeslagen' : 'geannuleerd (proef)'}${uit.stappen[0]?.meldingen.length ? ` — PostNL: ${uit.stappen[0].meldingen.join(' / ')}` : ''}`)
} catch (err) {
  console.log(`✘ ${err.soort ? `[${err.soort}] ` : ''}${String(err.message).split('\n')[0]}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
