// De stand van één depot op één dag, en hoe die verandert na een taak. Puur (floatops/matransport#562).
// Wordt na elke wijziging opgeslagen in `postnl_dagstatus`, zodat een herstart (deploy, crash)
// verdergaat waar hij was en niet opnieuw een ochtendlezing doet of deadlines kwijt is.
//
// {
//   datum: 'JJJJ-MM-DD',
//   ochtend:   { gelezenOm, nietBeschikbaarTot, pogingen },
//   shifts:    { '03': { deadline, laatsteControleOm, geautoriseerdOm, definitiefOm, vangnet } },
//   ritmonitor:{ laatsteOm, gestartOm, reden },
//   aanvragen: [{ id, soort: 'planner'|'depotUrl', ... }],
// }

const MIN = 60_000
const iso = (d) => new Date(d).toISOString()

export function nieuweDag(datum) {
  return { datum, ochtend: {}, shifts: {}, ritmonitor: {}, aanvragen: [] }
}

// Een opgeslagen stand van een andere dag telt niet: dan begint de dag opnieuw.
// Openstaande aanvragen gaan mee (een planner-opdracht van 23:59 vervalt niet om middernacht).
export function voorDatum(opgeslagen, datum) {
  if (opgeslagen?.datum === datum) return { ...nieuweDag(datum), ...opgeslagen }
  return { ...nieuweDag(datum), aanvragen: opgeslagen?.aanvragen ?? [] }
}

// shifts: { '03': { deadline: ISO|null, geautoriseerd: bool } } uit de ochtendlezing.
export function naOchtend(dag, { nu, shifts }) {
  const uit = { ...dag, ochtend: { ...dag.ochtend, gelezenOm: iso(nu), nietBeschikbaarTot: null }, shifts: { ...dag.shifts } }
  for (const [naam, s] of Object.entries(shifts)) {
    const bestaand = uit.shifts[naam] ?? {}
    uit.shifts[naam] = {
      ...bestaand,
      // De deadline staat vast voor de dag: een eenmaal gelezen deadline wordt niet overschreven.
      deadline: bestaand.deadline ?? s.deadline ?? null,
      ...(s.geautoriseerd && !bestaand.geautoriseerdOm ? { geautoriseerdOm: iso(nu) } : {}),
    }
  }
  return uit
}

export function naOchtendNietBeschikbaar(dag, { nu, cfg }) {
  return { ...dag, ochtend: { ...dag.ochtend, nietBeschikbaarTot: iso(nu.getTime() + cfg.dagNietBeschikbaarWachtMin * MIN), pogingen: (dag.ochtend?.pogingen ?? 0) + 1 } }
}

// Na een controle van één shift. Geeft { dag, schrijven, vangnet }:
// schrijven = nu de definitieve lezing wegschrijven (geautoriseerd, of het vangnet).
export function naDefinitief(dag, shift, { nu, geautoriseerd, cfg }) {
  const s = { ...(dag.shifts?.[shift] ?? {}) }
  let schrijven = false
  let vangnet = false
  if (geautoriseerd) {
    s.geautoriseerdOm = s.geautoriseerdOm ?? iso(nu)
    s.definitiefOm = iso(nu)
    schrijven = true
  } else {
    const vanaf = s.deadline ? new Date(s.deadline).getTime() : null
    if (vanaf !== null && nu.getTime() - vanaf >= cfg.vangnetMin * MIN) {
      s.definitiefOm = iso(nu)
      s.vangnet = true
      schrijven = true
      vangnet = true
    } else {
      s.laatsteControleOm = iso(nu)
    }
  }
  return { dag: { ...dag, shifts: { ...dag.shifts, [shift]: s } }, schrijven, vangnet }
}

export function naRitmonitor(dag, { nu, reden = null }) {
  return { ...dag, ritmonitor: { ...dag.ritmonitor, laatsteOm: iso(nu), gestartOm: dag.ritmonitor?.gestartOm ?? iso(nu), ...(reden && !dag.ritmonitor?.reden ? { reden } : {}) } }
}

export function voegAanvraagToe(dag, aanvraag) {
  if ((dag.aanvragen ?? []).some(a => a.id === aanvraag.id)) return dag
  return { ...dag, aanvragen: [...(dag.aanvragen ?? []), aanvraag] }
}

export function aanvraagKlaar(dag, id) {
  return { ...dag, aanvragen: (dag.aanvragen ?? []).filter(a => a.id !== id) }
}
