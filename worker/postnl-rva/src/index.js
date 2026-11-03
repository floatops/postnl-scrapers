// postnl-rva — rijvolgorde per rit-dag aanpassen in PostNL RVA (floatops/matransport#569).
//
// Stap 1: alle handelingen uit de opnames van 03-11 uitvoeren en controleren. Later neemt de
// sessiehouder (postnl-sessie) dit over in een tweede tabblad van dezelfde sessie, en komt er een
// wachtrij vanuit de app. Uitleg: ../POSTNL_RVA.md.
//
// Een opdracht is een lijst handelingen op één rit-dag:
//   { rit: '<ritnaam>', dag: 'Ma'..'Za', handelingen: [
//       { soort: 'volgorde', regel: <sleutel>, nummer },
//       { soort: 'richting', regel, richting: 'Oplopend'|'Aflopend' },
//       { soort: 'knip', regel, tm },
//       { soort: 'samenvoegen', regel, naar: 'onder'|'boven' },
//       { soort: 'onderbreking', regel, minuten },
//       { soort: 'onderbreking_weg', regel } ] }
// <sleutel> = plan.regelSleutel(regel). Veiligheid: zonder `echt` eindigt alles met Annuleer.
import { regelSleutel, zetOpPlek, knipDelen, verschillen } from './plan.js'
import { meldingenOver } from './lezen.js'
import * as rva from './scherm.js'

// Wat we na een handeling verwachten te zien, of null als dat niet vooraf vast te leggen is.
function verwacht(regels, h) {
  if (h.soort === 'volgorde') return zetOpPlek(regels, h.regel, h.nummer)
  if (h.soort === 'richting') return regels.map(r => (regelSleutel(r) === h.regel ? { ...r, richting: h.richting } : r))
  if (h.soort === 'knip') {
    const i = regels.findIndex(r => regelSleutel(r) === h.regel)
    return [...regels.slice(0, i), ...knipDelen(regels[i], h.tm), ...regels.slice(i + 1)]
  }
  return null
}

const UITVOEREN = {
  volgorde: (page, m, h) => rva.zetVolgorde(page, m, h.regel, h.nummer),
  richting: (page, m, h) => rva.zetRichting(page, m, h.regel, h.richting),
  knip: (page, m, h) => rva.knip(page, m, h.regel, h.tm),
  samenvoegen: (page, m, h) => rva.voegSamen(page, m, h.regel, h.naar),
  onderbreking: (page, m, h) => rva.onderbreking(page, m, h.regel, h.minuten),
  onderbreking_weg: (page, m, h) => rva.verwijderOnderbreking(page, m, h.regel),
}

// Voert de opdracht uit in de open RVA-pagina. Geeft per handeling wat er gebeurde. Een fout
// midden in een handeling: geen herhaling, wel Annuleer (de kladversie weg), en dan gooien.
export async function voerUit(page, mendix, opdracht, { echt = false, log = console } = {}) {
  await rva.openRitDag(page, mendix, opdracht.rit, opdracht.dag)
  const voor = await rva.leesRegels(page)
  await rva.startWijzig(page, mendix)
  const stappen = []
  try {
    for (const [i, h] of opdracht.handelingen.entries()) {
      const fn = UITVOEREN[h.soort]
      if (!fn) throw new rva.RvaFout('opdracht', `Onbekende handeling: ${h.soort}`)
      const nu = await rva.leesRegels(page)
      const doel = verwacht(nu, h)
      const antwoorden = await fn(page, mendix, h)
      const na = await rva.leesRegels(page)
      const afwijking = doel ? verschillen(doel, na) : []
      const meldingen = meldingenOver(antwoorden).map(x => x.tekst)
      stappen.push({ nr: i + 1, soort: h.soort, ok: afwijking.length === 0, afwijking, meldingen })
      log.log(`  ${i + 1}. ${h.soort}: ${afwijking.length ? `AFWIJKING (${afwijking.join('; ')})` : 'ok'}${meldingen.length ? ` — PostNL: ${meldingen.join(' / ')}` : ''}`)
      if (afwijking.length) throw new rva.RvaFout('controle', `${h.soort}: ${afwijking.join('; ')}`)
    }
  } catch (err) {
    await rva.annuleer(page, mendix).catch(() => {})
    err.stappen = stappen
    throw err
  }
  const kladversie = await rva.leesRegels(page)
  if (echt) await rva.opslaan(page, mendix)
  else await rva.annuleer(page, mendix)
  const na = await rva.leesRegels(page)
  // Opgeslagen: wat nu in beeld staat moet de kladversie zijn. Proef: weer gelijk aan het begin.
  const controle = echt ? verschillen(kladversie, na) : verschillen(voor, na)
  if (controle.length) throw Object.assign(new rva.RvaFout('controle', `${echt ? 'Na Opslaan' : 'Na Annuleer'}: ${controle.join('; ')}`), { stappen })
  return { voor, kladversie, na, stappen, opgeslagen: echt }
}

export * from './scherm.js'
export { regelSleutel, stappenVoorVolgorde, knipDelen, verschillen, revisieTijdTekst } from './plan.js'
export { regelsUit, ritDagUit, rittenUit, revisiesUit, onderbrekingenUit } from './lezen.js'
