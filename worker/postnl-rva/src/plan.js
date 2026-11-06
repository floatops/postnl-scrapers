// Rekenwerk voor RVA-opdrachten. Puur en getest (test/plan.test.mjs).
//
// In de bewerkstand krijgt elke regel een nieuwe guid (RVA werkt op een kladversie), dus een
// regel herkennen we aan zijn inhoud: postcode, straat, huisnummers en even/oneven.

export const regelSleutel = (r) => [r.postcode, r.straat, r.van, r.tm, r.evenOneven].map(v => String(v ?? '').trim().toLowerCase()).join('|')

// Kort label voor logs: géén adres (de repo en de logs zijn publiek), alleen de plek in de rit.
export const regelLabel = (regels, sleutel) => {
  const i = regels.findIndex(r => regelSleutel(r) === sleutel)
  return i < 0 ? 'regel ?' : `regel ${i + 1}`
}

export function vindRegel(regels, sleutel) {
  const treffers = regels.filter(r => regelSleutel(r) === sleutel)
  if (treffers.length > 1) throw new Error(`Twee regels met dezelfde inhoud (${regelLabel(regels, sleutel)}): niet eenduidig`)
  return treffers[0] ?? null
}

// Wat RVA doet als je in het volgorde-vak een nummer typt: de regel gaat naar die plek, de rest
// schuift op. Te hoog wordt de laatste plek, 0 of lager de eerste (vastgesteld 03-11).
export function zetOpPlek(regels, sleutel, nummer) {
  const van = regels.findIndex(r => regelSleutel(r) === sleutel)
  if (van < 0) throw new Error('Regel niet gevonden')
  const naar = Math.min(Math.max(Number(nummer), 1), regels.length) - 1
  const uit = regels.slice()
  const [r] = uit.splice(van, 1)
  uit.splice(naar, 0, r)
  return uit.map((x, i) => ({ ...x, volgorde: i + 1 }))
}

// De stappen om van `huidig` naar de volgorde `gewenst` (lijst sleutels) te komen. Van boven
// naar beneden: wat bovenaan al goed staat blijft staan, dus hooguit één stap per regel.
export function stappenVoorVolgorde(huidig, gewenst) {
  const sleutels = huidig.map(regelSleutel)
  if (gewenst.length !== sleutels.length || new Set(gewenst).size !== gewenst.length || gewenst.some(s => !sleutels.includes(s))) {
    throw new Error('De gewenste volgorde bevat niet precies dezelfde regels als de rit')
  }
  const stappen = []
  let stand = huidig.slice()
  gewenst.forEach((sleutel, i) => {
    if (regelSleutel(stand[i]) === sleutel) return
    stappen.push({ sleutel, nummer: i + 1 })
    stand = zetOpPlek(stand, sleutel, i + 1)
  })
  return stappen
}

// Knippen: de regel loopt tot en met `tm`, PostNL maakt zelf de rest-regel (volgende huisnummer
// met dezelfde even/oneven tot het oude eind). Geeft de twee verwachte delen.
export function knipDelen(regel, tm) {
  const t = Number(tm)
  const stap = regel.evenOneven === 'Even' || regel.evenOneven === 'Oneven' ? 2 : 1
  if (!Number.isInteger(t)) throw new Error('Knippen: t/m is geen huisnummer')
  if (t < regel.van || t >= regel.tm) throw new Error(`Knippen: t/m moet tussen ${regel.van} en ${regel.tm} liggen (exclusief het eind)`)
  if (stap === 2 && (t % 2 === 0) !== (regel.evenOneven === 'Even')) throw new Error(`Knippen: ${t} is niet ${regel.evenOneven.toLowerCase()}`)
  return [{ ...regel, tm: t }, { ...regel, van: t + stap }]
}

// Verschillen tussen twee lijsten regels, voor de controle na een handeling. Leeg = gelijk.
export function verschillen(a, b, { velden = ['richting'] } = {}) {
  const uit = []
  const sa = a.map(regelSleutel)
  const sb = b.map(regelSleutel)
  if (sa.length !== sb.length) uit.push(`aantal regels ${sa.length} → ${sb.length}`)
  const weg = sa.filter(s => !sb.includes(s)).length
  const erbij = sb.filter(s => !sa.includes(s)).length
  if (weg || erbij) uit.push(`${weg} regel(s) weg, ${erbij} nieuw`)
  const verplaatst = sa.filter((s, i) => sb.includes(s) && sb.indexOf(s) !== i).length
  if (verplaatst) uit.push(`${verplaatst} regel(s) op een andere plek`)
  for (const veld of velden) {
    const anders = a.filter((r, i) => { const j = sb.indexOf(sa[i]); return j >= 0 && b[j][veld] !== r[veld] }).length
    if (anders) uit.push(`${anders} regel(s) met andere ${veld}`)
  }
  return uit
}

// Een revisie in de lijst op het scherm terugvinden: die toont "dd-mm-jjjj hh:mm" (NL-tijd).
export function revisieTijdTekst(ms) {
  const d = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {})
  return `${d.day}-${d.month}-${d.year} ${d.hour}:${d.minute}`
}

// ── Rittenoverzicht → rva_ritten in matransport (matransport#573) ─────────────

// De paginastatus onder het overzicht ("1 to 20 of 40") → { tot, totaal }; null als hij anders luidt.
export function pagingStatus(tekst) {
  const m = String(tekst ?? '').match(/(\d+)\s*(?:to|tot|-)\s*(\d+)\s*(?:of|van)\s*(\d+)/i)
  return m ? { tot: Number(m[2]), totaal: Number(m[3]) } : null
}

