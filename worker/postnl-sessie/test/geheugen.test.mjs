// node --test — geheugenwacht van de sessiehouder (floatops/matransport#578).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beoordeelGeheugen, beoordeelTotaal, geheugenTekst, kinderenVan, ouderUitStat, pssMbUit } from '../src/geheugen.js'
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

test('totaal met browsers: grens hangt aan het aantal depots (#600)', () => {
  assert.equal(beoordeelTotaal({ totaalMb: 4300, depots: 2, cfg }), 'ok')
  assert.equal(beoordeelTotaal({ totaalMb: 3600, depots: 1, cfg }), 'waarschuwen')
  assert.equal(beoordeelTotaal({ totaalMb: 3600, depots: 1, cfg, gewaarschuwd: true }), 'ok')
  assert.equal(beoordeelTotaal({ totaalMb: 7500, depots: 2, cfg, gewaarschuwd: true }), 'herstarten')
  assert.equal(beoordeelTotaal({ totaalMb: undefined, depots: 2, cfg }), 'ok', 'geen /proc: niets doen')
})

test('ouderUitStat: ook met spaties en haakjes in de procesnaam', () => {
  assert.equal(ouderUitStat('123 (chrome) S 42 123 0'), 42)
  assert.equal(ouderUitStat('123 (a (b) c) S 7 123 0'), 7)
})

test('kinderenVan: ook de kleinkinderen van de browser, niet de rest van de VPS', () => {
  const rijen = [{ pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 3 }, { pid: 5, ppid: 1 }, { pid: 6, ppid: 99 }]
  assert.deepEqual([...kinderenVan(2, rijen)].sort(), [3, 4])
})

test('pssMbUit leest smaps_rollup', () => {
  assert.equal(pssMbUit('Rss:   2048 kB\nPss:   1024 kB\nPss_Dirty:  5 kB\n'), 1)
  assert.equal(pssMbUit(''), null)
})

test('geheugenTekst noemt totaal, werkmap en schijf als die er zijn', () => {
  const t = geheugenTekst({ heapMb: 200, limietMb: 4288, rssMb: 1800, totaal: { totaalMb: 2700, procesMb: 1800, browsersMb: 900 }, werkMapMb: 12, vrijGb: 357 })
  assert.match(t, /totaal 2700 MB \(proces 1800, browsers 900\), werkmap 12 MB, schijf vrij 357 GB/)
})
