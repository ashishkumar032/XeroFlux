import { ArrowRight, Droplets, Mountain, Thermometer, Waves, Wind } from 'lucide-react';
import { useApi } from '../api/client';
import { Evidence, QueryState, ReportDownload, TrendChart } from '../components/DataPanels';
import { KpiCard, SlicerRibbon } from '../components/Executive';
import IndiaMap from '../components/IndiaMap';
import { useFilters } from '../hooks/useFilters';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

const hazards = [
  { id: 'heat', dataset: 'temperature', label: 'Heat', Icon: Thermometer },
  { id: 'floods', dataset: 'floods', label: 'Floods', Icon: Waves },
  { id: 'drought', dataset: 'drought', label: 'Drought', Icon: Droplets },
  { id: 'landslides', dataset: 'landslides', label: 'Landslides', Icon: Mountain },
  { id: 'cyclones', dataset: 'cyclones', label: 'Cyclones', Icon: Wind },
];

export default function Overview() {
  const { filters, setFilters } = useFilters();
  const metadata = useApi('/api/v1/metadata');
  const states = useApi('/api/v1/states');
  const boundaries = useApi('/api/v1/boundaries');
  const catalog = metadata.data?.data;
  const capabilities = catalog?.capabilities;
  const dates = [...(capabilities?.rainfall_observation_dates ?? [])].sort();
  const requestedDate = filters.get('observation_date') ?? '';
  const date = dates.includes(requestedDate) ? requestedDate : dates.at(-1) ?? '';
  const stateRows = states.data?.data ?? [];
  const requestedState = filters.get('state_id') ?? '';
  const selectedState = stateRows.some((state) => state.state_id === requestedState) ? requestedState : stateRows[0]?.state_id ?? '';
  const years = [...(capabilities?.available_years?.rainfall ?? [])].sort((a, b) => a - b);
  const startYear = years[0];
  const endYear = years.at(-1);
  const identity = JSON.stringify({ date, selectedState, startYear, endYear });
  const settledIdentity = useDebouncedValue(identity);
  const settled = JSON.parse(settledIdentity) as { date: string; selectedState: string; startYear?: number; endYear?: number };
  const updating = identity !== settledIdentity;
  const rainfall = useApi('/api/v1/map/rainfall', {
    year: Number(settled.date.slice(0, 4)), observation_date: settled.date,
  }, undefined, !!settled.date);
  const evidenceBusy = updating || (!!date && rainfall.isPending);
  const trend = useApi('/api/v1/trends/rainfall', {
    state_id: settled.selectedState, start_year: settled.startYear, end_year: settled.endYear,
  }, undefined, !!settled.selectedState && settled.startYear !== undefined && settled.endYear !== undefined);
  const focusedHazard = filters.get('hazard') ?? 'rainfall';
  const eventHazard = focusedHazard === 'floods' || focusedHazard === 'landslides' ? focusedHazard : null;
  const stateEvents = useApi(eventHazard === 'landslides' ? '/api/v1/events/landslides' : '/api/v1/events/floods',
    { state_id: settled.selectedState, limit: 1, offset: 0 }, undefined, !!eventHazard && !!settled.selectedState);
  const stateName = stateRows.find((state) => state.state_id === selectedState)?.name ?? 'Selected state';
  const observation = rainfall.data?.data.find((row) => row.state_id === selectedState && row.date === date);
  const trendRows = [...(trend.data?.data ?? [])].sort((a, b) => (a.date ?? String(a.year)).localeCompare(b.date ?? String(b.year))).map((row) => ({ label: row.date ?? String(row.year), value: row.value }));
  const slicerOptions = [
    { id: 'rainfall', label: 'Rainfall', count: catalog?.datasets?.rainfall?.observation_count ?? null },
    ...hazards.map(({ id, dataset, label }) => ({
      id,
      label,
      count: catalog?.datasets?.[dataset]?.observation_count ?? null,
      disabled: Boolean(capabilities && !capabilities.available_hazards?.includes(id)),
    })),
  ];
  const selectState = (state: string) => setFilters({ state_id: state });
  const route = (path: string, patch: Record<string, string> = {}) => {
    const query = new URLSearchParams(filters);
    if (selectedState) query.set('state_id', selectedState);
    if (startYear !== undefined) query.set('start_year', String(startYear));
    if (endYear !== undefined) query.set('end_year', String(endYear));
    for (const [key, value] of Object.entries(patch)) query.set(key, value);
    return `#/${path}?${query.toString()}`;
  };

  return <>
    <header className="page-heading">
      <div className="heading-row">
        <div>
          <h1>India climate atlas</h1>
          <p className="muted">Select a place and recorded date to examine the source observations.</p>
        </div>
        <dl className="coverage-ledger" aria-label="Catalog summary">
          <div><dt>Geographic areas</dt><dd>{states.data?.data.length ?? '—'}</dd></div>
          <div><dt>Datasets</dt><dd>{capabilities?.available_datasets?.length ?? '—'}</dd></div>
          <div><dt>Hazard catalogs</dt><dd>{capabilities?.available_hazards?.length ?? '—'}</dd></div>
        </dl>
      </div>
      <p className="coverage-note muted">Geographical coverage does not imply analytical coverage.</p>
    </header>
    <div className="filter-row atlas-toolbar">
      <div><label htmlFor="overview-date">Recorded rainfall date</label><select id="overview-date" value={date} disabled={!dates.length} onChange={(event) => setFilters({ observation_date: event.target.value })}>
        {!dates.length && <option value="">No supported dates</option>}{dates.map((value) => <option key={value} value={value}>{value}</option>)}
      </select></div>
      <div><label htmlFor="overview-state">State / union territory</label><select id="overview-state" value={selectedState} disabled={!stateRows.length} onChange={(event) => selectState(event.target.value)}>
        {!stateRows.length && <option value="">No states available</option>}{stateRows.map((state) => <option key={state.state_id} value={state.state_id}>{state.name}</option>)}
      </select></div>
    </div>
    {(metadata.isPending || metadata.error) && <QueryState query={metadata} />}
    {(states.isPending || states.error) && <QueryState query={states} />}
    <div className="atlas-workbench">
      <section className="map-stage" aria-label="Official India rainfall map" aria-busy={evidenceBusy}>
        <QueryState query={boundaries} empty={boundaries.data?.status === 'no_data'}>
          <IndiaMap boundaries={boundaries.data?.data} rainfall={updating ? undefined : rainfall.data?.data} selectedState={selectedState} onSelect={selectState} showStateSelector={false} basemapHint={focusedHazard === 'landslides' ? 'terrain' : undefined} unit={updating ? undefined : rainfall.data?.meta.unit} />
          {evidenceBusy && <p className="map-update-status" role="status">Updating filters…</p>}
          <div className="map-evidence-tray">
            <Evidence meta={boundaries.data?.meta} />
            {!updating && !!date && <Evidence meta={rainfall.data?.meta} />}
          </div>
        </QueryState>
      </section>
      <aside className="state-rail" aria-label="Selected state evidence" aria-busy={evidenceBusy}>
        <div className="state-rail-head">
          <h2>{stateName}</h2>
          <span className="state-code muted">{selectedState || 'No catalog state selected'}</span>
        </div>
        {evidenceBusy ? <p role="status">Updating filters…</p> : date ? <>
          <QueryState query={rainfall}>
            <div className="kpi-grid">
              <KpiCard label="Recorded rainfall" outputLabel="Recorded rainfall value" value={observation ? observation.value : null} unit={rainfall.data?.meta.unit} missingText="No observation for this date" info="Single-date source observation for the selected state; not an annual total or anomaly." badge={<>Recorded rainfall on <time dateTime={date}>{date}</time></>} tone={observation ? 'ok' : 'neutral'} series={trendRows} />
              {eventHazard && !stateEvents.isPending && !stateEvents.error && <KpiCard label={eventHazard === 'landslides' ? 'State landslide records' : 'State flood records'} value={stateEvents.data?.data.total ?? null} unit="catalog events" info="Reported events in the catalog matched to this state." badge={stateName} />}
            </div>
          </QueryState>
          {selectedState && years.length > 0 && <QueryState query={trend} empty={trend.data?.status === 'no_data' || trend.data?.data.length === 0}>
            <TrendChart title="Observed rainfall series" unit={trend.data?.meta.unit} meta={trend.data?.meta} rows={trendRows} />
          </QueryState>}
        </> : <p className="muted">The backend does not declare supported rainfall dates.</p>}
        <div className="route-links"><a href={route('explorer', { hazard: 'rainfall' })}>Explore this state <ArrowRight size={14} aria-hidden="true" /></a><a href={route('insights')}>NIElytics insights for this state</a></div>
        {selectedState && startYear !== undefined && endYear !== undefined && <ReportDownload stateId={selectedState} startYear={startYear} endYear={endYear} disabled={updating || trend.isPending || !trend.data?.data.length} />}
      </aside>
    </div>
    <section className="hazard-section" aria-labelledby="hazard-section-title">
      <div className="section-head">
        <h2 id="hazard-section-title">Hazard catalogs &amp; source records</h2>
        <p className="muted">Filter map focus or jump to hazard lenses in Disaster Explorer.</p>
      </div>
      <div className="slicer-bar">
        <SlicerRibbon label="Hazard focus (source records)" options={slicerOptions} value={focusedHazard} onChange={(id) => setFilters({ hazard: id ?? undefined })} onReset={filters.get('hazard') ? () => setFilters({ hazard: undefined }) : undefined} />
      </div>
      <nav className="instrument-strip" aria-label="Hazard lenses">{hazards.map(({ id, dataset, label, Icon }) => {
        const available = capabilities?.available_hazards?.includes(id);
        const reason = capabilities?.omitted_datasets?.[dataset];
        return <a key={id} href={route('explorer', { hazard: id })}><Icon size={19} aria-hidden="true" /><span>{label}<small>{available ? 'Catalog available' : reason ? 'Coverage unavailable' : capabilities ? 'Not declared available' : 'Loading coverage'}</small></span></a>;
      })}</nav>
    </section>
    <details className="dataset-coverage"><summary>Dataset coverage &amp; limitations</summary><QueryState query={metadata}>
      {Object.entries(catalog?.datasets ?? {}).map(([name, meta]) => <section key={name}><h2>{name}</h2><Evidence meta={meta} /></section>)}
      {Object.entries(capabilities?.omitted_datasets ?? {}).map(([name, reason]) => <p key={name}><strong>{name} unavailable:</strong> {reason}</p>)}
      <p><a className="source-link" href="#/sources">Review complete sources and methodology</a></p>
    </QueryState></details>
    <p className="coverage-disclaimer muted">Historical observations only, not forecasts or official alerts. Missing observations are not measured zero.</p>
  </>;
}
