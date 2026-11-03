// Proefronde RVA (floatops/matransport#569): alle handelingen uit de opnames van 03-11 op twee
// testritten, met controle na elke stap. Zichtbare browser; je logt zelf in bij PostNL (geen
// inloggegevens of sleutels nodig). Draai buiten werktijd (na 23:00).
//
//   node scripts/proef.mjs --klein "<ritnaam>" --groot "<ritnaam>" [--dag Za] [--echt]
//
// Zonder --echt: alles in de kladversie, afgesloten met Annuleer; alleen wat sowieso direct
// opslaat (kopieer weekdag, verantwoordelijke) wordt overgeslagen. Met --echt: opslaan,
// controleren, en daarna de revisie van vóór de proef terugzetten en vergelijken met het begin.
// De testritten staan in matransport#569 (niet hier: deze repo is publiek).
//
// Opname (video + trace + Excel) in ./opnames/<tijd>/ — die map staat in .gitignore.
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { volgMendix } from '../../postnl-planner/src/mendix.js'
import { nlTijdstempel } from '../../credentials-shared/src/sessieVideo.js'
import * as rva from '../src/index.js'
import { regelSleutel, verschillen, revisieTijdTekst } from '../src/plan.js'

const { values: arg } = parseArgs({ options: {
  klein: { type: 'string' }, groot: { type: 'string' }, dag: { type: 'string', default: 'Za' },
  echt: { type: 'boolean', default: false }, alleen: { type: 'string' },
} })
if (!arg.klein || !arg.groot) {
  console.error('Gebruik: node scripts/proef.mjs --klein "<ritnaam>" --groot "<ritnaam>" [--dag Za] [--echt] [--alleen <test>]')
  process.exit(2)
}
const ECHT = arg.echt
const DAG = arg.dag
const map = path.resolve('opnames', nlTijdstempel())
await fs.mkdir(map, { recursive: true })

