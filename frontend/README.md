# ClimateLens India — connected frontend

React/TypeScript/Vite dashboard using the actual FastAPI contract at `../contracts/openapi.yaml`. No mock-data mode, external tiles, paid maps or external fonts. Backend runtime code, scientific code and the API contract are unchanged by this frontend integration.

## Run the site

Use two terminals from the repository root. Prepared real datasets and the official boundaries are already available locally from the backend preparation step.

**Terminal 1 — API**

```powershell
cd backend
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Terminal 2 — website**

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1
```

Open **http://127.0.0.1:5173**. Backend docs: **http://127.0.0.1:8000/docs**. The API process must remain running. If dependencies/prepared files are absent on another machine, follow `../backend/README.md` first; no data is silently downloaded at startup.

Vite dev **and preview** proxy `/api` to `http://127.0.0.1:8000`. No environment configuration is needed for these commands. An old `.env.local` can override this: remove an obsolete URL or set `VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1` and restart Vite. The setting is public, never a place for secrets. For deployed static assets configure a same-origin `/api` reverse proxy or a complete API prefix with backend CORS allowing the frontend origin.

```powershell
npm.cmd run build
npm.cmd run preview -- --host 127.0.0.1
```

`dist/` is the production output. Hash routing requires no server-side page-route rewrites. On non-Windows platforms use `npm`/`npx` and the appropriate backend virtual-environment executable.

## Appearance

The dashboard opens in a **light sage-green theme**. Interface type uses the installed Bahnschrift face with native fallbacks (no font download). Use the sun/moon switch in the header to choose light or dark mode; on mobile it is a compact icon button with the same accessible **Dark mode** switch label.

The choice is stored as `climatelens-theme` in browser local storage and restored before first paint, across navigation and reloads. If browser storage is blocked, switching still works for the current page. Maps, legends, charts, tables, form controls and source popups follow the selected theme. Switching changes map paint in place: it does not reload geometry, reset the viewport, clear filters or restart cyclone playback.

## Connected routes

- `#/overview`: India climate atlas. The official boundary map and selected-state rainfall evidence (exact dated value, observed series, report) sit in the first working viewport. Rapid date/state changes are debounced and stale observations are never labelled with the new selection.
- `#/explorer`: rainfall and five hazard interfaces. Actual paginated flood/landslide events, cyclone selection/tracks, source attributes and scope/error disclosures. Temperature only requests a user-entered source region; no region identifier is guessed.
- `#/time-machine`: actual cyclone, rainfall-date and paginated event replay. Play/Pause/Restart/Step, speed and seek operate on recorded observations. Fani is selected only when returned. No visual interpolation is added.
- `#/comparison`: catalog states, backend-declared comparable metrics and periods; current backend advertises no scientifically supported comparisons, so those requests remain disabled with an explanation.
- `#/insights`: actual NIElytics findings, source IDs, observations, executed method disclosure and real PDF download.
- `#/multi-hazard`: actual backend catalog-overlap relationships, map and chronological source records; not proof of simultaneous events or causation.
- `#/sources`: all returned source/provider/URL/provenance/coverage metadata. HTTP(S) links only; original landslide provenance remains uncertain.

Filters persist in hash-query parameters across navigation/history. Reset filters removes selections and restores only backend-confirmed defaults. Mobile navigation traps focus, supports Escape/focus return, and avoids off-screen keyboard targets. Charts have accessible observation tables; map failure retains keyboard state selectors and actual data views.

## API / types / failure handling

`src/api/schema.d.ts` is generated, not handwritten wire types:

```powershell
npm.cmd run generate:api
```

`src/api/client.ts` centralizes typed requests, encoded query/path parameters, envelope validation, abortable requests, five-minute historical caching and bounded transient retry. A failed request never silently substitutes samples or labels old filters as current. Actual backend `no_data`, unavailable dependencies and network errors have separate visible states and retry controls.

