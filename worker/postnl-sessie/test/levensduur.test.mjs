// node --test — welke metingen tellen voor de levensduur (floatops/matransport#598).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { levensdurenUit, METING_VANAF } from '../src/opslag.js'

const sessie = (ingelogd, einde, reden, gebeurtenissen = []) => ({ ingelogd_at: ingelogd, einde_at: einde, einde_reden: reden, gebeurtenissen })

test('levensdurenUit: de twee "metingen" van 04/05-11 tellen niet (van vóór de vastlegging van fouten 460)', () => {
  const rijen = [
    sessie('2026-11-04T11:02:00Z', '2026-11-04T11:51:26Z', 'verlopen', [{ at: '2026-11-04T11:51:26Z', soort: 'verlopen', fout: 'Taak ritmonitor duurde langer dan 150 s' }]),
    sessie('2026-11-05T11:40:00Z', '2026-11-05T14:09:46Z', 'verlopen', [{ at: '2026-11-05T14:08:40Z', soort: 'verlopen', fout: 'Planning-menu niet zichtbaar na 90s' }]),
  ]
  assert.ok(METING_VANAF > '2026-11-05T23:00:00Z')
  assert.deepEqual(levensdurenUit(rijen), [])
})

test('levensdurenUit: een zuivere verlopen sessie telt, met een storing in het half uur ervoor niet', () => {
  const zuiver = sessie('2026-11-07T05:00:00Z', '2026-11-07T15:00:00Z', 'verlopen', [{ at: '2026-11-07T15:00:00Z', soort: 'verlopen', fout: 'Planning-menu niet zichtbaar' }])
  const na460 = sessie('2026-11-07T05:00:00Z', '2026-11-07T08:00:00Z', 'verlopen', [{ at: '2026-11-07T07:45:00Z', soort: 'herlogin' }, { at: '2026-11-07T08:00:00Z', soort: 'verlopen' }])
  const herloginsVoor = sessie('2026-11-07T05:00:00Z', '2026-11-07T09:00:00Z', 'verlopen', [{ at: '2026-11-07T09:00:00Z', soort: 'verlopen', herlogins: 4 }])
  const vastgelopen = sessie('2026-11-07T05:00:00Z', '2026-11-07T06:00:00Z', 'verlopen', [{ at: '2026-11-07T06:00:00Z', soort: 'verlopen', fout: 'Taak ritmonitor duurde langer dan 150 s' }])
  const langGeleden = sessie('2026-11-07T05:00:00Z', '2026-11-07T12:00:00Z', 'verlopen', [{ at: '2026-11-07T09:00:00Z', soort: 'gegooid' }, { at: '2026-11-07T12:00:00Z', soort: 'verlopen' }])
  assert.deepEqual(levensdurenUit([zuiver, na460, herloginsVoor, vastgelopen, langGeleden]), [600, 420])
})

test('levensdurenUit: verloop binnen een sessie (sessie_verlopen) telt alleen zonder fouten 460', () => {
  const r = sessie('2026-11-07T05:00:00Z', null, null, [
    { at: '2026-11-07T10:00:00Z', soort: 'sessie_verlopen', tab: 'oompd', duurMin: 300 },
    { at: '2026-11-07T14:00:00Z', soort: 'sessie_verlopen', tab: 'oompd', duurMin: 240, herlogins: 2 },
    { at: '2026-11-07T15:00:00Z', soort: 'sessie_verlopen', tab: 'rva', duurMin: 60 },
  ])
  assert.deepEqual(levensdurenUit([r]), [300])
})
