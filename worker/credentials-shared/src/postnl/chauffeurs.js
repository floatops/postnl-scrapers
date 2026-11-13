// Alle PostNL-chauffeurs per klant naar `postnl_chauffeurs` (floatops/matransport#713).
//
// Eén bron voor "wie rijdt er voor PostNL": het vaste Mendix-id van Planning.Driver plus de naam
// (LastNameInitials). De koppeling naar een FloatOps-medewerker (user_id) zet HR in de app; die
// kolom schrijft de worker nooit. Rijen worden nooit verwijderd: PostNL ruimt zijn lijst ook niet
// op, en een rij zonder recente `laatst_gezien` toont de app niet meer.
//
// Twee bronnen in PostNL, beide OOM PD:
// - de chauffeur van elke rit in de Dagplanning-antwoorden (id + naam, via dagplanningRitten);
// - de open chauffeurkeuzelijst bij een rit (option value = hetzelfde id; trace 13-11). Alleen een
//   niet-vergrendelde lijst is volledig: bij een geautoriseerde rit staat alleen de eigen chauffeur
//   erin. Die bron zet ook `laatst_in_keuzelijst` (wie PostNL nu laat kiezen, voor Plannen).

// Hoe oud `laatst_gezien` mag zijn voor hij opnieuw geschreven wordt: anders schrijft elke lezing
// (elke paar minuten) alle chauffeurs, en gaat elk van die schrijfacties live naar de app.
export const VERVERS_MS = 60 * 60_000

const schoon = (w) => (typeof w === 'string' ? w.trim() : '')

// Unieke chauffeurs (id + naam) uit gelezen dagplanning-ritten (dagplanningRitten()).
export function chauffeursUitRitten(ritten) {
  const uit = new Map()
  for (const r of ritten ?? []) {
    const id = schoon(r?.velden?.postnl_chauffeur_id)
    const naam = schoon(r?.velden?.postnl_chauffeur)
    if (id && naam) uit.set(id, { postnl_id: id, naam })
  }
  return [...uit.values()]
}

// Opties uit een keuzelijst ({ id, naam }) naar dezelfde vorm. Lege of dubbele opties vallen weg.
export function chauffeursUitKeuzes(keuzes) {
  const uit = new Map()
  for (const k of keuzes ?? []) {
    const id = schoon(k?.id)
    const naam = schoon(k?.naam)
    if (id && naam) uit.set(id, { postnl_id: id, naam })
  }
  return [...uit.values()]
}

// Puur: welke rijen moeten naar de database? bestaand: rijen van deze klant (postnl_id, naam, depot,
// laatst_gezien, laatst_in_keuzelijst). Nieuw, andere naam of ander depot: altijd; anders alleen als
// de tijd VERVERS_MS oud is.
export function chauffeursTeSchrijven(bestaand, gelezen, { klantId, depot, nu, uitKeuzelijst = false }) {
  const nuMs = new Date(nu).getTime()
  const oud = new Map((bestaand ?? []).map(r => [r.postnl_id, r]))
  const verlopen = (t) => !(Date.parse(t ?? '') > nuMs - VERVERS_MS)
  const uit = []
  for (const c of gelezen) {
    const o = oud.get(c.postnl_id)
    const nodig = !o || o.naam !== c.naam || o.depot !== depot || verlopen(o.laatst_gezien)
      || (uitKeuzelijst && verlopen(o.laatst_in_keuzelijst))
    if (!nodig) continue
    uit.push({
      klant_id: klantId, depot, postnl_id: c.postnl_id, naam: c.naam, laatst_gezien: nu,
      ...(uitKeuzelijst ? { laatst_in_keuzelijst: nu } : (o?.laatst_in_keuzelijst ? { laatst_in_keuzelijst: o.laatst_in_keuzelijst } : {})),
    })
  }
  return uit
}

// Bestaat de tabel nog niet (stack waar de matransport-migratie nog niet gepromoot is), dan
// overslaan in plaats van de lezing te laten mislukken. Elke andere fout is luid.
const TABEL_ONTBREEKT = new Set(['42P01', 'PGRST205'])

// Schrijft de chauffeurs. Geeft { geschreven, overgeslagen } terug. Gooit bij een databasefout met
// `database: true`, zodat de sessiehouder het niet als sessieprobleem ziet.
export async function bewaarChauffeurs(supabase, { klantId, depot, chauffeurs, uitKeuzelijst = false, nu = new Date().toISOString() }) {
  if (!chauffeurs?.length) return { geschreven: 0, overgeslagen: false }
  const { data, error } = await supabase.from('postnl_chauffeurs')
    .select('postnl_id, naam, depot, laatst_gezien, laatst_in_keuzelijst')
    .eq('klant_id', klantId).in('postnl_id', chauffeurs.map(c => c.postnl_id))
  if (error) {
    if (TABEL_ONTBREEKT.has(error.code)) return { geschreven: 0, overgeslagen: true }
    throw Object.assign(new Error(`PostNL-chauffeurs lezen: ${error.code ?? ''} ${error.message}`.trim()), { database: true })
  }
  const schrijf = chauffeursTeSchrijven(data ?? [], chauffeurs, { klantId, depot, nu, uitKeuzelijst })
  if (!schrijf.length) return { geschreven: 0, overgeslagen: false }
  // user_id staat bewust niet in de rij: een upsert laat de koppeling van HR zo ongemoeid.
  const { error: fout } = await supabase.from('postnl_chauffeurs').upsert(schrijf, { onConflict: 'klant_id,postnl_id' })
  if (fout) throw Object.assign(new Error(`PostNL-chauffeurs bewaren: ${fout.code ?? ''} ${fout.message}`.trim()), { database: true })
  return { geschreven: schrijf.length, overgeslagen: false }
}
