// Alles wat de sessiehouder in de database leest en schrijft (floatops/matransport#562). Een
// databasefout gooit (nooit stil), behalve bij het loggen van gebeurtenissen: dat mag de sessie
// niet stilleggen, maar komt wel in de console en in de volgende run-log.
import { mergeInstellingen } from './instellingen.js'
import { startRunLog, eindeRunLog } from '../../credentials-shared/src/runLog.js'

async function vereis(belofte, wat) {
  const { data, error } = await belofte
  if (error) throw Object.assign(new Error(`${wat}: ${error.code ?? ''} ${error.message}`.trim()), { database: true })
  return data
}

// Volgorde van de RVA-wachtrij (matransport#573): eerst wat iemand opslaat (wijzigen e.d.), dan een
// lezing die iemand in de app open heeft (parameters.voorrang), dan de rest; binnen elke groep de
// oudste eerst. Zo wacht een chauffeur nooit achter een bulk-lezing van alle ritten.
export function rvaVolgorde(opdrachten) {
  const groep = (o) => ((o.soort ?? 'wijzigen') !== 'ophalen' ? 0 : o.parameters?.voorrang ? 1 : 2)
  return opdrachten.map((o, i) => ({ o, i })).sort((a, b) => groep(a.o) - groep(b.o) || a.i - b.i).map(x => x.o)
}

