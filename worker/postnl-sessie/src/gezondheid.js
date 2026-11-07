// Hoe gaat het met de sessie, en wat doen we eraan? Puur (floatops/matransport#562).
//
// Na elke taak (geslaagd of niet) bekijkt de sessiehouder de pagina en de fout:
//   gezond      niets aan de hand
//   verlopen    PostNL stuurt naar de loginpagina: de sessie is afgelopen
//   gegooid     de pagina herlaadde, of staat na de taak op de startpagina ("OOM PD Proces")
//               in plaats van op het scherm van de taak. Gemeten op 02-11: zodra een andere sessie
//               met dezelfde login in Mendix werkt, zet PostNL deze terug naar de startpagina; hij
//               blijft ingelogd en het Planning-menu blijft zichtbaar.
//   proxy_geweigerd  de aanbieder van de proxies weigert de login (407, alle IP's; 07-11 een
//               mislukte betaling, matransport#613): niet inloggen, wachten tot de proxy werkt
//   blokkade    het IP is geblokkeerd (Akamai)
//   browser_weg de browser of het tabblad is gesloten of gecrasht
//   database    de taak faalde op de database, niet op PostNL: de sessie is in orde
//   herlogin    PostNL trok tijdens de taak de Mendix-sessie in (fout 460) en de app logde zichzelf
//               stil opnieuw in. De sessie zelf is in orde: de taak opnieuw, geen alarm, geen login.
//               Gemeten op 05-11 (matransport#598): bij Waddinxveen in blokken elke 3–5 min, midden
//               in een taak gaf dat "Execution context was destroyed" en telde het als gegooid.
//   fout        iets anders
// De herkenning van `gegooid` komt uit de meting van stap 0 (POSTNL_SESSIE.md § Meting): dat is
// dezelfde fout 460, alleen dan niet gezien (06-11, matransport#600).

export const isLoginUrl = (url) => /loginpostnl|\/login(?:\.html)?(?:[?#/]|$)|\/authorize/i.test(String(url ?? ''))

const BROWSER_WEG = /has been closed|Target closed|browser has disconnected|Browser closed|crash/i
const HERLADEN = /Execution context was destroyed|frame was detached|Navigation.*interrupted|herlaadde|PageReload/i

// `herlogin`: hoe vaak PostNL tijdens deze taak een 460 gaf (de app logde daarna zelf opnieuw in).
// `proxyGeweigerd`: de depot-lus toetste de proxy na een proxyfout en de aanbieder gaf 407 (toetsProxy).
export function classificeer({ url = '', depotHost = null, fout = null, planningZichtbaar = null, opStartpagina = false, blokkade = false, herlogin = 0, proxyGeweigerd = false } = {}) {
  // Vóór alles: met een geweigerde proxy is elke andere uitkomst (leeg scherm, time-out) daar het gevolg van.
  if (proxyGeweigerd || fout?.name === 'ProxyGeweigerdError') return 'proxy_geweigerd'
  if (blokkade || fout?.name === 'ProxyBlokkadeError') return 'blokkade'
  if (fout?.database) return 'database'
  const tekst = String(fout?.message ?? '')
  if (BROWSER_WEG.test(tekst)) return 'browser_weg'
  if (isLoginUrl(url)) return 'verlopen'
  // Na een 460 is alles wat misging (herladen, startpagina, time-out) daar het gevolg van.
  if (herlogin > 0 && (fout || opStartpagina)) return 'herlogin'
  if (HERLADEN.test(tekst)) return 'gegooid'
  if (opStartpagina) return 'gegooid'
  let host = null
  try { host = new URL(url).hostname } catch {}
  if (depotHost && host === depotHost && planningZichtbaar === false) return 'gegooid'
  if (fout) return 'fout'
  if (depotHost && host && host !== depotHost) return 'fout'   // bv. chrome-error://
  return 'gezond'
}

// recent: eerdere uitkomsten [{ soort, at: Date|ISO }] van deze sessie, nieuwste laatst.
// logins: tijdstippen van nieuwe logins van dit depot (laatste uur telt).
export function herstel(soort, { recent = [], logins = [], nu = new Date(), cfg }) {
  if (soort === 'gezond' || soort === 'database') return 'geen'
  if (soort === 'herlogin') return 'opnieuw_openen'
  // De aanbieder weigert de proxy (alle IP's tegelijk): inloggen heeft geen zin. Wachten en de proxy
  // toetsen tot hij weer werkt (matransport#613; 07-11: 10 uur lang elke 11 min een login).
  if (soort === 'proxy_geweigerd') return 'proxy_wacht'
  const binnen = (min) => (x) => nu - new Date(x.at ?? x) <= min * 60_000
  let actie
  if (soort === 'verlopen' || soort === 'blokkade' || soort === 'browser_weg') actie = 'nieuwe_login'
  else if (soort === 'gegooid') actie = recent.filter(r => r.soort === 'gegooid').some(binnen(cfg.gegooidVensterMin)) ? 'nieuwe_login' : 'opnieuw_openen'
  else {
    // gewone fout: na `maxFoutenAchtereen` achter elkaar een verse sessie
    let achtereen = 1
    for (let i = recent.length - 1; i >= 0 && recent[i].soort === 'fout'; i--) achtereen++
    actie = achtereen >= cfg.maxFoutenAchtereen ? 'nieuwe_login' : 'opnieuw_openen'
  }
  // Niet blijven hameren: te veel logins in een uur = pauze (en een melding via de wachtdog).
  if (actie === 'nieuwe_login' && logins.filter(binnen(60)).length >= cfg.maxLoginsPerUur) return 'pauze'
  return actie
}
