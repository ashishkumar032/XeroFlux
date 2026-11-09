import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { JsonPath, ResponseOf } from '../src/api/client';
import type { Catalog, RainfallRecord, StateRecord } from '../src/api/types';

async function api<P extends JsonPath>(request: APIRequestContext, path: P, params?: Record<string, string | number>): Promise<ResponseOf<P>> {
  const response = await request.get(path, { params });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return response.json();
}
async function scope(request: APIRequestContext) {
  const [metadata, states] = await Promise.all([api(request, '/api/v1/metadata'), api(request, '/api/v1/states')]);
  const dates = [...(metadata.data.capabilities.rainfall_observation_dates ?? [])].sort();
  const state = states.data.find(record => record.name === 'Karnataka');
  expect(state, 'The real state catalog must contain Karnataka for the geographic click check').toBeDefined();
  return { catalog: metadata.data, states: states.data, dates, state: state! };
}
function period(catalog: Catalog) {
  const years = [...new Set(['floods', 'landslides'].flatMap(dataset => catalog.capabilities.available_years?.[dataset] ?? []))].sort((a, b) => a - b);
  expect(years.length, 'A report period must come from actual catalog years').toBeGreaterThan(0);
  return { start: years[0], end: years[years.length - 1] };
}
async function expectOfficialMap(page: Page) {
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-map-ready]');
    return element && (element.getAttribute('data-map-ready') === 'true' || /could not|error|lost/.test(element.textContent ?? ''));
  }, undefined, { timeout: 120_000 });
  const status = page.locator('[data-map-ready]');
  expect(await status.getAttribute('data-map-ready'), await status.textContent() ?? 'Missing map status').toBe('true');
}
async function expectRainfall(rail: Locator, state: StateRecord, date: string, rows: RainfallRecord[], unit?: string | null) {
  await expect(rail).toHaveAttribute('aria-busy', 'false');
  await expect(rail.getByRole('heading', { name: state.name, exact: true })).toBeVisible();
  await expect(rail.getByText(state.state_id, { exact: true })).toBeVisible();
  await expect(rail.locator('time').first()).toHaveAttribute('datetime', date);
  await expect(rail.locator('time').first()).toHaveText(date);
  const observation = rows.find(row => row.state_id === state.state_id && row.date === date);
  const output = rail.getByRole('status', { name: 'Recorded rainfall value' });
  if (observation) {
    await expect(output).toHaveText(String(observation.value));
    await expect(rail.getByText(unit ?? 'Unit not declared', { exact: true }).first()).toBeVisible();
  } else {
    await expect(output).toHaveCount(0);
    await expect(rail.getByText('No observation for this date', { exact: true })).toBeVisible();
  }
}
async function replayFixture(request: APIRequestContext) {
  const catalog = (await api(request, '/api/v1/metadata')).data;
  const years = [...(catalog.capabilities.available_years?.cyclones ?? [])].sort((a, b) => a - b);
  expect(years.length).toBeGreaterThan(0);
  const year = years.includes(2019) ? 2019 : years[years.length - 1];
  const storms = (await api(request, '/api/v1/cyclones', { year, limit: 100, offset: 0 })).data;
  const storm = storms.items.find(item => item.name.toUpperCase() === 'FANI') ?? storms.items[0];
  expect(storm, 'Replay must select a storm actually returned by the source catalog').toBeDefined();
  const track = await request.get(`/api/v1/cyclones/${encodeURIComponent(storm.storm_id)}/track`);
  expect(track.ok()).toBe(true);
  const records: ResponseOf<'/api/v1/cyclones/{storm_id}/track'>['data'] = (await track.json()).data;
  records.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  expect(records.length).toBeGreaterThan(2);
  return { year, years, storm, storms, records };
}
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('official map fits the first fold and selects actual state rainfall evidence', async ({ page, request }, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const { catalog, dates, state } = await scope(request);
  expect(dates.length).toBeGreaterThan(0);
  const date = dates[dates.length - 1];
  const rainfall = await api(request, '/api/v1/map/rainfall', { year: Number(date.slice(0, 4)), observation_date: date });
  await page.goto(`/#/overview?observation_date=${date}`);
  await expect(page.getByText('Historical API connected')).toBeVisible();
  await expectOfficialMap(page);
  const canvas = page.locator('canvas.maplibregl-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (testInfo.project.name === 'desktop') {
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(box!.y).toBeLessThanOrEqual(300);
    expect(box!.height).toBeGreaterThanOrEqual(400);
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  }
  const bounds = await api(request, '/api/v1/boundaries');
  let west = 180, east = -180, south = 90, north = -90;
  const visit = (coordinates: unknown) => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
      west = Math.min(west, coordinates[0]); east = Math.max(east, coordinates[0]);
      south = Math.min(south, coordinates[1]); north = Math.max(north, coordinates[1]);
    } else coordinates.forEach(visit);
  };
  bounds.data.features.forEach(feature => visit(feature.geometry.coordinates));
  const mercator = (longitude: number, latitude: number) => ({ x: (longitude + 180) / 360, y: (1 - Math.log(Math.tan(latitude * Math.PI / 180) + 1 / Math.cos(latitude * Math.PI / 180)) / Math.PI) / 2 });
  const nw = mercator(west, north), se = mercator(east, south), bengaluru = mercator(77.59, 12.97);
  const scale = Math.min((box!.width - 60) / (se.x - nw.x), (box!.height - 60) / (se.y - nw.y));
  await canvas.click({ position: { x: box!.width / 2 + (bengaluru.x - (nw.x + se.x) / 2) * scale, y: box!.height / 2 + (bengaluru.y - (nw.y + se.y) / 2) * scale } });
  await expect.poll(() => new URLSearchParams(page.url().split('?')[1]).get('state_id')).toBe(state.state_id);
  await expect(page.getByLabel('State / union territory', { exact: true })).toHaveValue(state.state_id);
  await expect(page.getByLabel('State / union territory', { exact: true })).toHaveCount(1);
  const tooltip = page.locator('.maplibregl-popup');
  await expect(tooltip).toBeVisible();
  const tooltipBox = await tooltip.boundingBox(), mapBox = await canvas.boundingBox();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(mapBox!.x - 1);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(mapBox!.x + mapBox!.width + 1);
  const rail = page.getByRole('complementary', { name: 'Selected state evidence' });
  await expectRainfall(rail, state, date, rainfall.data, rainfall.meta.unit);
  const years = [...(catalog.capabilities.available_years?.rainfall ?? [])].sort((a, b) => a - b);
  const trend = await api(request, '/api/v1/trends/rainfall', { state_id: state.state_id, start_year: years[0], end_year: years[years.length - 1] });
  if (trend.data.length) {
    await rail.getByText('Observation values (accessible table)', { exact: true }).click();
    const table = rail.getByRole('table');
    await expect(table.locator('tbody tr')).toHaveCount(trend.data.length);
    for (const row of [trend.data[0], trend.data[trend.data.length - 1]]) {
      await expect(table.getByRole('row').filter({ has: page.getByRole('cell', { name: row.date ?? String(row.year), exact: true }) })).toContainText(String(row.value));
    }
  }
  await page.locator('.map-canvas').screenshot({ path: `test-results/india-map-${testInfo.project.name}.png` });
  await rail.screenshot({ path: `test-results/selected-evidence-${testInfo.project.name}.png` });
  await page.screenshot({ path: `test-results/dashboard-${testInfo.project.name}.png`, fullPage: true });
  await expectNoOverflow(page);
  expect(failures).toEqual([]);
});

