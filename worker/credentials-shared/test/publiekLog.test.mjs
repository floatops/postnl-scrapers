// node --test — bewaakt dat de publieke run-log geen klant verraadt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installeerNeutraleConsole, depotCode } from '../src/publiekLog.js'

const depots = [
  { naam: 'Den Hoorn', username: 'ma.denhoorn@voorbeeld.nl', url: 'https://pnl-oompd-process-hbd-h.p15.cldsvc.net/index.html' },
  { naam: 'Den Hoorn Noord', username: 'noord@voorbeeld.nl' },
]

function vang(fn) {
  const regels = []
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  // De filter wikkelt de dán geldende console; vang daarom eerst, installeer daarna.
  console.log = console.warn = console.error = console.info = (...a) => regels.push(a.join(' '))
  try { fn() } finally { Object.assign(console, orig) }
  return regels.join('\n')
}

test('depotcode is stabiel per klant en verschilt per klant', () => {
  assert.equal(depotCode('k1', 'Den Hoorn'), depotCode('k1', 'Den Hoorn'))
  assert.notEqual(depotCode('k1', 'Den Hoorn'), depotCode('k2', 'Den Hoorn'))
  assert.match(depotCode('k1', 'Den Hoorn'), /^D-[0-9a-f]{4}$/)
})

test('depotnamen, logins, URL\'s en stacktraces verdwijnen uit de log', () => {
  const uit = vang(() => {
    installeerNeutraleConsole({ klantId: 'k1', depots, forceer: true })
    console.log('[Den Hoorn] Ingelogd, URL:', 'https://pnl-oompd-process-hbd-h.p15.cldsvc.net/index.html?x=1')
    console.log('[den hoorn noord] Start sync met ma.denhoorn@voorbeeld.nl')
    console.error('[Den Hoorn] Sync mislukt:', new Error('Timeout op https://portaal.nl/pad\n    at stapel (x.js:1)'))
    console.log('Chauffeurs gekoppeld: 3 ritten', { depot: 'Den Hoorn', rit: '0135' })
  })
  for (const verboden of ['Den Hoorn', 'den hoorn', 'Noord', 'voorbeeld.nl', 'cldsvc', 'portaal.nl', 'at stapel', 'hbd'])
    assert.ok(!uit.includes(verboden), `"${verboden}" staat nog in de log:\n${uit}`)
  assert.ok(uit.includes(depotCode('k1', 'Den Hoorn')), 'depotcode ontbreekt')
  assert.ok(uit.includes(depotCode('k1', 'Den Hoorn Noord')), 'langere naam moet als geheel gecodeerd worden')
  assert.ok(uit.includes('<url>') && uit.includes('<login>'))
  assert.ok(uit.includes('rit') && uit.includes('0135'), 'ritnummers mogen blijven')
})

test('buiten GitHub Actions blijft de console ongefilterd', () => {
  delete process.env.GITHUB_ACTIONS
  const uit = vang(() => {
    installeerNeutraleConsole({ klantId: 'k1', depots })
    console.log('[Den Hoorn] lokaal leesbaar')
  })
  assert.ok(uit.includes('Den Hoorn'))
})
