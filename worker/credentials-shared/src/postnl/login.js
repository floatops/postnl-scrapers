// Inloggen bij PostNL en naar het depot-portaal gaan. Eén versie voor alle PostNL-workers
// (floatops/matransport#562); stond eerder in ritmonitor, dagplanning en planner apart.
// Geen eigen packages: de aanroeper geeft de Playwright-page mee.
import { detecteerBlok, isBlokStatus, proxyPoolAan, ProxyBlokkadeError } from '../proxyPool.js'

export const SEL_LOGIN_VELD = 'input[type="text"], input[type="email"]'
export const SEL_PLANNING = 'a.mx-name-menuBar1-2, a[title="Planning"]'
export const SEL_DAGPLANNING = 'a.mx-name-menuBar1-2-0, a[title="Dagplanning"]'
export const SEL_DAG = 'select.form-control'

export const isLoginPagina = (url) => /loginpostnl|\/login|\/authorize/.test(String(url ?? ''))

export async function login(page, depot, { log = console } = {}) {
  // Het invoerveld staat soms al in de DOM terwijl het nog verborgen is (de PCI-loginpagina
  // hydrateert traag). Langer wachten en anders één keer herladen.
  try {
    await page.locator(SEL_LOGIN_VELD).first().waitFor({ state: 'visible', timeout: 45000 })
  } catch {
    const blok = await detecteerBlok(page)
    log.warn(`[${depot.naam}] Loginveld niet zichtbaar na 45 s${blok.isBlok ? ' — mogelijke IP-blokkering' : ''} (titel: "${blok.title}")`)
    // Met de pool helpt herladen niet: dit IP is geblokkeerd.
    if (blok.isBlok && proxyPoolAan()) throw new ProxyBlokkadeError(`Loginpagina geblokkeerd: ${blok.title || blok.snippet.slice(0, 80)}`)
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
    await page.locator(SEL_LOGIN_VELD).first().waitFor({ state: 'visible', timeout: 45000 })
  }
  await page.locator(SEL_LOGIN_VELD).first().fill(depot.username)
  await page.locator('input[type="password"]').first().fill(depot.password)
  await page.locator('button[data-trn-key="login.butlogin"]').click()
  // Wachten tot we van de loginpagina af zijn. NIET op de depot-URL wachten: de login-URL bevat
  // die zelf in de redirect-parameter.
  await page.waitForFunction(() => !window.location.hostname.includes('loginpostnl'), { timeout: 90000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  if (page.url().includes('loginpostnl')) {
    // "Er klopt iets niet. Controleer je e-mailadres en wachtwoord." staat dan op de pagina.
    const melding = await page.locator('[role="alert"], .alert, .error').first().innerText({ timeout: 2000 }).catch(() => '')
    throw Object.assign(new Error(`Login mislukt${melding ? `: ${melding.trim().slice(0, 120)}` : ''}`), { loginGeweigerd: true })
  }
}

// Naar het depot-portaal tot het Planning-menu zichtbaar is; logt in als PostNL daarom vraagt.
// Mendix start de OAuth-redirect soms pas ná de goto, daarom pollen in plaats van één check.
export async function naarDepot(page, depot, { log = console, maxMs = 90000 } = {}) {
  const response = await page.goto(depot.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => null)
  if (isBlokStatus(response) && proxyPoolAan()) throw new ProxyBlokkadeError('HTTP 403 op het portaal')
  const deadline = Date.now() + maxMs
  let logins = 0
  while (Date.now() < deadline) {
    if (isLoginPagina(page.url())) {
      if (logins >= 2) throw new Error(`Planning-menu niet bereikbaar na ${logins} keer inloggen`)
      logins++
      await login(page, depot, { log })
      continue
    }
    if (await page.locator(SEL_PLANNING).first().isVisible().catch(() => false)) return { ingelogd: logins > 0 }
    await page.waitForTimeout(1000)
  }
  throw new Error(`Planning-menu niet zichtbaar na ${maxMs / 1000}s (url: ${page.url()})`)
}

// Planning → Dagplanning, met herkansing: vlak na het inloggen komt een klik op het menu soms
// niet aan (planner, 02-11 06:26, op de video).
export async function openDagplanning(page, depot, opties = {}) {
  await naarDepot(page, depot, opties)
  const planning = page.locator(SEL_PLANNING).first()
  for (let poging = 1; ; poging++) {
    await planning.click()
    await page.locator(SEL_DAGPLANNING).first().click({ timeout: 10_000 }).catch(() => {})
    const open = await page.locator(SEL_DAG).first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
    if (open) break
    if (poging >= 3) throw new Error('Dagplanning ging niet open in PostNL')
    await page.waitForTimeout(2_000)
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
}
