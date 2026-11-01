# postnl-planner

Leest de Dagplanning van OOM PD Process en verplaatst stops tussen ritten, voor de tab Plannen in FloatOps (floatops/matransport#557). De database, de edge function `planning-taak` en het scherm staan in `floatops/matransport`, zie `src/pages/Plannen/PLANNEN_ARCHITECTUUR.md`.

## Hoe hij start

De app maakt een rij in `planning_taken`; `planning-taak` roept `POST /run/postnl-planner` op de VPS aan met `{klant_id}`. De worker pakt alle opdrachten met status `wacht` van die klant en werkt ze af. Per klant loopt er één opdracht (unieke index).

## Proefstand: `PLANNER_ECHT`

**Echt verplaatsen gebeurt alleen met `PLANNER_ECHT=ja` in de omgeving van de worker.** Zonder die instelling selecteert hij de stops, controleert hij alles, stopt hij vóór de dubbelklik en zet hij de verplaatsing op `overgeslagen` met de melding "Proefstand". Zet hem pas aan nadat een geslaagde verplaatsing op een toestel is gezien en op de opname is nagekeken.

## De handeling in PostNL

1. Dag kiezen, shift links kiezen, rit links kiezen.
2. Postcodes op **Nee**. Die keuze staat nooit in de app.
3. Stops selecteren in de tabel.
4. Rechts de shift kiezen en de doelrit **dubbelklikken** (geen slepen).
5. PostNL voert het uit als achtergrondtaak en geeft eventueel een melding terug.

## Schermnamen (`src/mendix.js`)

| Onderdeel | Selector |
|---|---|
| Dag | `select.form-control` |
| Shifts / ritten links | `.mx-name-Shift_Grid_1` / `.mx-name-Rit_Grid` |
| Shifts / ritten rechts (doel) | `.mx-name-Shift_Grid2` / `.mx-name-Rit_Grid1` |
| Postcodes Nee | `div.mx-name-radioButtons1 input[value="false"]` |
| Stoptabel | `.mx-name-dataGrid21`, rijen `.widget-datagrid-grid-body [role="row"]`, cel `[data-position="kolom,rij"]` |
| Geselecteerd | `aria-selected="true"` op de rij |

## Lezen uit de antwoorden, niet uit het scherm

Mendix stuurt alles naar `/xas/`. Herken data aan `objectType`, **nooit aan `operationId`**: die code verandert bij een PostNL-release. Valkuilen:

- Stops komen binnen in **`partialObjects`**, andere objecten in `objects` of `mxobjects`.
- Sommige waarden staan alleen in **`changes[guid]`**, het object zelf heeft dan `null`.
- De stoplijst heeft `amount: 500`; `hasMoreItems` is nog nooit waar gezien.

## Timing

Vanaf **ongeveer 05:30** staat de nieuwe dag in PostNL. Tot de deadline kan PostNL nog adressen toevoegen, dus: wat in FloatOps staat kan verouderd zijn, en rijnummers zijn niet vast. Daarom leest de worker vlak voor elke verplaatsing opnieuw, en zoekt hij rijen altijd op tijd + adres. De ritmonitor start pas om 08:00 en de dagplanning-scraper om 07:00, dus het sessie-slot is in dit tijdvak meestal vrij.

## Deadline

De tekst "Ritten kunnen tot HH:MM uur worden aangepast." op de pagina is de officiële bron en verschilt per shift. **Nooit zelf berekenen.**

## Veiligheid bij schrijven

- **Geen sessie-slot = niet doorvoeren.** Lezen gaat na het wachten door zonder slot; schrijven stopt, en de concepten blijven staan.
- **Vóór de dubbelklik:** opnieuw lezen of de stops nog in de bronrit zitten, doelrit niet geautoriseerd, deadline niet voorbij, en `aria-selected` staat op precies de bedoelde rijen.
- **Rij zoeken op tijd + adres.** De rijen hebben geen id. Staat dezelfde sleutel dubbel in de tabel, dan weigert de worker.
- **Selecteren vergrendelt stops bij PostNL** (`OperationalPlanning.Lock`). Aan het eind meldt de worker zich af.
- **Dialogen alleen met het kruisje sluiten**, nooit met de hoofdknop: die kan een bevestigingsvraag met ja beantwoorden.
- **Geen automatische herhaling** na een fout tijdens een verplaatsing. De dubbelklik kan al gegeven zijn.
- **Controle achteraf op adres**, niet op `StopID`: daar zit het ritnummer in, dus die kan veranderen.

## Chauffeur wisselen

De keuzelijst `.mx-name-referenceSelector1 select` bij de open rit. Bij een geautoriseerde rit staat hij op slot (`disabled`): de worker volgt wat het scherm toestaat, niet het attribuut `AllowDriverChange` (dat staat ook bij geautoriseerde ritten op true). Na een gelukte wissel werkt de worker meteen `ritten.postnl_chauffeur` en `chauffeur_id` bij, zodat de Ritten-pagina niet tot de volgende sync achterloopt. Een met de hand gekozen chauffeur eindigt dan via de trigger `rit_chauffeur_handmatig`.

## Terugzoeken

De video van een doorvoer blijft 30 dagen staan (`fout/{depot}-doorvoeren-{tijdstip}.webm`), ook als alles goed ging. In `worker_run_log` staat per run hoeveel wijzigingen gelukt, mislukt of overgeslagen zijn. Log geen adressen of namen: deze uitvoer staat op de VPS.

## Nog vast te stellen op een echte opname

Een geslaagde verplaatsing en chauffeurwissel zijn nog niet gezien. Open: of de keuzelijst direct opslaat, of een losse klik selectie toevoegt of vervangt (de code probeert daarom klik en daarna Ctrl), of er een bevestigingsvraag komt, wat er met vergrendelingen gebeurt en of de `StopID` wijzigt. Ook: de kop toont soms meer stops dan de lijst (111 tegenover 107).
