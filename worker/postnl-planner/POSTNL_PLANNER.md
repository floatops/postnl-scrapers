# postnl-planner

Leest de Dagplanning van OOM PD Process en verplaatst stops tussen ritten, voor de tab Plannen in FloatOps (floatops/matransport#557). De database, de edge function `planning-taak` en het scherm staan in `floatops/matransport`, zie `src/pages/Plannen/PLANNEN_ARCHITECTUUR.md`.

## Hoe hij start

De app maakt een rij in `planning_taken`; `planning-taak` roept `POST /run/postnl-planner` op de VPS aan met `{klant_id}`. Per klant loopt er één opdracht (unieke index).

- **Draait de sessiehouder** (`postnl-sessie`, floatops/matransport#562): de VPS wekt hem en hij voert de opdracht binnen een seconde uit **in zijn open PostNL-sessie**. Hij importeert `verwerk(taak, { metSessie })` uit `src/index.js` en geeft zijn eigen pagina mee: geen tweede login, geen uitloggen, geen eigen slot. De logica hieronder is dezelfde.
- **Anders** (vóór 05:25, na 23:00, zondag, uitval, of na 2 min niet opgepakt) start de VPS dit script: eigen browser, sessie-slot, inloggen, uitloggen. Het pakt alle opdrachten met status `wacht` van die klant en werkt ze af.
- **Alleen verschillen schrijven** (`verschil` in `src/logica.js`, #562): `planning_ritten` en `planning_stops` krijgen alleen nieuwe en gewijzigde rijen (inhoud vergeleken, niet `opgehaald_at`), en verwijderd wordt alleen wat in de gelezen ritten niet meer staat. `planning_stops` altijd in stukken lezen: een antwoord is hooguit 1000 rijen en een shift heeft er ruim 2000 (#600). Na de autorisatie leest de sessiehouder de hele shift nog één keer (`naDeadline`); een lege rit of shift geldt dan als mislukte lezing. Wanneer een shift voor het laatst gecontroleerd is, staat in `planning_versheid` (`ritten_om`, `stops_om`). De sessiehouder ververst zo de Plannen-tab vanzelf (`verversPlanning`, alleen ritten vóór hun deadline).
- **Postcode per stop** (matransport#587): `stopNaarRij` bewaart ook `PostalCode` als `postcode` (zonder spatie, hoofdletters), voor de stops op de kaart van een rit. Het stopobject heeft geen coördinaten (trace van 04-11 nagelopen). Op een stack zonder de kolom (Stack B tot de promotie van de migratie) slaat `stopVelden()` hem over; die kijkt één keer per proces, en alleen fout 42703 ("kolom bestaat niet") telt. Daarna kan die controle eruit.
- Dubbel uitvoeren kan niet: `verwerk` pakt een opdracht alleen op zolang hij op `wacht` staat (compare-and-set).

## Proefstand: `PLANNER_ECHT`

**Alleen binnen dezelfde shift** (regel eigenaar 03-11): een verplaatsing naar een rit van een andere shift zet de worker op `overgeslagen` (`shiftReden`), vóór hij iets in PostNL opent. De app biedt alleen ritten van dezelfde shift aan.

**Echt verplaatsen gebeurt alleen met `PLANNER_ECHT=ja` in de omgeving van de worker.** Zonder die instelling selecteert hij de stops, controleert hij alles, stopt hij vóór de dubbelklik en zet hij de verplaatsing op `overgeslagen` met de melding "Proefstand". Naar een **geautoriseerde** doelrit dubbelklikt hij altijd, ook met `PLANNER_ECHT=ja`: PostNL weigert dat zelf, en de melding komt in de app. Zet hem pas aan nadat een geslaagde verplaatsing op een toestel is gezien en op de opname is nagekeken.

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

- Stops komen binnen in **`partialObjects`**, andere objecten in `objects` of `mxobjects`. Die stoplijst heeft geen `StopID` en `RideID`: de **`guid`** is de sleutel van stops en ritten.
- De ritlijst is **genest**: `RideNumber` bevat in zijn attribuut de `Ride`, en die weer de `Driver`.
- Sommige waarden staan alleen in **`changes[guid]`**, het object zelf heeft dan `null`.
- De stoplijst heeft `amount: 500`; `hasMoreItems` is nog nooit waar gezien.
- **`volgMendix(page)` geeft per pagina altijd dezelfde volger** en bewaart antwoorden alleen tijdens een `actie()`. Maak er nooit een tweede volger naast: in de sessiehouder (pagina uren open) stapelde een nieuwe volger per taak listeners op die elk antwoord voor altijd bewaarden. Op 04-11 liep de heap zo vol (exit 134, ~3,4 GB), en de auto-deploy rolde daardoor twee goede versies terug (matransport#573).
- **De volger houdt open `/xas/`-verzoeken bij per verzoek, niet met een teller, en vergeet ze bij een nieuw document in het hoofdframe** (`goto`, herladen). Mendix stuurt bij het verlaten van de pagina nog een fetch die in Playwright nooit `requestfinished` of `requestfailed` krijgt. Met een teller die de hele levensduur van de pagina meegaat (sinds #573) bleef die dan op 1 staan, en liep elke wachtstap na 30 s af met "PostNL reageerde niet binnen de wachttijd". In de sessiehouder: na elke `opnieuw_openen` mislukte alles tot een nieuwe login, na 5 logins 10 min pauze, en een Plannen-opdracht wachtte zo 7–11 min (05-11, matransport#592). Vangnet: een verzoek zonder antwoord telt na `VERWEESD_MS` (20 s) niet meer mee; voor lange acties blijft de voortgangsbalk van Mendix het signaal.
- **Op het uitlezen van antwoorden wordt hooguit `LEZEN_MS` (5 s) gewacht** (matransport#598). Een antwoord van een document dat intussen weg is (PostNL gaf een fout 460 en herlaadde de app) krijgt in Playwright nooit een body; zonder grens bleef Plannen daar op 05-11 09:53 4,5 min op hangen tot de taaklimiet. Bij een nieuw hoofddocument worden ook die openstaande leesacties vergeten.

## Is alles gelezen?

`hasMoreItems` op de stoplijst = fout, de rit is dan niet compleet. Het aantal gelezen rijen gaat naar `planning_ritten.stops_gelezen`, en het log toont per rit kop, antwoord en scherm. De kop van PostNL kan afwijken van de lijst, ook in een gewone browser: op de afgesloten dag 31-10 bij 8 van de 11 ritten in shift 02. Oorzaak nog onbekend, opnieuw bekijken op een lopende dag.

## Timing

Vanaf **ongeveer 05:30** staat de nieuwe dag in PostNL. Tot de deadline kan PostNL nog adressen toevoegen, dus: wat in FloatOps staat kan verouderd zijn, en rijnummers zijn niet vast. Daarom leest de worker vlak voor elke verplaatsing opnieuw, en zoekt hij rijen altijd op tijd + adres. De ritmonitor start pas om 08:00 en de dagplanning-scraper om 07:00, dus het sessie-slot is in dit tijdvak meestal vrij.

## Deadline

De tekst "Ritten kunnen tot HH:MM uur worden aangepast." op de pagina is de officiële bron en verschilt per shift. **Nooit zelf berekenen.**

## Veiligheid bij schrijven

- **Geen sessie-slot = niet doorvoeren.** Lezen gaat na het wachten door zonder slot; schrijven stopt, en de concepten blijven staan.
- **Lezen bij een doorvoer (matransport#578):** vooraf alleen de ritlijst van de shifts van de wijzigingen (`shiftsVan`; ontbreekt er een shift, dan alles). Na afloop alleen de ritlijst van de geraakte shifts (totalen, chauffeur) en de stops van de geraakte ritten (bron en doel), niet meer elke rit van de shift: dat was het grootste deel van de 1–2 min per opslag. De rest ververst de sessiehouder vanzelf (taak `plannen`). Zo'n deel-lezing zet `planning_versheid` niet.
- **Vóór de dubbelklik:** opnieuw lezen welke stops nog in de bronrit zitten (staat een deel er niet meer, dan gaat de rest door, met de melding op de gelukte rij: `kiesGewenst`, #600; staat er geen enkele meer, dan overgeslagen), doelrit niet geautoriseerd, deadline niet voorbij, en `aria-selected` staat op precies de bedoelde rijen.
- **Rij zoeken op tijd + adres.** De rijen hebben geen id. Staat dezelfde sleutel dubbel in de tabel, dan weigert de worker.
- **Selecteren vergrendelt stops bij PostNL** (`OperationalPlanning.Lock`). Aan het eind meldt de worker zich af.
- **Dialogen alleen met het kruisje sluiten**, nooit met de hoofdknop: die kan een bevestigingsvraag met ja beantwoorden.
- **Geen automatische herhaling** na een fout tijdens een verplaatsing. De dubbelklik kan al gegeven zijn.
- **Controle achteraf op adres**, niet op `StopID`: daar zit het ritnummer in, dus die kan veranderen.

## Chauffeur wisselen

De keuzelijst `.mx-name-referenceSelector1 select` bij de open rit. Bij een geautoriseerde rit staat hij op slot (`disabled`): de worker volgt wat het scherm toestaat, niet het attribuut `AllowDriverChange` (dat staat ook bij geautoriseerde ritten op true). Na een gelukte wissel werkt de worker meteen `ritten.postnl_chauffeur` en `chauffeur_id` bij, zodat de Ritten-pagina niet tot de volgende sync achterloopt. Een met de hand gekozen chauffeur eindigt dan via de trigger `rit_chauffeur_handmatig`.

### De vraag na het kiezen (gezien op 02-11)

PostNL slaat de gekozen chauffeur **direct** op en toont dan "Wijzig chauffeur: Wilt u de gekozen chauffeur voor de nog komende ritten van dit scenario koppelen?". De worker kiest altijd **"Nee, koppel de chauffeur alleen voor de rit van vandaag"**: een wissel uit Plannen raakt nooit andere dagen. Een ander venster op dat moment = fout, de worker klikt dan niets aan. Tot deze fix bleef de vraag open staan en liep de worker vast, terwijl de wissel zelf al was opgeslagen.

## Playwright-trace (aan, zonder einddatum)

Naast de video bewaart de worker bij elke run een trace: per stap een schermafdruk, de HTML van de pagina en het netwerkverkeer. Zo is een nieuw scherm of een nieuwe vraag van PostNL meteen te volgen. Pad: `worker-sessies/{klant_id}/postnl-planner/trace/{depot}-{ophalen|doorvoeren}-{tijdstip}.zip`, ook in `worker_run_log.video_paths` (soort `trace`), 14 dagen bewaard. Bekijken: `npx playwright show-trace <bestand>`.

- Start pas **na het inloggen**: het wachtwoord staat er nooit in. Wel sessiecookies van PostNL, die na het afmelden aan het eind van de run niet meer werken; de bucket is privé.
- Staat aan tot `PLANNER_TRACE=uit` in de omgeving van de worker (`/opt/matransport/.env`) staat. Ongeveer 9 MB per run, 14 dagen bewaard.

## Terugzoeken

De video van een doorvoer blijft 30 dagen staan (`fout/{depot}-doorvoeren-{tijdstip}.webm`), ook als alles goed ging. In `worker_run_log` staat per run hoeveel wijzigingen gelukt, mislukt of overgeslagen zijn. Log geen adressen of namen: deze uitvoer staat op de VPS.

## Vastgesteld op de sessievideo (02-11, naar een geautoriseerde rit)

Een losse klik voegt een rij toe aan de selectie; onder de tabel staat dan "4 rijen geselecteerd | Selectie wissen". De dubbelklik op de doelrit in een andere shift werkt, en de weigering van PostNL komt terug als melding.

## Nog vast te stellen op een echte opname

Een geslaagde verplaatsing en chauffeurwissel zijn nog niet gezien. Open: of de keuzelijst direct opslaat, of er een bevestigingsvraag komt, wat er met vergrendelingen gebeurt en of de `StopID` wijzigt. Ook: de kop toont soms meer stops dan de lijst (111 tegenover 107).