test('rapid catalog filters never label a stale observation as the new selection', async ({ page, request }) => {
  const { dates, states, state } = await scope(request);
  expect(dates.length, 'This real-data regression requires two supplied observation dates').toBeGreaterThanOrEqual(2);
  const initialDate = dates[0], middleDate = dates[1], finalDate = dates[dates.length - 1];
  const otherState = states.find(record => record.state_id !== state.state_id)!;
  const initial = await api(request, '/api/v1/map/rainfall', { year: Number(initialDate.slice(0, 4)), observation_date: initialDate });
  const final = await api(request, '/api/v1/map/rainfall', { year: Number(finalDate.slice(0, 4)), observation_date: finalDate });
  await page.goto(`/#/overview?state_id=${state.state_id}&observation_date=${initialDate}`);
  const rail = page.getByRole('complementary', { name: 'Selected state evidence' });
  await expectRainfall(rail, state, initialDate, initial.data, initial.meta.unit);
  await expectOfficialMap(page);
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: requested, resolve: finalRequested } = Promise.withResolvers<void>();
  const observedQueries: URLSearchParams[] = [];
  // Delay delivery only: every payload and status still comes from the real endpoint.
  await page.route('**/api/v1/map/rainfall?**', async route => {
    const query = new URL(route.request().url()).searchParams;
    observedQueries.push(query);
    if (query.get('observation_date') === finalDate) finalRequested();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByLabel('Recorded rainfall date', { exact: true }).selectOption(middleDate);
    await page.getByLabel('Recorded rainfall date', { exact: true }).selectOption(initialDate);
    await page.getByLabel('State / union territory', { exact: true }).selectOption(otherState.state_id);
    await page.getByLabel('Recorded rainfall date', { exact: true }).selectOption(finalDate);
    await expect(page.getByLabel('Recorded rainfall date', { exact: true })).toHaveValue(finalDate);
    await expect(rail).toHaveAttribute('aria-busy', 'true');
    await expect(rail.getByRole('status', { name: 'Recorded rainfall value' })).toHaveCount(0);
    await expect(rail.getByRole('table')).toHaveCount(0);
    await expect(rail.getByRole('img')).toHaveCount(0);
    await requested;
    await expect(rail).toHaveAttribute('aria-busy', 'true');
    await expect(rail.getByRole('status', { name: 'Recorded rainfall value' })).toHaveCount(0);
    for (const query of observedQueries) expect(query.get('year')).toBe(query.get('observation_date')!.slice(0, 4));
  } finally {
    release();
  }
  await expectRainfall(rail, otherState, finalDate, final.data, final.meta.unit);
  await expectOfficialMap(page);
  await page.unroute('**/api/v1/map/rainfall?**');
});

