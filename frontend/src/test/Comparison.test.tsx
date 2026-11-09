import { cloneElement } from 'react';
import type { ReactElement } from 'react';
import type * as Recharts from 'recharts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseOf } from '../api/client';
import type { Catalog, ComparisonResult, Metadata } from '../api/types';
import Comparison from '../pages/Comparison';
import { ThemeProvider } from '../theme';

// Only replace container measurement: the actual Recharts bars, axes and lines render.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width: number; height: number }> }) => <div>{cloneElement(children, { width: 720, height: 280 })}</div>,
  };
});

// Isolated synthetic contract fixtures; none are imported by production pages.
const fixtureMeta: Metadata = {
  metric: 'synthetic_fixture_event_count', unit: 'events', geographic_level: 'state',
  time_resolution: 'annual', period: { start: '2018', end: '2019' },
  source_ids: ['fixture_source'], method: 'Test-only supplied count method',
  observation_count: 2, limitations: ['Synthetic fixture coverage limitation'],
};
const fixtureResult: ComparisonResult = {
  state_a: 'FIXTURE_A', state_b: 'FIXTURE_B', metric: 'flood_event_count', unit: 'events',
  period: { start: '2018', end: '2019' }, state_a_value: 0, state_b_value: null,
  series: [
    { year: 2018, state_a: 0, state_b: null },
    { year: 2019, state_a: 4, state_b: 6 },
  ],
};
const clients: QueryClient[] = [];

function installFixtureApi(options: {
  metrics?: string[];
  years?: number[];
  result?: ComparisonResult | null;
  status?: 'ok' | 'no_data';
} = {}) {
  const requests: URL[] = [];
  const catalog: Catalog = {
    processed_at: '2026-01-01T00:00:00Z',
    capabilities: {
      boundaries: false, comparison_metrics: options.metrics ?? ['flood_event_count'],
      available_years: { floods: options.years ?? [2018, 2019], rainfall: options.years ?? [2018, 2019], landslides: options.years ?? [2018, 2019] },
      omitted_datasets: { drought: 'Synthetic national drought omission, unrelated to comparison' },
    },
    datasets: { floods: fixtureMeta, rainfall: { ...fixtureMeta, unit: 'mm', metric: 'rainfall_fixture' } },
  };
  const stateResponse: ResponseOf<'/api/v1/states'> = {
    status: 'ok', data: [{ state_id: 'FIXTURE_A', name: 'Fixture state A' }, { state_id: 'FIXTURE_B', name: 'Fixture state B' }], meta: fixtureMeta,
  };
  const catalogResponse: ResponseOf<'/api/v1/metadata'> = { status: 'ok', data: catalog, meta: fixtureMeta };
  const resultResponse: ResponseOf<'/api/v1/compare'> = { status: options.status ?? 'ok', data: options.result === undefined ? fixtureResult : options.result, meta: fixtureMeta };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/v1/states') return Response.json(stateResponse);
    if (url.pathname === '/api/v1/metadata') return Response.json(catalogResponse);
    if (url.pathname === '/api/v1/compare') return Response.json(resultResponse);
    throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  }));
  return requests;
}

