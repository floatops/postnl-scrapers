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

// ---- Verdeling (matransport#668) ----
import { compact, depotUitCmdline, geheugenBestand, maakGeheugenLog, metGrens, nodeDelen, soortUitCmdline, verdeel, verdelingTekst, verschilTaak } from '../src/geheugen.js'
import { maakRapport } from '../src/geheugenRapport.js'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const cmd = (...a) => a.join('\0') + '\0'
const CHROME = '/root/.cache/ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell'

test('soortUitCmdline herkent de Chromium-processen en ffmpeg', () => {
  assert.equal(soortUitCmdline(cmd(CHROME, '--disable-dev-shm-usage', '--floatops-depot=waddinxveen')), 'browser')
  assert.equal(soortUitCmdline(cmd(CHROME, '--type=renderer', '--lang=nl')), 'tabblad')
  assert.equal(soortUitCmdline(cmd(CHROME, '--type=gpu-process')), 'gpu')
  assert.equal(soortUitCmdline(cmd(CHROME, '--type=utility', '--utility-sub-type=network.mojom.NetworkService')), 'hulp')
  assert.equal(soortUitCmdline(cmd(CHROME, '--type=zygote')), 'zygote')
  assert.equal(soortUitCmdline(cmd('/root/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux', '-f', 'image2pipe')), 'video')
  assert.equal(soortUitCmdline(''), 'overig')
})

test('depotUitCmdline leest het merk van sessie.js', () => {
  assert.equal(depotUitCmdline(cmd(CHROME, '--floatops-depot=den-hoorn')), 'den-hoorn')
  assert.equal(depotUitCmdline(cmd(CHROME, '--type=renderer')), null)
})

test('verdeel: renderers onder de zygote tellen bij de browser van hun depot, ffmpeg apart', () => {
  const node = 100
  const rijen = [
    { pid: 200, ppid: node, cmdline: cmd(CHROME, '--floatops-depot=waddinxveen'), pssMb: 150 },
    { pid: 201, ppid: 200, cmdline: cmd(CHROME, '--type=zygote'), pssMb: 5 },
    { pid: 202, ppid: 201, cmdline: cmd(CHROME, '--type=renderer'), pssMb: 600 },
    { pid: 203, ppid: 201, cmdline: cmd(CHROME, '--type=renderer'), pssMb: 300.4 },
    { pid: 204, ppid: 200, cmdline: cmd(CHROME, '--type=gpu-process'), pssMb: 80 },
    { pid: 300, ppid: node, cmdline: cmd(CHROME, '--floatops-depot=den-hoorn'), pssMb: 120 },
    { pid: 301, ppid: 300, cmdline: cmd(CHROME, '--type=renderer'), pssMb: 400 },
    { pid: 400, ppid: node, cmdline: cmd('/x/ffmpeg-linux', '-y'), pssMb: 40 },
    { pid: 500, ppid: node, cmdline: cmd('/usr/bin/git', 'rev-parse'), pssMb: 3 },
  ]
  const v = verdeel(node, rijen)
  assert.deepEqual(v.browsers.waddinxveen, { totaalMb: 1135, tabbladen: 2, browser: 150, tabblad: 900, gpu: 80, hulp: 0, zygote: 5, overig: 0 })
  assert.equal(v.browsers['den-hoorn'].totaalMb, 520)
  assert.equal(v.videoMb, 40)
  assert.equal(v.overigMb, 3)
})

test('browser zonder merk (oude code, losse browser): telt als overig, niet bij een depot', () => {
  const v = verdeel(1, [{ pid: 2, ppid: 1, cmdline: cmd(CHROME), pssMb: 100 }, { pid: 3, ppid: 2, cmdline: cmd(CHROME, '--type=renderer'), pssMb: 50 }])
  assert.deepEqual(v.browsers, {})
  assert.equal(v.overigMb, 150)
})

test('nodeDelen: buiten V8 = rss min de V8-heap', () => {
  const MB = 1048576
  assert.deepEqual(nodeDelen({ heapUsed: 200 * MB, heapTotal: 260 * MB, external: 30 * MB, arrayBuffers: 20 * MB, rss: 1800 * MB }), { heapMb: 200, heapTotaalMb: 260, externMb: 30, buffersMb: 20, rssMb: 1800, buitenV8Mb: 1540 })
})

test('verschilTaak: per depot de browser, het proces gedeeld', () => {
  const voor = { totaalMb: 2000, procesMb: 1500, node: { heapMb: 200 }, browsers: { waddinxveen: { totaalMb: 400, tabblad: 250 } } }
  const na = { totaalMb: 2600, procesMb: 1600, node: { heapMb: 260 }, browsers: { waddinxveen: { totaalMb: 900, tabblad: 700 }, 'den-hoorn': { totaalMb: 50, tabblad: 0 } } }
  assert.deepEqual(verschilTaak(voor, na, 'waddinxveen'), { totaalMb: 600, procesMb: 100, heapMb: 60, browserMb: 500, tabbladMb: 450 })
  assert.equal(verschilTaak(voor, na, 'den-hoorn').browserMb, 50, 'nieuwe browser (login) telt vanaf 0')
  assert.equal(verschilTaak(null, na, 'x'), null)
})

