import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

type Point = { label: string; value: number | null };

/** Plots only supplied observations. The vertical scale spans the plotted min–max; nothing is aggregated or inferred. */
export function Sparkline({ rows }: { rows: Point[] }) {
  const observed = rows.filter((row): row is { label: string; value: number } => row.value !== null && Number.isFinite(row.value));
  if (observed.length < 2) return null;
  const width = 240, height = 24, pad = 2;
  let min = Infinity, max = -Infinity;
  for (const row of observed) { min = Math.min(min, row.value); max = Math.max(max, row.value); }
  const span = max - min || 1;
  const x = (index: number) => pad + (index / (rows.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2);
  let line = '';
  let open = false;
  rows.forEach((row, index) => {
    if (row.value === null || !Number.isFinite(row.value)) { open = false; return; }
    line += `${open ? 'L' : 'M'}${x(index).toFixed(1)} ${y(row.value).toFixed(1)}`;
    open = true;
  });
  const area = `${line}L${x(rows.length - 1).toFixed(1)} ${height}L${x(0).toFixed(1)} ${height}Z`;
  return <svg className="sparkline" data-sparkline="true" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <path className="sparkline-area" d={area} />
    <path className="sparkline-line" d={line} fill="none" />
  </svg>;
}

export type KpiTone = 'ok' | 'neutral' | 'warn';

/** Executive scorecard. Badges state backend-supplied facts (date, record count, scope), never computed variances. */
export function KpiCard({ label, outputLabel, value, unit, info, series, badge, missingText = 'No observation', tone = 'neutral' }: {
  label: string; outputLabel?: string; value: number | string | null | undefined; unit?: string | null; info?: string;
  series?: Point[]; badge?: ReactNode; missingText?: string; tone?: KpiTone;
}) {
  const shown = value === null || value === undefined ? null : typeof value === 'number' ? value.toLocaleString() : value;
  return <div className="kpi-card">
    <div className="kpi-head">
      <span className="kpi-label">{label}</span>
      {info && <span className="kpi-info" title={info}><Info size={12} aria-hidden="true" /></span>}
    </div>
    {shown === null ? <p className="kpi-missing">{missingText}</p> : <p className="kpi-value">
      <output aria-label={outputLabel ?? label}>{shown}</output>{' '}
      <small>{unit ?? 'Unit not declared'}</small>
    </p>}
    {badge && <div className={`kpi-badge kpi-${tone}`}>{badge}</div>}
    {series && <Sparkline rows={series} />}
  </div>;
}

export type SlicerOption = { id: string; label: string; count?: number | null; disabled?: boolean };

/** Segmented slicer. Count badges must come from backend catalog or response metadata. */
export function SlicerRibbon({ label, options, value, onChange, onReset }: {
  label: string; options: SlicerOption[]; value: string | null; onChange: (id: string | null) => void; onReset?: () => void;
}) {
  return <div className="slicer" role="group" aria-label={label}>
    <span className="slicer-label">{label}</span>
    <div className="slicer-options">
      {options.map(option => <button key={option.id} type="button" className="slicer-option" aria-pressed={value === option.id} disabled={option.disabled}
        onClick={() => onChange(value === option.id ? null : option.id)}>
        <span>{option.label}</span>
        {option.count !== undefined && option.count !== null && <span className="slicer-count">{option.count.toLocaleString()}</span>}
      </button>)}
      {onReset && <button type="button" className="slicer-reset" onClick={onReset}>Reset</button>}
    </div>
  </div>;
}

/** Inline data bar. Bar length is relative to the largest supplied value in the compared set; it is a visual scale, not a statistic. */
export function DataBar({ value, max, tone = 'a', suffix = '' }: { value: number | null | undefined; max: number; tone?: 'a' | 'b'; suffix?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="databar-missing">Not supplied</span>;
  const width = max > 0 ? Math.max(0, Math.min(100, (Math.abs(value) / max) * 100)) : 0;
  return <span className="databar"><span className="databar-value">{`${value.toLocaleString()}${suffix ? ` ${suffix}` : ''}`}</span><span className={`databar-track databar-${tone}`} aria-hidden="true"><span className="databar-fill" data-bar-width={Math.round(width)} style={{ width: `${width}%` }} /></span></span>;
}
