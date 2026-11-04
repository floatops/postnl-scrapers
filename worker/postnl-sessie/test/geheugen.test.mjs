// node --test — geheugenwacht van de sessiehouder (floatops/matransport#578).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beoordeelGeheugen, geheugenTekst } from '../src/geheugen.js'
import { mergeInstellingen } from '../src/instellingen.js'

const cfg = mergeInstellingen({})
const limietMb = 4288 // gemeten op de VPS (Node 24), 04-11

test('normaal gebruik (zoals na de fix van 04-11, ~650 MB): niets doen', () => {
  assert.equal(beoordeelGeheugen({ heapMb: 500, limietMb, cfg }), 'ok')
})

test('boven de waarschuwgrens: één keer melden, daarna niet opnieuw', () => {
  assert.equal(beoordeelGeheugen({ heapMb: 1600, limietMb, cfg }), 'waarschuwen')
  assert.equal(beoordeelGeheugen({ heapMb: 1600, limietMb, cfg, gewaarschuwd: true }), 'ok')
})

test('boven de herstartgrens: herstarten, ruim vóór de crash van 04-11 bij ~3,3 GB', () => {
  assert.equal(beoordeelGeheugen({ heapMb: 2200, limietMb, cfg, gewaarschuwd: true }), 'herstarten')
  assert.ok(cfg.geheugenHerstartDeel * limietMb < 3300 * 0.7, 'herstart ruim vóór de crashgrens: de lopende taak mag nog afmaken')
})

test('zonder bruikbare meting: nooit herstarten', () => {
  assert.equal(beoordeelGeheugen({ heapMb: NaN, limietMb, cfg }), 'ok')
  assert.equal(beoordeelGeheugen({ heapMb: 3000, limietMb: 0, cfg }), 'ok')
})

test('logtekst zonder namen, alleen getallen', () => {
  assert.equal(geheugenTekst({ heapMb: 410.4, limietMb: 4144, rssMb: 652.6 }), 'heap 410 MB van 4144 MB (10%), rss 653 MB')
})
