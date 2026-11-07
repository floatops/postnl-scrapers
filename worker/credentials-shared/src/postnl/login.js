// Inloggen bij PostNL en naar het depot-portaal gaan. Eén versie voor alle PostNL-workers
// (floatops/matransport#562); stond eerder in ritmonitor, dagplanning en planner apart.
// Geen eigen packages: de aanroeper geeft de Playwright-page mee.
import { detecteerBlok, isBlokStatus, proxyPoolAan, ProxyBlokkadeError, PROXY_NETWERKFOUT, gooiBijProxyWeigering, gaNaarMetProxyControle } from '../proxyPool.js'

export const SEL_LOGIN_VELD = 'input[type="text"], input[type="email"]'
export const SEL_PLANNING = 'a.mx-name-menuBar1-2, a[title="Planning"]'
export const SEL_DAGPLANNING = 'a.mx-name-menuBar1-2-0, a[title="Dagplanning"]'
export const SEL_DAG = 'select.form-control'
// De startpagina van het portaal ("Homepage", tekst "OOM PD Proces"). Hier zet PostNL een sessie
// naartoe terug als een andere sessie met dezelfde login in Mendix werkt (meting 02-11, #562):
// nog ingelogd, Planning-menu zichtbaar, maar het scherm van de taak is weg.
export const TEKST_STARTPAGINA = 'OOM PD Proces'
// Hoe lang één login in het slechtste geval duurt (s): de stappen in login() tellen op tot ±270 s,
// en naarDepot kan daar ±150 s aan vooraf laten gaan (#599). Voor de hartslag van het slot en de waakhond.
export const LOGIN_MAX_SEC = 450
export async function opStartpagina(page) {
  return page.getByText(TEKST_STARTPAGINA, { exact: true }).first().isVisible().catch(() => false)
}

export const isLoginPagina = (url) => /loginpostnl|\/login|\/authorize/.test(String(url ?? ''))

// Wie wil weten dat er op deze pagina ingelogd wordt (de sessiehouder meet zo hoe lang een sessie
// geldig blijft, matransport#562). Eén luisteraar per pagina; vervalt met de pagina.
const bijLogin = new WeakMap()
export function volgLogins(page, fn) { bijLogin.set(page, fn) }

// Wie een trace heeft lopen (de sessiehouder), zet die stil rond het wachtwoord: Playwright schrijft
// de waarde van elke fill() en het POST-verkeer leesbaar in de trace (matransport#600). Per context.
const rondWachtwoord = new WeakMap()
export function volgWachtwoord(context, haak) { rondWachtwoord.set(context, haak) }

// Wachten op het loginveld, maar stoppen als de pagina intussen van de loginpagina af is: PostNL
// hoeft geen wachtwoord, de SSO logde stil opnieuw in. 'veld', 'weg' of 'niets' (tijd om).
export async function wachtOpLoginVeld(page, ms = 45_000) {
  const veld = page.locator(SEL_LOGIN_VELD).first()
  const eind = Date.now() + ms
  while (Date.now() < eind) {
    if (await veld.isVisible().catch(() => false)) return 'veld'
    if (!isLoginPagina(page.url())) return 'weg'
    await page.waitForTimeout(500)
  }
  return 'niets'
}

