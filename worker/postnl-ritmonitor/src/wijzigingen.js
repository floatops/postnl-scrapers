// Welke velden van een bestaande rit moeten echt naar de database? Bewust los van
// Playwright/Supabase, zodat het testbaar is (test/wijzigingen.test.js).
//
// Waarom (floatops/matransport#462): de worker leest de Ritmonitor ~6× per run
// (CONFIG.vensterSec) en schreef bij elke lezing élke rit opnieuw weg, ook als er
// niets veranderd was — alleen postnl_monitor_opgehaald schoof op. Dat waren
// ~1,2 mln updates, en elke update ging als realtime-bericht naar alle open apps.
//
// postnl_monitor_opgehaald is een hartslag ("deze rit staat nog in de grid"), geen
// gegeven: de afwezig-regel hieronder (20 min), sluit_stille_ritten() (20 min) en
// useLiveVoertuig (30 min) kijken alleen of hij recent is. Hij gaat daarom mee als
// er toch al iets verandert, of als de vorige waarde HARTSLAG_MS oud is.

export const HARTSLAG_MS = 5 * 60000

const HARTSLAG_VELD = 'postnl_monitor_opgehaald'

// Tijdstempels komen uit de database terug als '…+00:00' en gaan erin als '…Z':
// zelfde moment, andere tekst. Alleen strings die op een ISO-tijdstempel lijken als
// moment vergelijken; 'HH:MM' (postnl_laatste_actie) blijft een gewone tekst.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
function gelijk(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) {
    return Date.parse(a) === Date.parse(b)
  }
  return false
}

// existing: de rij zoals gelezen (moet elk veld uit `velden` bevatten, anders telt
// het als gewijzigd). velden: wat de worker zou schrijven. Retourneert de velden die
// geschreven moeten worden, of null als er niets te doen is.
export function teSchrijven(existing, velden, nuMs = Date.now()) {
  const uit = {}
  for (const [veld, waarde] of Object.entries(velden)) {
    if (veld === HARTSLAG_VELD) continue
    if (!(veld in existing) || !gelijk(existing[veld], waarde)) uit[veld] = waarde
  }
  const vorige = existing[HARTSLAG_VELD] ? Date.parse(existing[HARTSLAG_VELD]) : NaN
  const hartslagNodig = !(vorige > nuMs - HARTSLAG_MS)
  if (HARTSLAG_VELD in velden && (Object.keys(uit).length || hartslagNodig)) {
    uit[HARTSLAG_VELD] = velden[HARTSLAG_VELD]
  }
  return Object.keys(uit).length ? uit : null
}
