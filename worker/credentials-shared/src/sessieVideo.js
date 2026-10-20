// Sessie-video's in de private bucket worker-sessies (floatops/matransport#354, #360).
//
// - Laatste sessie per depot: {klant}/{worker}/{depot}-latest.webm, elke run overschreven.
// - Mislukte sessie: {klant}/{worker}/fout/{depot}-{JJJJ-MM-DD_HH-MM-SS}.webm (NL-tijd),
//   blijft BEWAAR_DAGEN bewaard. Vóór #360 was dat één -fout-latest.webm die de
//   volgende fout weer overschreef, zodat een fout van gisteren niet meer terug te
//   kijken was.
// Alles best-effort: een video-probleem laat de scrape nooit falen.

export const BUCKET = 'worker-sessies'
export const BEWAAR_DAGEN = 30

export function depotSlug(depotNaam) {
  return String(depotNaam || 'onbekend-depot').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'onbekend-depot'
}

// NL-tijd als 2026-10-20_15-32-01 (sorteert op tijd, geen ':' in de bestandsnaam).
export function nlTijdstempel(datum = new Date()) {
  const d = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(datum).reduce((a, p) => (a[p.type] = p.value, a), {})
  return `${d.year}-${d.month}-${d.day}_${d.hour}-${d.minute}-${d.second}`
}

export function latestPad(klantId, worker, depotNaam, achtervoegsel = '') {
  return `${klantId}/${worker}/${depotSlug(depotNaam)}${achtervoegsel}-latest.webm`
}

export function foutPad(klantId, worker, depotNaam, datum = new Date(), achtervoegsel = '') {
  return `${klantId}/${worker}/fout/${depotSlug(depotNaam)}${achtervoegsel}-${nlTijdstempel(datum)}.webm`
}

// Namen in fout/ waarvan de tijdstempel ouder is dan `dagen`. Gaat op de naam,
// niet op created_at: dan doet hij het ook als de lijst-API dat veld niet geeft.
export function teOudeFoutVideos(namen, nu = new Date(), dagen = BEWAAR_DAGEN) {
  const grens = nlTijdstempel(new Date(nu.getTime() - dagen * 86_400_000))
  return namen.filter(n => {
    const m = n.match(/-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.webm$/)
    return m && m[1] < grens
  })
}

async function upload(supabase, pad, buffer) {
  const { error } = await supabase.storage.from(BUCKET).upload(pad, buffer, { contentType: 'video/webm', upsert: true })
  if (error) throw error
  return pad
}

// Leest het (afgeronde) videobestand en uploadt het naar `pad`. Roep pas aan na
// context.close(): Playwright rondt het bestand dan pas af. Ruimt het lokale
// bestand op. Geeft het pad terug, of null als het niet lukte.
export async function bewaarVideo(supabase, video, pad, label = '') {
  if (!video) return null
  const fs = await import('node:fs/promises')
  let localPath
  try {
    localPath = await video.path()
    const pad2 = await upload(supabase, pad, await fs.readFile(localPath))
    console.log(`${label}Sessie-video opgeslagen: ${pad2}`)
    return pad2
  } catch (error) {
    console.error(`${label}Video-opslag mislukt (gaat gewoon door):`, error.message)
    return null
  } finally {
    if (localPath) await fs.unlink(localPath).catch(() => {})
  }
}

// Verwijdert foutvideo's ouder dan BEWAAR_DAGEN in {klant}/{worker}/fout/.
// Best-effort; draait na het opslaan van een nieuwe foutvideo.
export async function ruimOudeFoutVideosOp(supabase, klantId, worker, nu = new Date()) {
  try {
    const map = `${klantId}/${worker}/fout`
    const { data, error } = await supabase.storage.from(BUCKET).list(map, { limit: 1000 })
    if (error) throw error
    const weg = teOudeFoutVideos((data ?? []).map(o => o.name), nu)
    if (weg.length) {
      const { error: e2 } = await supabase.storage.from(BUCKET).remove(weg.map(n => `${map}/${n}`))
      if (e2) throw e2
      console.log(`Oude foutvideo's opgeruimd: ${weg.length}`)
    }
  } catch (error) {
    console.error('Opruimen oude foutvideo\'s mislukt (niet kritiek):', error.message)
  }
}
