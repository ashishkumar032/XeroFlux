import { useEffect, useMemo, type ReactNode } from 'react';
import { Clock3, Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
import { useApi } from '../api/client';
import type { Catalog, StormRecord } from '../api/types';
import { Evidence, QueryState } from '../components/DataPanels';
import IndiaMap, { type IndiaMapProps } from '../components/IndiaMap';
import { useFilters } from '../hooks/useFilters';
import { usePlayback, type Playback } from '../hooks/usePlayback';

const categoryLabels = { cyclones: 'Cyclones', rainfall: 'Rainfall', floods: 'Floods', landslides: 'Landslides' } as const;
type Category = keyof typeof categoryLabels;

function PlaybackControls({ playback, count, timestamp }: { playback: Playback; count: number; timestamp?: string }) {
  return <section className="replay-playback" aria-labelledby="playback-controls-title">
    <h2 id="playback-controls-title">Observation-step playback</h2>
    {!count && <p role="status">No compatible source observations are loaded. Playback is unavailable.</p>}
    {count === 1 && <p>One observation is available for inspection; Play and Step require at least two observations.</p>}
    <div className="playback-controls" aria-describedby="playback-reason">
      <button className="button primary" type="button" disabled={count < 2 || playback.playing} onClick={playback.play}><Play size={16} aria-hidden="true" /> Play</button>{' '}
      <button className="button" type="button" disabled={!count || !playback.playing} onClick={playback.pause}><Pause size={16} aria-hidden="true" /> Pause</button>{' '}
      <button className="button" type="button" disabled={!count} onClick={playback.restart}><RotateCcw size={16} aria-hidden="true" /> Restart</button>{' '}
      <button className="button" type="button" disabled={count < 2 || playback.index >= count - 1} onClick={playback.step}><SkipForward size={16} aria-hidden="true" /> Step</button>
    </div>
    <p id="playback-reason" className="muted">Speed counts source observations, not elapsed weather time. At 1×, one observation advances each second.</p>
    <div className="playback-timeline">
      <div>
        <label htmlFor="playback-speed">Playback speed</label>
        <select id="playback-speed" value={playback.speed} disabled={!count} onChange={event => playback.setSpeed(Number(event.target.value))}>
          <option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option>
        </select>
      </div>
      <div>
        <label htmlFor="playback-position">Observation timeline</label>
        <input id="playback-position" type="range" min="0" max={Math.max(0, count - 1)} value={playback.index} disabled={!count} onChange={event => playback.seek(Number(event.target.value))} aria-valuetext={timestamp ? `Observation ${playback.index + 1} of ${count}: ${timestamp}` : 'No recorded observations available'} />
      </div>
    </div>
    <p role="status">{count ? `Observation ${playback.index + 1} of ${count} · ${playback.playing ? 'Playing' : 'Paused'} · ${timestamp ?? 'Source timestamp unavailable'}` : 'No observations'}</p>
  </section>;
}

function ReplayMap({ controls, ...props }: Omit<IndiaMapProps, 'boundaries'> & { controls: ReactNode }) {
  // This component exists only on the active replay map. useApi caches boundaries for five minutes.
  const boundaries = useApi('/api/v1/boundaries');
  return <section className="replay-stage" aria-label="Observed geography and playback">
    <QueryState query={boundaries} empty={boundaries.data?.status === 'no_data' || boundaries.data?.data.features.length === 0}>
      <IndiaMap {...props} boundaries={boundaries.data?.data} />
    </QueryState>
    {controls}
    <Evidence meta={boundaries.data?.meta} />
  </section>;
}

function PageControls({ page, onChange, label }: { page: { offset: number; limit: number; total: number; items: unknown[] }; onChange: (offset: number) => void; label: string }) {
  return <div className="replay-page-controls">
    <p className="muted">Current-page coverage: {page.items.length ? page.offset + 1 : 0}–{page.offset + page.items.length} of {page.total} {label}. Only this page is loaded, not the full history.</p>
    {page.offset > 0 && <button className="button" type="button" onClick={() => onChange(Math.max(0, page.offset - page.limit))}>Previous {label} page</button>}
    {page.offset + page.items.length < page.total && <button className="button" type="button" onClick={() => onChange(page.offset + page.limit)}>Next {label} page</button>}
  </div>;
}

function StormReplay({ storm }: { storm: StormRecord }) {
  const track = useApi('/api/v1/cyclones/{storm_id}/track', undefined, { storm_id: storm.storm_id });
  const records = useMemo(() => [...(track.data?.data ?? [])].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), [track.data]);
  const playback = usePlayback(records.length, `cyclones:${storm.year}:${storm.storm_id}`);
  const current = records[playback.index];
  const ready = !track.isPending && !track.error && track.data?.status === 'ok' && records.length > 0;
  const controls = <PlaybackControls playback={playback} count={ready ? records.length : 0} timestamp={ready ? current?.timestamp : undefined} />;
  return <>
    <QueryState query={track} empty={track.data?.status === 'no_data' || records.length === 0}>
      <div className="replay-workbench">
        <ReplayMap track={records} activePoint={current} controls={controls} />
        <aside className="replay-readout" aria-labelledby="replay-observation-title">
          <h2 id="replay-observation-title"><Clock3 size={21} aria-hidden="true" /> Source record</h2>
          <dl>
            <dt>Source timestamp</dt><dd>{current ? <time dateTime={current.timestamp}>{current.timestamp}</time> : 'Not available'}</dd>
            <dt>Storm identity</dt><dd>{storm.name} · {storm.storm_id} · catalog season {storm.year}</dd>
            <dt>Recorded position (longitude, latitude)</dt><dd>{current ? `${current.longitude}, ${current.latitude}` : 'Not available'}</dd>
            <dt>Recorded wind</dt><dd>{current?.wind != null ? `${current.wind} ${current.wind_unit ?? '(source unit unspecified)'}` : 'Not available'}{current?.wind == null && current?.wind_unit ? ` · source unit: ${current.wind_unit}` : ''}</dd>
            <dt>Recorded pressure</dt><dd>{current?.pressure != null ? `${current.pressure} ${current.pressure_unit ?? '(source unit unspecified)'}` : 'Not available'}{current?.pressure == null && current?.pressure_unit ? ` · source unit: ${current.pressure_unit}` : ''}</dd>
          </dl>
          <p className="muted">The complete returned route is shown. The marker moves between recorded positions only; no interpolation, inferred wind, pressure or landfall.</p>
          <Evidence meta={track.data?.meta} />
        </aside>
      </div>
    </QueryState>
    {!ready && <>{controls}<Evidence meta={track.data?.meta} /></>}
  </>;
}