test('returned cyclone replay keeps the map and playback in one desktop viewport', async ({ page, request }, testInfo) => {
  const { year, years, storm, storms, records } = await replayFixture(request);
  await page.goto(`/#/time-machine?hazard=cyclones&year=${year}&storm_id=${storm.storm_id}`);
  const time = page.getByRole('complementary', { name: 'Source record' }).locator('time');
  await expect(time).toHaveText(records[0].timestamp);
  await expect(time).toHaveAttribute('datetime', records[0].timestamp);
  await expectOfficialMap(page);
  const stage = page.getByRole('region', { name: 'Observed geography and playback' });
  const canvas = stage.locator('canvas.maplibregl-canvas');
  const play = stage.getByRole('button', { name: 'Play', exact: true });
  await expect(play).toBeEnabled();
  if (testInfo.project.name === 'desktop') {
    const mapBox = await canvas.boundingBox(), playBox = await play.boundingBox();
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(mapBox!.y).toBeGreaterThanOrEqual(0);
    expect(mapBox!.y + mapBox!.height).toBeLessThanOrEqual(900);
    expect(playBox!.y).toBeGreaterThanOrEqual(mapBox!.y + mapBox!.height);
    expect(playBox!.y + playBox!.height).toBeLessThanOrEqual(900);
  }
  await expect(stage.getByText('Recorded cyclone route', { exact: false })).toBeVisible();
  const boundaries = await api(request, '/api/v1/boundaries');
  let west = 180, east = -180, south = 90, north = -90;
  const extend = (coordinates: unknown) => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
      west = Math.min(west, coordinates[0]); east = Math.max(east, coordinates[0]);
      south = Math.min(south, coordinates[1]); north = Math.max(north, coordinates[1]);
    } else coordinates.forEach(extend);
  };
  boundaries.data.features.forEach(feature => extend(feature.geometry.coordinates));
  records.forEach(record => extend([record.longitude, record.latitude]));
  const project = (longitude: number, latitude: number) => ({ x: (longitude + 180) / 360, y: (1 - Math.log(Math.tan(latitude * Math.PI / 180) + 1 / Math.cos(latitude * Math.PI / 180)) / Math.PI) / 2 });
  const northwest = project(west, north), southeast = project(east, south);
  // Inspect actual rendered source markers at both route ends, using the real fitted extent.
  for (const index of [0, records.length - 1]) {
    await stage.getByLabel('Observation timeline', { exact: true }).fill(String(index));
    await expect(time).toHaveText(records[index].timestamp);
    const box = await canvas.boundingBox();
    const point = project(records[index].longitude, records[index].latitude);
    const scale = Math.min((box!.width - 60) / (southeast.x - northwest.x), (box!.height - 60) / (southeast.y - northwest.y));
    await expect.poll(async () => {
      await canvas.hover({ position: { x: box!.width / 2 + (point.x - (northwest.x + southeast.x) / 2) * scale, y: box!.height / 2 + (point.y - (northwest.y + southeast.y) / 2) * scale } });
      return (await page.locator('.maplibregl-popup').allTextContents()).join(' ');
    }).toContain(records[index].timestamp);
    await expect(page.getByRole('complementary', { name: 'Source record' }).getByText(`${records[index].longitude}, ${records[index].latitude}`, { exact: true })).toBeVisible();
  }
  await stage.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(time).toHaveText(records[0].timestamp);
  await stage.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(time).toHaveText(records[1].timestamp);
  const timeline = stage.getByLabel('Observation timeline', { exact: true });
  await timeline.fill('2');
  await expect(time).toHaveText(records[2].timestamp);
  await stage.getByLabel('Playback speed').selectOption('2');
  await play.click();
  await expect(timeline).not.toHaveValue('2');
  await stage.getByRole('button', { name: 'Pause', exact: true }).click();
  const index = Number(await timeline.inputValue());
  await expect(time).toHaveText(records[index].timestamp);
  await page.waitForTimeout(650);
  await expect(timeline).toHaveValue(String(index));
  await stage.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(time).toHaveText(records[0].timestamp);
  await page.screenshot({ path: `test-results/replay-${testInfo.project.name}.png`, fullPage: true });
  const otherStorm = storms.items.find(item => item.storm_id !== storm.storm_id);
  if (otherStorm) {
    await play.click();
    await page.getByLabel('Cyclone / storm', { exact: true }).selectOption(otherStorm.storm_id);
    await expect(page.getByLabel('Observation timeline', { exact: true })).toHaveValue('0');
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  }
  const otherYear = years.find(value => value !== year);
  if (otherYear !== undefined) {
    await page.getByLabel('Recorded year / catalog season').selectOption(String(otherYear));
    await expect.poll(() => new URLSearchParams(page.url().split('?')[1]).get('year')).toBe(String(otherYear));
    await expect(page.getByLabel('Observation timeline', { exact: true })).toHaveValue('0');
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  }
  if (storms.total > storms.items.length) {
    await page.goto(`/#/time-machine?hazard=cyclones&year=${year}&storm_id=${storm.storm_id}`);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Next storms page', exact: true }).click();
    await expect(page.getByLabel('Observation timeline', { exact: true })).toHaveValue('0');
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  }
  await expectNoOverflow(page);
});

