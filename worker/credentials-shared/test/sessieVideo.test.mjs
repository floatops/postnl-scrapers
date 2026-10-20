// node --test — paden en opruimregel van de sessie-video's (floatops/matransport#360).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { depotSlug, nlTijdstempel, latestPad, foutPad, teOudeFoutVideos } from '../src/sessieVideo.js'

test('tijdstempel is NL-tijd, ook rond de wintertijd', () => {
  assert.equal(nlTijdstempel(new Date('2026-10-20T13:32:01Z')), '2026-10-20_15-32-01') // CEST
  assert.equal(nlTijdstempel(new Date('2026-11-02T13:32:01Z')), '2026-11-02_14-32-01') // CET
})

test('paden: latest blijft gelijk, foutvideo is uniek per tijdstip', () => {
  assert.equal(depotSlug('Den Hoorn'), 'den-hoorn')
  assert.equal(latestPad('k1', 'postnl-ritmonitor', 'Den Hoorn'), 'k1/postnl-ritmonitor/den-hoorn-latest.webm')
  assert.equal(foutPad('k1', 'postnl-ritmonitor', 'Waddinxveen', new Date('2026-10-20T13:32:01Z')),
    'k1/postnl-ritmonitor/fout/waddinxveen-2026-10-20_15-32-01.webm')
  assert.equal(foutPad('k1', 'postnl-depot-url', 'Den Hoorn', new Date('2026-10-20T13:32:01Z'), '-tab2'),
    'k1/postnl-depot-url/fout/den-hoorn-tab2-2026-10-20_15-32-01.webm')
})

test('alleen foutvideo\'s ouder dan de bewaartermijn worden opgeruimd', () => {
  const nu = new Date('2026-10-20T12:00:00Z')
  const namen = [
    'waddinxveen-2026-09-19_10-00-00.webm', // 31 dagen: weg
    'waddinxveen-2026-09-21_10-00-00.webm', // 29 dagen: blijft
    'den-hoorn-tab1-2026-08-01_08-00-00.webm', // weg
    'iets-anders.webm',                       // geen tijdstempel: blijft
  ]
  assert.deepEqual(teOudeFoutVideos(namen, nu, 30),
    ['waddinxveen-2026-09-19_10-00-00.webm', 'den-hoorn-tab1-2026-08-01_08-00-00.webm'])
})
