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
