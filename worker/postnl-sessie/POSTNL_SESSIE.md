# postnl-sessie (de sessiehouder)

Per klant één proces op de VPS dat per depot **één PostNL-sessie** open houdt zolang er werk is, in één tabblad. Elk depot heeft een eigen browser met één tabblad (eigen login, eigen slot). Een PostNL-login toevoegen, wijzigen, uitzetten of verwijderen op Instellingen → Inloggegevens geeft via de database-trigger `postnl_sessie_koppeling` een seintje (VPS → wekkerbestand `POSTNL_SESSIE_WEKKER`): de sessiehouder leest de depots opnieuw en start een nieuw depot, logt opnieuw in bij een gewijzigde login, of stopt een uitgezet depot (`src/depots.js`, getest). Lopende depots zonder wijziging blijven in hun sessie. Eens per uur dezelfde controle als vangnet. Daarin lopen de ochtendlezing, de definitieve lezing per shift en de ritmonitor achter elkaar, zodat workers elkaar nooit meer wegduwen (PostNL verdraagt per login maar één sessie, #361). Aanleiding en plan: floatops/matransport#562.

## Wanneer doet hij wat

De **autorisatie** van een rit is het omslagpunt, niet de klok (`src/taken.js`, getest met een gesimuleerde werkdag in `test/planning.test.mjs`):

| Taak | Wanneer | Wat |
|---|---|---|
| `ochtend` | vanaf `ochtendVanaf` (05:30), één keer per dag | alle shifts en ritten lezen en aanmaken, **deadline per shift één keer vastleggen** (staat vast voor de dag). Staat de dag er nog niet: na 5 min opnieuw. |
| `definitief` | per shift vanaf zijn deadline, elke 5 min | geautoriseerd (`Authorized` in de Mendix-antwoorden; ritten per shift via `hoortBijShift`: de shift van PostNL, anders het eerste cijfer van het ritnummer)? Dan één definitieve lezing. **Vangnet:** 30 min na de deadline zonder autorisatie toch lezen + `autorisatie_niet_gezien`, en daarna **blijven kijken** (elke 5 min, hooguit `naVangnetKijkenMin` = 4 uur): bij de autorisatie nog één lezing (`na_autorisatie`), want pas dan staan de cijfers vast. Op 03-11 kwam de autorisatie 1–3 uur na de deadline. Geen deadline te lezen bij de ochtendlezing? Dan wordt hij bij de eerstvolgende controle vastgelegd, en anders geldt het vangnet vanaf `ritmonitorUiterlijk`. |
| `plannen` | per shift tot zijn deadline (daarna overgeslagen; na de laatste deadline niets meer) | De Plannen-tab vanzelf bijwerken in deze sessie (`verversPlanning` van postnl-planner), **zo snel als het kan**: is al het andere gedaan, dan om de beurt de ritten of de stops van een open shift, wat het langst geleden is (geen vaste wachttijd; `plannenRittenMin`/`plannenStopsMin` zijn een ondergrens, standaard 0). De shift die iemand in Plannen open heeft (`planning_kijkers`, hartslag van de app) gaat voor (`plannenKijkerVoorsprongSec`). Alleen ritten vóór hun deadline; alleen verschillen naar de database. Niet tijdens een lopende Plannen-opdracht. Houdt de sessie meteen ook levend. Uit: `plannenVerversen: false`. |
| `wakker` | in stille tijd, na `wakkerHoudenMin` (10 min) zonder andere taak | Dagplanning opnieuw openen: houdt de sessie levend. Bleek hij verlopen, dan opnieuw inloggen in hetzelfde tabblad (gebeurtenis `verlopen_stil`, een meting van de levensduur), vóór een planner-opdracht erop moet wachten. |
| `ritmonitor` | vanaf de eerste autorisatie (vangnet: `ritmonitorUiterlijk` 08:00), elke 60 s tot 23:00 | Ritmonitor lezen en schrijven (`postnl-ritmonitor/src/ritmonitor.js`). |
| `planner` | op aanvraag: de VPS wekt hem binnen 1 s (`POSTNL_PLANNER_WEKKER`), vangnet elke 15 s (`planning_taken` met status `wacht`) | **in deze sessie** (stap 2): `verwerk()` van `postnl-planner` met de open pagina (`handlers.planner`). Geen tweede login, geen uitloggen; is er nog geen sessie (vóór de eerste deadline), dan één login. Gaat voor de ritmonitor, die daarna verdergaat. Vóór een opdracht een verse sessie als de oude dicht bij haar gemeten einde zit. Een doorvoer: trace en video 30 dagen in `fout/`, gebeurtenis `planner` in `postnl_sessies`, trace-pad in de run-log van de planner. |

**De sessie blijft de hele werkdag open** (`sessieOpenHouden`, standaard aan): van de eerste taak tot 23:00 is er per depot één sessie in één tabblad, ook in de stille tijd tussen de ochtendlezing en de eerste deadline. Een planner-opdracht hoeft dan nooit in te loggen. Verloopt de sessie toch, dan logt de volgende taak in hetzelfde tabblad opnieuw in (`naarDepot`), en dat telt als meting van de levensduur. Met `sessieOpenHouden: false` geldt de oude regel: ligt de volgende taak verder dan `sluitNaLeegMin` (10 min) weg, dan gaat de sessie dicht. Na 23:00 en op zondag stopt het proces; de cronjob `postnl-sessie-bewaker` start hem vanaf 05:25 weer. Alle tijden en intervallen staan in `src/instellingen.js` en zijn per klant te overschrijven in `postnl_instellingen.instellingen` (jsonb), zonder deploy.

## RVA: tweede tabblad, 24/7 (matransport#569)

Met `rva: true` in `postnl_instellingen.instellingen` heeft elk depot **één browser met twee tabbladen**: OOM PD (`sessie.page`) en RVA (`sessie.rvaPage`, `https://pnl-rva.p15.cldsvc.net/`). Beide gebruiken dezelfde login en cookies (zelfde context). Er komt geen tweede login of sessie bij. Code en hoe RVA werkt: `../postnl-rva/POSTNL_RVA.md`.

- **Altijd open:** het RVA-tabblad gaat open direct na het inloggen en na elk nieuw videosegment (`sessie.rvaOpenen()`). De taak `rvaWakker` (prioriteit 25: boven `plannen`, dat 's ochtends continu loopt, onder de ritmonitor) ververst elke `rvaWakkerMin` (10) het Rittenoverzicht. Is de RVA-sessie verlopen, dan logt hij in dat tabblad opnieuw in (gebeurtenis `rva_verlopen_stil`).
- **24/7** (`rvaAltijd`, standaard aan): `rva` en `rvaWakker` negeren `rustdagen` en `eindtijd`. De lus stopt dus 's nachts en op zondag niet. De bewaker start de sessiehouder buiten de OOM PD-werktijd met `trigger_postnl_sessie(true)`, alleen voor klanten met RVA aan. Het OOM PD-tabblad blijft 's nachts stil open.
- **Opdrachten** (`rva_opdrachten` in matransport, één Opslaan in de app = één rij):
  - Taak `rva` (prioriteit 95: na een planner-opdracht, vóór alle OOM PD-taken) pakt steeds de **oudste** wachtende opdracht van het depot.
  - De lus doet één taak tegelijk. Een lopende opdracht wordt dus nooit onderbroken, en meerdere opdrachten gaan na elkaar. Een OOM PD-taak die al loopt, maakt eerst zijn werk af.
  - Gewekt via `POSTNL_RVA_WEKKER` (VPS `/run/postnl-rva`, binnen een seconde), met elke 15 s lezen als vangnet.
  - Status `wacht → bezig` alleen als hij nog op `wacht` staat, en daarna `klaar` of `mislukt` met de reden. Na een fout geen herhaling: `voerUit` doet dan Annuleer.
  - `stap` en `voortgang` (0–100) worden live bijgewerkt, voor de voortgangsbalk in de app.
  - Echt opslaan in RVA alleen met `RVA_ECHT=ja` in de omgeving (de `.env` op de VPS, zonder herstart gelezen); anders proefstand.
- **Beoordelen na een RVA-taak:** het RVA-tabblad (loginpagina, crash, fout), **niet** de OOM PD-startpagina. Een verse login staat daar, en een RVA-taak laat dat tabblad ongemoeid; anders gaf elke RVA-taak een valse "gegooid".
- **Opnames:** elke RVA-opdracht bewaart trace en video 30 dagen in `fout/` (`bewaren: true`, ook als hij slaagt en in de proefstand). De video van het RVA-tabblad heet `video-rva-*.webm`.
- **Code:** de sessiehouder laadt nu ook `worker/postnl-rva` (`codeversie.js`). Een RVA-commit geeft dus weer een herstart.

## Lezen en schrijven

- **Dagplanning uit de Mendix-antwoorden** (`credentials-shared/src/postnl/ritten.js`): PostNL stuurt per rit `RideNumber` (Stops, Pieces, Volume, Weight, MailboxOnlyStops, TotalRideTime, RideID), `Ride` (RideName, RideID, Authorized/Enum_Authorized, Driver, Shift) en het kanaal van het scherm (`DisplayPlanning` → `DistributionChannel`). Op 02-11 vergeleken met wat het scherm-lezen in `ritten` had gezet: gelijk. Welke waarde in welke kolom komt staat op één plek: `postnl/velden.js`.
- **Eén schrijver** (`postnl/schrijver.js`), ook voor het losse dagplanning-script: sleutel ritnummer + kanaal (#560), altijd `klant_id`, geen dubbelen verwijderen, alleen wijzigingen, een databasefout gooit. Een rit zonder bekend kanaal wordt niet geschreven (een gok tussen HD en AD gaf #560) en komt als fout in de run-log.
- **Alleen de gekozen dag** (`dagVenster` in `credentials-shared/src/postnl/dagplanningScherm.js`): de Dagplanning opent op vandaag. Kies je een andere dag, dan komen ritten van vandaag soms nog ná het wisselen binnen (03-11: rit 114 Den Hoorn). `kiesDag` laat de standaarddag eerst uitladen, `dagVenster` negeert ritten die al vóór het wisselen gemeld waren, en twee verschillende versies van één rit worden niet geschreven (`tegenstrijdig`, fout in de run-log).
- **Chauffeur koppelen** doet de database (trigger `trg_rit_chauffeur_koppeling`, matransport-migratie `20261102140635`).

## Meting stap 0 (02-11, beide depots)

Op de VPS met `scripts/meet.mjs --zonder-levensduur`, opnames in `/var/log/workers/postnl/opnames/meting/2026-11-02/`.

| Vraag | Uitkomst | Gevolg |
|---|---|---|
| Nieuwe browser-context met dezelfde cookies en hetzelfde IP | blijft ingelogd, Planning-menu zichtbaar; de oude sessie ook | `contextWissel` staat standaard aan: elke 30 min een nieuw videosegment zonder login |
| `loginpostnl.net/myapps` in hetzelfde tabblad | opent zonder login; daarna is het depot nog ingelogd | depot-URL kan later in de sessie (stap 3) |
| Tweede login (ander IP), beide sessies herladen alleen de startpagina | beide blijven ingelogd (0, 30 en 90 s) | een tweede login gooit niet meteen iemand eruit |
| Tweede login, beide sessies werken in Mendix (Dagplanning openen, shift kiezen) | de ándere sessie staat daarna op de **startpagina** ("Homepage", "OOM PD Proces"); nog ingelogd, Planning-menu zichtbaar | dit is "eruit gegooid": herkend via `opStartpagina()` na elke taak (`gezondheid.js`) |
| Levensduur | niet overdag gemeten (houdt het slot uren vast) | meet de sessiehouder zelf (`einde_reden = 'verlopen'`) |

Eén tabblad per depot: bij een nieuw segment gaat eerst het oude tabblad dicht en dan pas het nieuwe open.

## Herstel (`src/gezondheid.js`)

Na elke taak, geslaagd of niet, wordt de sessie beoordeeld:

| Soort | Herkend aan | Herstel |
|---|---|---|
| `verlopen` | loginpagina | meteen nieuwe login, nieuw IP |
| `gegooid` | pagina herlaadde, of na de taak de startpagina ("OOM PD Proces") in plaats van het scherm van de taak | 1e keer opnieuw openen, 2e keer binnen 2 min nieuwe login; altijd een melding (er hoort niemand anders in te loggen) |
| `blokkade` | Akamai (403 of blokpagina) | IP in quarantaine (database), nieuwe login met het volgende IP |
| `browser_weg` | browser/tabblad gesloten of gecrasht | nieuwe login |
| `database` | `database: true` op de fout | sessie blijft; 10 s wachten |
| `fout` | iets anders (time-out, …) | opnieuw openen; na 3 achter elkaar nieuwe login |

`gegooid` wordt hoogstens eens per 30 min per depot gemeld (de gebeurtenis staat er altijd; 03-11 gaf een taak die op de startpagina eindigde 69 meldingen). Een taak moet daarom altijd op zijn eigen scherm eindigen: eindigt hij op de startpagina, dan telt dat als eruit gegooid. Met `contextWissel` aan wordt de browser niet om de 4 uur vernieuwd (dat gaf een onnodige login). Meer dan 4 logins per uur per depot = 10 min pauze + melding `te_veel_logins` (niet blijven hameren op PostNL). Elke taak heeft een tijdslimiet (`taakLimietSec`); een waakhond stopt het proces als geen enkele depot-lus meer voortgang maakt. Elk incident komt als gebeurtenis in `postnl_sessies.gebeurtenissen`, met het pad van de trace.

## Levensduur (`src/levensduur.js`)

Gemeten, niet aangenomen: gewone lezingen laten een sessie gewoon verlopen (`einde_reden = 'verlopen'`). Vanaf 3 metingen is de schatting het 10e percentiel van de laatste 30 dagen; vóór schrijvend werk wordt een sessie dan vernieuwd als hij dichter dan 15 min bij dat einde zit.

## Opnames (op de schijf van de VPS)

Opnames staan op de VPS, niet in de database-opslag (die is duur; de VPS heeft ruimte): `$OPNAME_ROOT` (standaard `/var/log/workers/postnl/opnames`) `/{klant}/{depot}/`.
- **Trace:** na het inloggen gestart (geen wachtwoord in de trace), daarna een chunk per taak. Geslaagd: `trace-{taak}-latest.zip`; incident: `fout/trace-{taak}-{tijd}.zip`.
- **Video:** per browser-context. Een segment eindigt bij sluiten of, met `contextWissel` aan, elke 30 min (nieuwe context met dezelfde cookies, geen login). Zonder incident `video-latest.webm`, met incident `fout/video-{tijd}.webm`. Zonder contextwissel wordt de browser elke `browserVernieuwenUur` vernieuwd (nieuwe login), zodat een video nooit uren lang wordt.
- `fout/` wordt na 30 dagen door de worker zelf opgeruimd (bij elke login). `postnl_sessies.video_path` en de gebeurtenissen bevatten het pad op de VPS. Bekijken: `scp matransport-vps:<pad> .` en `npx playwright show-trace <zip>`.
- Lokale proef met een echte Chromium tegen een nagemaakt portaal: `node scripts/proef-lokaal.mjs`.
- Meting op PostNL zelf (stap 0): `scripts/meet.mjs` → `$OPNAME_ROOT/meting/{datum}/{depot}/` met `meting.json`, video's, traces en schermafdrukken. Overdag met `--zonder-levensduur` (anders houdt hij het slot uren vast); de levensduur meet de sessiehouder zelf.

## Logboek en wachtdogs

- `worker_run_log` onder dezelfde namen als de losse scripts: `postnl-ritmonitor` elke 7 min samengevat (lezingen en `leeg_onbevestigd` per depot), `postnl-dagplanning` per lezing. De bestaande wachtdogs en de koppelingsbadge werken dus zoals altijd.
- `check_postnl_sessie()` (elke 5 min, matransport-migratie `20261103002006`): `sessiehouder_niet_actief`, `ochtend_te_laat` (07:30), `definitief_te_laat` (deadline + 45 min), `ritmonitor_stil` (10 min geen lezing terwijl de sessiehouder het depot heeft), `veel_logins` (> 6 per depot per dag), `login_problemen` (≥ 3× login mislukt of blokkade), en altijd `planner_niet_opgepakt` (> 3 min wacht), `planner_lang_bezig` (> 20 min), `planner_afgebroken`, `planner_mislukt` (technisch; een weigering van PostNL telt niet). Dit draait in de database: niemand hoeft mee te kijken. `check_worker_staleness()` slaat de dagplanning over voor klanten met de sessiehouder aan.
- Meldingen gaan via `db_fout_log` → `check_operationele_fouten()` → push naar super_admin.

## Vangnet

De sessiehouder houdt het sessie-slot vast (lease 3 min, verlengd bij elke ronde van de lus). De losse scripts (ritmonitor elke 7 min, dagplanning elke 30 min) blijven via cron draaien, maar zien de sessiehouder en doen dan niets (`sessiehouderHeeftAlles`, `wijkVoorSessiehouder`). Valt de sessiehouder uit, dan verloopt de lease binnen 3 min en nemen ze bij de volgende cron-tik vanzelf over. Een slot dat bezet is door een ander proces wordt nooit meer genegeerd: dan slaat een script over.

## Aanzetten

Per klant: `postnl_instellingen.actief = true` (migratie). Tot dan doet de sessiehouder niets en draaien de losse scripts zoals altijd.

## Herstart bij nieuwe code

Elke 5 min kijkt het proces naar `git HEAD` van de checkout. Nieuwe code: de lopende taken afmaken, sessies sluiten (reden `herstart`), exit 42; de wrapper op de VPS start meteen opnieuw (één nieuwe login per depot).
