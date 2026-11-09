import { Droplets, Mountain, Thermometer, Waves, Wind } from 'lucide-react';
import { useApi } from '../api/client';
import type { Metadata } from '../api/types';
import { Evidence, QueryState, ReportDownload, TrendChart } from '../components/DataPanels';
import { KpiCard, SlicerRibbon } from '../components/Executive';
import IndiaMap from '../components/IndiaMap';
import { useFilters } from '../hooks/useFilters';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

const lenses = [
  { id: 'rainfall', label: 'Rainfall', Icon: Droplets, scope: 'Daily state rainfall observations are not annual totals, anomalies, or a complete climate baseline.' },
  { id: 'heat', label: 'Heat', Icon: Thermometer, scope: 'Temperature is regional, not state-level. Heat-wave days are not interchangeable with maximum temperature.' },
  { id: 'floods', label: 'Floods', Icon: Waves, scope: 'Recorded flood events, not continuous measurements of inundation or risk.' },
  { id: 'drought', label: 'Drought', Icon: Droplets, scope: 'National drought indicators cannot be mapped as state measurements or used for state comparisons.' },
  { id: 'landslides', label: 'Landslides', Icon: Mountain, scope: 'Reported landslides have uneven coverage and unverified original provenance.' },
  { id: 'cyclones', label: 'Cyclones', Icon: Wind, scope: 'Recorded basin positions are not state exposure, landfall estimates, forecasts, or simulated routes.' },
] as const;