const ritnummerVan = (nummer) => (nummer ? (String(nummer).replace(/^0+/, '') || String(nummer)) : null)
const namenUitTekst = (t) => String(t ?? '').split(/\s*[,\n]\s*/).map(s => s.trim()).filter(Boolean)

// Eén rij per route-rij zoals RVA hem toont (per route twee: Ma, en Di–Za). Het scherm is de basis
// (naam, dagen, slotje, verantwoordelijken); het tripnummer komt uit de Mendix-antwoorden (rittenUit).
// Ritten die alleen in de antwoorden staan (niet op het scherm, bv. een lange lijst) komen er ook bij.
export function ritRijen(trips, scherm) {
  const nummerVan = (naam) => trips.find(t => t.naam === naam)?.nummer ?? String(naam).match(/^\s*(\d+)/)?.[1] ?? null
  const rijen = scherm.filter(s => s.ritnaam && s.dagen?.length).map(s => ({
    naam: s.ritnaam, nummer: nummerVan(s.ritnaam), dagen: s.dagen, opSlot: s.opSlot ?? [],
    verantwoordelijken: namenUitTekst(s.verantwoordelijkenTekst).length ? namenUitTekst(s.verantwoordelijkenTekst) : (trips.find(t => t.naam === s.ritnaam)?.verantwoordelijken ?? []),
  }))
  for (const t of trips) {
    if (!t.naam || !t.dagen?.length || rijen.some(r => r.naam === t.naam)) continue
    rijen.push({ naam: t.naam, nummer: t.nummer, dagen: t.dagen, opSlot: [], verantwoordelijken: t.verantwoordelijken ?? [] })
  }
  const gezien = new Set()
  return rijen.map(r => {
    const nummer = r.nummer == null ? null : String(r.nummer).trim()
    return {
      sleutel: `${nummer ?? r.naam}|${r.dagen[0]}`, naam: r.naam, trip_nummer: nummer, ritnummer: ritnummerVan(nummer),
      dagen: r.dagen, verantwoordelijken: r.verantwoordelijken, vergrendeld_dagen: r.opSlot,
    }
  }).filter(r => !gezien.has(r.sleutel) && gezien.add(r.sleutel))
}

// Wat er naar rva_ritten moet: nieuwe of gewijzigde rijen, plus rijen die langer dan `verversUur`
// niet bijgewerkt zijn (gezien_at: matransport ruimt een rij op die 30 dagen niet gezien is).
export function rittenTeSchrijven(bestaand, gelezen, nu = new Date(), verversUur = 12) {
  const oud = new Map(bestaand.map(b => [b.sleutel, b]))
  const zelfde = (a, b) => JSON.stringify([a.naam, a.trip_nummer, a.ritnummer, a.dagen, a.verantwoordelijken, a.vergrendeld_dagen])
    === JSON.stringify([b.naam, b.trip_nummer, b.ritnummer, b.dagen, b.verantwoordelijken, b.vergrendeld_dagen])
  return gelezen.filter(r => {
    const b = oud.get(r.sleutel)
    return !b || !zelfde(b, r) || nu - new Date(b.gezien_at) > verversUur * 3_600_000
  })
}

// Rijen die niet meer in het Rittenoverzicht staan: weg, zodat de app geen rit of dag aanbiedt die
// RVA niet meer heeft (matransport#601). Tot dan bleven ze 30 dagen staan. Alleen als alle pagina's
// aantoonbaar gelezen zijn (`compleet`: evenveel rijen als "1 to 20 of N" zegt): anders verliest een
// chauffeur door een halve lezing zijn rit. Een veel kleiner resultaat blijft daarnaast verdacht.
export function rittenTeVerwijderen(bestaand, gelezen, compleet, minDeel = 0.8) {
  if (compleet !== true || !gelezen.length || gelezen.length < bestaand.length * minDeel) return []
  const er = new Set(gelezen.map(r => r.sleutel))
  return bestaand.filter(b => !er.has(b.sleutel)).map(b => b.sleutel)
}

// Welke rit-dag de sessiehouder als volgende uit RVA leest (taak rvaBijlezen, matransport#573):
// eerst wat nog nooit gelezen is (of als verouderd gemarkeerd), dan de oudste lezing die ouder is
// dan `uur`. `overslaan(rit|dag)`: bv. een rit-dag die net mislukte. null = alles is vers.
export function volgendeBijlezen(ritten, regels, nu = new Date(), { uur = 6, overslaan = () => false } = {}) {
  const gelezen = new Map(regels.map(g => [`${g.rit}|${g.weekdag}`, g.gelezen_at]))
  const kandidaten = []
  for (const r of ritten) {
    for (const d of r.dagen ?? []) {
      const k = `${r.naam}|${d}`
      if (overslaan(k)) continue
      const t = gelezen.get(k)
      const ouderdom = t == null ? Infinity : nu - new Date(t)
      if (ouderdom > uur * 3_600_000) kandidaten.push({ rit: r.naam, weekdag: d, ouderdom })
    }
  }
  kandidaten.sort((a, b) => b.ouderdom - a.ouderdom)
  return kandidaten[0] ? { rit: kandidaten[0].rit, weekdag: kandidaten[0].weekdag } : null
}
