// Hoe gaat het met de sessie, en wat doen we eraan? Puur (floatops/matransport#562).
//
// Na elke taak (geslaagd of niet) bekijkt de sessiehouder de pagina en de fout:
//   gezond      niets aan de hand
//   verlopen    PostNL stuurt naar de loginpagina: de sessie is afgelopen
//   gegooid     de pagina herlaadde, of staat na de taak op de startpagina ("OOM PD Proces")
//               in plaats van op het scherm van de taak. Gemeten op 02-11: zodra een andere sessie
//               met dezelfde login in Mendix werkt, zet PostNL deze terug naar de startpagina; hij
//               blijft ingelogd en het Planning-menu blijft zichtbaar.
//   blokkade    het IP is geblokkeerd (Akamai)
//   browser_weg de browser of het tabblad is gesloten of gecrasht
//   database    de taak faalde op de database, niet op PostNL: de sessie is in orde
//   fout        iets anders
// De herkenning van `gegooid` komt uit de meting van stap 0 (POSTNL_SESSIE.md § Meting).

export const isLoginUrl = (url) => /loginpostnl|\/login(?:\.html)?(?:[?#/]|$)|\/authorize/i.test(String(url ?? ''))

const BROWSER_WEG = /has been closed|Target closed|browser has disconnected|Browser closed|crash/i
const HERLADEN = /Execution context was destroyed|frame was detached|Navigation.*interrupted|herlaadde|PageReload/i

export function classificeer({ url = '', depotHost = null, fout = null, planningZichtbaar = null, opStartpagina = false, blokkade = false } = {}) {
  if (blokkade || fout?.name === 'ProxyBlokkadeError') return 'blokkade'
  if (fout?.database) return 'database'
  const tekst = String(fout?.message ?? '')
  if (BROWSER_WEG.test(tekst)) return 'browser_weg'
  if (isLoginUrl(url)) return 'verlopen'
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