export function maakOpslag({ supabase, klantId, log = console }) {
  return {
    async instellingen(boven = null) {
      const { data, error } = await supabase.from('postnl_instellingen').select('instellingen').eq('klant_id', klantId).maybeSingle()
      if (error) log.warn(`Instellingen niet gelezen (${error.message}): standaardwaarden`)
      if (boven) log.warn(`Instellingen overschreven voor een proef: ${Object.keys(boven).join(', ')}`)
      return mergeInstellingen({ ...(data?.instellingen ?? {}), ...(boven ?? {}) })
    },

    async dagstatus(depot) {
      const { data, error } = await supabase.from('postnl_dagstatus').select('status')
        .eq('klant_id', klantId).eq('depot', depot).order('datum', { ascending: false }).limit(1).maybeSingle()
      if (error) log.warn(`[${depot}] Dagstatus niet gelezen (${error.message}): begint opnieuw`)
      return data?.status ?? null
    },

    async bewaarDagstatus(depot, status) {
      await vereis(supabase.from('postnl_dagstatus').upsert(
        { klant_id: klantId, depot, datum: status.datum, status, bijgewerkt_at: new Date().toISOString() },
        { onConflict: 'klant_id,depot,datum' }), 'dagstatus bewaren')
    },

    // Gemeten levensduren (minuten) van sessies die door PostNL beëindigd werden.
    // Gemeten levensduren (min) van de laatste `dagen`: sessies die eindigden omdat ze verliepen, plus
    // elk verloop binnen een sessie (gebeurtenis sessie_verlopen, OOM PD-tabblad; levensmeter.js).
    async levensduren(depot, dagen = 30) {
      const { data, error } = await supabase.from('postnl_sessies').select('ingelogd_at, einde_at, einde_reden, gebeurtenissen')
        .eq('klant_id', klantId).eq('depot', depot)
        .gte('ingelogd_at', new Date(Date.now() - dagen * 86400_000).toISOString())
      if (error) { log.warn(`[${depot}] Levensduren niet gelezen: ${error.message}`); return [] }
      return levensdurenUit(data ?? [])
    },

    async sessieStart({ depot, proxyGebruikId, externIp }) {
      const rij = await vereis(supabase.from('postnl_sessies').insert({
        klant_id: klantId, depot, proxy_gebruik_id: proxyGebruikId ?? null, extern_ip: externIp ?? null,
        ingelogd_at: new Date().toISOString(),
      }).select('id').single(), 'sessie registreren')
      return rij.id
    },

    async sessieBij(id, velden) {
      if (!id) return
      const { error } = await supabase.from('postnl_sessies').update(velden).eq('id', id).eq('klant_id', klantId)
      if (error) log.error(`Sessie ${id} bijwerken mislukt: ${error.message}`)
    },

    // Een gebeurtenis (taak mislukt, eruit gegooid, herstel, …) bij de sessie, max 50 per sessie.
    async gebeurtenis(id, g) {
      if (!id) return
      const { error } = await supabase.rpc('postnl_sessie_gebeurtenis', { p_id: id, p_gebeurtenis: { at: new Date().toISOString(), ...g } })
      if (error) log.error(`Gebeurtenis loggen mislukt (${g.soort}): ${error.message}`)
    },

    // Shifts die iemand nu in Plannen open heeft (hartslag van de app, laatste 2 min). Mag nooit gooien.
    async plannenKijkers(depot, datum) {
      const { data, error } = await supabase.from('planning_kijkers').select('shift')
        .eq('klant_id', klantId).eq('depot', depot).eq('datum', datum).gt('gezien_at', new Date(Date.now() - 2 * 60_000).toISOString())
      if (error) return []
      return [...new Set((data ?? []).map(k => k.shift))]
    },

    // Planner-opdrachten van dit depot die nog wachten (Plannen, #557). Niet 'bezig': die heeft
    // al iemand (of hing na een crash) en mag nooit een tweede keer worden uitgevoerd.
    async plannerOpdrachten(depot) {
      const { data, error } = await supabase.from('planning_taken').select('id, depot, status, soort')
        .eq('klant_id', klantId).eq('depot', depot).eq('status', 'wacht').order('aangemaakt_at')
      if (error) { log.warn(`[${depot}] Planner-opdrachten niet gelezen: ${error.message}`); return null }
      return data ?? []
    },

    // Sessie-slot (#361): pakken of verlengen. true = van ons.
    async slotPak(sleutel, houder, seconden) {
      const { data, error } = await supabase.rpc('postnl_sessie_pak', { p_sleutel: sleutel, p_houder: houder, p_seconden: seconden })
      if (error) throw Object.assign(new Error(`sessie-slot: ${error.message}`), { database: true })
      return data === true
    },
    async slotLos(sleutel, houder) {
      const { error } = await supabase.rpc('postnl_sessie_los', { p_sleutel: sleutel, p_houder: houder })
      if (error) log.warn(`Sessie-slot vrijgeven mislukt (verloopt vanzelf): ${error.message}`)
    },

    // RVA-opdrachten van dit depot die nog wachten (matransport#569), oudste eerst. Niet 'bezig':
    // die is al begonnen (of hing na een crash) en mag nooit een tweede keer worden uitgevoerd.
    async rvaOpdrachten(depot) {
      const { data, error } = await supabase.from('rva_opdrachten').select('id, depot, status, soort, parameters')
        .eq('klant_id', klantId).eq('depot', depot).eq('status', 'wacht').order('aangemaakt_at')
      if (error) { log.warn(`[${depot}] RVA-opdrachten niet gelezen: ${error.message}`); return null }
      return rvaVolgorde(data ?? [])
    },

    runStart: (worker) => startRunLog(supabase, { worker, klantId }),
    runEinde: (id, velden) => eindeRunLog(supabase, id, velden),
    // Opnames (VPS-paden) bij een run die een ander (de planner) al afsloot. Mag nooit gooien.
    async runOpnames(id, opnames) {
      const { error } = await supabase.from('worker_run_log').update({ video_paths: opnames }).eq('id', id)
      if (error) log.warn(`Opnames bij run ${id} niet opgeslagen: ${error.message}`)
    },
  }
}

// Puur (getest): de levensduren uit rijen van postnl_sessies.
export function levensdurenUit(rijen) {
  const uit = []
  for (const r of rijen) {
    if (r.einde_reden === 'verlopen' && r.einde_at) uit.push((new Date(r.einde_at) - new Date(r.ingelogd_at)) / 60_000)
    for (const g of r.gebeurtenissen ?? []) {
      if (g?.soort === 'sessie_verlopen' && (g.tab ?? 'oompd') === 'oompd' && Number.isFinite(g.duurMin)) uit.push(g.duurMin)
    }
  }
  return uit
}
