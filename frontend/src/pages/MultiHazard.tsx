import { useState } from 'react';
import { CalendarDays, Layers } from 'lucide-react';
import { useApi } from '../api/client';
import type { EventRecord } from '../api/types';
import { Evidence, QueryState } from '../components/DataPanels';
import { KpiCard, SlicerRibbon } from '../components/Executive';
import IndiaMap from '../components/IndiaMap';
import { useFilters } from '../hooks/useFilters';

export default function MultiHazard() {
  const states = useApi('/api/v1/states');
  const catalog = useApi('/api/v1/metadata');
  const { filters, setFilters } = useFilters();
  const [showMap, setShowMap] = useState(false);
  const [selectedRelationship, setSelectedRelationship] = useState('');
  const [hazardSlicer, setHazardSlicer] = useState<string | null>(null);
  const [decadeSlicer, setDecadeSlicer] = useState<string | null>(null);
  const [tablePosition, setTablePosition] = useState({ identity: '', page: 0 });
  const stateRecords = states.data?.data ?? [];
  const stateId = filters.get('state_id') ?? stateRecords[0]?.state_id ?? '';
  const available = catalog.data?.data.capabilities.available_years;
  const years = [...new Set(['floods', 'landslides'].flatMap((dataset) => available?.[dataset] ?? []))].sort((a, b) => a - b);
  const startYear = Number(filters.get('start_year') ?? years[0]);
  const endYear = Number(filters.get('end_year') ?? years.at(-1));
  const validState = stateRecords.some((state) => state.state_id === stateId);
  const validPeriod = years.includes(startYear) && years.includes(endYear) && startYear <= endYear;
  const enabled = validState && validPeriod;
  const relationships = useApi('/api/v1/multi-hazard', { state_id: stateId, start_year: startYear, end_year: endYear }, undefined, enabled);
  const records = relationships.data?.data ?? [];
  const active = records.find((record) => record.id === selectedRelationship) ?? records[0];
  const allObservations = [...(active?.observations ?? [])].sort((a, b) => (a.timestamp ?? String(a.year ?? '')).localeCompare(b.timestamp ?? String(b.year ?? '')));
  const rowYear = (row: (typeof allObservations)[number]) => row.year ?? (row.timestamp ? Number(row.timestamp.slice(0, 4)) : NaN);
  const hazardOptions = [...new Set(allObservations.map((row) => row.hazard))].map((hazard) => ({
    id: hazard,
    label: hazard,
    count: allObservations.filter((row) => row.hazard === hazard).length,
  }));
  const distinctYears = [...new Set(allObservations.map(rowYear).filter((y) => Number.isFinite(y)))].sort((a, b) => a - b);
  const decadeOptions = [...new Set(distinctYears.map((y) => Math.floor(y / 10) * 10))].map((decade) => ({
    id: `${decade}s`,
    label: `${decade}s`,
    count: distinctYears.filter((y) => Math.floor(y / 10) * 10 === decade).length,
  }));
  const observations = allObservations.filter((row) => {
    if (hazardSlicer && row.hazard !== hazardSlicer) return false;
    if (decadeSlicer) {
      const y = rowYear(row);
      if (!Number.isFinite(y) || `${Math.floor(y / 10) * 10}s` !== decadeSlicer) return false;
    }
    return true;
  });
  const identity = JSON.stringify([stateId, startYear, endYear, active?.id, hazardSlicer, decadeSlicer]);
  if (tablePosition.identity !== identity) {
    setTablePosition({ identity, page: 0 });
  }
  const lastPage = Math.max(0, Math.ceil(observations.length / 50) - 1);
  const page = tablePosition.identity === identity ? Math.min(tablePosition.page, lastPage) : 0;
  const visibleObservations = observations.slice(page * 50, (page + 1) * 50);
  const hasYearOnly = observations.some((observation) => !observation.timestamp && observation.year != null);
  const points: EventRecord[] = observations.map((observation) => ({
    event_id: observation.event_id,
    state_id: observation.state_id,
    year: observation.year,
    timestamp: observation.timestamp,
    longitude: observation.longitude,
    latitude: observation.latitude,
    attributes: { hazard: observation.hazard, source_ids: active?.source_ids ?? [] },
  }));
  const boundariesAvailable = catalog.data?.data.capabilities.boundaries === true;
  const boundaries = useApi('/api/v1/boundaries', undefined, undefined, showMap && boundariesAvailable && Boolean(active));

  return (
    <>
      <header className="page-heading">
        <h1>Multi-hazard explorer</h1>
        <p className="muted">Inspect backend-supplied relationships and their original source records.</p>
      </header>
      <section className="work-section" aria-labelledby="multi-scope-title">
        <h2 id="multi-scope-title"><Layers size={22} aria-hidden="true" /> Observation scope</h2>
        <QueryState query={states} empty={Boolean(states.data) && stateRecords.length === 0}>
          <QueryState query={catalog}>
            <div className="filter-row">
              <label htmlFor="multi-state">State
                <select id="multi-state" value={stateId} onChange={(event) => setFilters({ state_id: event.target.value })}>
                  {!validState && <option value={stateId}>Select a catalog state</option>}
                  {stateRecords.map((state) => <option key={state.state_id} value={state.state_id}>{state.name}</option>)}
                </select>
              </label>
              <label htmlFor="multi-start">Start year
                <select id="multi-start" value={years.includes(startYear) ? startYear : ''} disabled={!years.length} onChange={(event) => setFilters({ start_year: event.target.value })}>
                  {!years.includes(startYear) && <option value="">Select an observed year</option>}
                  {years.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              </label>
              <label htmlFor="multi-end">End year
                <select id="multi-end" value={years.includes(endYear) ? endYear : ''} disabled={!years.length} onChange={(event) => setFilters({ end_year: event.target.value })}>
                  {!years.includes(endYear) && <option value="">Select an observed year</option>}
                  {years.map((year) => <option key={year} value={year} disabled={year < startYear}>{year}</option>)}
                </select>
              </label>
              <button className="button" type="button" onClick={() => setFilters({ state_id: undefined, start_year: undefined, end_year: undefined })}>Reset to catalog defaults</button>
            </div>
            <p className="muted">Flood and landslide catalog years do not establish overlapping state coverage. Each returned relationship defines its actual scope.</p>
            {!enabled && <p role="status">Select a catalog state and an ordered observation period.</p>}
          </QueryState>
        </QueryState>
      </section>
      <p className="research-note"><strong>Co-occurrence is not causation or simultaneity.</strong> Records in the same state or period do not establish simultaneous events or a causal connection. No combined hazard score is computed here.</p>
      {enabled ? <>
        <QueryState query={relationships} empty={relationships.data?.status === 'no_data' || (Boolean(relationships.data) && records.length === 0)}>
          <div className="multi-workbench">
            <section className="relationship-index" aria-labelledby="multi-relationships-title">
              <h2 id="multi-relationships-title">Returned relationships</h2>
              <ul className="relationship-list">{records.map((relationship) => <li key={relationship.id}>
                <button type="button" className="relationship-choice" aria-pressed={active?.id === relationship.id} onClick={() => setSelectedRelationship(relationship.id)}>
                  <strong>{relationship.title}</strong>
                  <span>{relationship.hazards.join(', ')}</span>
                  <span>{relationship.observation_count.toLocaleString()} source observations</span>
                </button>
              </li>)}</ul>
            </section>
            {active && <section className="relationship-records" aria-labelledby="multi-observations-title">
              <h2 id="multi-observations-title"><CalendarDays size={22} aria-hidden="true" /> {active.title}</h2>
              <p>{active.description}</p>
              <div className="kpi-grid">
                <KpiCard label="Source observations" value={active.observation_count} unit="records" badge={`${active.region} (${active.state_ids.join(', ') || 'unassigned'})`} tone="ok" />
                <KpiCard label="Source period" value={`${active.period.start ?? '—'}–${active.period.end ?? '—'}`} unit={active.hazards.join(' + ')} badge={<span className="source-links">Sources: {active.source_ids.length ? active.source_ids.map((id) => <a key={id} href={`#/sources?source_id=${encodeURIComponent(id)}`}>{id}</a>) : 'Not provided'}</span>} />
              </div>
              <details><summary>How was this relationship identified?</summary><p>{active.method || 'Calculation details not provided'}</p><ul>{active.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details>
              <div className="slicer-bar">
                {hazardOptions.length > 0 && <SlicerRibbon label="Hazard (source records)" options={hazardOptions} value={hazardSlicer} onChange={setHazardSlicer} />}
                {decadeOptions.length > 0 && <SlicerRibbon label="Decade (years with records)" options={decadeOptions} value={decadeSlicer} onChange={setDecadeSlicer} onReset={hazardSlicer || decadeSlicer ? () => { setHazardSlicer(null); setDecadeSlicer(null); } : undefined} />}
              </div>
              <button className="button" type="button" aria-expanded={showMap} aria-controls="multi-observation-map" onClick={() => setShowMap((shown) => !shown)}>{showMap ? 'Hide' : 'Show'} observed-record map</button>
              {showMap && <div id="multi-observation-map">{boundariesAvailable ? <QueryState query={boundaries} empty={boundaries.data?.status === 'no_data' || (Boolean(boundaries.data) && boundaries.data?.data.features.length === 0)}>
                <IndiaMap boundaries={boundaries.data?.data} selectedState={stateId} onSelect={(id) => setFilters({ state_id: id })} showStateSelector={false} basemapHint={observations.some((row) => row.hazard.toLowerCase().includes('landslide')) ? 'terrain' : undefined} points={points} />
                {!points.some((point) => point.longitude != null && point.latitude != null) && <p>No observation has source coordinates; no markers are fabricated.</p>}
                <Evidence meta={boundaries.data?.meta} />
              </QueryState> : <p>Official boundary geometry is unavailable. Use the state selector and observed-record table.</p>}</div>}
              <h3>Chronological source records</h3>
              <p className="muted">Original timestamps are retained without timezone conversion, interpolation or inferred precision. Missing timestamps remain missing.</p>
              {hasYearOnly && <p className="muted">Year-only records have no within-year ordering.</p>}
              {observations.length ? <>
                <div className="table-scroll"><table>
                  <caption>Source records supplied with this relationship</caption>
                  <thead><tr><th scope="col">Source timestamp / year</th><th scope="col">Hazard</th><th scope="col">Event ID</th><th scope="col">State ID</th><th scope="col">Coordinates (longitude, latitude)</th></tr></thead>
                  <tbody>{visibleObservations.map((observation, index) => <tr key={`${observation.hazard}-${observation.event_id}-${page * 50 + index}`}>
                    <th scope="row">{observation.timestamp ? <time dateTime={observation.timestamp}>{observation.timestamp}</time> : observation.year != null ? `${observation.year} (year only)` : 'Timestamp not provided'}</th><td>{observation.hazard}</td><td>{observation.event_id}</td><td>{observation.state_id ?? 'Not attributed'}</td><td>{observation.longitude != null && observation.latitude != null ? `${observation.longitude}, ${observation.latitude}` : 'Not provided — not mapped'}</td>
                  </tr>)}</tbody>
                </table></div>
                <div className="pagination" aria-label="Observation table pagination">
                  <button type="button" className="button" disabled={page === 0} onClick={() => setTablePosition({ identity, page: page - 1 })}>Previous observations</button>
                  <p role="status">Records {page * 50 + 1}–{Math.min((page + 1) * 50, observations.length)} of {observations.length.toLocaleString()}</p>
                  <button type="button" className="button" disabled={page >= lastPage} onClick={() => setTablePosition({ identity, page: page + 1 })}>Next observations</button>
                </div>
              </> : <p>No observed records were supplied for this relationship.</p>}
            </section>}
          </div>
        </QueryState>
        <Evidence meta={relationships.data?.meta} />
      </> : <div className="empty-state">Relationships require valid state and period selections.</div>}
      <p className="muted">Historical analysis only: no real-time forecasts, official alerts or validated future predictions.</p>
    </>
  );
}
