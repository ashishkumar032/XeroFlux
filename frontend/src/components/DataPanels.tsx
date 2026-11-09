import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Insight, Metadata } from '../api/types';
import { ApiError, downloadReport } from '../api/client';

export function QueryState({ query, empty = false, children }: { query: { isPending: boolean; error: Error | null; refetch: () => unknown }; empty?: boolean; children?: ReactNode }) {
  if (query.isPending) return <div className="panel skeleton" role="status" aria-live="polite">Loading source data…</div>;
  if (query.error) {
    const apiError = query.error instanceof ApiError ? query.error : null;
    const dependency = apiError && ['DATASET_UNAVAILABLE', 'DATASET_INVALID', 'ANALYTICS_UNAVAILABLE'].includes(apiError.code ?? '');
    return <section className="panel api-error" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <h2>{dependency || apiError?.status === 503 ? 'Data not available' : apiError?.status === 422 ? 'Selection not supported by this dataset' : 'Unable to load this evidence'}</h2>
      <p>{query.error.message}</p>
      {dependency ? <p><a className="source-link" href="#/sources">Review sources and coverage</a>. No replacement values are shown.</p> : apiError?.status === 422 ? <p className="muted">Choose another state or observation period in the scope controls. Some prepared catalog areas have no matching records in the analytical library.</p> : <p className="muted">Check the backend connection and API configuration, then retry. Missing observations are never replaced with zero or sample data.</p>}
      <button className="button" type="button" onClick={() => void query.refetch()}><RefreshCw size={14} aria-hidden="true" />Retry request</button>
    </section>;
  }
  if (empty) return <section className="empty-state" role="status"><h3>Data not available for these filters</h3><p>No matching source observations were returned. This is not a measured zero; try another supported state or period.</p></section>;
  return <>{children}</>;
}

export function Evidence({ meta }: { meta?: Metadata }) {
  if (!meta) return null;
  return <footer className="evidence">
    <div className="source-links">Sources: {(meta.source_ids ?? []).length ? (meta.source_ids ?? []).map(id => <a key={id} href={'#/sources?source_id=' + encodeURIComponent(id)}>{id}</a>) : 'Not supplied'}</div>
    <details>
      <summary>Source &amp; method</summary>
      <dl>
        <dt>Metric</dt><dd>{meta.metric ?? 'Not supplied'}</dd>
        <dt>Geographical level / time resolution</dt><dd>{meta.geographic_level} / {meta.time_resolution}</dd>
        <dt>Unit</dt><dd>{meta.unit ?? 'Unit not declared'}</dd>
        {(meta.period?.start || meta.period?.end) && <><dt>Source period</dt><dd>{meta.period.start ?? 'Period not supplied'} — {meta.period.end ?? 'Period not supplied'}</dd></>}
        <dt>Source-record count</dt><dd>{meta.observation_count.toLocaleString()}</dd>
        <dt>Method</dt><dd>{meta.method ?? 'Calculation details not provided'}</dd>
      </dl>
      <ul>{meta.limitations?.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
    </details>
  </footer>;
}

export function TrendChart({ rows, unit, title, meta }: { rows: { label: string; value: number | null }[]; unit?: string | null; title: string; meta?: Metadata }) {
  return <section className="trend-panel">
    <h2>{title}</h2>
    <p className="muted">{unit ?? 'Unit not declared'} · {rows[0]?.label ?? 'No period'} — {rows.at(-1)?.label ?? 'No period'}</p>
    {rows.some(row => row.value !== null) ? <>
      <div className="chart-canvas" role="img" aria-label={title + '. ' + (unit ?? 'Unit not declared') + '. Individual values in the observation table below.'}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ left: 0, right: 8, top: 10, bottom: 10 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="label" minTickGap={40} stroke="var(--muted)" tick={{ fontSize: 11 }} />
            <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} width={48} />
            <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--text)' }} labelStyle={{ color: 'var(--text)' }} cursor={{ stroke: 'var(--border)' }} />
            <Line name={unit ?? 'Observed value (unit unspecified)'} dataKey="value" type="linear" stroke="var(--accent)" dot={false} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details>
        <summary>Observation values (accessible table)</summary>
        <div className="table-scroll">
          <table>
            <thead><tr><th scope="col">Source period</th><th scope="col">Value · {unit ?? 'unit unspecified'}</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={row.label + ':' + index}><td>{row.label}</td><td>{row.value ?? 'Not observed'}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </> : <div className="empty-state"><p>No measured series available.</p></div>}
    <Evidence meta={meta} />
  </section>;
}

export function ReportDownload({ stateId, startYear, endYear, disabled = false }: { stateId: string; startYear: number; endYear: number; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const identity = stateId + ':' + startYear + ':' + endYear;

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setState('idle');
    setMessage('');
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [identity]);

  async function download() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState('pending');
    setMessage('Generating an evidence report from available observations…');
    try {
      await downloadReport(stateId, startYear, endYear, controller.signal);
      if (controller.signal.aborted) return;
      setState('success');
      setMessage('Report downloaded. Unavailable measurements are labeled in the document.');
    } catch (error) {
      if (controller.signal.aborted) return;
      setState('error');
      setMessage(error instanceof ApiError ? error.message : 'Could not reach the report service. Check that the backend is running and retry.');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  return <div className="report-control">
    <button className="button primary" type="button" onClick={() => void download()} disabled={disabled || !stateId || !Number.isFinite(startYear) || !Number.isFinite(endYear) || startYear > endYear || state === 'pending'}>
      <Download size={15} aria-hidden="true" />
      {state === 'pending' ? 'Preparing report…' : 'Download Climate Report'}
    </button>
    <p role={state === 'error' ? 'alert' : 'status'} aria-live="polite" className="muted">
      {message || 'Downloads an actual backend PDF for the selected state and period.'}
    </p>
  </div>;
}

export function InsightCard({ insight }: { insight: Insight }) {
  return <article className="insight-card">
    <h2>{insight.title}</h2>
    <p className="muted">{insight.region} · {insight.period.start ?? 'Unspecified'} — {insight.period.end ?? 'Unspecified'}</p>
    <p className="insight-value">{insight.computed_value ?? 'Not supplied'} <small>{insight.unit ?? ''}</small></p>
    <p>{insight.description}</p>
    <details>
      <summary>How was this calculated?</summary>
      <dl>
        <dt>Executed method</dt><dd>{insight.method ?? 'Calculation details not provided'}</dd>
        <dt>Geographical resolution</dt><dd>{insight.geographic_resolution}</dd>
        <dt>Observations used</dt><dd>{insight.observation_count.toLocaleString()}</dd>
        <dt>Supporting backend statistics</dt>
        <dd>{Object.entries(insight.statistics).map(([key, value]) => <div key={key}>{key}: {value ?? 'Not supplied'}</div>)}</dd>
      </dl>
      <p>Source datasets: {insight.source_ids.map(id => <a className="source-link" key={id} href={'#/sources?source_id=' + encodeURIComponent(id)}>{id} </a>)}</p>
      <ul>{insight.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
    </details>
  </article>;
}