Report downloads require successful HTTP, PDF content type and a nonempty response. Requests abort when leaving/changing the report selection. Source IDs link to the corresponding transparency entries. All scientific findings and differences come from the backend; frontend code does not calculate climate metrics.

## Real-data limits

- Rainfall is **daily actual source data**, not a full annual total. Source units are not established, so charts/legend say so instead of assuming millimetres. A state without observations is not colored as measured zero.
- Drought source columns lack established meaning: backend returns unavailable, never invented percentages.
- Supplied state annual heatwave records cannot replace the requested regional/monthly temperature series.
- No validated annual/common-coverage comparisons are declared. Disabled comparison controls are intentional, not fake chart placeholders.
- Event catalogs have missing dates, coordinates and ambiguous state assignments. Unmapped events remain visible in lists; no locations or date precision are invented.
- Cyclones are North Indian Ocean records, not assertions of Indian landfall. Replay timing counts observation steps, not simulated historical clock time.
- All analysis is historical evidence, not official alerts, forecasting or validated future risk predictions.

## Demo

1. Overview: wait for `Historical API connected` and the official map. Choose a returned rainfall date; click a state to see its observed series and coverage.
2. Time Machine: select cyclones, 2019, FANI (`2019116N02090`, when returned). Play, pause, step and restart while inspecting source timestamps and wind/pressure units.
3. Insights: choose Karnataka (`29`), 2007–2023. Open **How was this calculated?** and review actual NIElytics method/source/limitations.
4. Download the state climate report through the backend.
5. Inspect multi-hazard catalog overlap and provider links. Explain unsupported annual comparisons, drought and temperature honestly.

## Verification commands

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

Playwright starts the real local backend and Vite frontend automatically (or reuses existing servers). It requires prepared source data and the backend virtual environment. Its desktop/mobile scenarios use actual API responses—not fixture network routes. Unit tests use explicitly synthetic transport responses under `src/test/` only and cover malformed data, zero versus no-data, errors/cancellation, replay transitions, navigation and health retry. The previous static missing-contract gate and connectivity-only transport were removed.
When reusing servers under a CI-marked shell, explicitly opt in with `$env:PLAYWRIGHT_REUSE_SERVER = '1'` before running Playwright. This leaves your existing backend/frontend processes alone rather than stopping them to free ports.

Verification: run the commands above. Real-backend Chromium scenarios cover both themes, desktop 1440×900 and mobile 390×844 (plus a 1024×768 stacked layout), map first-fold geometry, state selection, rapid filters, replay controls, source links, PDF downloads, multi-hazard paging and mobile navigation. Evidence is written under ignored `test-results/`.
The frontend proxy was also exercised directly against the backend. Playwright leaves reused existing servers running and shuts down only processes it starts; diagnostic browser tabs were closed. Use the two-terminal commands above if the site is not already running.
MapLibre's bundled engine remains a large lazy-loaded chunk, and full-resolution official geometry makes the first map load heavier. The production build reports the chunk-size warning rather than hiding it; historical responses are cached, and no external tile service is required.

## Files changed / added

- Generated types, API client and schema aliases: `src/api/{schema.d.ts,client.ts,types.ts}`.
- Live map and shared evidence/chart/report controls: `src/components/{IndiaMap,DataPanels}.tsx`.
- URL filters and playback: `src/hooks/{useFilters,usePlayback}.ts`.
- All seven `src/pages/` views; live connection indicator/filter reset in `src/App.tsx`; responsive live-data styles.
- Vite proxy, environment example, generated-type script/dependency lock, unit and live browser scenarios.
- Appearance: `src/theme.tsx`, pre-paint initialization in `index.html`, header switch in `src/App.tsx`, and token-based light/dark `src/styles.css`. Theme persistence/storage restrictions and live map/replay preservation have dedicated tests.
- Removed obsolete `IntegrationGate.tsx`, `connection.ts` and their obsolete tests. No scientific/backend contract was changed to make the UI work.
