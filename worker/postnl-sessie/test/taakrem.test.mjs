// node --test — fouten per taak tellen en remmen (floatops/matransport#598).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { naTaak, remTaken } from '../src/taakrem.js'
import { STANDAARD } from '../src/instellingen.js'

const cfg = STANDAARD
const nu = new Date('2026-11-05T08:00:00+01:00')
const fout = new Error('PostNL reageerde niet binnen de wachttijd')

function reeks(soorten, { taak = 'plannen', opAanvraag = false } = {}) {
  let stand = {}
  const uit = []
  soorten.forEach((soort, i) => {
    const r = naTaak(stand, { taak, opAanvraag, soort, fout, nu: new Date(nu.getTime() + i * 60_000), cfg })
    stand = r.stand
    uit.push(r)
  })
  return { stand, uit }
}

test('naTaak: na 3 gewone fouten van dezelfde taak precies één nieuwe login', () => {
  const { uit } = reeks(['fout', 'fout', 'fout', 'fout'])
  assert.deepEqual(uit.map(u => u.nieuweLogin), [false, false, true, false])
})

test('naTaak: vanaf 5 keer mislukt steeds langer wachten (1, 2, 4 … max 15 min) en één melding', () => {
  const { uit } = reeks(Array(10).fill('fout'))
  const wacht = uit.map((u, i) => u.stand.plannen.tot ? Math.round((new Date(u.stand.plannen.tot) - (nu.getTime() + i * 60_000)) / 60_000) : 0)
  assert.deepEqual(wacht, [0, 0, 0, 0, 1, 2, 4, 8, 15, 15])
  assert.equal(uit.filter(u => u.melding?.soort === 'taak_faalt').length, 1)
  assert.match(uit[4].melding.detail, /plannen 5x.*reageerde niet/)
})

test('naTaak: één keer gelukt en de telling van die taak begint opnieuw', () => {
  const { stand } = reeks(['fout', 'fout', 'fout', 'fout', 'fout', 'gezond'])
  assert.equal(stand.plannen, undefined)
})

test('naTaak: herlogin en gegooid tellen voor de rem, niet voor een nieuwe login; database telt niet', () => {
  const { uit, stand } = reeks(['herlogin', 'gegooid', 'herlogin', 'database', 'herlogin', 'herlogin'])
  assert.ok(uit.every(u => !u.nieuweLogin))
  assert.equal(stand.plannen.n, 5)
  assert.ok(stand.plannen.tot)
})

test('naTaak: een opdracht (planner, RVA) wordt nooit geremd', () => {
  const { stand, uit } = reeks(Array(8).fill('fout'), { taak: 'planner', opAanvraag: true })
  assert.deepEqual(stand, {})
  assert.ok(uit.every(u => !u.melding && !u.nieuweLogin))
})

test('remTaken: een geremde taak komt pas om `tot` aan de beurt, de andere gewoon', () => {
  const taken = [
    { naam: 'plannen', volgende: () => ({ nu: true }) },
    { naam: 'ritmonitor', volgende: () => ({ nu: true }) },
    { naam: 'planner', opAanvraag: true, volgende: () => ({ nu: true }) },
  ]
  const tot = new Date(nu.getTime() + 4 * 60_000).toISOString()
  const r = remTaken(taken, { plannen: { n: 7, gewoon: 7, tot }, planner: { n: 9, tot } }, nu)
  assert.deepEqual(r[0].volgende({}, nu, cfg), { om: new Date(tot) })
  assert.deepEqual(r[1].volgende({}, nu, cfg), { nu: true })
  assert.deepEqual(r[2].volgende({}, nu, cfg), { nu: true }, 'opdrachten nooit')
  assert.equal(remTaken(taken, { plannen: { n: 7, tot } }, new Date(nu.getTime() + 5 * 60_000)), taken, 'na `tot` weer gewoon')
})