test('geheugenTekst noemt de verdeling per browser als die er is', () => {
  const totaal = { totaalMb: 2700, procesMb: 1800, browsersMb: 900, videoMb: 30, node: { heapMb: 200, heapTotaalMb: 260, buitenV8Mb: 1540, buffersMb: 20 }, browsers: { waddinxveen: { totaalMb: 900, tabbladen: 2, tabblad: 700, gpu: 80, browser: 100, hulp: 15, zygote: 5, overig: 0 } } }
  const t = geheugenTekst({ heapMb: 200, limietMb: 4288, rssMb: 1800, totaal })
  assert.match(t, /proces: heap 200\/260, buiten V8 1540 \(buffers 20\); browser waddinxveen 900 \(tabbladen 2x 700, gpu 80, hoofd 100, hulp 20\); video 30/)
  assert.equal(verdelingTekst(null), '')
  assert.deepEqual(Object.keys(compact(totaal)).sort(), ['browsers', 'browsersMb', 'node', 'overigMb', 'procesMb', 'totaalMb', 'videoMb'])
})

test('metGrens: een meting die hangt of faalt geeft null, nooit een wachtende taak', async () => {
  assert.equal(await metGrens(new Promise(() => {}), 20), null)
  assert.equal(await metGrens(Promise.reject(new Error('x')), 20), null)
  assert.equal(await metGrens(Promise.resolve(5), 20), 5)
})

test('dagbestand: één regel JSON per meting, naam per klant en NL-dag; zonder map niets', async () => {
  const map = await fsp.mkdtemp(path.join(os.tmpdir(), 'geheugen-'))
  assert.equal(path.basename(geheugenBestand(map, '46064b3a-aaaa', Date.parse('2026-11-10T23:30:00Z'))), 'geheugen-46064b3a-2026-11-11.jsonl')
  const schrijf = maakGeheugenLog({ map, klantId: '46064b3a-aaaa', log: { warn() {} } })
  await schrijf({ soort: 'minuut', totaalMb: 1 })
  await schrijf({ soort: 'minuut', totaalMb: 2 })
  const regels = (await fsp.readFile(geheugenBestand(map, '46064b3a-aaaa'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(regels.map(r => r.totaalMb), [1, 2])
  await maakGeheugenLog({ map: null, klantId: 'x' })({ soort: 'minuut' })
  await fsp.rm(map, { recursive: true, force: true })
})

test('rapport: per uur, per taak (som van de verschillen) en de grootste sprongen', () => {
  const regels = [
    { t: '2026-11-11T05:00:00Z', soort: 'minuut', totaalMb: 2000, procesMb: 1500, node: { heapMb: 200, buitenV8Mb: 1200 }, browsers: { w: { totaalMb: 500, tabblad: 300, tabbladen: 2, gpu: 50 } } },
    { t: '2026-11-11T05:30:00Z', soort: 'minuut', totaalMb: 3000, procesMb: 1700, node: { heapMb: 300, buitenV8Mb: 1300 }, browsers: { w: { totaalMb: 1300, tabblad: 1000, tabbladen: 2, gpu: 60 } } },
    { t: '2026-11-11T05:10:00Z', soort: 'taak', depot: 'w', taak: 'plannen', duurMs: 60000, verschil: { totaalMb: 700, browserMb: 600, tabbladMb: 550, procesMb: 100 }, na: { totaalMb: 2700 } },
    { t: '2026-11-11T05:20:00Z', soort: 'taak', depot: 'w', taak: 'plannen', duurMs: 30000, verschil: { totaalMb: 100, browserMb: 80, tabbladMb: 80, procesMb: 20 }, na: { totaalMb: 2800 } },
    { t: '2026-11-11T05:25:00Z', soort: 'taak', depot: 'w', taak: 'ritmonitor', duurMs: 5000, login: true, verschil: { totaalMb: -50, browserMb: -50, tabbladMb: -50, procesMb: 0 }, na: { totaalMb: 2750 } },
  ]
  const r = maakRapport(regels)
  assert.equal(r.uren.length, 1)
  assert.equal(r.uren[0].uur, '2026-11-11 06:00')
  assert.equal(r.uren[0].totaalMaxMb, 3000)
  assert.deepEqual(r.uren[0].browsers.w, { maxMb: 1300, tabbladMaxMb: 1000, tabbladenMax: 2, gpuMaxMb: 60 })
  assert.deepEqual(r.taken.map(t => [t.taak, t.aantal, t.somMb, t.maxMb]), [['plannen', 2, 800, 700], ['ritmonitor', 1, -50, -50]])
  assert.equal(r.taken[1].metLogin, 1)
  assert.deepEqual(r.sprongen.map(s => s.totaalMb), [700, 100, -50])
})
