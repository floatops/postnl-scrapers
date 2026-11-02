// Stap 0 van floatops/matransport#562: meten hoe een PostNL-sessie zich gedraagt, vóór de
// sessiehouder erop vertrouwt. Draait 's avonds na 23:00 (geen andere workers), houdt het
// sessie-slot vast, en legt alles vast met video, trace en schermafdrukken op de schijf van de
// VPS (niet in de database): $OPNAME_ROOT/meting/{datum}/{depot}/ plus meting.json.
//
//   KLANT_ID=… DEPOT="…" PROXY_POOL=true node scripts/meet.mjs [--tot 06:45] [--zonder-levensduur]
//
// Metingen:
//  1. contextwissel: blijft de sessie ingelogd in een nieuwe context met dezelfde cookies en IP?
//  2. myapps:        opent loginpostnl.net/myapps in hetzelfde tabblad zonder nieuwe login, en
//                    is het depot daarna nog ingelogd?
//  3. tweede login:  wat ziet sessie A als sessie B (ander IP) met dezelfde login inlogt?
//  4. levensduur:    elke minuut verversen tot PostNL de sessie beëindigt (of tot --tot).
import 'dotenv/config'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { getDepots } from '../../credentials-shared/src/index.js'
import { kiesProxy, sluitProxyAf } from '../../credentials-shared/src/proxyPool.js'
import { naarDepot, isLoginPagina, SEL_PLANNING } from '../../credentials-shared/src/postnl/login.js'
import { depotSlug } from '../../credentials-shared/src/sessieVideo.js'
import { vandaagNl, minutenNl } from '../../credentials-shared/src/postnl/tekst.js'

const KLANT_ID = process.env.KLANT_ID
const DEPOT_NAAM = process.env.DEPOT
const totArg = process.argv.indexOf('--tot')
const TOT = totArg > 0 ? process.argv[totArg + 1] : '06:45'
const [totU, totM] = TOT.split(':').map(Number)
const ZONDER_LEVENSDUUR = process.argv.includes('--zonder-levensduur')
const OPNAME_ROOT = process.env.OPNAME_ROOT || '/var/log/workers/postnl/opnames'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const houder = `postnl-sessie-meting:${process.pid}:${randomUUID().slice(0, 8)}`
const werkmap = await fs.mkdtemp(path.join(os.tmpdir(), 'postnl-meting-'))
const uitkomst = { gestart: new Date().toISOString(), depot: DEPOT_NAAM, stappen: [] }
const stap = (naam, data) => { const r = { naam, at: new Date().toISOString(), ...data }; uitkomst.stappen.push(r); console.log(JSON.stringify(r)) }

const depot = (await getDepots(supabase, KLANT_ID, 'postnl')).find(d => d.naam === DEPOT_NAAM)
if (!depot) throw new Error(`Depot ${DEPOT_NAAM} niet gevonden`)
const map = path.join(OPNAME_ROOT, 'meting', vandaagNl(), depotSlug(depot.naam))
await fs.mkdir(map, { recursive: true })
const sleutel = `${KLANT_ID}:${depot.naam}`

// Bewaren op de schijf van de VPS (genoeg ruimte; de database-opslag is duur).
async function upload(lokaal, naam) {
  await fs.copyFile(lokaal, path.join(map, naam)).catch(e => console.error(`bewaren ${naam}: ${e.message}`))
}
async function schermafdruk(page, naam) {
  const p = path.join(werkmap, `${naam}.png`)
  await page.screenshot({ path: p, fullPage: false }).catch(() => {})
  await upload(p, `${naam}.png`, 'image/png').catch(() => {})
}
const staat = async (page) => ({ url: page.url().replace(/\?.*/, '?…'), login: isLoginPagina(page.url()), planning: await page.locator(SEL_PLANNING).first().isVisible().catch(() => false) })

// Een browser met een eigen IP, een context met video en trace.
async function nieuweBrowser(label, { video = true } = {}) {
  const proxy = await kiesProxy(supabase, { worker: 'postnl-sessie-meting', depot })
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'], ...(proxy ? { proxy: proxy.proxy } : {}) })
  const dir = path.join(werkmap, label)
  const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'Europe/Amsterdam', viewport: { width: 1440, height: 900 }, ...(video ? { recordVideo: { dir, size: { width: 1280, height: 720 } } } : {}) })
  const page = await context.newPage()
  return { label, proxy, browser, context, page, dir }
}
async function sluit(b, reden) {
  const video = b.page.video()
  await b.context.tracing.stop({ path: path.join(werkmap, `${b.label}-trace.zip`) }).catch(() => {})
  await b.context.close().catch(() => {})
  await b.browser.close().catch(() => {})
  await sluitProxyAf(supabase, b.proxy, 'ok', `meting ${b.label}: ${reden}`)
  if (video) await upload(await video.path(), `${b.label}.webm`, 'video/webm').catch(e => console.error(e.message))
  await upload(path.join(werkmap, `${b.label}-trace.zip`), `${b.label}-trace.zip`, 'application/zip').catch(() => {})
}
const slotPak = async () => (await supabase.rpc('postnl_sessie_pak', { p_sleutel: sleutel, p_houder: houder, p_seconden: 600 })).data === true