function CycloneReplay({ year, scopeControls }: { year: number; scopeControls: ReactNode }) {
  const { filters, setFilters } = useFilters();
  const requestedOffset = Number(filters.get('storm_offset') ?? 0);
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? Math.floor(requestedOffset) : 0;
  const storms = useApi('/api/v1/cyclones', { year, limit: 100, offset });
  const items = storms.data?.data.items ?? [];
  const storm = items.find(item => item.storm_id === filters.get('storm_id')) ?? items.find(item => item.name.toUpperCase() === 'FANI') ?? items[0];
  const ready = !storms.isPending && !storms.error && storms.data?.status === 'ok' && !!storm;
  const unavailablePlayback = usePlayback(0, `cyclones:${year}:catalog:${offset}`);
  return <>
    <div className="replay-scope-controls">
      {scopeControls}
      <div>
        <label htmlFor="replay-storm">Cyclone / storm</label>
        <select id="replay-storm" value={ready ? storm.storm_id : ''} disabled={!ready} onChange={event => setFilters({ storm_id: event.target.value })}>
          {!ready && <option value="">No returned storm available</option>}
          {items.map(item => <option key={item.storm_id} value={item.storm_id}>{item.name} · {item.year} · {item.storm_id}</option>)}
        </select>
      </div>
    </div>
    <QueryState query={storms} empty={storms.data?.status === 'no_data' || items.length === 0}>
      {ready && <StormReplay key={storm.storm_id} storm={storm} />}
    </QueryState>
    {!ready && <PlaybackControls playback={unavailablePlayback} count={0} />}
    {storms.data && <PageControls page={storms.data.data} label="storms" onChange={next => setFilters({ storm_offset: String(next), storm_id: undefined })} />}
    <details className="replay-catalog"><summary>Storm catalog coverage</summary>
      <p className="muted">Fani is preferred only when present in the returned page. Catalog season years are not reconstructed track dates.</p>
      <Evidence meta={storms.data?.meta} />
    </details>
  </>;
}