function renderComparison(hash = '#/comparison') {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(<ThemeProvider><QueryClientProvider client={client}><Comparison /></QueryClientProvider></ThemeProvider>);
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => {
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Scientifically supported state comparison', () => {
  it('renders supplied event-count bars and preserves zero, null and absent differences', async () => {
    const requests = installFixtureApi();
    renderComparison();
    const table = await screen.findByRole('table', { name: 'Backend-supplied annual series; events' });
    const firstRow = within(table).getByRole('row', { name: '2018 0 Not supplied Not supplied Not supplied' });
    expect(within(firstRow).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['0', 'Not supplied', 'Not supplied', 'Not supplied']);
    const secondRow = within(table).getByRole('row', { name: '2019 4 6 Not supplied Not supplied' });
    expect(within(secondRow).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['4', '6', 'Not supplied', 'Not supplied']);
    const summary = screen.getByLabelText('Backend-supplied summary');
    expect(within(summary).getByText('0 events')).toBeInTheDocument();
    expect(within(summary).getByText('Backend absolute difference').nextElementSibling).toHaveTextContent('Not supplied');
    expect(within(summary).getByText('Backend percentage difference').nextElementSibling).toHaveTextContent('Not supplied');
    const chart = screen.getByRole('img', { name: /grouped event-count bars/ });
    await waitFor(() => expect(chart.querySelectorAll('.recharts-bar')).toHaveLength(2));
    expect(within(chart).getByText('0')).toBeInTheDocument();
    expect(chart.querySelector('.recharts-line')).not.toBeInTheDocument();
    const request = requests.find((url) => url.pathname === '/api/v1/compare');
    expect(Object.fromEntries(request!.searchParams)).toEqual({ state_a: 'FIXTURE_A', state_b: 'FIXTURE_B', metric: 'flood_event_count', start_year: '2018', end_year: '2019' });
    expect(screen.getByRole('link', { name: 'Inspect actual NIElytics findings for State A' })).toHaveAttribute('href', '#/insights?state_id=FIXTURE_A&start_year=2018&end_year=2019');
  });

  it('shows supplied differences without replacing them with browser arithmetic', async () => {
    installFixtureApi({ result: { ...fixtureResult, absolute_difference: 17, percentage_difference: null, series: [{ year: 2018, state_a: 0, state_b: 6, absolute_difference: 17, percentage_difference: null }] } });
    renderComparison();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('row', { name: '2018 0 6 17 Not supplied' })).toBeInTheDocument();
    expect(screen.getByLabelText('Backend-supplied summary')).toHaveTextContent('17 events');
  });

  it('keeps rainfall on observed lines rather than event-count bars', async () => {
    installFixtureApi({ metrics: ['rainfall_annual_total'], result: { ...fixtureResult, metric: 'rainfall_annual_total', unit: 'mm' } });
    renderComparison();
    const chart = await screen.findByRole('img', { name: /rainfall lines/ });
    await waitFor(() => expect(chart.querySelectorAll('.recharts-line')).toHaveLength(2));
    expect(chart.querySelector('.recharts-bar')).not.toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Backend-supplied annual series; mm' })).toBeInTheDocument();
  });

  it.each<[string, string, string[], RegExp]>([
    ['identical states', 'state_a=FIXTURE_A&state_b=FIXTURE_A', ['flood_event_count'], /Select two different catalog states/],
    ['a noncatalog state', 'state_a=UNKNOWN', ['flood_event_count'], /Select two different catalog states/],
    ['an unsupported advertised metric', 'metric=regional_temperature', ['regional_temperature'], /No advertised metric supports/],
    ['a metric not advertised by the backend', 'metric=landslide_event_count', ['flood_event_count'], /Select a backend-advertised/],
    ['reversed years', 'start_year=2019&end_year=2018', ['flood_event_count'], /Select an ordered period/],
    ['a year outside observed coverage', 'start_year=1999&end_year=2019', ['flood_event_count'], /Select an ordered period/],
  ])('does not request or chart %s', async (_label, search, metrics, message) => {
    const requests = installFixtureApi({ metrics });
    renderComparison(`#/comparison?${search}`);
    await screen.findByText(message);
    expect(screen.getByRole('button', { name: 'Compare states' })).toBeDisabled();
    expect(requests.filter((url) => url.pathname === '/api/v1/compare')).toHaveLength(0);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('reports unavailable comparison once with relevant backend coverage, not unrelated omissions', async () => {
    const requests = installFixtureApi({ metrics: [] });
    renderComparison();
    expect(await screen.findAllByText('Comparison is unavailable: the backend advertises no scientifically supported comparison metrics.')).toHaveLength(1);
    expect(screen.getByText('Synthetic fixture coverage limitation')).toBeInTheDocument();
    expect(screen.queryByText(/Synthetic national drought omission/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Backend-supported metric')).toBeDisabled();
    expect(requests.filter((url) => url.pathname === '/api/v1/compare')).toHaveLength(0);
  });

  it('keeps requests disabled when no observation years are declared', async () => {
    const requests = installFixtureApi({ years: [] });
    renderComparison();
    await screen.findByText(/Without declared years/);
    expect(screen.getByLabelText('Start year')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Compare states' })).toBeDisabled();
    expect(requests.filter((url) => url.pathname === '/api/v1/compare')).toHaveLength(0);
  });

  it('requests the new valid state pair without silently substituting the selection', async () => {
    const requests = installFixtureApi();
    renderComparison();
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('State A'), { target: { value: 'FIXTURE_B' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Compare states' })).toBeDisabled());
    expect(screen.getByLabelText('State A')).toHaveValue('FIXTURE_B');
    expect(screen.getByLabelText('State B')).toHaveValue('FIXTURE_B');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(requests.filter((url) => url.pathname === '/api/v1/compare')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('State B'), { target: { value: 'FIXTURE_A' } });
    await waitFor(() => expect(requests.filter((url) => url.pathname === '/api/v1/compare')).toHaveLength(2));
    const latest = requests.filter((url) => url.pathname === '/api/v1/compare').at(-1)!;
    expect(latest.searchParams.get('state_a')).toBe('FIXTURE_B');
    expect(latest.searchParams.get('state_b')).toBe('FIXTURE_A');
  });

  it('does not turn a valid no-data response into zero values or a chart', async () => {
    installFixtureApi({ result: null, status: 'no_data' });
    renderComparison();
    await screen.findByRole('heading', { name: 'Data not available for these filters' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Backend-supplied summary')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
