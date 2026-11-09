import { useApi } from '../api/client';
import { Evidence, InsightCard, QueryState, ReportDownload, TrendChart } from '../components/DataPanels';
import { KpiCard } from '../components/Executive';
import { useFilters } from '../hooks/useFilters';

export default function Insights() {
  const states = useApi('/api/v1/states');
  const catalog = useApi('/api/v1/metadata');
  const { filters, setFilters } = useFilters();
  const stateRecords = states.data?.data ?? [];
  const stateId = filters.get('state_id') ?? stateRecords[0]?.state_id ?? '';
  const available = catalog.data?.data.capabilities.available_years;
  const years = [...new Set(['rainfall', 'floods', 'landslides'].flatMap((dataset) => available?.[dataset] ?? []))].sort((a, b) => a - b);
  const startYear = Number(filters.get('start_year') ?? years[0] ?? 1967);
  const endYear = Number(filters.get('end_year') ?? years.at(-1) ?? 2026);
  const validState = stateRecords.some((state) => state.state_id === stateId);
  const validPeriod = years.includes(startYear) && years.includes(endYear) && startYear <= endYear;
  const enabled = validState && validPeriod;
  const stateName = stateRecords.find((s) => s.state_id === stateId)?.name ?? stateId;
  const insights = useApi('/api/v1/insights', { state_id: stateId, start_year: startYear, end_year: endYear }, undefined, enabled);
  const rainfall = useApi('/api/v1/trends/rainfall', { state_id: stateId, start_year: Math.max(startYear, 2019), end_year: endYear }, undefined, enabled);
  const floods = useApi('/api/v1/events/floods', { state_id: stateId, limit: 1 }, undefined, enabled);
  const landslides = useApi('/api/v1/events/landslides', { state_id: stateId, limit: 1 }, undefined, enabled);
  const rainfallRows = [...(rainfall.data?.data ?? [])].sort((a, b) => (a.date ?? String(a.year)).localeCompare(b.date ?? String(b.year))).map((r) => ({ label: r.date ?? String(r.year), value: r.value }));
  const latestRain = rainfallRows.filter((r) => r.value !== null).at(-1);

  return (
    <>
      <header className="page-heading">
        <h1>NIElytics Insight Engine</h1>
        <p className="muted">Inspect backend-generated findings, their source observations and calculation limits through 2026.</p>
      </header>
      <div className="insights-workbench">
      <section className="insight-findings" aria-labelledby="insight-findings-title">
        <div className="section-head">
          <h2 id="insight-findings-title">{stateName} ({stateId}) · State Climate Insights</h2>
          <p className="muted">Evaluated catalog observations and multi-year hazard findings through {endYear}.</p>
        </div>
        {enabled ? <>
          <div className="kpi-grid">
            <KpiCard
              label="Hazard Event Occurrences"
              value={insights.data?.data[0]?.computed_value ?? ((floods.data?.data.total ?? 0) + (landslides.data?.data.total ?? 0))}
              unit="events"
              info="Documented hazard events evaluated by NIElytics for this state."
              badge={`${stateName} · ${startYear}–${endYear}`}
              tone="ok"
            />
            <KpiCard
              label="Rainfall Observations (to 2026)"
              value={rainfall.data?.data.length ?? null}
              unit="daily observations"
              missingText="Daily observations available"
              info="Daily source observations covering up to 2026-11-01."
              badge={latestRain ? `Latest: ${latestRain.value} (${latestRain.label})` : 'Catalog observations'}
              tone="ok"
              series={rainfallRows}
            />
            <KpiCard
              label="Flood Catalog Records"
              value={floods.data?.data.total ?? 0}
              unit="catalog events"
              info="Historical flood events documented for this state in IIT Delhi catalog."
              badge={`IIT Delhi (1967–2023)`}
            />
            <KpiCard
              label="Landslide Catalog Records"
              value={landslides.data?.data.total ?? 0}
              unit="catalog events"
              info="Documented landslide events in community catalog (unverified provenance)."
              badge={`Community catalog`}
            />
          </div>
          <QueryState query={insights} empty={false}>
            {!!insights.data?.data.length && <div className="findings-list">
              {insights.data.data.map((insight) => <InsightCard key={insight.id} insight={insight} />)}
            </div>}
          </QueryState>
          {rainfallRows.length > 0 && (
            <TrendChart
              title={`${stateName} Daily Rainfall Observations (through 2026)`}
              unit={rainfall.data?.meta.unit}
              meta={rainfall.data?.meta}
              rows={rainfallRows}
            />
          )}
          <Evidence meta={insights.data?.meta ?? rainfall.data?.meta} />
        </> : <div className="empty-state">Findings require valid state and period selections. No conclusions are inferred from unavailable data.</div>}
      </section>
      <aside className="scope-rail" aria-label="Insight scope and report">
      <section className="work-section" aria-labelledby="insight-filter-title">
        <h2 id="insight-filter-title">Evidence scope</h2>
        <QueryState query={states} empty={Boolean(states.data) && stateRecords.length === 0}>
          <QueryState query={catalog}>
            <div className="scope-fields">
              <label htmlFor="insight-state">State
                <select id="insight-state" value={stateId} onChange={(event) => setFilters({ state_id: event.target.value })}>
                  {!validState && <option value={stateId}>Select a catalog state</option>}
                  {stateRecords.map((state) => <option key={state.state_id} value={state.state_id}>{state.name}</option>)}
                </select>
              </label>
              <label htmlFor="insight-start">Start year
                <select id="insight-start" value={years.includes(startYear) ? startYear : ''} disabled={!years.length} onChange={(event) => setFilters({ start_year: event.target.value })}>
                  {!years.includes(startYear) && <option value="">Select an observed year</option>}
                  {years.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              </label>
              <label htmlFor="insight-end">End year
                <select id="insight-end" value={years.includes(endYear) ? endYear : ''} disabled={!years.length} onChange={(event) => setFilters({ end_year: event.target.value })}>
                  {!years.includes(endYear) && <option value="">Select an observed year</option>}
                  {years.map((year) => <option key={year} value={year} disabled={year < startYear}>{year}</option>)}
                </select>
              </label>
              <button type="button" className="button" onClick={() => setFilters({ state_id: undefined, start_year: undefined, end_year: undefined })}>Reset to catalog defaults</button>
            </div>
            <p className="muted">Year choices are observed rainfall, flood, and landslide catalog years, not a claim of continuous or state-specific coverage. Each finding retains its own supported period.</p>
            {!enabled && <p role="status">Select a catalog state and an ordered period from the available observation years.</p>}
          </QueryState>
        </QueryState>
      </section>
      <section className="work-section" aria-labelledby="insight-report-title">
        <h2 id="insight-report-title">Evidence report</h2>
        <ReportDownload stateId={stateId} startYear={startYear} endYear={endYear} disabled={!enabled} />
      </section>
      </aside>
      </div>
      <section className="research-note">
        <h2>Historical analysis, with limits</h2>
        <p>Statistical association is not causal evidence. Sparse or uneven reporting limits conclusions. These findings are not real-time forecasts, official alerts, or validated predictions of future hazards.</p>
        <a href="#/sources">Inspect sources and processing methods</a>
      </section>
    </>
  );
}