function EventReplay({ category, year }: { category: 'floods' | 'landslides'; year: number }) {
  const { filters, setFilters } = useFilters();
  const requestedOffset = Number(filters.get('offset') ?? 0);
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? Math.floor(requestedOffset) : 0;
  const query = useApi(category === 'floods' ? '/api/v1/events/floods' : '/api/v1/events/landslides', { year, limit: 100, offset });
  const page = query.data?.data;
  const records = useMemo(() => (query.data?.data.items ?? []).filter(event => event.timestamp && Number.isFinite(Date.parse(event.timestamp))).sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!)), [query.data]);
  const playback = usePlayback(records.length, `${category}:${year}:${offset}`);
  const current = records[playback.index];
  const visible = current ? records.filter(event => Date.parse(event.timestamp!) <= Date.parse(current.timestamp!)) : [];
  const withoutTimestamp = page?.items.filter(event => !event.timestamp || !Number.isFinite(Date.parse(event.timestamp))) ?? [];
  const ready = !query.isPending && !query.error && query.data?.status === 'ok' && !!page?.items.length;
  const controls = <PlaybackControls playback={playback} count={ready ? records.length : 0} timestamp={ready ? current?.timestamp ?? undefined : undefined} />;
  return <>
    <div className="replay-workbench">
      <ReplayMap points={ready ? visible : []} basemapHint={category === 'landslides' ? 'terrain' : undefined} controls={controls} />
      <aside className="replay-readout" aria-labelledby="replay-events-title">
        <h2 id="replay-events-title">{categoryLabels[category]} · recorded events</h2>
        <QueryState query={query} empty={query.data?.status === 'no_data' || page?.items.length === 0}>
          <p aria-live="polite">{current?.timestamp ? <time dateTime={current.timestamp}>{current.timestamp}</time> : 'No compatible source timestamp available'}</p>
          <p className="muted">This page's events appear through the selected timestamp, including simultaneous records. Missing coordinates remain in the list, not on the map.</p>
          <ol className="replay-event-list" aria-label="Events through the selected source timestamp">
            {visible.map(event => <li key={event.event_id} aria-current={event.event_id === current?.event_id ? 'step' : undefined}>
              <strong>{event.event_id}</strong> · <time dateTime={event.timestamp ?? undefined}>{event.timestamp}</time> · {event.state_id ?? 'State not resolved'}
              <p className="muted">Recorded position: {event.longitude != null && event.latitude != null ? `${event.longitude}, ${event.latitude}` : 'Not available; not mapped'}</p>
              <details><summary>Source attributes</summary><pre style={{ overflowX: 'auto' }}>{JSON.stringify(event.attributes ?? {}, null, 2)}</pre></details>
            </li>)}
          </ol>
          {!records.length && <p>No compatible timestamped records are present on this page.</p>}
          {withoutTimestamp.length > 0 && <details><summary>Records without compatible timestamps ({withoutTimestamp.length})</summary>
            <p>These records are excluded from animated replay. A source year is never turned into an invented day; year-only records have no within-year ordering.</p>
            <ul>{withoutTimestamp.map(event => <li key={event.event_id}>{event.event_id} · source timestamp: {event.timestamp ?? 'Not available'} · source year: {event.year ?? 'Not available'}</li>)}</ul>
          </details>}
        </QueryState>
        <Evidence meta={query.data?.meta} />
      </aside>
    </div>
    {page && <PageControls page={page} label="events" onChange={next => setFilters({ offset: String(next) })} />}
  </>;
}

function RainfallReplay({ year, catalog }: { year: number; catalog: Catalog }) {
  const { filters, setFilters } = useFilters();
  const dates = useMemo(() => [...(catalog.capabilities.rainfall_observation_dates ?? [])].filter(date => date.startsWith(`${year}-`)).sort(), [catalog, year]);
  const playback = usePlayback(dates.length, `rainfall:${year}`);
  const requestedDate = filters.get('observation_date');
  const { seek } = playback;
  useEffect(() => {
    const index = requestedDate ? dates.indexOf(requestedDate) : -1;
    if (index >= 0) seek(index);
  }, [dates, requestedDate, seek]);
  const currentDate = dates[playback.index];
  const rainfall = useApi('/api/v1/map/rainfall', { year, observation_date: currentDate }, undefined, !!currentDate);
  const ready = !rainfall.isPending && !rainfall.error && rainfall.data?.status === 'ok' && rainfall.data.data.length > 0;
  const controls = <PlaybackControls playback={playback} count={ready ? dates.length : 0} timestamp={ready ? currentDate : undefined} />;
  if (!dates.length) return <section className="replay-empty">
    <h2>Rainfall observation dates unavailable</h2>
    <p>No confirmed daily periods were supplied for this year. Annual totals and artificial dates are not substituted.</p>
    {controls}
    <Evidence meta={catalog.datasets.rainfall} />
  </section>;
  return <>
    <div className="replay-workbench">
      <ReplayMap rainfall={ready ? rainfall.data?.data : undefined} unit={rainfall.data?.meta.unit} controls={controls} />
      <aside className="replay-readout" aria-labelledby="replay-rainfall-title">
        <h2 id="replay-rainfall-title">Daily Actual · <time dateTime={currentDate}>{currentDate}</time></h2>
        <label htmlFor="replay-rainfall-date">Source observation date</label>
        <select id="replay-rainfall-date" value={currentDate} onChange={event => { playback.seek(dates.indexOf(event.target.value)); setFilters({ observation_date: event.target.value }); }}>
          {dates.map(date => <option key={date} value={date}>{date}</option>)}
        </select>
        <p className="muted">Replay uses declared daily observations, not annual totals or anomalies. Missing values are not measured zero. {rainfall.data?.meta.unit ? `Source unit: ${rainfall.data.meta.unit}.` : 'Source unit unspecified; millimetres are not inferred.'}</p>
        <QueryState query={rainfall} empty={rainfall.data?.status === 'no_data' || rainfall.data?.data.length === 0}>
          <details className="replay-records"><summary>Returned state observations</summary>
            <div className="replay-table-scroll"><table><thead><tr><th scope="col">State identifier</th><th scope="col">Source date</th><th scope="col">Daily Actual ({rainfall.data?.meta.unit ?? 'source unit unspecified'})</th></tr></thead><tbody>
              {rainfall.data?.data.map(record => <tr key={`${record.state_id}:${record.date ?? record.year}`}><th scope="row">{record.state_id}</th><td>{record.date ?? `Source year only: ${record.year}`}</td><td>{record.value}</td></tr>)}
            </tbody></table></div>
          </details>
        </QueryState>
        <Evidence meta={rainfall.data?.meta ?? catalog.datasets.rainfall} />
      </aside>
    </div>
  </>;
}

