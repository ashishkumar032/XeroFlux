import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseOf } from '../api/client';
import { ApiError } from '../api/client';
import type { Metadata } from '../api/types';
import { Evidence, QueryState } from '../components/DataPanels';
import Overview from '../pages/Overview';
import Explorer from '../pages/Explorer';
import { ThemeProvider } from '../theme';

// Only WebGL is substituted. Source fetching, filters, tables and reports use production code.
vi.mock('../components/IndiaMap', () => ({ default: () => <div aria-label="Test-only official map surface" /> }));
const staticMeta: Metadata = { metric: 'boundary_catalog', unit: null, geographic_level: 'state', time_resolution: 'static', source_ids: ['test-official'], method: 'Test-only boundary import', observation_count: 2, limitations: ['Fixture coverage is not disaster frequency.'] };
const observationMeta: Metadata = { metric: 'rainfall', unit: 'mm', geographic_level: 'state', time_resolution: 'daily', period: { start: '2019-01-01', end: '2020-01-02' }, source_ids: ['test-observations'], method: 'Test-only source rows without aggregation', observation_count: 3, limitations: ['Test-only incomplete record.'] };
const catalog: ResponseOf<'/api/v1/metadata'> = { status: 'ok', data: { processed_at: '2020-01-03', capabilities: { boundaries: true, available_datasets: ['states', 'rainfall', 'temperature'], available_hazards: ['floods'], rainfall_observation_dates: ['2019-01-01', '2020-01-01', '2020-01-02'], available_years: { rainfall: [2019, 2020], floods: [2020] }, omitted_datasets: { temperature: 'Test-only declared temperature coverage limitation', drought: 'Test-only national drought coverage limitation' } }, datasets: { rainfall: observationMeta, boundaries: staticMeta } }, meta: staticMeta };
const states: ResponseOf<'/api/v1/states'> = { status: 'ok', data: [{ state_id: 'TEST_A', name: 'Fixture Alpha' }, { state_id: 'TEST_B', name: 'Fixture Beta' }], meta: staticMeta };
const boundaries: ResponseOf<'/api/v1/boundaries'> = { status: 'ok', data: { type: 'FeatureCollection', features: [] }, meta: staticMeta };
const temperature: ResponseOf<'/api/v1/trends/temperature'> = { status: 'ok', data: [{ region: 'REGION_TEST', year: 2019, month: null, value: 29 }, { region: 'REGION_TEST', year: 2020, month: 1, value: 30 }, { region: 'REGION_TEST', year: 2020, month: 7, value: 31 }], meta: { ...observationMeta, metric: 'temperature', unit: '°C', geographic_level: 'region', time_resolution: 'mixed source precision' } };
const drought: ResponseOf<'/api/v1/trends/drought'> = { status: 'ok', data: [{ year: 2019, value: 0 }, { year: 2020, value: 2 }], meta: { ...observationMeta, metric: 'drought', unit: null, geographic_level: 'national', time_resolution: 'annual' } };
let temperatureUnavailable = false;
const clients: QueryClient[] = [];
function renderPage(page: 'overview' | 'explorer') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(<ThemeProvider><QueryClientProvider client={client}>{page === 'overview' ? <Overview /> : <Explorer />}</QueryClientProvider></ThemeProvider>);
}
beforeEach(() => {
  // jsdom has no layout observer; accessible observation tables remain real DOM.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  temperatureUnavailable = false;
  window.location.hash = '#/overview?state_id=TEST_A&observation_date=2020-01-02';
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const path = url.pathname;
    if (path.endsWith('/metadata')) return Promise.resolve(Response.json(catalog));
    if (path.endsWith('/states')) return Promise.resolve(Response.json(states));
    if (path.endsWith('/boundaries')) return Promise.resolve(Response.json(boundaries));
    if (path.endsWith('/map/rainfall')) {
      const date = url.searchParams.get('observation_date')!;
      const data: ResponseOf<'/api/v1/map/rainfall'> = { status: 'ok', data: [{ state_id: 'TEST_A', year: Number(date.slice(0, 4)), date, value: date === '2020-01-02' ? 0 : 8 }], meta: observationMeta };
      return Promise.resolve(Response.json(data));
    }
    if (path.endsWith('/trends/rainfall')) {
      const data: ResponseOf<'/api/v1/trends/rainfall'> = { status: 'ok', data: [{ state_id: url.searchParams.get('state_id')!, year: 2019, date: '2019-01-01', value: 4 }, { state_id: url.searchParams.get('state_id')!, year: 2020, date: '2020-01-01', value: 8 }], meta: observationMeta };
      return Promise.resolve(Response.json(data));
    }
    if (path.endsWith('/trends/temperature') && !temperatureUnavailable) return Promise.resolve(Response.json(temperature));
    if (path.endsWith('/trends/drought')) return Promise.resolve(Response.json(drought));
    return Promise.resolve(Response.json({ error: { code: 'DATASET_UNAVAILABLE', message: 'Test-only source unavailable' } }, { status: 503 }));
  }));
});
afterEach(() => { clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('map-first selected evidence', () => {
  it('distinguishes measured zero from an absent selected-date row even when a series exists', async () => {
    renderPage('overview');
    const rail = screen.getByRole('complementary', { name: 'Selected state evidence' });
    expect(await within(rail).findByLabelText('Recorded rainfall value')).toHaveTextContent(/^0$/);
    expect(within(rail).getByText('2020-01-02', { selector: 'time' })).toHaveAttribute('datetime', '2020-01-02');
    fireEvent.change(screen.getByLabelText('State / union territory'), { target: { value: 'TEST_B' } });
    await waitFor(() => expect(rail).toHaveAttribute('aria-busy', 'true'));
    expect(within(rail).queryByLabelText('Recorded rainfall value')).not.toBeInTheDocument();
    expect(await within(rail).findByText('No observation for this date')).toBeInTheDocument();
    expect(within(rail).getByRole('heading', { name: 'Fixture Beta' })).toBeInTheDocument();
    expect(within(rail).getByText('TEST_B')).toBeInTheDocument();
    expect(await within(rail).findByRole('heading', { name: 'Observed rainfall series' })).toBeInTheDocument();
  });

  it('couples a settled request year to its date and keeps the old output out of a new date selection', async () => {
    renderPage('overview');
    const rail = screen.getByRole('complementary', { name: 'Selected state evidence' });
    await within(rail).findByLabelText('Recorded rainfall value');
    fireEvent.change(screen.getByLabelText('Recorded rainfall date'), { target: { value: '2019-01-01' } });
    await waitFor(() => expect(rail).toHaveAttribute('aria-busy', 'true'));
    expect(within(rail).queryByLabelText('Recorded rainfall value')).not.toBeInTheDocument();
    expect(await within(rail).findByText('2019-01-01', { selector: 'time' })).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), 'http://localhost')).filter((url) => url.pathname.endsWith('/map/rainfall'));
    expect(calls.every((url) => url.searchParams.get('year') === url.searchParams.get('observation_date')?.slice(0, 4))).toBe(true);
  });

  it('keeps trend/report period owned by the selected state and explicit report selectors', async () => {
    window.location.hash = '#/explorer?hazard=rainfall&state_id=TEST_B&year=2020&start_year=2019&end_year=2019';
    renderPage('explorer');
    const button = await screen.findByRole('button', { name: 'Download Climate Report' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/reports/state/TEST_B?start_year=2019&end_year=2019&format=pdf'))).toBe(true));
  });
});

describe('traceable metadata and failures', () => {
  it('retains static source method and limitations without inventing a unit or period', () => {
    render(<Evidence meta={staticMeta} />);
    fireEvent.click(screen.getByText('Source & method'));
    expect(screen.getByText('Test-only boundary import')).toBeInTheDocument();
    expect(screen.getByText('Fixture coverage is not disaster frequency.')).toBeInTheDocument();
    expect(screen.getByText('Unit not declared')).toBeInTheDocument();
    expect(screen.queryByText(/Period unavailable|Period not supplied/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'test-official' })).toHaveAttribute('href', '#/sources?source_id=test-official');
  });

  it('distinguishes unavailable scientific dependencies from a disconnected backend', () => {
    const refetch = vi.fn();
    const view = render(<QueryState query={{ isPending: false, error: new ApiError('Fixture workbook is incompatible', 503, 'DATASET_INVALID'), refetch }} />);
    expect(screen.getByText('Fixture workbook is incompatible')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sources/i })).toBeInTheDocument();
    expect(screen.queryByText(/Ensure the backend is running/)).not.toBeInTheDocument();
    view.rerender(<QueryState query={{ isPending: false, error: new TypeError('Failed to fetch'), refetch }} />);
    expect(screen.getByText(/backend.*running|backend.*configuration/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry request' }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});

describe('returned regional and national views', () => {
  it('only offers source years/months, preserves year precision and never sends month to the API', async () => {
    window.location.hash = '#/explorer?hazard=heat&state_id=TEST_A&region=REGION_TEST';
    renderPage('explorer');
    const month = await screen.findByLabelText('Returned observation month');
    expect(within(month).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', '1', '7']);
    expect(within(screen.getByLabelText('View start year')).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', '2019', '2020']);
    const table = screen.getByText('Observation values (accessible table)').closest('details')!;
    expect(within(table).getByText('2019', { selector: 'td' })).toBeInTheDocument();
    expect(within(table).queryByText('2019-01')).not.toBeInTheDocument();
    fireEvent.change(month, { target: { value: '7' } });
    await waitFor(() => expect(window.location.hash).toContain('month=7'));
    expect(await screen.findByText('Year-only records have no month and are not part of the selected month view')).toBeInTheDocument();
    const filteredTable = screen.getByText('Observation values (accessible table)').closest('details')!;
    expect(within(filteredTable).getByText('2020-07', { selector: 'td' })).toBeInTheDocument();
    expect(within(filteredTable).getByText('31', { selector: 'td' })).toBeInTheDocument();
    expect(within(filteredTable).queryByText('2020-01', { selector: 'td' })).not.toBeInTheDocument();
    const requests = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), 'http://localhost')).filter((url) => url.pathname.endsWith('/trends/temperature'));
    expect(requests).toHaveLength(1);
    expect([...requests[0].searchParams.keys()]).toEqual(['region']);
    expect(screen.queryByRole('button', { name: 'Download Climate Report' })).not.toBeInTheDocument();
  });

  it('suppresses a chart for reversed bounds and clears temporal filters on region submission and lens change', async () => {
    window.location.hash = '#/explorer?hazard=heat&region=REGION_TEST&start_year=2020&end_year=2019&month=7';
    renderPage('explorer');
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose returned year bounds');
    expect(screen.queryByRole('heading', { name: 'Regional temperature · REGION_TEST' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Source region identifier'), { target: { value: 'REGION_NEXT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load regional temperature' }));
    await waitFor(() => expect(window.location.hash).toContain('region=REGION_NEXT'));
    expect(window.location.hash).not.toMatch(/start_year|end_year|month/);
    await screen.findByLabelText('Returned observation month');
    fireEvent.change(screen.getByLabelText('Returned observation month'), { target: { value: '1' } });
    await waitFor(() => expect(window.location.hash).toContain('month=1'));
    const floodLink = within(screen.getByRole('navigation', { name: 'Hazard lenses' })).getByRole('link', { name: 'Floods' });
    expect(floodLink.getAttribute('href')).not.toMatch(/month|start_year|end_year/);
    // Hash navigation is applied explicitly because jsdom does not perform anchor navigation.
    await act(async () => { window.location.hash = floodLink.getAttribute('href')!; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.queryByLabelText('Returned observation month')).not.toBeInTheDocument();
  });

  it('exposes no fabricated view controls for an unavailable regional dataset', async () => {
    temperatureUnavailable = true;
    window.location.hash = '#/explorer?hazard=heat&region=REGION_TEST';
    renderPage('explorer');
    expect(await screen.findByText('Test-only source unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('View start year')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Returned observation month')).not.toBeInTheDocument();
    expect(screen.getByText(/Test-only declared temperature coverage limitation/)).toBeInTheDocument();
  });

  it('keeps national drought requests and successful view filters free of state and month parameters', async () => {
    window.location.hash = '#/explorer?hazard=drought&state_id=TEST_A';
    renderPage('explorer');
    await screen.findByLabelText('View start year');
    const request = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), 'http://localhost')).find((url) => url.pathname.endsWith('/trends/drought'))!;
    expect(request.search).toBe('');
    expect(screen.queryByLabelText('Returned observation month')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('State / union territory')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download Climate Report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /NIElytics insights for this state/ })).not.toBeInTheDocument();
  });
});
