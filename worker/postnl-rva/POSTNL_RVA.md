# postnl-rva

Past de **vaste rijvolgorde per rit per weekdag** aan in RVA, de Route Volgorde Applicatie van PostNL (`https://pnl-rva.p15.cldsvc.net/`, één adres voor alle depots; welk depot je ziet hangt af van de login). Issue: floatops/matransport#569.

Afgesproken volgorde:
1. **Klaar (03-11):** alle handelingen uit de opnames kunnen uitvoeren en controleren (`src/`, `scripts/proef.mjs`, live getest).
2. **Gebouwd (03-11):** in de sessiehouder, met één browser per depot en twee tabbladen (OOM PD + RVA, dezelfde login), RVA 24/7, met een wachtrij (`rva_opdrachten` + edge function `rva-opdracht` in matransport). Zie `../postnl-sessie/POSTNL_SESSIE.md` § RVA. Nog te doen: de meting met `scripts/twee-tabs.mjs` na 23:00, dan aanzetten in de proefstand.
3. **Daarna:** het scherm voor chauffeurs in de app, met een **voortgangsbalk** tijdens het doorvoeren (afspraak eigenaar 03-11; `rva_opdrachten.stap` en `.voortgang` worden al live bijgewerkt).
4. **Gebouwd (04-11, matransport#573):** de app-kant. Nieuwe functies hier: `leesRitDag` (regels, onderbrekingen als regelsleutel, de laatste `REVISIES_MAX` revisies met regels, slot; wijzigt niets, ook geen achtergebleven bewerkstand), `kopieerNaar`, `revisieTerug`, `zetVerantwoordelijkenVeilig` (eigen account moet blijven), `leesRitten` (Rittenoverzicht → rijen voor `rva_ritten`, `plan.ritRijen`/`rittenTeSchrijven`) en `zorgVoorRechten`: **staat het eigen account niet als ritverantwoordelijke bij de rit, dan zet `voerUit` het er echt zelf bij** (keuze eigenaar 03-11) en opent de rit-dag opnieuw; in de proefstand fout `geen_rechten`.

## Hoe RVA werkt (vastgesteld op de opnames van 03-11)

- **Rittenoverzicht:** datagrid met per route **twee of drie rijen** (Den Hoorn: Ma en Di–Za; Waddinxveen: Ma, Di–Vr en Za, gezien 04-11). Per dag een klikbaar vak. Het **slotje** (een `img` in het tooltip-vak van de dag) betekent dat die rit-dag in bewerking is.
- **Pagina's (04-11):** het Rittenoverzicht toont **20 rijen per pagina** ("1 to 20 of 40") met een zoekveld (`input[aria-label="Zoeken"]`) en knoppen `Go to next page`/`Go to first page`. `leesAlleRitten` bladert alle pagina's door en laat het overzicht op pagina 1 achter; `overzichtRij` zoekt een rit die niet op de huidige pagina staat eerst met het zoekveld, anders pagina voor pagina. Tot 04-11 las de worker alleen pagina 1: de helft van de ritten ontbrak. **Blader op de paginastatus (`.paging-status`, `pagingStatus()`), niet op `isVisible` van de knop:** Mendix tekent de knoppen net ná de rijen, en de eerste versie zag ze daardoor nooit (trace `rvaWakker` 04-11).
- **Bewerken gaat op een kladversie.** Wijzig zet een slot op de rit-dag (`TripWeekday.IsLocked/LockedBy` = account) en begint vanaf de stand van nu. Elke handeling past de kladversie meteen aan bij PostNL. **Opslaan** maakt het definitief en een revisie (`Snapshot`). In de bewerkstand krijgen regels nieuwe guids: herken een regel aan zijn inhoud (`plan.regelSleutel`: postcode, straat, van, t/m, even/oneven).
- ⚠️ **Annuleer zet de LAATST OPGESLAGEN REVISIE terug, niet de stand van vlak voor Wijzig** (proef 03-11). PostNL haalt soms zelf adressen uit de lijst zonder een revisie te maken: bij de grote testrit stond op alle dagen een straat minder dan in de revisie van 15-09. Een Annuleer zette die straat op zaterdag terug. Daarom maakt `zorgVoorBasisRevisie()` vóór elke opdracht eerst Wijzig + Opslaan zonder wijziging als de stand van nu afwijkt van de actieve revisie. Dan zet een latere Annuleer precies de stand van nu terug. In de proefstand weigert de worker in dat geval (`revisie_wijkt_af`). Een revisie terugzetten die al actief is, doet niets.
- **Rechten:** alleen een account dat bij de rit als **Ritverantwoordelijke** staat, ziet de knop Wijzig. Welke namen dat zijn, verschilt per klant. Haal het eigen account daar dus nooit weg. Geen Wijzig-knop: fout `geen_rechten`.
- **Slot na een weggevallen tabblad:** het slot blijft staan, maar **hetzelfde account komt er weer in**, meteen in de bewerkstand, met de halve wijzigingen nog erin. Daarom doet `startWijzig()` dan eerst Annuleer. Het slot van een **ander** account: PostNL laat Wijzig niet toe. Dat is fout `vergrendeld`, niets doen (nog niet gezien met een tweede account).
- **Volgorde:** een nummer typen in het vak links (`.mx-name-textBox1 input`) en het vak verlaten. RVA verplaatst de regel en nummert de rest zelf opnieuw. Te hoog wordt de laatste plek, 0 de eerste. Slepen is niet nodig.
- **Richting:** klik op het label (`.mx-name-badge2`) wisselt Oplopend/Aflopend.
- **Knippen:** rechtsklik → "Knips maken" → venster "Adressen knippen": de t/m van de laatste regel aanpassen. PostNL maakt zelf de rest-regel (volgende nummer met dezelfde even/oneven, tot het oude eind). ↺ haalt een extra regel weg. Opslaan in het venster past alleen de kladversie aan.
- **Samenvoegen:** rechtsklik → "Knips samenvoegen" (of het schaartje, alleen zichtbaar bij een geknipte straat) → venster "Adressen samenvoegen" met alle delen van die straat en even/oneven, op huisnummer. **↓ voegt een deel samen met het deel eronder, ↑ met het deel erboven.** Het eerste deel heeft alleen ↓, het laatste alleen ↑.
- **Plaatsgebonden onderbreking:** rechtsklik → "Nieuwe plaatsgebonden onderbreking" → Minuten (keuzelijst-widget, geen `<select>`; de eerste keuze is 5) → Opslaan. Hetzelfde menu-item opent een bestaande onderbreking (met de minuten ingevuld); **Verwijder vraagt "Weet je het zeker?"** → Ja. **Een revisie bevat geen onderbrekingen**: terugzetten haalt er dus geen weg.
- **Kopieer weekdag:** schakelaar per dag (de checkbox is een verborgen `sr-only`-vak, klik op `[role="switch"]`) → "Kopiëren en opslaan" → venster "Informatie" → OK. **Slaat direct op**, en gaat over beide rijen van de route heen: kopiëren vanaf de Ma-rij overschrijft di–za van de andere rij.
- **Revisies:** lijst (gemaakt op als `dd-mm-jjjj hh:mm`, door, actief). Klokje → "Bevestiging" → Doorgaan zet die versie terug. Dit is de terugdraaiknop.
- **Ritverantwoordelijke** (keuzelijst in het Rittenoverzicht, meerdere namen): **elke klik slaat direct op.**
- **Excel export:** een download.

## Code

| Bestand | Wat |
|---|---|
| `src/scherm.js` | Alle selectors (`SCHERM`) en handelingen. Knoppen eerst op `data-button-id` (`p.PlanningData.TripWeekday_View_DnDNew.actionButton6` enz.), anders op tekst. Elke handeling loopt via `volgMendix(page).actie()` uit `postnl-planner/src/mendix.js`. |
| `src/lezen.js` | Puur: Mendix-antwoorden lezen (`regelsUit`, `ritDagUit`, `rittenUit`, `revisiesUit`, `onderbrekingenUit`). Bouwt op `credentials-shared/src/postnl/mendix.js`. |
| `src/plan.js` | Puur: `regelSleutel`, `zetOpPlek` (wat RVA doet bij een getypt nummer), `stappenVoorVolgorde`, `knipDelen`, `verschillen`, `revisieTijdTekst`. |
| `src/index.js` | `voerUit(page, mendix, opdracht, { echt })`: één rit-dag openen, Wijzig, de handelingen één voor één met controle, dan Opslaan (`echt`) of Annuleer. Een fout midden in een handeling: Annuleer, geen herhaling. |
| `scripts/proef.mjs` | De proefronde, zie hieronder. |

**Valkuilen in het scherm** (alle gezien in de proef van 03-11):
- `locator.filter({ hasText })` ziet de cellen van een datagrid-rij aan elkaar geplakt, zonder spatie ("…1276Even"). Zoek een rij dus op celwaarde onder de kolomkop (`samenvoegRij`, `leesRittenoverzicht`), niet met een regex over de rij.
- In een lange lijst valt een element na Playwrights eigen scrollen onder de vaste kopbalk: eerst naar het midden scrollen (`inBeeld`).
- In het Rittenoverzicht ligt het onzichtbare invoerveld van de keuzelijst Ritverantwoordelijke over het midden van het dagvak: klik op de tekst van de dag, en anders `dispatchEvent('click')`.
- Het kruisje van een Mendix-venster noemt Playwright "niet zichtbaar": geforceerd klikken, anders Escape.
- Direct na Annuleer/Opslaan tekent Mendix bij een lange rit eerst lege regels: `leesRegels` wacht tot elke regel een straat heeft.

**Publieke repo:** geen ritnamen, adressen of namen in code, tests of logs. De logs noemen alleen "regel N" en tellingen. De testritten staan in matransport#569.

## Proef

```bash
cd worker/postnl-rva && npm install && npm test
node scripts/proef.mjs --klein "<ritnaam>" --groot "<ritnaam>" --dag Za          # proefstand: alles Annuleer
node scripts/proef.mjs --klein "<ritnaam>" --groot "<ritnaam>" --dag Za --echt   # opslaan + terugzetten
```

- Er opent een zichtbare browser. **Je logt zelf in** (vijf minuten de tijd). Daarna loopt alles vanzelf. Draai buiten werktijd (na 23:00).
- **Proefstand:** volgorde (ook 0 en te hoog), richting, slot (Wijzig → herladen → opnieuw openen → bewerkstand → Annuleer), knippen + samenvoegen, onderbreking, Excel export. Alles eindigt met Annuleer. Kopieer weekdag en verantwoordelijke worden alleen gelezen, want die slaan direct op.
- **`--echt`:** hetzelfde, maar met Opslaan. Daarna zet de proef de **revisie die vóór de proef actief was** terug en vergelijkt hij met het begin. De onderbreking haalt hij apart weg. Verantwoordelijke: één naam weg en weer terug. Kopieer weekdag: alleen als Ma en de testdag nu al gelijk zijn (anders overgeslagen).
- De uitkomst staat in `opnames/<tijd>/uitslag.json`, met video en `trace.zip` (`npx playwright show-trace`). Die map staat in `.gitignore`: hij bevat adressen.

Eén losse handeling (bv. om iets te herstellen): `node scripts/handeling.mjs --rit "<ritnaam>" --dag Za --soort onderbreking_weg --regel 2 --echt`.

Meting **één login, twee tabbladen** (zoals in de sessiehouder): `node scripts/twee-tabs.mjs --oompd "<portaal-URL>" --rit "<ritnaam>" --dag Za --minuten 30`. Elke minuut leest hij in beide tabbladen, en kijkt dan of OOM PD op de startpagina of loginpagina staat, of RVA op de loginpagina. ⚠️ Alleen als de sessiehouder van dat depot niet draait (na 23:00): anders is het een tweede OOM PD-sessie, en die gooit de sessiehouder er wél uit.

## Stand

- **03-11, live proef (Den Hoorn, dag Za, 16:59–17:35):** proefstand helemaal geslaagd. Echte ronde: 17 van 19 geslaagd. Volgorde (ook 0 en te hoog), richting, revisie terugzetten, slot (slotje → bewerkstand → Annuleer), knippen + samenvoegen, onderbreking toevoegen, Excel export en ritverantwoordelijke (andere naam weg en terug) werkten. Mislukt: onderbreking weghalen (de bevestigingsvraag, nu opgevangen) en kopieer weekdag (verborgen checkbox, nu de schakelaar; er is niets gekopieerd).
- **Daarna (zelfde dag):** **kopieer weekdag werkt live** (Vr → Za, "De volgende weekdagen zijn succesvol gekopieerd: Zaterdag"; alleen Za veranderd). Zo is ook de straat die een Annuleer had teruggezet weer weg: vrijdag was gelijk aan zaterdag zonder die regel. **Een regel weghalen kan in RVA alleen zo**: een gelijke dag eroverheen kopiëren. De testonderbreking bleek al weg (het venster na de regel opende leeg); `verwijderOnderbreking` weigert nu als er geen onderbreking staat. Verwijder + "Weet je het zeker? → Ja" is dus nog niet live gezien.
- **RVA naast OOM PD met dezelfde login:** tijdens de proef draaide de sessiehouder op de VPS met dezelfde Den Hoorn-login in OOM PD. Volgens `postnl_sessies` gaf dat geen enkele "gegooid" (de drie onderbrekingen waren Chromium-crashes op de VPS, ook bij Waddinxveen). Voorlopige conclusie: een RVA-sessie gooit OOM PD er niet uit. Volgende stap: RVA als taak in de sessiehouder, in een tweede tabblad van dezelfde sessie (afgestemd in #562).
- Nog niet gezien: wat PostNL toont bij een slot van een ander account.