// Geeft true als er echt met het wachtwoord is ingelogd, false als PostNL er niet om vroeg.
export async function login(page, depot, { log = console } = {}) {
  // Het invoerveld staat soms al in de DOM terwijl het nog verborgen is (de PCI-loginpagina
  // hydrateert traag). Langer wachten en anders één keer herladen.
  const stand = await wachtOpLoginVeld(page)
  if (stand === 'weg') {
    // Stille SSO. Komt die uit op een fout van PostNL (06-11 15:43: 500 op /oauth/v2/callback), dan
    // zou hier niets meer gebeuren: één keer opnieuw naar het depot. Tot #600 telde dit als een
    // verlopen login, wachtte het 90 s op een loginveld dat nooit kwam en werd het 'gegooid'.
    if (/\/oauth\/|error-page/.test(page.url())) await gaNaarMetProxyControle(page, depot.url, { waitUntil: 'domcontentloaded', timeout: 60_000, stil: true })
    return false
  }
  if (stand === 'niets') {
    const blok = await detecteerBlok(page)
    log.warn(`[${depot.naam}] Loginveld niet zichtbaar na 45 s${blok.isBlok ? ' — mogelijke IP-blokkering' : ''} (titel: "${blok.title}")`)
    // Met de pool helpt herladen niet: dit IP is geblokkeerd.
    if (blok.isBlok && proxyPoolAan()) throw new ProxyBlokkadeError(`Loginpagina geblokkeerd: ${blok.title || blok.snippet.slice(0, 80)}`)
    gooiBijProxyWeigering(await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null))
    await page.locator(SEL_LOGIN_VELD).first().waitFor({ state: 'visible', timeout: 45000 })
  }
  // Pas hier is het zeker een echte login, en pas dit telt als een verlopen sessie.
  try { bijLogin.get(page)?.() } catch { /* meten mag inloggen nooit tegenhouden */ }
  const haak = rondWachtwoord.get(page.context?.())
  await haak?.voor()
  try {
    await page.locator(SEL_LOGIN_VELD).first().fill(depot.username)
    await page.locator('input[type="password"]').first().fill(depot.password)
    await page.locator('button[data-trn-key="login.butlogin"]').click()
    // Wachten tot we van de loginpagina af zijn. NIET op de depot-URL wachten: de login-URL bevat
    // die zelf in de redirect-parameter.
    await page.waitForFunction(() => !window.location.hostname.includes('loginpostnl'), { timeout: 90000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  } finally {
    await haak?.na()
  }
  if (page.url().includes('loginpostnl')) {
    // "Er klopt iets niet. Controleer je e-mailadres en wachtwoord." staat dan op de pagina.
    const melding = await page.locator('[role="alert"], .alert, .error').first().innerText({ timeout: 2000 }).catch(() => '')
    throw Object.assign(new Error(`Login mislukt${melding ? `: ${melding.trim().slice(0, 120)}` : ''}`), { loginGeweigerd: true })
  }
  return true
}

// Naar het depot-portaal tot het Planning-menu zichtbaar is; logt in als PostNL daarom vraagt.
// Mendix start de OAuth-redirect soms pas ná de goto, daarom pollen in plaats van één check.
export async function naarDepot(page, depot, { log = console, maxMs = 90000 } = {}) {
  let gotoFout = null
  const response = await page.goto(depot.url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => { gotoFout = e; return null })
  if (isBlokStatus(response) && proxyPoolAan()) throw new ProxyBlokkadeError('HTTP 403 op het portaal')
  // De proxy liet de verbinding niet door: dan komt het portaal nooit, en 90 s wachten op een lege
  // pagina verstopt de oorzaak (07-11: 119x "Planning-menu niet zichtbaar", matransport#613). Een 407
  // is de aanbieder zelf; bij een andere proxyfout toetst de aanroeper dat nog (toetsProxy).
  gooiBijProxyWeigering(response)
  if (gotoFout && PROXY_NETWERKFOUT.test(String(gotoFout.message))) {
    throw Object.assign(new Error(`Proxy liet de verbinding niet door: ${String(gotoFout.message).split('\n')[0]}`), { proxyFout: true })
  }
  const deadline = Date.now() + maxMs
  let logins = 0
  let stil = 0
  while (Date.now() < deadline) {
    if (isLoginPagina(page.url())) {
      if (logins >= 2) throw new Error(`Planning-menu niet bereikbaar na ${logins} keer inloggen`)
      if (await login(page, depot, { log })) logins++
      else if (++stil > 3) throw new Error(`Planning-menu niet bereikbaar: ${stil} keer stille SSO`)
      continue
    }
    if (await page.locator(SEL_PLANNING).first().isVisible().catch(() => false)) {
      // De startpagina laadt pas daarna echt ("Overzicht shift"). Wie meteen doorklikt, ziet zijn
      // scherm later vervangen door die startpagina (03-11: Dagplanning open, daarna toch de
      // startpagina, en dat leek op eruit gegooid). Dus eerst die laten verschijnen.
      await page.getByText(TEKST_STARTPAGINA, { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      return { ingelogd: logins > 0 }
    }
    await page.waitForTimeout(1000)
  }
  throw new Error(`Planning-menu niet zichtbaar na ${maxMs / 1000}s (url: ${page.url()})`)
}

// Planning → Dagplanning, met herkansing: vlak na het inloggen komt een klik op het menu soms
// niet aan (planner, 02-11 06:26, op de video).
// Geeft { ingelogd }: true als de sessie verlopen bleek en er opnieuw is ingelogd (zie naarDepot).
export async function openDagplanning(page, depot, opties = {}) {
  const uit = await naarDepot(page, depot, opties)
  const planning = page.locator(SEL_PLANNING).first()
  for (let poging = 1; ; poging++) {
    await planning.click()
    await page.locator(SEL_DAGPLANNING).first().click({ timeout: 10_000 }).catch(() => {})
    const open = await page.locator(SEL_DAG).first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
    // Blijft hij open staan als PostNL klaar is? Anders laadde de startpagina er alsnog overheen.
    const blijft = open && await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      .then(() => page.locator(SEL_DAG).first().isVisible().catch(() => false))
    if (blijft) break
    if (poging >= 3) throw new Error(open ? 'Dagplanning werd steeds vervangen door de startpagina van PostNL' : 'Dagplanning ging niet open in PostNL')
    await page.waitForTimeout(2_000)
  }
  return uit
}
