// Eén PostNL-sessie per login tegelijk (floatops/matransport#361).
//
// Loggen de dagplanning en de Ritmonitor tegelijk in met dezelfde login, dan zet
// PostNL een van beide terug naar de startpagina: de Ritmonitor faalt ("Execution
// context was destroyed"), de dagplanning las stil "0 ritten". Daarom pakt elke
// worker vóór het inloggen een slot per klant + depot in de database
// (public.postnl_sessie_pak / _los, matransport-migratie 20261020165256) en geeft
// het vrij na het sluiten van de browser. Het slot is een lease: een gecrasht
// proces houdt het hooguit `seconden` vast.
//
// Bestaat de functie nog niet (omgeving zonder de migratie), dan gaat de worker
// zonder slot door: het oude gedrag, nooit een stilgevallen scrape.

import { randomUUID } from 'node:crypto'

const POLL_MS = 3000

export function slotSleutel(klantId, depotNaam) {
  return `${klantId}:${depotNaam}`
}

export function nieuweHouder(worker) {
  return `${worker}:${process.pid}:${randomUUID().slice(0, 8)}`
}

const geenSlot = { gekregen: false, los: async () => {} }

// Wacht tot het slot vrij is (hooguit maxWachtMs) en geeft { gekregen, los } terug.
// Na maxWachtMs gaat de worker zonder slot door: beter een mogelijk botsende
// sessie dan een overgeslagen run.
export async function pakSessieSlot(supabase, { klantId, depot, worker, seconden, maxWachtMs, label = '' }) {
  const sleutel = slotSleutel(klantId, depot)
  const houder = nieuweHouder(worker)
  const start = Date.now()
  let gemeld = false
  for (;;) {
    const { data, error } = await supabase.rpc('postnl_sessie_pak', { p_sleutel: sleutel, p_houder: houder, p_seconden: seconden })
    if (error) {
      console.warn(`${label}Sessie-slot niet beschikbaar (${error.message}) — door zonder slot`)
      return geenSlot
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
    if (!gemeld) { console.log(`${label}Andere PostNL-sessie met deze login actief — wachten...`); gemeld = true }
    if (Date.now() - start + POLL_MS > maxWachtMs) {
      console.warn(`${label}Sessie-slot na ${Math.round(maxWachtMs / 1000)}s nog bezet — door zonder slot`)
      return geenSlot
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}
