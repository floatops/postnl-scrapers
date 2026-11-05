// Datum en tijd (NL) voor elke regel van het VPS-log (floatops/matransport#599). Tot 05-11 hadden
// de logs geen tijden, en moest een storing uit traces en bestandsnamen worden teruggerekend. Met
// datum: de logbestanden heten naar de startdag, en de sessiehouder loopt door na middernacht.
// Eén keer per proces: de planner is ook een los script én wordt door de sessiehouder geladen.
const GEZET = Symbol.for('floatops.tijdLog')

export function tijdStempel(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]))
  return `${p.day}-${p.month} ${p.hour}:${p.minute}:${p.second}`
}

export function zetTijdInLog(c = console) {
  if (c[GEZET]) return
  c[GEZET] = true
  for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = c[m].bind(c)
    c[m] = (...args) => orig(tijdStempel(), ...args)
  }
}