if (!(await slotPak())) throw new Error('Sessie-slot bezet: meting niet gestart')
const slotTimer = setInterval(() => slotPak().catch(() => {}), 120_000)

try {
  // A inloggen
  const a = await nieuweBrowser('a')
  await naarDepot(a.page, depot)
  await a.context.tracing.start({ screenshots: true, snapshots: true })
  stap('a_ingelogd', { ip: a.proxy?.label, ...(await staat(a.page)) })
  await schermafdruk(a.page, '01-a-ingelogd')

  // 1. contextwissel
  const cookies = await a.context.storageState()
  const ctx2 = await a.browser.newContext({ storageState: cookies, serviceWorkers: 'block', timezoneId: 'Europe/Amsterdam', recordVideo: { dir: path.join(werkmap, 'a2'), size: { width: 1280, height: 720 } } })
  const p2 = await ctx2.newPage()
  await p2.goto(depot.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await p2.waitForTimeout(5000)
  stap('1_contextwissel', { ...(await staat(p2)) })
  await schermafdruk(p2, '02-contextwissel')
  const v2 = p2.video()
  await ctx2.close()
  if (v2) await upload(await v2.path(), 'a-contextwissel.webm', 'video/webm')
  await a.page.reload({ waitUntil: 'networkidle' }).catch(() => {})
  stap('1_a_na_contextwissel', { ...(await staat(a.page)) })

  // 2. myapps in hetzelfde tabblad
  await a.page.goto('https://www.loginpostnl.net/myapps/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await a.page.waitForTimeout(3000)
  stap('2_myapps', { url: a.page.url().replace(/\?.*/, '?…'), loginGevraagd: await a.page.locator('input[type="password"]').first().isVisible().catch(() => false) })
  await schermafdruk(a.page, '03-myapps')
  await a.page.goto(depot.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await a.page.waitForTimeout(5000)
  stap('2_a_terug_naar_depot', { ...(await staat(a.page)) })

  // 3. tweede login met een ander IP
  const b = await nieuweBrowser('b')
  await naarDepot(b.page, depot)
  stap('3_b_ingelogd', { ip: b.proxy?.label, ...(await staat(b.page)) })
  await schermafdruk(b.page, '04-b-ingelogd')
  for (const wacht of [0, 30, 90]) {
    await a.page.waitForTimeout(wacht * 1000)
    await a.page.reload({ waitUntil: 'networkidle' }).catch(() => {})
    await a.page.waitForTimeout(3000)
    stap(`3_a_na_${wacht}s`, { ...(await staat(a.page)) })
    await schermafdruk(a.page, `05-a-na-tweede-login-${wacht}s`)
    await b.page.reload({ waitUntil: 'networkidle' }).catch(() => {})
    await b.page.waitForTimeout(3000)
    stap(`3_b_na_${wacht}s`, { ...(await staat(b.page)) })
  }
  await sluit(b, 'tweede login klaar')
  await sluit(a, 'na tweede-login-test')

  // 4. levensduur: verse sessie, elke minuut verversen tot PostNL hem beëindigt. Overdag overslaan
  // (--zonder-levensduur): dat houdt het slot uren vast. De sessiehouder meet het zelf.
  if (ZONDER_LEVENSDUUR) throw Object.assign(new Error('levensduur overgeslagen'), { klaar: true })
  // Zonder video: een hele nacht is te groot. Elke 15 min een schermafdruk, plus het einde.
  const c = await nieuweBrowser('c-levensduur', { video: false })
  await naarDepot(c.page, depot)
  const begin = Date.now()
  stap('4_c_ingelogd', { ip: c.proxy?.label })
  let i = 0
  for (;;) {
    await c.page.waitForTimeout(60_000)
    await c.page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
    await c.page.waitForTimeout(2000)
    const s = await staat(c.page)
    i++
    if (i % 15 === 0) await schermafdruk(c.page, `06-levensduur-${String(i).padStart(4, '0')}min`)
    if (s.login || !s.planning) {
      stap('4_einde', { minuten: Math.round((Date.now() - begin) / 60000), ...s })
      await schermafdruk(c.page, '07-levensduur-einde')
      break
    }
    const nu = minutenNl()
    if (nu >= totU * 60 + totM && nu < 12 * 60) { stap('4_nog_geldig_bij_stoppen', { minuten: Math.round((Date.now() - begin) / 60000) }); break }
  }
  await sluit(c, 'levensduur klaar')
} catch (err) {
  stap('fout', { fout: String(err.message).split('\n')[0] })
  process.exitCode = 1
} finally {
  clearInterval(slotTimer)
  await supabase.rpc('postnl_sessie_los', { p_sleutel: sleutel, p_houder: houder })
  uitkomst.klaar = new Date().toISOString()
  const p = path.join(werkmap, 'meting.json')
  await fs.writeFile(p, JSON.stringify(uitkomst, null, 2))
  await upload(p, 'meting.json', 'application/json')
  console.log(`Meting opgeslagen in ${map}`)
}