test('real insight methods link to their source article and download a backend PDF', async ({ page, request }, testInfo) => {
  const { catalog, state } = await scope(request);
  const { start, end } = period(catalog);
  const insights = await api(request, '/api/v1/insights', { state_id: state.state_id, start_year: start, end_year: end });
  expect(insights.data.length).toBeGreaterThan(0);
  const insight = insights.data[0];
  const sources = (await api(request, '/api/v1/sources')).data;
  const source = sources.find(record => insight.source_ids.includes(record.id));
  expect(source, 'The actual insight must retain a catalog source deep link').toBeDefined();
  await page.goto(`/#/insights?state_id=${state.state_id}&start_year=${start}&end_year=${end}`);
  const finding = page.getByRole('article').filter({ has: page.getByRole('heading', { name: insight.title, exact: true }) });
  await finding.getByText('How was this calculated?', { exact: true }).click();
  if (insight.method) await expect(finding.getByText(insight.method, { exact: true })).toBeVisible();
  for (const limitation of insight.limitations) await expect(finding.getByText(limitation, { exact: true })).toBeVisible();
  const reportResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/reports/state/${state.state_id}`);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Climate Report', exact: true }).click();
  const [download, response] = await Promise.all([downloadEvent, reportResponse]);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('application/pdf');
  const reportQuery = new URL(response.url()).searchParams;
  expect(reportQuery.get('start_year')).toBe(String(start));
  expect(reportQuery.get('end_year')).toBe(String(end));
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  expect((await readFile(path!)).subarray(0, 5).toString()).toBe('%PDF-');
  await page.screenshot({ path: `test-results/insight-${testInfo.project.name}.png`, fullPage: true });
  await finding.locator(`a[href="#/sources?source_id=${encodeURIComponent(source!.id)}"]`).click();
  await expect.poll(() => new URLSearchParams(page.url().split('?')[1]).get('source_id')).toBe(source!.id);
  const article = page.locator(`[id="source-${source!.id}"]`);
  await expect(article.getByRole('heading', { name: source!.name, exact: true })).toBeVisible();
  await expect(article.getByText(source!.provider, { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Dataset index', exact: true })).toBeVisible();
  const external = page.locator('main a[target="_blank"]');
  for (const link of await external.all()) expect(await link.getAttribute('href')).toMatch(/^https?:\/\//);
  await expectNoOverflow(page);
});

test('multi-hazard paging preserves original observations and lazy map activation', async ({ page, request }) => {
  const { catalog, state, states } = await scope(request);
  const { start, end } = period(catalog);
  let chosenState = state;
  let relationships = await api(request, '/api/v1/multi-hazard', { state_id: chosenState.state_id, start_year: start, end_year: end });
  let relationship = relationships.data.find(record => record.observations.length > 50);
  // Find a real pageable relationship; never inflate or replace the API records.
  for (const candidate of states) {
    if (relationship) break;
    if (candidate.state_id === chosenState.state_id) continue;
    const response = await api(request, '/api/v1/multi-hazard', { state_id: candidate.state_id, start_year: start, end_year: end });
    const found = response.data.find(record => record.observations.length > 50);
    if (found) { chosenState = candidate; relationships = response; relationship = found; }
  }
  expect(relationship, 'The real relationship catalog must supply more than 50 observations to exercise paging').toBeDefined();
  const observations = [...relationship!.observations].sort((a, b) => (a.timestamp ?? String(a.year ?? '')).localeCompare(b.timestamp ?? String(b.year ?? '')));
  await page.goto(`/#/multi-hazard?state_id=${chosenState.state_id}&start_year=${start}&end_year=${end}`);
  await page.getByRole('button', { name: new RegExp(relationship!.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await expect(page.locator('[data-map-ready]')).toHaveCount(0);
  const table = page.getByRole('table', { name: 'Source records supplied with this relationship' });
  const assertRows = async (offset: number) => {
    const expected = observations.slice(offset, offset + 50);
    await expect(table.locator('tbody tr')).toHaveCount(expected.length);
    for (const [index, observation] of expected.entries()) {
      const row = table.locator('tbody tr').nth(index);
      await expect(row.getByRole('cell').nth(1)).toHaveText(observation.event_id);
      const source = row.getByRole('rowheader');
      await expect(source).toHaveText(observation.timestamp ?? (observation.year != null ? `${observation.year} (year only)` : 'Timestamp not provided'));
      if (observation.timestamp) await expect(source.locator('time')).toHaveAttribute('datetime', observation.timestamp);
      await expect(row.getByRole('cell').nth(3)).toHaveText(observation.longitude != null && observation.latitude != null ? `${observation.longitude}, ${observation.latitude}` : 'Not provided — not mapped');
    }
  };
  await assertRows(0);
  await page.getByRole('button', { name: 'Next observations', exact: true }).click();
  await assertRows(50);
  await expect(page.getByRole('status').filter({ hasText: /^Records 51–/ })).toContainText(`of ${observations.length.toLocaleString()}`);
  await page.getByRole('button', { name: 'Previous observations', exact: true }).click();
  await assertRows(0);
  await expect(page.getByText('Co-occurrence is not causation or simultaneity.', { exact: true })).toBeVisible();
  if (observations.some(record => !record.timestamp && record.year != null)) await expect(page.getByText('Year-only records have no within-year ordering.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show observed-record map', exact: true }).click();
  await expectOfficialMap(page);
  await expect(page.locator('#multi-state')).toHaveCount(1);
  await expect(page.getByLabel('Map state selection')).toHaveCount(0);
  await assertRows(0);
  await expectNoOverflow(page);
});

test('hazard lenses keep source scope and retain unmapped event rows across server pages', async ({ page, request }) => {
  const { catalog, state } = await scope(request);
  let selected: { hazard: 'floods' | 'landslides'; year: number; records: ResponseOf<'/api/v1/events/floods'> } | undefined;
  for (const hazard of ['floods', 'landslides'] as const) {
    for (const year of [...(catalog.capabilities.available_years?.[hazard] ?? [])].sort((a, b) => b - a)) {
      const records = await api(request, hazard === 'floods' ? '/api/v1/events/floods' : '/api/v1/events/landslides', { year, limit: 100, offset: 0 });
      if (records.data.total > 100 && records.data.items.some(event => event.latitude == null || event.longitude == null)) {
        selected = { hazard, year, records };
        break;
      }
    }
    if (selected) break;
  }
  expect(selected, 'A real event page must contain unmapped records and a following server page').toBeDefined();
  const { hazard, year, records } = selected!;
  await page.goto(`/#/overview?state_id=${state.state_id}&year=${year}`);
  const scopedRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === `/api/v1/events/${hazard}` && url.searchParams.get('state_id') === state.state_id && url.searchParams.get('year') === String(year);
  });
  await page.getByRole('navigation', { name: 'Hazard lenses', exact: true }).getByRole('link', { name: new RegExp(`^${hazard === 'floods' ? 'Floods' : 'Landslides'}`) }).click();
  const initialQuery = new URL((await scopedRequest).url()).searchParams;
  expect(initialQuery.get('limit')).toBe('100');
  expect(initialQuery.get('offset')).toBe('0');
  await expect(page.getByLabel('State / union territory', { exact: true })).toHaveValue(state.state_id);
  await page.getByLabel('State / union territory', { exact: true }).selectOption('');
  const rail = page.getByRole('region', { name: 'Recorded observations', exact: true });
  await expect(rail.locator('.event-records > li')).toHaveCount(records.data.items.length);
  const missing = records.data.items.find(event => event.latitude == null || event.longitude == null)!;
  const unmapped = rail.getByRole('listitem').filter({ has: page.getByRole('heading', { name: missing.event_id, exact: true }) });
  await expect(unmapped.getByText('Location not available', { exact: true })).toBeVisible();
  if (missing.timestamp) await expect(unmapped.locator('time')).toHaveAttribute('datetime', missing.timestamp);
  else if (missing.year != null) await expect(unmapped.getByText(String(missing.year), { exact: true })).toBeVisible();
  const pager = rail.getByRole('navigation', { name: `${hazard === 'floods' ? 'Floods' : 'Landslides'} pagination`, exact: true });
  await expect(pager).toContainText(`of ${records.data.total}`);
  const nextRequest = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/v1/events/${hazard}` && url.searchParams.get('offset') === '100' && !url.searchParams.has('state_id');
  });
  await pager.getByRole('button', { name: 'Next 100', exact: true }).click();
  const response = await nextRequest;
  expect(response.ok()).toBe(true);
  const next: ResponseOf<'/api/v1/events/floods'> = await response.json();
  await expect(rail.locator('.event-records > li')).toHaveCount(next.data.items.length);
  if (next.data.items.length) await expect(rail.getByRole('heading', { name: next.data.items[0].event_id, exact: true })).toBeVisible();
  await expect(pager).toContainText(`of ${next.data.total}`);
  await expect(pager.getByRole('button', { name: 'Previous 100', exact: true })).toBeEnabled();
  await expectNoOverflow(page);
});

test('unavailable comparison and hazards retain the real backend explanation', async ({ page, request }, testInfo) => {
  const { catalog } = await scope(request);
  await page.goto('/#/comparison');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if (!catalog.capabilities.comparison_metrics?.length) {
    await expect(page.getByLabel('Backend-supported metric')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Compare states', exact: true })).toBeDisabled();
    await expect(page.locator('main .recharts-wrapper')).toHaveCount(0);
  }
  const reason = catalog.capabilities.omitted_datasets?.drought;
  if (reason) {
    await page.goto('/#/explorer?hazard=drought');
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible();
    await expect(alert.getByRole('link', { name: 'Review sources and coverage' })).toBeVisible();
    await expect(alert).not.toContainText('Check the backend connection');
    await expect(page.getByRole('button', { name: 'Download Climate Report', exact: true })).toHaveCount(0);
  }
  await expectNoOverflow(page);
  if (testInfo.project.name === 'mobile') {
    const open = page.getByRole('button', { name: 'Open navigation' });
    await open.click();
    const nav = page.getByRole('navigation', { name: 'Primary', exact: true });
    await expect(nav).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'Primary navigation', exact: true });
    const first = dialog.getByRole('link').first(), last = dialog.getByRole('link').last();
    await last.focus();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
  }
});

test('1024 by 768 workbenches stack without horizontal document overflow', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The laptop layout is an additional desktop viewport.');
  await page.setViewportSize({ width: 1024, height: 768 });
  const { state, dates } = await scope(request);
  await page.goto(`/#/overview?state_id=${state.state_id}&observation_date=${dates[dates.length - 1]}`);
  await expectOfficialMap(page);
  const map = await page.locator('canvas.maplibregl-canvas').boundingBox();
  const rail = await page.getByRole('complementary', { name: 'Selected state evidence' }).boundingBox();
  expect(rail!.y).toBeGreaterThanOrEqual(map!.y + map!.height);
  await expectNoOverflow(page);
  await page.screenshot({ path: 'test-results/overview-laptop.png', fullPage: true });
  const { year, storm } = await replayFixture(request);
  await page.goto(`/#/time-machine?hazard=cyclones&year=${year}&storm_id=${storm.storm_id}`);
  await expectOfficialMap(page);
  const stage = page.getByRole('region', { name: 'Observed geography and playback' });
  const stageBox = await stage.boundingBox();
  const readout = await page.getByRole('complementary', { name: 'Source record' }).boundingBox();
  expect(readout!.y).toBeGreaterThanOrEqual(stageBox!.y + stageBox!.height);
  await expect(stage.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await expectNoOverflow(page);
  await page.screenshot({ path: 'test-results/replay-laptop.png', fullPage: true });
});
