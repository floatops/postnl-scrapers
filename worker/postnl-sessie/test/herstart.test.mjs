// node --test — vaste dagelijkse herstart (floatops/matransport#668).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dagelijkseHerstartNu, nlMinuut } from '../src/herstart.js'
import { mergeInstellingen, waakhondMs } from '../src/instellingen.js'

// 10-11-2026 is wintertijd (UTC+1); 10-07-2026 zomertijd (UTC+2).
const nl = (dag, hhmm, ss = 0) => Date.parse(`${dag}T${hhmm}:${String(ss).padStart(2, '0')}+01:00`)
const om = '03:00'

test('nlMinuut volgt de NL-wandklok, ook in de zomertijd', () => {
  assert.equal(nlMinuut(Date.parse('2026-11-10T02:00:00Z')), 3 * 60)
  assert.equal(nlMinuut(Date.parse('2026-07-10T01:00:00Z')), 3 * 60)
})

test('gestart gisteren 10:00: om 03:00 herstarten, om 02:59 nog niet', () => {
  const startMs = nl('2026-11-09', '10:00')
  assert.equal(dagelijkseHerstartNu({ nuMs: nl('2026-11-10', '02:59', 59), startMs, om }), false)
  assert.equal(dagelijkseHerstartNu({ nuMs: nl('2026-11-10', '03:00', 5), startMs, om }), true)
  assert.equal(dagelijkseHerstartNu({ nuMs: nl('2026-11-10', '05:40'), startMs, om }), true, 'gemist (lange taak): alsnog')
})

test('na de herstart van 03:00 niet opnieuw, ook niet later die dag', () => {
  const startMs = nl('2026-11-10', '03:02')
  for (const t of ['03:05', '04:30', '12:00', '23:59']) assert.equal(dagelijkseHerstartNu({ nuMs: nl('2026-11-10', t), startMs, om }), false, t)
  assert.equal(dagelijkseHerstartNu({ nuMs: nl('2026-11-11', '03:00'), startMs, om }), true, 'de volgende nacht wel')
})

test('net vóór 03:00 gestart (na een crash): geen extra login, pas de nacht erna', () => {
  const startMs = nl('2026-11-10', '02:30')
  for (const t of ['03:00', '03:31', '12:00']) assert.equal(dagelijkseHerstartNu({ nuMs: nl('2026-11-10', t), startMs, om }), false, t)
  assert.equal(dagelijkseHerstartNu({ nuMs: nl('2026-11-11', '03:00'), startMs, om }), true)
})

test('onbruikbare tijd: nooit herstarten', () => {
  const startMs = nl('2026-11-09', '10:00')
  for (const o of ['', null, '3:00', 'nooit']) assert.equal(dagelijkseHerstartNu({ nuMs: nl('2026-11-10', '04:00'), startMs, om: o }), false, String(o))
})

test('standaard aan om 03:00, buiten de werktijd van OOM PD', () => {
  const cfg = mergeInstellingen({})
  assert.equal(cfg.dagelijkseHerstart, true)
  assert.equal(cfg.dagelijkseHerstartOm, '03:00')
  assert.ok(cfg.dagelijkseHerstartOm < cfg.ochtendVanaf, 'vóór de ochtendlezing')
})

// Het vangnet van de VPS (matransport worker/vps-server, POSTNL_SCRAPERS['postnl-sessie'].timeoutSec,
// 26 uur) moet ruim boven een dag liggen plus de langste afbouw, anders schiet het de dagelijkse
// herstart voor en valt het weer op een wisselend moment.
test('vangnet van de VPS ligt boven een dag plus de afbouw van de langste taak', () => {
  const VPS_TIMEOUT_SEC = 26 * 3600
  const cfg = mergeInstellingen({})
  assert.ok(VPS_TIMEOUT_SEC * 1000 > 24 * 3600_000 + 60 * 60_000 + waakhondMs(cfg))
})
