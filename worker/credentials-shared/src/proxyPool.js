// Proxy per browsersessie — gedeeld door postnl-dagplanning en postnl-ritmonitor
// (floatops/matransport#173).
//
// Twee standen:
// - PROXY_POOL=true (de VPS zet dit altijd): elke sessie vraagt de database om het
//   volgende IP uit de eigen proxy-pool (`volgende_proxy()`, rouleert 1..n over alle
//   depots) en sluit af met `proxy_gebruik_afsluiten()` → uitkomst ok / fout /
//   blokkade in `proxy_gebruik_log`. Een blokkade zet het IP in quarantaine en stuurt
//   super_admin een pushmelding; de volgende sessie krijgt vanzelf een ander IP.
//   Geen bruikbaar IP = een harde fout, nooit stil via het (geblokkeerde) VPS-IP.
// - anders (GitHub Actions): het oude gedrag — optioneel één vaste PROXY_SERVER uit
//   de omgeving, niets gelogd. De pool-proxies werken daar ook niet: ze accepteren
//   alleen verkeer vanaf het VPS-IP.
//
// Uitleg van de pool zelf: matransport worker/proxy-pool/PROXY_POOL.md.

import { decrypt } from './index.js'

export function proxyPoolAan() {
  return String(process.env.PROXY_POOL ?? '').toLowerCase() === 'true'
}

// Akamai/WAF gaf deze pagina i.p.v. het portaal. Aparte fout zodat de aanroeper
// het IP meteen als geblokkeerd kan afsluiten en met het volgende verder kan.
export class ProxyBlokkadeError extends Error {
  constructor(melding) {
    super(melding)
    this.name = 'ProxyBlokkadeError'
  }
}

// Herkent een Akamai-/WAF-blokkade aan de paginainhoud — overgenomen uit de
// route-TVI-scraper (matransport, stap1.js). Alleen aanroepen als er al iets misging
// (loginveld komt niet, portaal onbereikbaar): de patronen zijn ruim, en op een
// gewone pagina zou een los woord als "blocked" een goed IP in quarantaine zetten.
export async function detecteerBlok(page) {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const snippet = await page.locator('body').innerText({ timeout: 3000 })
    .catch(() => '').then(t => t.slice(0, 300).replace(/\s+/g, ' ').trim())
  const patronen = [
    /access denied/i, /access blocked/i, /blocked/i, /forbidden/i,
    /reference #\d/i, /ray id/i, /error 403/i, /your request has been blocked/i,
    /akamai/i, /web application firewall/i, /waf/i,
  ]
  return { url, title, snippet, isBlok: patronen.some(r => r.test(title) || r.test(snippet)) }
}

// Een 403 op de eerste paginalading is het duidelijkste blokkadesignaal.
export function isBlokStatus(response) {
  return response?.status?.() === 403
}

/**
 * Kiest de proxy voor één browsersessie.
 * @returns {Promise<null | { proxy: {server, username?, password?}, gebruikId: number|null, label: string }>}
 *   null = geen proxy (direct verbinden, alleen buiten de pool-stand).
 */
export async function kiesProxy(supabase, { worker, depot }) {
  if (!proxyPoolAan()) {
    const server = process.env.PROXY_SERVER
    if (!server) return null
    const proxy = { server }
    if (process.env.PROXY_USERNAME) proxy.username = process.env.PROXY_USERNAME
    if (process.env.PROXY_PASSWORD) proxy.password = process.env.PROXY_PASSWORD
    return { proxy, gebruikId: null, label: server }
  }

  const key = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!key) throw new Error('kiesProxy: CREDENTIALS_ENCRYPTION_KEY ontbreekt in env')
  const { data, error } = await supabase.rpc('volgende_proxy', {
    p_credential_id: depot?.id ?? null,
    p_worker: worker,
    p_depot: depot?.naam ?? null,
  })
  if (error) throw new Error(`Geen proxy uit de pool: ${error.message}`)
  const p = data?.[0]
  if (!p) throw new Error('Geen proxy uit de pool: volgende_proxy gaf niets terug')
  return {
    proxy: {
      server: `http://${p.host}:${p.poort}`,
      username: p.gebruikersnaam,
      password: decrypt(p.wachtwoord_encrypted, key),
    },
    gebruikId: p.gebruik_id,
    label: `poort ${p.poort} (${p.extern_ip ?? '?'})`,
  }
}

/**
 * Sluit het gebruik van een proxy af in proxy_gebruik_log. Idempotent: de database
 * negeert een tweede afsluiting, dus een blokkade wordt nooit door een latere 'fout'
 * overschreven. Best-effort: een logfout mag de scrape niet laten falen.
 * @param {'ok'|'fout'|'blokkade'} uitkomst
 */
export async function sluitProxyAf(supabase, sessie, uitkomst, detail = null) {
  if (!sessie?.gebruikId) return
  try {
    const { error } = await supabase.rpc('proxy_gebruik_afsluiten', {
      p_gebruik_id: sessie.gebruikId,
      p_uitkomst: uitkomst,
      p_detail: detail ? String(detail).split('\n')[0].slice(0, 500) : null,
    })
    if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
  } catch (err) {
    console.error(`proxy_gebruik_afsluiten mislukt (${uitkomst}):`, err.message)
  }
}

// Uitkomst bij een fout: blokkade als de fout dat al zegt of de pagina er een toont.
export async function uitkomstBijFout(err, page) {
  if (err instanceof ProxyBlokkadeError) return 'blokkade'
  if (!page || !proxyPoolAan()) return 'fout'
  const blok = await detecteerBlok(page).catch(() => ({ isBlok: false }))
  return blok.isBlok ? 'blokkade' : 'fout'
}