export default function TimeMachine() {
  const metadata = useApi('/api/v1/metadata');
  const { filters, setFilters } = useFilters();
  const catalog = metadata.data?.data;
  const categories = (Object.keys(categoryLabels) as Category[]).filter(category => catalog?.capabilities.observed_replay?.includes(category));
  const requestedCategory = filters.get('hazard');
  const category = categories.find(item => item === requestedCategory) ?? categories[0];
  const years = [...(category ? catalog?.capabilities.available_years?.[category] ?? [] : [])].sort((a, b) => a - b);
  const requestedYear = Number(filters.get('year'));
  const year = years.includes(requestedYear) ? requestedYear : category === 'cyclones' && years.includes(2019) ? 2019 : years.at(-1);
  const unavailablePlayback = usePlayback(0, 'replay-unavailable');
  const ready = !metadata.isPending && !metadata.error && metadata.data?.status === 'ok' && !!category && year !== undefined;
  const scopeControls = <>
    <div><label htmlFor="replay-category">Observation category</label>
      <select id="replay-category" value={category ?? ''} disabled={!categories.length} onChange={event => setFilters({ hazard: event.target.value, year: undefined, storm_id: undefined, storm_offset: undefined, observation_date: undefined, offset: undefined })}>
        {!categories.length && <option value="">No compatible replay category supplied</option>}
        {categories.map(item => <option key={item} value={item}>{categoryLabels[item]}</option>)}
      </select>
    </div>
    <div><label htmlFor="replay-year">Recorded year / catalog season</label>
      <select id="replay-year" value={year ?? ''} disabled={!years.length} onChange={event => setFilters({ year: event.target.value, storm_id: undefined, storm_offset: undefined, observation_date: undefined, offset: undefined })}>
        {!years.length && <option value="">No confirmed years available</option>}
        {years.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>
  </>;
  return <>
    <header className="page-heading">
      <h1>Climate Time Machine</h1>
      <p className="muted">Replay recorded positions and event timestamps.</p>
    </header>
    <QueryState query={metadata} empty={metadata.data?.status === 'no_data'}>
      {category === 'cyclones' && year !== undefined
        ? <CycloneReplay key={`cyclones:${year}`} year={year} scopeControls={scopeControls} />
        : <>
          <div className="replay-scope-controls">{scopeControls}</div>
          {(category === 'floods' || category === 'landslides') && year !== undefined && <EventReplay key={`${category}:${year}`} category={category} year={year} />}
          {category === 'rainfall' && year !== undefined && catalog && <RainfallReplay key={`rainfall:${year}`} catalog={catalog} year={year} />}
        </>}
      {requestedCategory && requestedCategory !== category && <p role="status">The requested category does not support observed replay. Showing {category ? categoryLabels[category] : 'no category'} instead.</p>}
      {filters.has('year') && requestedYear !== year && <p role="status">The requested year is not in this category's confirmed coverage. {year ? `Showing ${year}.` : 'No period can be selected.'}</p>}
      {!categories.length && <p role="status">No observed replay capability has been provided by the backend.</p>}
    </QueryState>
    {!ready && <PlaybackControls playback={unavailablePlayback} count={0} />}
    <section className="replay-notes" aria-label="Historical replay limitations">
      <p className="muted">Source intervals and timestamps retain their original precision; missing measurements are not generated. Coverage does not prove complete reporting or absence of unrecorded events. Historical analysis only, not forecasting or official alerts. Heat and drought have no compatible observed replay.</p>
      <a href="#/sources">Read source and coverage limitations</a>
      <Evidence meta={metadata.data?.meta} />
    </section>
  </>;
}
