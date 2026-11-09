# Executed backend verification

## Environment / commands

Python 3.12 virtual environment; FastAPI 0.162.0, Pydantic 2.14.3, Pandas 2.3.3, PyArrow 23.0.1, pyproj 3.8.0, NIElytics 0.2.0.dev1 at pinned upstream revision `ebb751664d92ce11a6751d2d933a9c2282de0c83`.

From `backend/`, executed successfully:

```powershell
.venv/Scripts/python.exe prepare_workbook.py --workbook "../XeroFlux Dataset.xlsx" --output ../data/processed
.venv/Scripts/python.exe prepare_boundaries.py --archive ../data/raw/state_nwic_geojson.zip --output ../data/processed
.venv/Scripts/python.exe -c "import os,pytest; os.environ['CLIMATELENS_REAL_DATA_TESTS']='1'; raise SystemExit(pytest.main(['-q','-rs']))"
.venv/Scripts/python.exe export_openapi.py
```

Final test run: **246 passed, 2 skipped**, 14.93 seconds. The two skipped cases require symlink privileges unavailable to this Windows account. One upstream Starlette/httpx TestClient deprecation warning remains; it was not suppressed. Three opt-in tests read the actually prepared local source datasets and validate official geometry/catalog matching, source cyclone chronology/units, actual NIElytics event counts and readable report evidence. Other tests use isolated explicitly synthetic fixtures, never production fallbacks.

Contract exporter: **17 paths** generated in `contracts/openapi.yaml`. No frontend tests were rerun or frontend files changed during backend work.

## Real data preparation observed

| Prepared collection | Rows/features | Available observed period |
| --- | ---: | --- |
| State attributes | 36 | Static attributes, vintage not inferred |
| Official boundary features | 36 | Static geometry, vintage not inferred |
| Daily actual rainfall | 1,998 | 2026-08-19 through 2026-11-01 |
| Reported flood records | 6,876 | 1967-07-02 through 2023-09-12 |
| Reported landslide records | 1,265 | 2007-03-12 through 2016-10-17 |
| NI cyclone catalog | 1,860 | Source seasons 1842–2026, not continuous coverage |
| NI track observations | 57,880 | 1842-10-25 through 2026-10-29 |

These are available prepared records, not counts of unique disasters, reporting completeness, Indian landfalls or risk. The workbook contains additional rejected/unassigned/unsupported entries: see generated `data/processed/processing_report.json` and `processing_issues.jsonl`. Rainfall joins use exact normalized state labels only, so not all raw rainfall rows were mapped; no guessed geography was added. Daily rainfall units remain null because source units were not established in the workbook.

The official NWIC archive was fetched explicitly from its workbook-declared HTTPS URL (20,809,092 bytes); this is not a startup download. Its actual CRS is EPSG:7755. Full polygons were transformed to EPSG:4326 with longitude-first coordinates. All 36 features match verified catalog IDs; no outline was invented, simplified or substituted.

## Actual HTTP smoke

Launched a real Uvicorn process on `127.0.0.1:8000`, made HTTP requests using httpx, then terminated the process after verification. This was not a TestClient-only claim. The tool's named-service supervisor failed on this Windows machine because it attempted unavailable WSL `/bin/bash`; a directly launched Python/Uvicorn process worked. The issue was reported to the tool harness.

| Actual request | Observed result |
| --- | --- |
| `/api/v1/health` | 200; manifest ready, analytics configured |
| `/api/v1/metadata`, `/sources`, `/states` | 200; seven source entries and 36 states/UT entries |
| `/api/v1/boundaries` | 200; 36 complete official features, cache header |
| `/api/v1/map/rainfall?year=2026&observation_date=2026-08-19` | 200; 27 state observations for that date, unit null |
| `/api/v1/trends/rainfall?state_id=02&start_year=2026&end_year=2026` | 200; actual dated records |
| `/api/v1/events/floods?year=2010&limit=2&offset=1` | 200; paginated records |
| `/api/v1/events/landslides?year=2010&limit=2&offset=1` | 200; paginated records |
| `/api/v1/cyclones?year=2019` | 200; actual recorded storms, including FANI |
| `/api/v1/cyclones/2019116N02090/track` | 200; 71 Fani observations, 2019-04-25T18:00:00Z through 2019-05-04T12:00:00Z |
| `/api/v1/insights?state_id=29&start_year=2007&end_year=2023` | 200; actual NIElytics regional aggregation followed by InsightEngine finding |
| `/api/v1/multi-hazard?state_id=29&start_year=2007&end_year=2023` | 200; one catalog-overlap relationship, explicitly not temporal causation |
| `/api/v1/reports/state/29?start_year=2007&end_year=2023&format=pdf` | 200; 112,164-byte, 50-page PDF parsed by pypdf, Karnataka evidence text found |
| `/api/v1/trends/drought` | Expected 503 DATASET_UNAVAILABLE; undefined source value columns are not mislabeled |
| `/api/v1/trends/temperature?region=India` | Expected 503 DATASET_UNAVAILABLE; state annual heatwave records are not regional monthly temperature |
| `/api/v1/compare?state_a=29&state_b=21&metric=rainfall_annual_total&start_year=2019&end_year=2019` | Expected 422 UNSUPPORTED_METRIC; no validated annual/common coverage declared |

PDF validation in this backend task was structural parsing and extracted-content verification, not visual PDF-viewer inspection. Frontend map rendering/playback was not part of that backend verification; the subsequent frontend connection and its browser verification are documented in `../frontend/README.md`.

## Failures fixed during verification

- Source-reference parsing incorrectly treated an HTTP URL on the next line as a new label; corrected and covered by preparation tests.
- Same-size manifest updates inside one filesystem clock tick could reuse stale declarations; cache identity now includes small-manifest content, with deterministic regression coverage.
- Pandas converted nullable Parquet integer event years into floats, causing strict validation failures on actual records; Arrow-backed nullable reads now preserve source integer/null types, covered by a real Parquet regression.
- The event analytics adapter initially required state-resolution metadata even for point-event records carrying explicit verified state IDs; it now permits source-assigned point events, excludes missing assignments and discloses aggregation scope. National estimates remain rejected.
- Boundary preparation initially left the map capability falsely disabled; publication now updates capabilities and resolves only the boundary omission without clearing unrelated limitations.

## Judge / frontend handoff

1. Start the backend with the README command; inspect `/docs` and `/api/v1/metadata`.
2. Fetch official boundaries and a returned rainfall observation date. Show actual daily values without implying an annual total or unverified units.
3. List 2019 storms; select FANI ID `2019116N02090`; replay its 71 source timestamps in the frontend.
4. Select Karnataka ID `29`, period 2007–2023; display the actual event insight and returned method/source/limitations.
5. Open the multi-hazard result as period-wide catalog overlap, not simultaneous hazard causation.
6. Download the state evidence PDF through the actual endpoint.
7. Explain disabled annual comparison/drought/regional-temperature controls honestly. Additional compatible processed science data and a validated comparison policy are required; no fake demo is provided.

Dependency consistency: `.venv/Scripts/python.exe -m pip check` completed with `No broken requirements found.`
