// Meting "één login, twee tabbladen" (floatops/matransport#569): één browser, één context, tab A
// OOM PD en tab B RVA, met dezelfde login, zoals in de sessiehouder. Elke ronde werkt in beide
// tabbladen (alleen lezen) en kijkt of PostNL een van de twee heeft teruggezet of uitgelogd.
//
//   node scripts/twee-tabs.mjs --oompd "<portaal-URL van het depot>" --rit "<ritnaam>" --dag Za [--minuten 30]
//
// ⚠️ Alleen als de sessiehouder voor dit depot NIET draait (na 23:00, of RVA en de sessiehouder
// uit): anders is dit een tweede OOM PD-sessie, en twee OOM PD-sessies met dezelfde login gooien
// elkaar wel eruit (#361). Je logt zelf in (of de sessie van de proef wordt hergebruikt).
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { volgMendix } from '../../postnl-planner/src/mendix.js'
import { SEL_PLANNING, SEL_DAGPLANNING, SEL_DAG, opStartpagina, isLoginPagina } from '../../credentials-shared/src/postnl/login.js'
import { nlTijdstempel } from '../../credentials-shared/src/sessieVideo.js'
import * as rva from '../src/index.js'

const { values: a } = parseArgs({ options: {
  oompd: { type: 'string' }, rit: { type: 'string' }, dag: { type: 'string', default: 'Za' }, minuten: { type: 'string', default: '30' },
} })
if (!a.oompd || !a.rit) {
  console.error('Gebruik: node scripts/twee-tabs.mjs --oompd "<portaal-URL>" --rit "<ritnaam>" [--dag Za] [--minuten 30]')
  process.exit(2)
}
const map = path.resolve('opnames', `twee-tabs-${nlTijdstempel()}`)
await fs.mkdir(map, { recursive: true })
const SESSIE = path.resolve('opnames', '.sessie.json')
const vorige = await fs.access(SESSIE).then(() => SESSIE, () => undefined)

const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: map, size: { width: 1440, height: 900 } }, storageState: vorige })
const oom = await context.newPage()
const tab = await context.newPage()
const mendix = volgMendix(tab)
const zicht = (loc) => loc.isVisible().catch(() => false)
const tijd = () => new Date().toLocaleTimeString('nl-NL')
const rondes = []

async function oomOpen() {
  await oom.goto(a.oompd, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  const tot = Date.now() + 5 * 60_000
  while (!(await zicht(oom.locator(SEL_PLANNING).first()))) {
    if (Date.now() > tot) throw new Error('OOM PD niet in beeld (log in het OOM PD-tabblad in)')
    await oom.waitForTimeout(1_000)
  }
}

// Tab A: Planning → Dagplanning, wachten op de dagkeuze (alleen lezen).
async function oomRonde() {
  await oom.locator(SEL_PLANNING).first().click()
  await oom.locator(SEL_DAGPLANNING).first().click({ timeout: 10_000 }).catch(() => {})
  const open = await oom.locator(SEL_DAG).first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
  return { open, startpagina: await opStartpagina(oom), login: isLoginPagina(oom.url()) }
}

// Tab B: Rittenoverzicht → de rit-dag openen en lezen (alleen lezen).
async function rvaRonde() {
  await rva.naarRittenoverzicht(tab, mendix)
  await rva.openRitDag(tab, mendix, a.rit, a.dag)
  const regels = await rva.leesRegels(tab)
  return { regels: regels.length, login: isLoginPagina(tab.url()) }
}

try {
  console.log(`Twee tabbladen, één login — ${a.minuten} min, elke minuut. Log in als PostNL erom vraagt.`)
  await oomOpen()
  await rva.openRva(tab, { maxMs: 5 * 60_000 })
  await context.storageState({ path: SESSIE }).catch(() => {})
  const eind = Date.now() + Number(a.minuten) * 60_000
  for (let n = 1; Date.now() < eind; n++) {
    const r = { n, tijd: tijd() }
    // Om de beurt eerst A of eerst B, en ook een keer vlak na elkaar: zo valt een terugzetten op.
    try { Object.assign(r, { oom: await oomRonde() }) } catch (e) { r.oom = { fout: e.message.split('\n')[0] } }
    try { Object.assign(r, { rva: await rvaRonde() }) } catch (e) { r.rva = { fout: e.message.split('\n')[0] } }
    r.oomNa = { startpagina: await opStartpagina(oom), login: isLoginPagina(oom.url()) }
    const ok = r.oom?.open && !r.oom.startpagina && !r.oom.login && !r.oomNa.startpagina && !r.oomNa.login && r.rva?.regels > 0 && !r.rva.login
    r.ok = Boolean(ok)
    rondes.push(r)
    console.log(`${r.ok ? '✔' : '✘'} ronde ${n} ${r.tijd} — OOM PD: ${r.oom?.fout ?? (r.oom.open ? 'Dagplanning open' : 'NIET open')}${r.oomNa.startpagina ? ', daarna STARTPAGINA' : ''}${r.oomNa.login ? ', daarna LOGIN' : ''} | RVA: ${r.rva?.fout ?? `${r.rva.regels} regels`}${r.rva?.login ? ', LOGIN' : ''}`)
    await oom.waitForTimeout(60_000)
  }
} catch (err) {
  console.log(`✘ ${err.message.split('\n')[0]}`)
} finally {
  await fs.writeFile(path.join(map, 'rondes.json'), JSON.stringify(rondes, null, 2))
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  const fout = rondes.filter(r => !r.ok).length
  console.log(`\n${rondes.length - fout}/${rondes.length} rondes zonder terugzetten of uitloggen. Opname: ${map}`)
  process.exitCode = fout ? 1 : 0
}
