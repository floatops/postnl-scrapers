// De knop-checks van de rit-dag, met een nagemaakte pagina: welke knoppen staan in beeld.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inBewerkstand, magWijzigen, revisieRijenGeladen, wachtOpVolleLijst } from '../src/scherm.js'

// Een pagina waarop alleen de knoppen met deze teksten zichtbaar zijn. knop() zoekt op
// data-button-id óf op de knoptekst; de nep-locator kijkt alleen naar de tekst.
function pagina(...zichtbaar) {
  const loc = (naam) => ({ or: () => loc(naam), first: () => loc(naam), isVisible: async () => zichtbaar.includes(naam) })
  return {
    locator: (selector) => loc(/actionButton2"/.test(selector) ? 'Opslaan' : /actionButton6"/.test(selector) ? 'Wijzig' : /actionButton5"/.test(selector) ? 'Annuleer' : selector),
    getByRole: (_rol, { name }) => loc(name),
  }
}

test('inBewerkstand: geen knoppen (geen ritverantwoordelijke) is géén bewerkstand (matransport#589)', async () => {
  assert.equal(await inBewerkstand(pagina()), false)
})

test('inBewerkstand: alleen Wijzig = gewone stand, Opslaan zonder Wijzig = bewerkstand', async () => {
  assert.equal(await inBewerkstand(pagina('Wijzig')), false)
  assert.equal(await inBewerkstand(pagina('Opslaan', 'Annuleer')), true)
})

test('magWijzigen: zonder knoppen nee, dan voegt zorgVoorRechten het account toe (matransport#589)', async () => {
  assert.equal(await magWijzigen(pagina()), false)
  assert.equal(await magWijzigen(pagina('Wijzig')), true)
  assert.equal(await magWijzigen(pagina('Opslaan', 'Annuleer')), true)
})

// Het venster Revisies: per poging de paginastatus en of er een rij in beeld is.
function revisieVenster(standen) {
  let i = 0
  const nu = () => standen[Math.min(i, standen.length - 1)]
  const v = {
    locator: (sel) => ({
      first: () => ({
        isVisible: async () => sel.includes('gridcell') && nu().rij,
        innerText: async () => nu().status,
      }),
    }),
  }
  const page = { waitForTimeout: async () => { i++ } }
  return { v, page }
}

test('revisieRijenGeladen: lege lijst ("0 to 0 of 0") is geen fout (matransport#589)', async () => {
  const { v, page } = revisieVenster([{ status: '0 to 0 of 0', rij: false }])
  assert.equal(await revisieRijenGeladen(page, v, { stilMs: 0 }), false)
})

test('revisieRijenGeladen: eerst nog laden, dan rijen', async () => {
  const { v, page } = revisieVenster([{ status: '', rij: false }, { status: '0 to 0 of 0', rij: false }, { status: '1 to 3 of 3', rij: true }])
  assert.equal(await revisieRijenGeladen(page, v, { stilMs: 60_000 }), true)
})

test('revisieRijenGeladen: niets en geen status = fout na de tijdslimiet', async () => {
  const { v, page } = revisieVenster([{ status: '', rij: false }])
  await assert.rejects(revisieRijenGeladen(page, v, { ms: 50 }), /revisielijst laadde niet/)
})

test('wachtOpVolleLijst: wacht tot de dagen er staan en het aantal stil blijft (#601: 06-11 07:02)', async () => {
  const stand = [0, 0, 0, 2, 2, 5]
  let i = 0
  const rijen = { count: async () => stand[Math.min(i++, stand.length - 1)] }
  assert.equal(await wachtOpVolleLijst(rijen, { ms: 2000, stilMs: 40, stapMs: 5 }), 5, 'niet stoppen bij de eerste rijen')
})

test('wachtOpVolleLijst: komt er niets, dan 0 binnen de grens', async () => {
  const begin = Date.now()
  assert.equal(await wachtOpVolleLijst({ count: async () => 0 }, { ms: 60, stilMs: 20, stapMs: 5 }), 0)
  assert.ok(Date.now() - begin < 1000)
})

test('wachtOpVolleLijst: met een verwacht aantal meteen klaar, zonder op stilte te wachten', async () => {
  const begin = Date.now()
  assert.equal(await wachtOpVolleLijst({ count: async () => 5 }, { verwacht: 5, stilMs: 5000 }), 5)
  assert.ok(Date.now() - begin < 1000)
})
