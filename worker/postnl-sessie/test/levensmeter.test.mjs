// node --test — hoe lang een PostNL-sessie geldig blijft, per tabblad (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maakLevensmeter, duurTekst } from '../src/levensmeter.js'

const MIN = 60_000

test('het eerste inloggen telt niet; een latere login is een verloop met duur en stille tijd', () => {
  let t = 0
  const m = maakLevensmeter({ tab: 'oompd', klok: () => t })
  assert.equal(m.login({ taak: 'ochtend' }), null, 'vóór start: dat is de eerste login')
  m.start()
  t = 90 * MIN; m.taakKlaar()
  t = 192 * MIN
  assert.deepEqual(m.login({ taak: 'ritmonitor' }), { tab: 'oompd', duurMin: 192, stilMin: 102, taak: 'ritmonitor' })
  t = 250 * MIN
  assert.deepEqual(m.login({ taak: 'plannen' }), { tab: 'oompd', duurMin: 58, stilMin: 58, taak: 'plannen' }, 'de klok begint opnieuw bij het nieuwe inloggen')
})

test('start twee keer (bv. na een contextwissel) zet de klok niet terug', () => {
  let t = 0
  const m = maakLevensmeter({ tab: 'rva', klok: () => t })
  m.start()
  t = 30 * MIN
  m.start()
  t = 60 * MIN
  assert.equal(m.login().duurMin, 60)
})

test('duurTekst', () => {
  assert.equal(duurTekst(45.4), '45 min')
  assert.equal(duurTekst(192), '3 u 12 min')
})

test('levensdurenUit: verlopen sessies plus elk verloop binnen een sessie (alleen OOM PD)', async () => {
  const { levensdurenUit } = await import('../src/opslag.js')
  const rijen = [
    { ingelogd_at: '2026-11-04T05:00:00Z', einde_at: '2026-11-04T07:00:00Z', einde_reden: 'verlopen', gebeurtenissen: [] },
    { ingelogd_at: '2026-11-04T07:00:00Z', einde_at: '2026-11-04T12:00:00Z', einde_reden: 'herstart', gebeurtenissen: [
      { soort: 'sessie_verlopen', tab: 'oompd', duurMin: 185 }, { soort: 'sessie_verlopen', tab: 'rva', duurMin: 40 }, { soort: 'planner' }] },
  ]
  assert.deepEqual(levensdurenUit(rijen), [120, 185], 'herstart telt niet; RVA telt niet voor de OOM PD-schatting')
})
