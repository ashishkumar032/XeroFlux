import { ArrowLeftRight } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../api/client';
import { Evidence, QueryState } from '../components/DataPanels';
import { DataBar } from '../components/Executive';
import { useFilters } from '../hooks/useFilters';

const comparisonDatasets: Record<string, string> = {
  rainfall_annual_total: 'rainfall',
  rainfall_anomaly: 'rainfall',
  flood_event_count: 'floods',
  landslide_event_count: 'landslides',
};

function supplied(value: number | null | undefined, unit?: string | null): string {
  return value == null ? 'Not supplied' : `${value.toLocaleString()}${unit ? ` ${unit}` : ''}`;
}

export default function Comparison() {
  const states = useApi('/api/v1/states');
  const catalog = useApi('/api/v1/metadata');
  const { filters, setFilters } = useFilters();
  const stateRecords = states.data?.data ?? [];
  const stateA = filters.get('state_a') ?? filters.get('state_id') ?? stateRecords[0]?.state_id ?? '';
  const stateB = filters.get('state_b') ?? stateRecords.find((state) => state.state_id !== stateA)?.state_id ?? '';
  const capabilities = catalog.data?.data.capabilities;
  const advertisedMetrics = capabilities?.comparison_metrics ?? [];
  const metrics = advertisedMetrics.filter((metric) => Object.hasOwn(comparisonDatasets, metric));
  const metric = filters.get('metric') ?? metrics[0] ?? '';
  const dataset = comparisonDatasets[metric];
  const years = [...new Set((dataset ? capabilities?.available_years?.[metric] ?? capabilities?.available_years?.[dataset] : []) ?? [])].sort((a, b) => a - b);
  const startYear = Number(filters.get('start_year') ?? years[0]);
  const endYear = Number(filters.get('end_year') ?? years.at(-1));
  const validStates = stateA !== stateB && stateRecords.some((state) => state.state_id === stateA) && stateRecords.some((state) => state.state_id === stateB);
  const validMetric = metrics.includes(metric);
  const validPeriod = years.includes(startYear) && years.includes(endYear) && startYear <= endYear;
  const enabled = validStates && validMetric && validPeriod;
  const comparison = useApi('/api/v1/compare', { state_a: stateA, state_b: stateB, metric, start_year: startYear, end_year: endYear }, undefined, enabled);
  const result = comparison.data?.data;
  const stateName = (id: string) => stateRecords.find((state) => state.state_id === id)?.name ?? id;
  const unavailableReason = !advertisedMetrics.length
    ? 'Comparison is unavailable: the backend advertises no scientifically supported comparison metrics.'
    : !metrics.length
      ? 'No advertised metric supports a state-level rainfall or event-count comparison.'
      : !validStates
        ? 'Select two different catalog states.'
        : !validMetric
          ? 'Select a backend-advertised supported comparison metric.'
          : !validPeriod
            ? 'Select an ordered period from the observed years for this metric. Without declared years the comparison request remains disabled.'
            : '';
  const relevantDatasets = dataset ? [dataset] : [...new Set(Object.values(comparisonDatasets))];
  const coverageReasons = [...new Set([
    ...relevantDatasets.flatMap((name) => catalog.data?.data.datasets[name]?.limitations ?? []),
    ...Object.entries(capabilities?.omitted_datasets ?? {}).filter(([name]) => relevantDatasets.includes(name) || name.includes('compar')).map(([, reason]) => reason),
  ])];
  const isCount = result?.metric === 'flood_event_count' || result?.metric === 'landslide_event_count';
  const seriesMax = Math.max(0, ...(result?.series.flatMap((point) => [point.state_a, point.state_b, point.absolute_difference].filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).map((v) => Math.abs(v))) ?? []));
  const chartAxes = <>
    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
    <XAxis dataKey="year" stroke="var(--muted)" />
    <YAxis stroke="var(--muted)" domain={isCount ? [0, 'auto'] : ['auto', 'auto']} allowDecimals={!isCount} />
    <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--text)' }} labelStyle={{ color: 'var(--text)' }} />
    <Legend />
  </>;

  return (
    <>
      <header className="page-heading">
        <h1>State comparison</h1>
        <p className="muted">Compare only backend-supported metrics with compatible observation coverage.</p>
      </header>
      <section className="work-section" aria-labelledby="comparison-selection-title">
        <h2 id="comparison-selection-title"><ArrowLeftRight size={22} aria-hidden="true" /> Comparison setup</h2>
        <QueryState query={states} empty={Boolean(states.data) && stateRecords.length === 0}>
          <QueryState query={catalog}>
            <div className="filter-row">
              <label htmlFor="comparison-state-a">State A
                <select id="comparison-state-a" value={stateA} onChange={(event) => setFilters({ state_a: event.target.value, state_b: stateB })}>
                  {!stateRecords.some((state) => state.state_id === stateA) && <option value={stateA}>Select a catalog state</option>}
                  {stateRecords.map((state) => <option key={state.state_id} value={state.state_id}>{state.name}</option>)}
                </select>
              </label>
              <label htmlFor="comparison-state-b">State B
                <select id="comparison-state-b" value={stateB} onChange={(event) => setFilters({ state_a: stateA, state_b: event.target.value })}>
                  {!stateRecords.some((state) => state.state_id === stateB) && <option value={stateB}>Select a different catalog state</option>}
                  {stateRecords.map((state) => <option key={state.state_id} value={state.state_id}>{state.name}</option>)}
                </select>
              </label>
              <label htmlFor="comparison-metric">Backend-supported metric
                <select id="comparison-metric" value={validMetric ? metric : ''} disabled={!metrics.length} aria-describedby="comparison-disabled-reason" onChange={(event) => setFilters({ metric: event.target.value, start_year: undefined, end_year: undefined })}>
                  {!validMetric && <option value="">No comparable metric selected</option>}
                  {metrics.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
                </select>
              </label>
              <label htmlFor="comparison-start">Start year
                <select id="comparison-start" value={years.includes(startYear) ? startYear : ''} disabled={!validMetric || !years.length} onChange={(event) => setFilters({ start_year: event.target.value })}>
                  {!years.includes(startYear) && <option value="">Supported years unavailable</option>}
                  {years.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              </label>
              <label htmlFor="comparison-end">End year
                <select id="comparison-end" value={years.includes(endYear) ? endYear : ''} disabled={!validMetric || !years.length} onChange={(event) => setFilters({ end_year: event.target.value })}>
                  {!years.includes(endYear) && <option value="">Supported years unavailable</option>}
                  {years.map((year) => <option key={year} value={year} disabled={year < startYear}>{year}</option>)}
                </select>
              </label>
            </div>
            <p id="comparison-disabled-reason" role="status">{unavailableReason || 'Results update with valid filters. The backend validates common coverage; missing observations are never zero.'}</p>
            <div className="button-row">
              <button type="button" className="button primary" disabled={!enabled || comparison.isFetching} aria-describedby="comparison-disabled-reason" onClick={() => void comparison.refetch()}>Compare states</button>
              <button type="button" className="button" onClick={() => setFilters({ state_a: undefined, state_b: undefined, state_id: undefined, metric: undefined, start_year: undefined, end_year: undefined })}>Reset to catalog defaults</button>
            </div>
            {!enabled && coverageReasons.length > 0 && <div className="coverage-reasons"><h3>Backend coverage limitations</h3><ul>{coverageReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
          </QueryState>
        </QueryState>
      </section>
      {enabled && <>
        <QueryState query={comparison} empty={comparison.data?.status === 'no_data' || (Boolean(comparison.data) && !result)}>
          {result && <section className="work-section" aria-labelledby="comparison-chart-title">
            <h2 id="comparison-chart-title">Aligned observations: {result.metric.replaceAll('_', ' ')}</h2>
            <p className="muted">{result.unit ?? 'Unit not declared'}; {result.period.start ?? 'Period not supplied'} — {result.period.end ?? 'Period not supplied'}</p>
            <dl className="comparison-summary" aria-label="Backend-supplied summary">
              <div><dt>{stateName(result.state_a)}</dt><dd>{supplied(result.state_a_value, result.unit)}</dd></div>
              <div><dt>{stateName(result.state_b)}</dt><dd>{supplied(result.state_b_value, result.unit)}</dd></div>
              <div><dt>Backend absolute difference</dt><dd>{supplied(result.absolute_difference, result.unit)}</dd></div>
              <div><dt>Backend percentage difference</dt><dd>{supplied(result.percentage_difference, '%')}</dd></div>
            </dl>
            <div className="chart-canvas" role="img" aria-label={`Backend-supplied ${isCount ? 'grouped event-count bars' : 'rainfall lines'} for ${stateName(result.state_a)} and ${stateName(result.state_b)}. Exact values are in the following table.`}>
              <ResponsiveContainer width="100%" height="100%">
                {isCount ? <BarChart data={result.series} margin={{ top: 15, right: 20, bottom: 15, left: 5 }}>
                  {chartAxes}
                  <Bar dataKey="state_a" name={stateName(result.state_a)} fill="var(--flood)" isAnimationActive={false} />
                  <Bar dataKey="state_b" name={stateName(result.state_b)} fill="var(--accent-strong)" isAnimationActive={false} />
                </BarChart> : <LineChart data={result.series} margin={{ top: 15, right: 20, bottom: 15, left: 5 }}>
                  {chartAxes}
                  <Line type="linear" dataKey="state_a" name={stateName(result.state_a)} stroke="var(--flood)" strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                  <Line type="linear" dataKey="state_b" name={stateName(result.state_b)} stroke="var(--accent-strong)" strokeWidth={2} strokeDasharray="5 3" connectNulls={false} isAnimationActive={false} />
                </LineChart>}
              </ResponsiveContainer>
            </div>
            <p className="muted">Differences use only supplied backend values. Percentage differences use the backend-defined State A baseline; missing values and invalid baselines are not reconstructed.</p>
            <div className="table-scroll"><table>
              <caption>Backend-supplied annual series; {result.unit ?? 'Unit not declared'}</caption>
              <thead><tr><th scope="col">Year</th><th scope="col">{stateName(result.state_a)}</th><th scope="col">{stateName(result.state_b)}</th><th scope="col">Absolute difference</th><th scope="col">Percentage difference</th></tr></thead>
              <tbody>{result.series.map((point) => <tr key={point.year}><th scope="row">{point.year}</th><td><DataBar value={point.state_a} max={seriesMax} tone="a" /></td><td><DataBar value={point.state_b} max={seriesMax} tone="b" /></td><td><DataBar value={point.absolute_difference} max={seriesMax} tone="a" /></td><td>{supplied(point.percentage_difference, '%')}</td></tr>)}</tbody>
            </table></div>
            <p>No narrative conclusion is supplied by the comparison contract. <a href={`#/insights?state_id=${encodeURIComponent(result.state_a)}&start_year=${startYear}&end_year=${endYear}`}>Inspect actual NIElytics findings for State A</a>.</p>
          </section>}
        </QueryState>
        <Evidence meta={comparison.data?.meta} />
      </>}
      <p className="muted">Unequal reporting does not establish which state is safer. <a href="#/sources">Review source coverage and limitations</a>.</p>
    </>
  );
}