const uitslag = []
const log = { log: (...a) => console.log(...a), warn: (...a) => console.warn(...a) }
function noteer(test, ok, detail = '') {
  uitslag.push({ test, ok, detail })
  console.log(`${ok ? '✔' : '✘'} ${test}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: map, size: { width: 1440, height: 900 } }, acceptDownloads: true })
const page = await context.newPage()
const mendix = volgMendix(page)

// De revisie die nu actief is, als tekst zoals de lijst hem toont: daar zetten we na de proef op terug.
async function actieveRevisie(rit) {
  await rva.openRitDag(page, mendix, rit, DAG)
  const { rijen } = await rva.openRevisies(page, mendix)
  await rva.sluitVenster(page, mendix)
  return rijen.find(r => r.actief)?.gemaaktOp ?? null
}

async function terugNaarBegin(rit, revisie, begin) {
  await rva.openRitDag(page, mendix, rit, DAG)
  await rva.zetRevisieTerug(page, mendix, revisie)
  await rva.openRitDag(page, mendix, rit, DAG)
  const nu = await rva.leesRegels(page)
  const v = verschillen(begin, nu)
  noteer(`${rit === arg.klein ? 'klein' : 'groot'}: revisie ${revisie} terug, gelijk aan het begin`, v.length === 0, v.join('; '))
}

async function test(naam, fn) {
  if (arg.alleen && !naam.startsWith(arg.alleen)) return
  try { await fn() } catch (err) {
    noteer(naam, false, `${err.soort ? `[${err.soort}] ` : ''}${String(err.message).split('\n')[0]}`)
    await rva.sluitVenster(page, mendix).catch(() => {})
    if (await rva.inBewerkstand(page).catch(() => false)) await rva.annuleer(page, mendix).catch(() => {})
  }
}

try {
  console.log(`Proef RVA — ${ECHT ? 'ECHT (opslaan + terugzetten)' : 'proefstand (alles Annuleer)'} — dag ${DAG}`)
  console.log('Log in bij PostNL in het venster dat opengaat (5 minuten de tijd)...')
  await rva.openRva(page, { maxMs: 5 * 60_000 })
  await context.tracing.start({ screenshots: true, snapshots: true, title: 'RVA proef' })
  await rva.naarRittenoverzicht(page, mendix)
  const rijen = await rva.leesRittenoverzicht(page)
  for (const rit of [arg.klein, arg.groot]) {
    const r = rijen.find(x => x.ritnaam === rit && x.dagen.includes(DAG))
    if (!r) throw new Error(`Testrit niet in het Rittenoverzicht op ${DAG}`)
    if (r.opSlot.includes(DAG)) console.log(`  let op: ${rit === arg.klein ? 'klein' : 'groot'} staat op slot op ${DAG} (vorige poging?), de worker doet eerst Annuleer`)
  }
  noteer('Rittenoverzicht lezen', true, `${rijen.length} rijen`)

  const revKlein = await actieveRevisie(arg.klein)
  const revGroot = await actieveRevisie(arg.groot)
  noteer('Revisies lezen', Boolean(revKlein && revGroot), `actief: ${revKlein ?? '?'} / ${revGroot ?? '?'}`)
  await rva.openRitDag(page, mendix, arg.klein, DAG)
  const beginKlein = await rva.leesRegels(page)
  await rva.openRitDag(page, mendix, arg.groot, DAG)
  const beginGroot = await rva.leesRegels(page)

  // ── Klein: volgorde (ook 0 en te hoog), richting ──
  await test('klein: volgorde + richting', async () => {
    const [a, b] = beginKlein
    const opdracht = { rit: arg.klein, dag: DAG, handelingen: [
      { soort: 'volgorde', regel: regelSleutel(a), nummer: 3 },
      { soort: 'volgorde', regel: regelSleutel(b), nummer: 99 },
      { soort: 'volgorde', regel: regelSleutel(b), nummer: 0 },
      { soort: 'richting', regel: regelSleutel(a), richting: a.richting === 'Oplopend' ? 'Aflopend' : 'Oplopend' },
    ] }
    const uit = await rva.voerUit(page, mendix, opdracht, { echt: ECHT, log })
    noteer('klein: volgorde + richting', uit.stappen.every(s => s.ok), `${uit.stappen.length} stappen${ECHT ? ', opgeslagen' : ', geannuleerd'}`)
    if (ECHT) await terugNaarBegin(arg.klein, revKlein, beginKlein)
  })

  // ── Slot: Wijzig, tabblad weg (herladen), opnieuw openen: bewerkstand → Annuleer → verder ──
  await test('slot', async () => {
    await rva.openRitDag(page, mendix, arg.klein, DAG)
    await rva.startWijzig(page, mendix)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await rva.openRva(page)
    await rva.naarRittenoverzicht(page, mendix)
    const r = (await rva.leesRittenoverzicht(page)).find(x => x.ritnaam === arg.klein && x.dagen.includes(DAG))
    const { opSlot } = await rva.openRitDag(page, mendix, arg.klein, DAG)
    const bewerkstand = await rva.inBewerkstand(page)
    await rva.startWijzig(page, mendix)
    await rva.annuleer(page, mendix)
    const v = verschillen(beginKlein, await rva.leesRegels(page))
    noteer('slot', r?.opSlot.includes(DAG) && opSlot && bewerkstand && v.length === 0, `slotje ${r?.opSlot.includes(DAG) ? 'gezien' : 'NIET gezien'}, bewerkstand ${bewerkstand ? 'ja' : 'nee'}, daarna vrijgegeven${v.length ? `; ${v.join('; ')}` : ''}`)
  })

  // ── Groot: knippen en weer samenvoegen ──
  await test('groot: knip + samenvoegen', async () => {
    const regel = beginGroot.find(r => (r.evenOneven === 'Even' || r.evenOneven === 'Oneven') && r.tm - r.van >= 4)
    if (!regel) throw new Error('Geen regel om te knippen')
    const tm = regel.van + 2 * Math.floor((regel.tm - regel.van) / 4)
    const eerste = { ...regel, tm }
    const opdracht = { rit: arg.groot, dag: DAG, handelingen: [
      { soort: 'knip', regel: regelSleutel(regel), tm },
      { soort: 'samenvoegen', regel: regelSleutel(eerste), naar: 'onder' },
    ] }
    const uit = await rva.voerUit(page, mendix, opdracht, { echt: ECHT, log })
    const v = verschillen(beginGroot, uit.kladversie)
    noteer('groot: knip + samenvoegen', uit.stappen.every(s => s.ok) && v.length === 0, v.length ? `na samenvoegen anders dan begin: ${v.join('; ')}` : 'geknipt en weer één regel')
  })

  // ── Groot: plaatsgebonden onderbreking erbij en weer weg ──
  await test('groot: onderbreking', async () => {
    const regel = regelSleutel(beginGroot[1])
    const erbij = await rva.voerUit(page, mendix, { rit: arg.groot, dag: DAG, handelingen: [{ soort: 'onderbreking', regel, minuten: null }] }, { echt: ECHT, log })
    noteer('groot: onderbreking toevoegen', erbij.stappen.every(s => s.ok), ECHT ? 'opgeslagen' : 'geannuleerd')
    if (ECHT) {
      const weg = await rva.voerUit(page, mendix, { rit: arg.groot, dag: DAG, handelingen: [{ soort: 'onderbreking_weg', regel }] }, { echt: true, log })
      noteer('groot: onderbreking weghalen', weg.stappen.every(s => s.ok), 'opgeslagen')
    }
  })
  if (ECHT && (!arg.alleen || arg.alleen.startsWith('groot'))) await test('groot: terugzetten', () => terugNaarBegin(arg.groot, revGroot, beginGroot))

  // ── Excel export (leest alleen) ──
  await test('excel', async () => {
    await rva.openRitDag(page, mendix, arg.klein, DAG)
    const pad = await rva.excelExport(page, mendix, map)
    const st = await fs.stat(pad)
    noteer('excel', st.size > 0, `${Math.round(st.size / 1024)} kB`)
  })

  // ── Wat direct opslaat: alleen met --echt ──
  await test('verantwoordelijke', async () => {
    const { gekozen } = await rva.leesVerantwoordelijken(page, mendix, arg.klein, DAG)
    if (!ECHT || gekozen.length < 2) return noteer('verantwoordelijke lezen', true, `${gekozen.length} gekozen${ECHT ? ' (minder dan 2: wijzigen overgeslagen)' : ''}`)
    await rva.zetVerantwoordelijken(page, mendix, arg.klein, DAG, gekozen.slice(0, 1))
    const tussen = (await rva.leesVerantwoordelijken(page, mendix, arg.klein, DAG)).gekozen
    await rva.zetVerantwoordelijken(page, mendix, arg.klein, DAG, gekozen)
    const terug = (await rva.leesVerantwoordelijken(page, mendix, arg.klein, DAG)).gekozen
    noteer('verantwoordelijke wijzigen en terug', tussen.length === 1 && terug.length === gekozen.length && gekozen.every(n => terug.includes(n)))
  })

  await test('kopieer', async () => {
    if (!ECHT) return
    // Alleen als Ma en DAG nu al gelijk zijn: dan verandert de kopie per saldo niets.
    await rva.openRitDag(page, mendix, arg.klein, 'Ma')
    const ma = await rva.leesRegels(page)
    const v = verschillen(ma, beginKlein)
    if (v.length) return noteer('kopieer weekdag', true, `overgeslagen: Ma en ${DAG} verschillen (${v.join('; ')})`)
    const { melding } = await rva.kopieerWeekdag(page, mendix, [DAG])
    await rva.openRitDag(page, mendix, arg.klein, DAG)
    const na = verschillen(beginKlein, await rva.leesRegels(page))
    noteer('kopieer weekdag', na.length === 0, `PostNL: ${melding.slice(0, 80)}`)
  })
} catch (err) {
  noteer('proef', false, String(err.message).split('\n')[0])
} finally {
  await context.tracing.stop({ path: path.join(map, 'trace.zip') }).catch(() => {})
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  await fs.writeFile(path.join(map, 'uitslag.json'), JSON.stringify({ echt: ECHT, dag: DAG, uitslag }, null, 2))
  const fout = uitslag.filter(u => !u.ok).length
  console.log(`\n${uitslag.length - fout}/${uitslag.length} geslaagd. Opname: ${map}`)
  process.exitCode = fout ? 1 : 0
}
