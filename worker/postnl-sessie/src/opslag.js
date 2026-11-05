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

    // Planner-opdrachten van dit depot die op 'bezig' bleven staan, bv. na een crash (matransport#578).
    // Alleen aanroepen met het sessie-slot van dit depot in de hand: dan kan niemand anders ermee
    // bezig zijn. Afbreken, nooit opnieuw uitvoeren: een verplaatsing kan al gelukt zijn. Tot dan
    // hield de wachtdog ze 60 min vast, en zolang kon niemand van de klant iets opslaan (04-11).
    // Mag de sessie niet stilleggen: bij een fout blijft de wachtdog in de database het vangnet.
    async ruimVerweesdePlannerOp(depot) {
      try {
        const taken = await vereis(supabase.from('planning_taken').select('id')
          .eq('klant_id', klantId).eq('depot', depot).eq('status', 'bezig'), 'verweesde planner-opdrachten lezen')
        if (!taken.length) return 0
        const ids = taken.map(t => t.id)
        await vereis(supabase.from('planning_verplaatsingen').update({ status: 'mislukt', melding: 'Onderbroken tijdens deze wijziging (de verbinding met PostNL viel weg). Controleer dit in PostNL.' })
          .in('taak_id', ids).eq('status', 'bezig'), 'onderbroken wijziging')
        await vereis(supabase.from('planning_verplaatsingen').update({ status: 'overgeslagen', melding: 'Niet uitgevoerd: de verbinding met PostNL viel weg. Sla deze wijziging opnieuw op.' })
          .in('taak_id', ids).eq('status', 'wacht'), 'niet uitgevoerde wijziging')
        await vereis(supabase.from('planning_taken').update({
          status: 'afgebroken', afgerond_at: new Date().toISOString(),
          fout: 'Afgebroken: de verbinding met PostNL viel weg tijdens deze opdracht. Per wijziging staat erbij wat er gebeurde.',
        }).in('id', ids).eq('status', 'bezig'), 'verweesde planner-opdracht afbreken')
        log.warn(`[${depot}] ${ids.length} planner-opdracht(en) bleven op bezig staan (crash of herstart): afgebroken`)
        return ids.length
      } catch (err) {
        log.warn(`[${depot}] Verweesde planner-opdrachten niet opgeruimd (wachtdog neemt het over): ${err.message}`)
        return 0
      }
    },

    // Sessierijen van dit depot zonder einde: het proces dat ze opende is weg (crash, exit 134,
    // kill) zonder ze af te sluiten (matransport#591; 04-11 bleven er zo 5 per depot open). Alleen
    // aanroepen met het slot in de hand en zonder eigen open sessie. Mag de sessie niet stilleggen.
    async sluitVerweesdeSessiesAf(depot) {
      try {
        const rijen = await vereis(supabase.from('postnl_sessies').select('id, ingelogd_at, laatste_ok_at')
          .eq('klant_id', klantId).eq('depot', depot).is('einde_at', null), 'open sessies lezen')
        for (const r of rijen) {
          await vereis(supabase.from('postnl_sessies').update(verweesdeSessieEinde(r))
            .eq('id', r.id).eq('klant_id', klantId).is('einde_at', null), 'verweesde sessie afsluiten')
        }
        if (rijen.length) log.warn(`[${depot}] ${rijen.length} sessie(s) van een vorig proces stonden nog open: afgesloten (proces_weg)`)
        return rijen.length
      } catch (err) {
        log.warn(`[${depot}] Verweesde sessies niet afgesloten: ${err.message}`)
        return 0
      }
    },

    // Sessie-slot (#361): pakken of verlengen. true = van ons.
    async slotPak(sleutel, houder, seconden) {
      const { data, error } = await supabase.rpc('postnl_sessie_pak', { p_sleutel: sleutel, p_houder: houder, p_seconden: seconden })
      if (error) throw Object.assign(new Error(`sessie-slot: ${error.message}`), { database: true })
      return data === true
    },
    // Wie heeft het slot nu (of null)? Voor de melding slot_kwijt (#599).
    async slotHouder(sleutel) {
      const { data, error } = await supabase.rpc('postnl_sessie_info', { p_sleutel: sleutel })
      if (error) return null
      return data?.[0]?.houder ?? null
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

// Puur (getest): het einde van een verweesde sessierij. Het laatste moment waarop hij bewezen
// werkte (de laatste geslaagde taak), anders de login zelf; nooit "nu", want dan lijkt een sessie
// van een proces dat 's ochtends crashte de hele dag geldig. In de levensduur een ondergrens.
export function verweesdeSessieEinde(rij) {
  return { einde_at: rij.laatste_ok_at ?? rij.ingelogd_at, einde_reden: 'proces_weg' }
}

// Puur (getest): de levensduren uit rijen van postnl_sessies.
// Alleen zuivere metingen (matransport#598):
// - pas vanaf METING_VANAF: daarvoor werden fouten 460 niet vastgelegd, dus is niet te zien of een
//   "verlopen" sessie eigenlijk door PostNL werd ingetrokken (05-11 15:08, na een uur fouten 460);
// - niet als er in de STORING_MIN ervoor een storing was (fout 460, eruit gegooid, een andere fout);
// - niet als het verlopen zelf uit een vastgelopen taak kwam (04-11: "duurde langer dan 150 s").
export const METING_VANAF = '2026-11-06T00:00:00Z'
const STORING_MIN = 30
const STORING = new Set(['herlogin', 'sessie_ingetrokken', 'gegooid', 'fout', 'browser_weg', 'blokkade'])

function zuiver(gebeurtenissen, om) {
  const t = new Date(om).getTime()
  return !(gebeurtenissen ?? []).some(g => {
    if (!g?.at) return false
    const at = new Date(g.at).getTime()
    if (at > t || t - at > STORING_MIN * 60_000) return false
    if (STORING.has(g.soort)) return true
    // Het verlopen zelf: uit een vastgelopen taak, of met fouten 460 in het uur ervoor.
    return g.soort === 'verlopen' && (g.herlogins > 0 || /duurde langer/.test(String(g.fout ?? '')))
  })
}

export function levensdurenUit(rijen) {
  const uit = []
  for (const r of rijen) {
    if (!r.ingelogd_at || r.ingelogd_at < METING_VANAF) continue
    const g = r.gebeurtenissen ?? []
    if (r.einde_reden === 'verlopen' && r.einde_at && zuiver(g, r.einde_at)) uit.push((new Date(r.einde_at) - new Date(r.ingelogd_at)) / 60_000)
    for (const x of g) {
      if (x?.soort === 'sessie_verlopen' && (x.tab ?? 'oompd') === 'oompd' && Number.isFinite(x.duurMin) && !(x.herlogins > 0) && zuiver(g, x.at)) uit.push(x.duurMin)
    }
  }
  return uit
}