/** View filters operate on returned source rows, never on undocumented API parameters. */
function ReturnedSeries({ rows, meta, title, allowMonths }: { rows: { year: number; month?: number | null; value: number }[]; meta: Metadata; title: string; allowMonths: boolean }) {
  const { filters, setFilters } = useFilters();
  const years = [...new Set(rows.map((row) => row.year))].sort((a, b) => a - b);
  const months = allowMonths ? [...new Set(rows.flatMap((row) => row.month != null && Number.isInteger(row.month) && row.month >= 1 && row.month <= 12 ? [row.month] : []))].sort((a, b) => a - b) : [];
  const rawStart = filters.get('start_year');
  const rawEnd = filters.get('end_year');
  const rawMonth = allowMonths ? filters.get('month') : null;
  const start = rawStart === null ? years[0] : Number(rawStart);
  const end = rawEnd === null ? years.at(-1) : Number(rawEnd);
  const month = rawMonth === null ? undefined : Number(rawMonth);
  const valid = start !== undefined && end !== undefined && years.includes(start) && years.includes(end) && start <= end && (month === undefined || months.includes(month));
  const withinYears = rows.filter((row) => start !== undefined && end !== undefined && row.year >= start && row.year <= end).sort((a, b) => a.year - b.year || (a.month ?? 0) - (b.month ?? 0));
  const visible = withinYears.filter((row) => month === undefined || row.month === month);
  const yearOnly = month === undefined ? [] : withinYears.filter((row) => row.month == null);
  const chartRows = visible.map((row) => ({ label: row.month == null ? String(row.year) : `${row.year}-${String(row.month).padStart(2, '0')}`, value: row.value }));
  const latest = visible.at(-1);
  return <>
    <div className="filter-row temporal-view-filters">
      <div><label htmlFor="returned-start">View start year</label><select id="returned-start" value={rawStart ?? ''} onChange={(event) => setFilters({ start_year: event.target.value || undefined })}><option value="">First returned year</option>{rawStart !== null && !years.includes(Number(rawStart)) && <option value={rawStart}>Unsupported selection: {rawStart}</option>}{years.map((year) => <option key={year} value={year}>{year}</option>)}</select></div>
      <div><label htmlFor="returned-end">View end year</label><select id="returned-end" value={rawEnd ?? ''} onChange={(event) => setFilters({ end_year: event.target.value || undefined })}><option value="">Last returned year</option>{rawEnd !== null && !years.includes(Number(rawEnd)) && <option value={rawEnd}>Unsupported selection: {rawEnd}</option>}{years.map((year) => <option key={year} value={year}>{year}</option>)}</select></div>
      {months.length > 0 && <div><label htmlFor="returned-month">Returned observation month</label><select id="returned-month" value={rawMonth ?? ''} onChange={(event) => setFilters({ month: event.target.value || undefined })}><option value="">All returned months</option>{rawMonth !== null && !months.includes(Number(rawMonth)) && <option value={rawMonth}>Unsupported selection: {rawMonth}</option>}{months.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>}
    </div>
    {!valid ? <p role="alert">Choose returned year bounds with the start no later than the end, and a supplied month if applicable.</p> : <>
      <p className="muted">Visible filtered period: {start}–{end}{month === undefined ? ', all returned observations' : `, month ${month}`}. Source rows are not aggregated.</p>
      {latest && <div className="kpi-grid"><KpiCard label={`Latest returned observation (${latest.month == null ? latest.year : `${latest.year}-${String(latest.month).padStart(2, '0')}`})`} value={latest.value} unit={meta.unit} badge={`${visible.length} observations in view`} tone="ok" series={chartRows} /></div>}
      {visible.length ? <TrendChart title={title} rows={chartRows} unit={meta.unit} /> : <p role="status">No observations in this view. This is not measured zero.</p>}
      {yearOnly.length > 0 && <div className="table-scroll"><table><caption>Year-only records have no month and are not part of the selected month view</caption><thead><tr><th scope="col">Source year</th><th scope="col">Value · {meta.unit ?? 'Unit not declared'}</th></tr></thead><tbody>{yearOnly.map((row, index) => <tr key={`${row.year}-${index}`}><td>{row.year}</td><td>{row.value}</td></tr>)}</tbody></table></div>}
    </>}
    <Evidence meta={meta} />
  </>;
}

export default function Explorer() {
  const { filters, setFilters } = useFilters();
  const active = lenses.find((lens) => lens.id === filters.get('hazard')) ?? lenses[0];
  const metadata = useApi('/api/v1/metadata');
  const states = useApi('/api/v1/states');
  const catalog = metadata.data?.data;
  const dataset = active.id === 'heat' ? 'temperature' : active.id;
  const years = [...(catalog?.capabilities.available_years?.[dataset] ?? [])].sort((a, b) => a - b);
  const requestedYear = Number(filters.get('year'));
  const year = years.includes(requestedYear) ? requestedYear : years.at(-1);
  const rainfallYears = [...(catalog?.capabilities.available_years?.rainfall ?? [])].sort((a, b) => a - b);
  const requestedStart = Number(filters.get('start_year'));
  const requestedEnd = Number(filters.get('end_year'));
  const startYear = rainfallYears.includes(requestedStart) ? requestedStart : rainfallYears[0];
  const endYear = rainfallYears.includes(requestedEnd) ? requestedEnd : rainfallYears.at(-1);
  const validPeriod = startYear !== undefined && endYear !== undefined && startYear <= endYear;
  const dates = [...(catalog?.capabilities.rainfall_observation_dates ?? [])].filter((value) => Number(value.slice(0, 4)) === year).sort();
  const requestedDate = filters.get('observation_date') ?? '';
  const date = dates.includes(requestedDate) ? requestedDate : dates.at(-1) ?? '';
  const stateRows = states.data?.data ?? [];
  const requestedState = filters.get('state_id') ?? '';
  const selectedState = stateRows.some((state) => state.state_id === requestedState) ? requestedState : active.id === 'rainfall' ? stateRows[0]?.state_id ?? '' : '';
  const stateName = stateRows.find((state) => state.state_id === selectedState)?.name;
  const mapVisible = active.id !== 'heat' && active.id !== 'drought';
  const eventLens = active.id === 'floods' || active.id === 'landslides';
  const parsedOffset = Number(filters.get('offset') ?? 0);
  const offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  const identity = JSON.stringify({ hazard: active.id, year, date, selectedState, startYear, endYear, offset, stormId: filters.get('storm_id') ?? '' });
  const settledIdentity = useDebouncedValue(identity);
  const settled = JSON.parse(settledIdentity) as { hazard: string; year?: number; date: string; selectedState: string; startYear?: number; endYear?: number; offset: number; stormId: string };
  const updating = identity !== settledIdentity;
  const scopeReady = active.id === settled.hazard;
  const boundaries = useApi('/api/v1/boundaries', undefined, undefined, mapVisible);
  const rainfall = useApi('/api/v1/map/rainfall', { year: Number(settled.date.slice(0, 4)), observation_date: settled.date }, undefined, scopeReady && active.id === 'rainfall' && !!settled.date);
  const evidenceBusy = updating || (active.id === 'rainfall' && !!date && rainfall.isPending);
  const trend = useApi('/api/v1/trends/rainfall', { state_id: settled.selectedState, start_year: settled.startYear, end_year: settled.endYear }, undefined, scopeReady && active.id === 'rainfall' && !!settled.selectedState && settled.startYear !== undefined && settled.endYear !== undefined && settled.startYear <= settled.endYear);
  const events = useApi(active.id === 'landslides' ? '/api/v1/events/landslides' : '/api/v1/events/floods', { state_id: settled.selectedState || undefined, year: settled.year, limit: 100, offset: settled.offset }, undefined, scopeReady && eventLens && settled.year !== undefined);
  const storms = useApi('/api/v1/cyclones', { year: settled.year, limit: 100, offset: settled.offset }, undefined, scopeReady && active.id === 'cyclones' && settled.year !== undefined);
  const stormRows = storms.data?.data.items ?? [];
  const storm = stormRows.find((row) => row.storm_id === settled.stormId) ?? stormRows.find((row) => row.name.toLowerCase() === 'fani') ?? stormRows[0];
  const track = useApi('/api/v1/cyclones/{storm_id}/track', undefined, { storm_id: storm?.storm_id ?? '' }, scopeReady && active.id === 'cyclones' && !!storm);
  const trackRows = [...(track.data?.data ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const region = filters.get('region')?.trim() ?? '';
  const temperature = useApi('/api/v1/trends/temperature', { region }, undefined, active.id === 'heat' && !!region);
  const drought = useApi('/api/v1/trends/drought', undefined, undefined, active.id === 'drought');
  const observation = rainfall.data?.data.find((row) => row.state_id === selectedState && row.date === date);
  const trendRows = [...(trend.data?.data ?? [])].sort((a, b) => (a.date ?? String(a.year)).localeCompare(b.date ?? String(b.year))).map((row) => ({ label: row.date ?? String(row.year), value: row.value }));
  const decades = [...new Set(years.map((value) => Math.floor(value / 10) * 10))].sort((a, b) => a - b);
  const activeDecade = year !== undefined ? `${Math.floor(year / 10) * 10}s` : null;
  const decadeOptions = decades.map((decade) => ({
    id: `${decade}s`,
    label: `${decade}s`,
    count: years.filter((value) => Math.floor(value / 10) * 10 === decade).length,
  }));
  const reportStartYear = active.id === 'rainfall' ? startYear : year;
  const reportEndYear = active.id === 'rainfall' ? endYear : year;
  const selectState = (stateId: string) => setFilters({ state_id: stateId || undefined, offset: undefined });
  const link = (path: string, patch: Record<string, string | undefined> = {}) => {
    const query = new URLSearchParams(filters);
    if (selectedState) query.set('state_id', selectedState);
    for (const [key, value] of Object.entries(patch)) { if (value === undefined) query.delete(key); else query.set(key, value); }
    return `#/${path}?${query.toString()}`;
  };
  const page = active.id === 'cyclones' ? storms.data?.data : events.data?.data;
  const pagination = !updating && (eventLens || active.id === 'cyclones') && (page || offset > 0) ? <nav className="filter-row record-pagination" aria-label={`${active.label} pagination`}>
    <button className="button" type="button" disabled={offset === 0} onClick={() => setFilters({ offset: String(Math.max(0, offset - 100)), storm_id: undefined })}>Previous 100</button>
    <p aria-live="polite">{page?.total ? page.items.length ? `${page.offset + 1}–${Math.min(page.offset + page.items.length, page.total)} of ${page.total}` : `No records on this page; ${page.total} matching records` : 'No matching records'}</p>
    <button className="button" type="button" disabled={!page || page.offset + page.limit >= page.total} onClick={() => setFilters({ offset: String(offset + 100), storm_id: undefined })}>Next 100</button>
  </nav> : null;

  return <>
    <header className="page-heading"><h1>Disaster explorer</h1><p className="muted">Keep geography, recorded periods, and source units in view.</p></header>
    <nav className="lens-strip" aria-label="Hazard lenses">{lenses.map(({ id, label, Icon }) => {
      const key = id === 'heat' ? 'temperature' : id;
      const count = catalog?.datasets?.[key]?.observation_count;
      return <a href={link('explorer', { hazard: id, offset: undefined, storm_id: undefined, start_year: undefined, end_year: undefined, month: undefined })} key={id} aria-current={active.id === id ? 'page' : undefined}><Icon size={17} aria-hidden="true" /><span>{label}</span>{count !== undefined && <span className="slicer-count" aria-hidden="true">{count.toLocaleString()}</span>}</a>;
    })}</nav>
    <section className="explorer-scope" aria-labelledby="explorer-scope-title">
      <h2 id="explorer-scope-title">{active.label}</h2>
      {catalog?.capabilities.omitted_datasets?.[dataset] && <p role="note"><strong>Backend coverage limitation:</strong> {catalog.capabilities.omitted_datasets[dataset]}</p>}
      <p className="muted">{active.scope}</p>
      {(metadata.isPending || metadata.error) && <QueryState query={metadata} />}
      {mapVisible && (states.isPending || states.error) && <QueryState query={states} />}
      {mapVisible && decadeOptions.length > 0 && <div className="slicer-bar">
        <SlicerRibbon label="Decade (years with records)" options={decadeOptions} value={activeDecade} onChange={(decadeId) => {
          if (!decadeId) { setFilters({ year: undefined, observation_date: undefined, offset: undefined, storm_id: undefined }); return; }
          const matching = years.filter((value) => `${Math.floor(value / 10) * 10}s` === decadeId);
          if (matching.length) setFilters({ year: String(matching.at(-1)), observation_date: undefined, offset: undefined, storm_id: undefined });
        }} />
      </div>}
      <div className="filter-row explorer-toolbar">
        {mapVisible && <div><label htmlFor="explorer-state">{active.id === 'cyclones' ? 'State for evidence / report (does not filter basin tracks)' : 'State / union territory'}</label><select id="explorer-state" value={selectedState} disabled={!stateRows.length} onChange={(event) => selectState(event.target.value)}>
          {active.id !== 'rainfall' && <option value="">{active.id === 'cyclones' ? 'No state selected' : 'All catalog states / unassigned events'}</option>}{!stateRows.length && <option value="">No states available</option>}{stateRows.map((state) => <option key={state.state_id} value={state.state_id}>{state.name}</option>)}
        </select></div>}
        {mapVisible && <div><label htmlFor="explorer-year">Available observation year</label><select id="explorer-year" value={year ?? ''} disabled={!years.length} onChange={(event) => setFilters({ year: event.target.value, observation_date: undefined, offset: undefined, storm_id: undefined })}>{!years.length && <option value="">No supported years</option>}{years.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>}
        {active.id === 'rainfall' && <div><label htmlFor="explorer-date">Recorded rainfall date</label><select id="explorer-date" value={date} disabled={!dates.length} onChange={(event) => setFilters({ observation_date: event.target.value })}>{!dates.length && <option value="">No supported dates</option>}{dates.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>}
        <button className="button" type="button" onClick={() => setFilters({ state_id: undefined, year: undefined, observation_date: undefined, start_year: undefined, end_year: undefined, month: undefined, storm_id: undefined, offset: undefined, region: undefined })}>Reset to available defaults</button>
      </div>
    </section>

    {mapVisible && <div className="explorer-workbench">
      <section className="map-stage" aria-label="Geographic evidence" aria-busy={evidenceBusy || (eventLens && events.isPending) || (active.id === 'cyclones' && (storms.isPending || track.isPending))}>
        <QueryState query={boundaries} empty={boundaries.data?.status === 'no_data'}>
          <IndiaMap boundaries={boundaries.data?.data} selectedState={selectedState || undefined} onSelect={selectState} showStateSelector={false} basemapHint={active.id === 'landslides' ? 'terrain' : undefined} rainfall={!updating && active.id === 'rainfall' ? rainfall.data?.data : undefined} points={!updating && eventLens ? events.data?.data.items : undefined} track={!updating && active.id === 'cyclones' ? trackRows : undefined} unit={!updating && active.id === 'rainfall' ? rainfall.data?.meta.unit : undefined} />
          <Evidence meta={boundaries.data?.meta} />
        </QueryState>
        {evidenceBusy ? <p role="status">Updating filters…</p> : active.id === 'rainfall' ? <Evidence meta={rainfall.data?.meta} /> : <p className="muted">{eventLens ? 'Only current-page events with valid coordinates are mapped. Records without coordinates remain in the list.' : 'Basin tracks do not establish state exposure or landfall.'}</p>}
      </section>
      {active.id === 'rainfall' ? <aside className="state-rail" aria-label="Selected state evidence" aria-busy={evidenceBusy}>
        <h2>{stateName ?? 'Selected state'}</h2><p className="muted">{selectedState}</p>
        <div className="filter-row"><div><label htmlFor="rainfall-start">Trend / report start year</label><select id="rainfall-start" value={startYear ?? ''} disabled={!rainfallYears.length} onChange={(event) => setFilters({ start_year: event.target.value })}>{!rainfallYears.length && <option value="">No supported years</option>}{rainfallYears.map((value) => <option key={value} value={value}>{value}</option>)}</select></div><div><label htmlFor="rainfall-end">Trend / report end year</label><select id="rainfall-end" value={endYear ?? ''} disabled={!rainfallYears.length} onChange={(event) => setFilters({ end_year: event.target.value })}>{!rainfallYears.length && <option value="">No supported years</option>}{rainfallYears.map((value) => <option key={value} value={value}>{value}</option>)}</select></div></div>
        {evidenceBusy ? <p role="status">Updating filters…</p> : <>
          {date ? <QueryState query={rainfall}>
            <div className="kpi-grid">
              <KpiCard label="Recorded rainfall" outputLabel="Recorded rainfall value" value={observation ? observation.value : null} unit={rainfall.data?.meta.unit} missingText="No observation for this date" info="Single-date source value for the selected state; not an annual total or anomaly." badge={<>Recorded rainfall on <time dateTime={date}>{date}</time></>} tone={observation ? 'ok' : 'neutral'} series={trendRows} />
            </div>
          </QueryState> : <p>No backend-supported rainfall dates are available.</p>}
          {!validPeriod ? <p role="alert">Choose a supported start year no later than the end year.</p> : selectedState && <QueryState query={trend} empty={trend.data?.status === 'no_data' || trend.data?.data.length === 0}><TrendChart title="Observed rainfall series (not annual totals)" unit={trend.data?.meta.unit} meta={trend.data?.meta} rows={trendRows} /></QueryState>}
        </>}
        <p className="muted">Date labels retain source resolution. No monthly or annual aggregation is calculated.</p>
        {selectedState && validPeriod && <ReportDownload stateId={selectedState} startYear={startYear!} endYear={endYear!} disabled={updating || trend.isPending || !trend.data?.data.length} />}
        <a href={link('insights', { start_year: startYear?.toString(), end_year: endYear?.toString() })}>NIElytics insights for this state</a>
      </aside> : <section className="record-rail" aria-label="Recorded observations" aria-busy={updating}>
        {updating ? <p role="status">Updating filters…</p> : eventLens ? <>
          <h2>{active.label} · Recorded events</h2>
          {year !== undefined ? <QueryState query={events} empty={events.data?.status === 'no_data' || events.data?.data.items.length === 0}>
            <div className="kpi-grid">
              <KpiCard label={`${active.label} matching records`} value={events.data?.data.total ?? null} unit="matching records" badge={selectedState ? `${stateName ?? selectedState} · ${year}` : `All catalog states · ${year}`} />
            </div>
            <ol className="event-records" start={offset + 1}>{events.data?.data.items.map((event) => {
              const located = event.latitude != null && event.longitude != null && Number.isFinite(event.latitude) && Number.isFinite(event.longitude) && Math.abs(event.latitude) <= 90 && Math.abs(event.longitude) <= 180;
              return <li key={event.event_id}><h3>{event.event_id}</h3><p>{stateRows.find((state) => state.state_id === event.state_id)?.name ?? event.state_id ?? 'Not assigned'}</p><p>{event.timestamp ? <time dateTime={event.timestamp}>{event.timestamp}</time> : event.year ?? 'Source date not recorded'}</p><p>{located ? `Latitude: ${event.latitude}; longitude: ${event.longitude}` : 'Location not available'}</p><details><summary>Source attributes</summary>{Object.keys(event.attributes ?? {}).length ? <dl>{Object.entries(event.attributes ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl> : <p>No source attributes supplied.</p>}</details></li>;
            })}</ol><Evidence meta={events.data?.meta} />
          </QueryState> : <p>The backend has not declared available years for this event family.</p>}
        </> : <>
          <h2>Cyclones · Observed tracks</h2>
          {year !== undefined ? <QueryState query={storms} empty={storms.data?.status === 'no_data' || stormRows.length === 0}>
            <div className="kpi-grid">
              <KpiCard label="Catalog storms" value={storms.data?.data.total ?? null} unit={`season ${year}`} badge={storm ? `${storm.name} · ${trackRows.length} track points` : undefined} />
            </div>
            <label htmlFor="explorer-storm">Storm from the returned year / page</label><select id="explorer-storm" value={storm?.storm_id ?? ''} onChange={(event) => setFilters({ storm_id: event.target.value })}>{stormRows.map((row) => <option key={row.storm_id} value={row.storm_id}>{row.name} · {row.year} · {row.storm_id}</option>)}</select><Evidence meta={storms.data?.meta} /></QueryState> : <p>No supported cyclone years are available.</p>}
          {!!storm && <QueryState query={track} empty={track.data?.status === 'no_data' || trackRows.length === 0}>
            <h3>{storm.name} · {storm.year} · {storm.storm_id}</h3><a className="button primary" href={link('time-machine', { hazard: 'cyclones', year: String(storm.year), storm_id: storm.storm_id, offset: undefined })}>Replay these recorded observations</a>
            <p>{trackRows.length} returned observations; no interpolation.</p>
            <details><summary>Recorded positions and source measurements</summary><div className="table-scroll"><table><thead><tr><th scope="col">Source timestamp</th><th scope="col">Latitude</th><th scope="col">Longitude</th><th scope="col">Wind</th><th scope="col">Pressure</th></tr></thead><tbody>{trackRows.map((row, index) => <tr key={`${row.timestamp}-${index}`}><th scope="row"><time dateTime={row.timestamp}>{row.timestamp}</time></th><td>{row.latitude}</td><td>{row.longitude}</td><td>{row.wind == null ? 'Not available' : `${row.wind} ${row.wind_unit ?? '(source unit unspecified)'}`}</td><td>{row.pressure == null ? 'Not available' : `${row.pressure} ${row.pressure_unit ?? '(source unit unspecified)'}`}</td></tr>)}</tbody></table></div></details><Evidence meta={track.data?.meta} />
          </QueryState>}
        </>}
        {pagination}
      </section>}
    </div>}

    {active.id === 'heat' && <section className="regional-workspace"><h2>Regional temperature</h2><p className="muted">Select a source region or enter an identifier; annual summer maximum temperature (°C) from IMD / MoSPI EnviStats.</p>
      <div className="slicer-bar">
        <SlicerRibbon label="Quick region" options={['India', 'Rajasthan', 'Andhra Pradesh', 'Karnataka', 'Maharashtra', 'Uttar Pradesh'].map((id) => ({ id, label: id }))} value={region || null} onChange={(next) => setFilters({ region: next ?? undefined, start_year: undefined, end_year: undefined, month: undefined })} />
      </div>
      <form className="filter-row" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); setFilters({ region: String(data.get('region') ?? '').trim() || undefined, start_year: undefined, end_year: undefined, month: undefined }); }}><div><label htmlFor="temperature-region">Source region identifier</label><input id="temperature-region" name="region" key={region} defaultValue={region} maxLength={100} required /></div><button className="button primary" type="submit">Load regional temperature</button></form>
      {region ? <QueryState query={temperature} empty={temperature.data?.status === 'no_data' || temperature.data?.data.length === 0}>{temperature.data?.status === 'ok' && !!temperature.data.data.length && <ReturnedSeries key={region} rows={temperature.data.data} meta={temperature.data.meta} title={`Regional temperature · ${region}`} allowMonths />}</QueryState> : <p>No temperature request is made until a source region is supplied.</p>}
    </section>}
    {active.id === 'drought' && <section className="regional-workspace"><h2>National drought indicator</h2><QueryState query={drought} empty={drought.data?.status === 'no_data' || drought.data?.data.length === 0}>{drought.data?.status === 'ok' && !!drought.data.data.length && <ReturnedSeries rows={drought.data.data} meta={drought.data.meta} title="National drought observations" allowMonths={false} />}</QueryState><p className="muted">No state-level drought estimates, choropleths, or temperature/drought state comparisons are supported.</p></section>}

    <section className="evidence-followup"><h2>Follow the evidence{mapVisible && stateName ? ` · ${stateName}` : ''}</h2>
      {mapVisible ? <>
        {active.id !== 'rainfall' && <a className="button" href={link('insights', { start_year: reportStartYear?.toString(), end_year: reportEndYear?.toString() })}>NIElytics insights{stateName ? ' for this state' : ''}</a>}
        {active.id !== 'rainfall' && (selectedState && reportStartYear !== undefined && reportEndYear !== undefined ? <ReportDownload stateId={selectedState} startYear={reportStartYear} endYear={reportEndYear} disabled={updating} /> : <p className="muted">Select a confirmed state and supported historical period for a backend report. A cyclone year does not establish state exposure or landfall.</p>)}
      </> : <p className="muted">The current insight and report contracts require a state. They do not supply regional temperature or national drought interpretations.</p>}
      <a href={link('sources')}>Sources, methods, and limitations</a><p className="muted">Unavailable observations are not measured zero. Unequal reporting coverage is not a difference in hazard intensity. Historical analysis only, not forecasts or official alerts.</p>
    </section>
  </>;
}
