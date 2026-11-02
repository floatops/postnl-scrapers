// Gelezen dagplanning-ritten naar `ritten` (floatops/matransport#562). Eén schrijver voor alle
// PostNL-workers, met deze regels:
// - Een rit is uniek op klant + datum + depot + ritnummer + kanaal (leeg = HD), zoals de unieke
//   index van matransport#560. Rit 307 's ochtends (HD) en 's avonds (AD) zijn twee ritten.
// - Altijd op klant_id gefilterd, ook bij het lezen van wat er al staat.
// - Geen "dubbelen verwijderen" meer: dat haalde de AD-rit weg naast de HD-rit (#560); de
//   unieke index voorkomt echte dubbelen.
// - Alleen gewijzigde velden gaan naar de database.
// - Een databasefout is nooit stil: uitvoeren() gooit, zodat de run als mislukt telt.
import { normaliseerRitnummer } from './tekst.js'
import { NIEUWE_KOLOMMEN } from './velden.js'

export function ritSleutel(ritnummer, kanaal) {
  return `${normaliseerRitnummer(ritnummer)}|${kanaal || 'HD'}`
}

// Tijdstempels komen terug als '…+00:00' en gaan erin als '…Z': zelfde moment, andere tekst.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
export function gelijk(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) return Date.parse(a) === Date.parse(b)
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return false
}

export function verschil(bestaand, velden) {
  const uit = {}
  for (const [k, v] of Object.entries(velden)) if (!(k in bestaand) || !gelijk(bestaand[k], v)) uit[k] = v
  return uit
}

// Welke kolommen de schrijver mag gebruiken. Zonder `kolommen` vallen de kolommen die pas na een
// matransport-migratie bestaan weg, zodat een omgeving zonder die migratie blijft werken.
function filterKolommen(velden, kolommen) {
  const uit = {}
  for (const [k, v] of Object.entries(velden)) {
    if (kolommen ? kolommen.has(k) : !NIEUWE_KOLOMMEN.includes(k)) uit[k] = v
  }
  return uit
}

// Plan zonder database: wat moet er bijgewerkt en aangemaakt worden?
// bestaande: rijen uit `ritten` van deze klant, datum en depot (id, ritnummer, postnl_kanaal + kolommen)
// gelezen:   uitkomst van dagplanningRitten()
export function planRitten({ bestaande, gelezen, klantId, datum, depot, nu, statusNieuw = 'gepland', kolommen = null }) {
  const perSleutel = new Map()
  for (const r of bestaande) {
    const s = ritSleutel(r.ritnummer, r.postnl_kanaal)
    if (!perSleutel.has(s)) perSleutel.set(s, r)
  }
  const updates = []
  const inserts = []
  const kanaalOnbekend = []
  // Twee verschillende versies van dezelfde rit (bv. van twee dagen): niet gokken, niet schrijven.
  const versies = new Map()
  for (const rit of gelezen) {
    if (!rit.kanaal) continue
    const s = ritSleutel(rit.ritnummer, rit.kanaal)
    versies.set(s, [...(versies.get(s) ?? []), JSON.stringify(rit.velden)])
  }
  const tegenstrijdig = [...versies].filter(([, v]) => new Set(v).size > 1).map(([s]) => s.split('|')[0])
  const gezien = new Set()
  for (const rit of gelezen) {
    if (!rit.kanaal) { kanaalOnbekend.push(normaliseerRitnummer(rit.ritnummer)); continue }
    const sleutel = ritSleutel(rit.ritnummer, rit.kanaal)
    if (gezien.has(sleutel) || tegenstrijdig.includes(sleutel.split('|')[0])) continue
    gezien.add(sleutel)
    const velden = {
      ...filterKolommen(rit.velden, kolommen),
      postnl_laatst_opgehaald: nu,
      postnl_sync_status: 'opgehaald',
      postnl_sync_error: null,
    }
    const bestaand = perSleutel.get(sleutel)
    if (bestaand) {
      const v = verschil(bestaand, velden)
      // postnl_laatst_opgehaald schuift altijd op: zo is te zien dat de rit gelezen is.
      if (Object.keys(v).length) updates.push({ id: bestaand.id, velden: v })
    } else {
      inserts.push({
        klant_id: klantId, datum, depot,
        ritnummer: normaliseerRitnummer(rit.ritnummer),
        status: statusNieuw,
        shift: rit.shift,
        ...(rit.kanaal && rit.kanaal !== 'HD' ? { postnl_kanaal: rit.kanaal } : {}),
        ...velden,
      })
    }
  }
  return { updates, inserts, kanaalOnbekend, tegenstrijdig }
}

const LEES_KOLOMMEN = ['id', 'ritnummer', 'postnl_kanaal', 'postnl_stops', 'postnl_stuks', 'postnl_volume', 'postnl_gewicht',
  'postnl_briefbusstops', 'postnl_geplande_duur', 'postnl_ritnaam', 'postnl_chauffeur', 'postnl_shift',
  'postnl_laatst_opgehaald', 'postnl_sync_status', 'postnl_sync_error']

async function vereis(belofte, wat) {
  const { data, error } = await belofte
  if (error) throw new Error(`${wat}: ${error.code ?? ''} ${error.message}`.trim())
  return data
}

// Welke van de nieuwe kolommen bestaan al in deze omgeving? (Stack B kan achterlopen.)
export async function beschikbareKolommen(supabase) {
  const basis = new Set(LEES_KOLOMMEN)
  for (const k of NIEUWE_KOLOMMEN) {
    const { error } = await supabase.from('ritten').select(k).limit(1)
    if (!error) basis.add(k)
  }
  return basis
}

// Leest, plant en schrijft de ritten van één depot en datum. Geeft { bijgewerkt, nieuw } terug.
export async function schrijfDagplanning(supabase, { klantId, datum, depot, gelezen, kolommen = null, nu = new Date().toISOString(), statusNieuw }) {
  const select = [...new Set([...LEES_KOLOMMEN, ...(kolommen ? [...kolommen].filter(k => NIEUWE_KOLOMMEN.includes(k)) : [])])].join(', ')
  const bestaande = await vereis(supabase.from('ritten').select(select)
    .eq('klant_id', klantId).eq('datum', datum).eq('depot', depot), 'ritten lezen')
  const plan = planRitten({ bestaande: bestaande ?? [], gelezen, klantId, datum, depot, nu, statusNieuw, kolommen })
  for (const u of plan.updates) {
    await vereis(supabase.from('ritten').update(u.velden).eq('id', u.id).eq('klant_id', klantId), 'rit bijwerken')
  }
  if (plan.inserts.length) await vereis(supabase.from('ritten').insert(plan.inserts), 'ritten aanmaken')
  return { bijgewerkt: plan.updates.length, nieuw: plan.inserts.length, kanaalOnbekend: plan.kanaalOnbekend, tegenstrijdig: plan.tegenstrijdig }
}

// Ritten van een dag in het verleden op Gereden zetten, alleen van deze klant en dit depot.
export async function markeerGereden(supabase, { klantId, datum, depot }) {
  await vereis(supabase.from('ritten').update({ status: 'gereden' })
    .eq('klant_id', klantId).eq('datum', datum).eq('depot', depot).neq('status', 'gereden'), 'ritten op gereden zetten')
}
