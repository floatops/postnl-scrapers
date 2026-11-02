// Eén PostNL-sessie per login tegelijk (floatops/matransport#361, #562).
//
// PostNL verdraagt geen twee gelijktijdige sessies met dezelfde login: een van beide wordt
// teruggezet naar de startpagina. Daarom pakt elke worker vóór het inloggen een slot per klant +
// depot in de database (public.postnl_sessie_pak / _los) en geeft het vrij na het sluiten van de
// browser. Het slot is een lease: een gecrasht proces houdt het hooguit `seconden` vast.
//
// Sinds #562:
// - Nooit meer "door zonder slot" na de wachttijd: dan slaat de worker over (`bezet`). Alleen als
//   de RPC ontbreekt (omgeving zonder de migratie) gaat hij door zoals vroeger.
// - De sessiehouder (worker postnl-sessie, houder 'postnl-sessie:…') houdt het slot de hele dag.
//   Een worker met `wijkVoorSessiehouder` (ritmonitor en dagplanning, het vangnet) ziet dat en
//   doet niets (`overgenomen`). De planner wacht wel: de sessiehouder geeft het slot voor hem vrij.

import { randomUUID } from 'node:crypto'

const POLL_MS = 3000

export function slotSleutel(klantId, depotNaam) {
  return `${klantId}:${depotNaam}`
}

export function nieuweHouder(worker) {
  return `${worker}:${process.pid}:${randomUUID().slice(0, 8)}`
}

export const isSessiehouder = (houder) => String(houder ?? '').startsWith('postnl-sessie:')

// Wie heeft het slot nu (of null)? null ook als de functie ontbreekt.
export async function slotHouder(supabase, sleutel) {
  const { data, error } = await supabase.rpc('postnl_sessie_info', { p_sleutel: sleutel })
  if (error) return null
  return data?.[0]?.houder ?? null
}

// Heeft de sessiehouder alle depots van deze klant? Dan hoeft een vangnet-script niets te doen.
export async function sessiehouderHeeftAlles(supabase, klantId, depotNamen) {
  if (!depotNamen.length) return false
  for (const d of depotNamen) if (!isSessiehouder(await slotHouder(supabase, slotSleutel(klantId, d)))) return false
  return true
}

const geenSlot = (extra = {}) => ({ gekregen: false, los: async () => {}, ...extra })

// Wacht tot het slot vrij is (hooguit maxWachtMs) en geeft { gekregen, los, overgenomen?, bezet? }.
export async function pakSessieSlot(supabase, { klantId, depot, worker, seconden, maxWachtMs, label = '', wijkVoorSessiehouder = false }) {
  const sleutel = slotSleutel(klantId, depot)
  const houder = nieuweHouder(worker)
  const start = Date.now()
  let gemeld = false
  for (;;) {
    const { data, error } = await supabase.rpc('postnl_sessie_pak', { p_sleutel: sleutel, p_houder: houder, p_seconden: seconden })
    if (error) {
      console.warn(`${label}Sessie-slot niet beschikbaar (${error.message}) — door zonder slot`)
      return geenSlot()
    }
    if (data === true) {
      if (gemeld) console.log(`${label}Sessie-slot gekregen na ${Math.round((Date.now() - start) / 1000)}s wachten`)
      return {
        gekregen: true,
        los: async () => {
          const { error: e } = await supabase.rpc('postnl_sessie_los', { p_sleutel: sleutel, p_houder: houder })
          if (e) console.warn(`${label}Sessie-slot vrijgeven mislukt (verloopt vanzelf): ${e.message}`)
        },
      }
    }
    if (wijkVoorSessiehouder && isSessiehouder(await slotHouder(supabase, sleutel))) {
      console.log(`${label}De sessiehouder heeft deze login — niets te doen`)
      return geenSlot({ overgenomen: true })
    }
    if (!gemeld) { console.log(`${label}Andere PostNL-sessie met deze login actief — wachten...`); gemeld = true }
    if (Date.now() - start + POLL_MS > maxWachtMs) {
      console.warn(`${label}Sessie-slot na ${Math.round(maxWachtMs / 1000)}s nog bezet — overgeslagen (nooit tegelijk inloggen)`)
      return geenSlot({ bezet: true })
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}
