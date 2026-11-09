import { test, expect, type Page } from '@playwright/test';
import type { ResponseOf } from '../src/api/client';

async function expectPaintedTheme(page:Page,theme:'light'|'dark') {
  await page.waitForFunction(()=>{const element=document.querySelector('[data-map-ready]');return element&&(element.getAttribute('data-map-ready')==='true'||/could not|error|lost/.test(element.textContent??''));},undefined,{timeout:120_000});
  const map=page.locator('[data-map-ready]');
  expect(await map.getAttribute('data-map-ready'),await map.textContent()??'Missing map status').toBe('true');
  await expect(map).toHaveAttribute('data-map-theme',theme);
}
function luminance(color:string) {
  const values=(color.match(/[\d.]+/g)??[]).slice(0,3).map(value=>Number(value)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
  return values[0]*.2126+values[1]*.7152+values[2]*.0722;
}

test('light green and dark themes persist with keyboard controls and a stable live map',async({page},testInfo)=>{
  await page.goto('/#/overview?state_id=29');
  const root=page.locator('html'),control=page.getByRole('switch',{name:'Dark mode'});
  await expect(root).toHaveAttribute('data-theme','light');await expect(control).not.toBeChecked();
  await expectPaintedTheme(page,'light');
  const originalCanvas=await page.locator('canvas.maplibregl-canvas').elementHandle();
  const light=await root.evaluate(element=>({background:getComputedStyle(element).backgroundColor,text:getComputedStyle(element).color}));
  expect((Math.max(luminance(light.background),luminance(light.text))+.05)/(Math.min(luminance(light.background),luminance(light.text))+.05)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({path:'test-results/theme-light-'+testInfo.project.name+'.png'});
  await control.focus();await page.keyboard.press('Space');
  await expect(control).toBeChecked();await expect(control).toBeFocused();await expectPaintedTheme(page,'dark');
  expect(await originalCanvas!.evaluate(element=>element.isConnected)).toBe(true);
  await expect(page).toHaveURL(/state_id=29/);
  const dark=await root.evaluate(element=>({background:getComputedStyle(element).backgroundColor,text:getComputedStyle(element).color}));
  expect(luminance(light.background)).toBeGreaterThan(luminance(dark.background));
  expect((Math.max(luminance(dark.background),luminance(dark.text))+.05)/(Math.min(luminance(dark.background),luminance(dark.text))+.05)).toBeGreaterThanOrEqual(4.5);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/theme-dark-'+testInfo.project.name+'.png'});
  await page.getByRole('complementary',{name:'Selected state evidence'}).screenshot({path:'test-results/theme-evidence-dark-'+testInfo.project.name+'.png'});
  await page.reload();await expect(control).toBeChecked();await expect(root).toHaveAttribute('data-theme','dark');
  if(testInfo.project.name==='mobile')await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Sources & Methodology',exact:true}).click();
  await expect(page).toHaveURL(/sources/);await expect(control).toBeChecked();
  await control.click();await expect(root).toHaveAttribute('data-theme','light');
  expect(await page.evaluate(()=>localStorage.getItem('climatelens-theme'))).toBe('light');
});

test('changing appearance preserves real cyclone replay position and playback',async({page,request},testInfo)=>{
  const metadata=await request.get('/api/v1/metadata');expect(metadata.ok()).toBe(true);
  const catalog:ResponseOf<'/api/v1/metadata'>=(await metadata.json());
  const years=catalog.data.capabilities.available_years?.cyclones??[];
  const year=years.includes(2019)?2019:years.at(-1);expect(year).toBeDefined();
  const list=await request.get('/api/v1/cyclones',{params:{year:year!,limit:100,offset:0}});expect(list.ok()).toBe(true);
  const storms:ResponseOf<'/api/v1/cyclones'>=await list.json();
  const storm=storms.data.items.find(item=>item.name.toUpperCase()==='FANI')??storms.data.items[0];expect(storm).toBeDefined();
  const response=await request.get(`/api/v1/cyclones/${encodeURIComponent(storm.storm_id)}/track`);expect(response.ok()).toBe(true);
  const records:ResponseOf<'/api/v1/cyclones/{storm_id}/track'>['data']=(await response.json()).data;
  records.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));expect(records.length).toBeGreaterThan(1);
  await page.goto(`/#/time-machine?hazard=cyclones&year=${year}&storm_id=${storm.storm_id}`);
  const control=page.getByRole('switch',{name:'Dark mode'});
  await control.click();await expectPaintedTheme(page,'dark');
  await page.getByRole('button',{name:'Step',exact:true}).click();await expect(page.locator('time')).toHaveText(records[1].timestamp);
  const originalCanvas=await page.locator('canvas.maplibregl-canvas').elementHandle();
  await control.click();await expectPaintedTheme(page,'light');
  await expect(page.getByLabel('Observation timeline',{exact:true})).toHaveValue('1');await expect(page.locator('time')).toHaveText(records[1].timestamp);
  expect(await originalCanvas!.evaluate(element=>element.isConnected)).toBe(true);
  await page.getByRole('button',{name:'Play',exact:true}).click();await control.click();
  await expectPaintedTheme(page,'dark');await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const index=Number(await page.getByLabel('Observation timeline',{exact:true}).inputValue());expect(index).toBeGreaterThanOrEqual(1);
  await expect(page.locator('time')).toHaveText(records[index].timestamp);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.map-canvas').screenshot({path:'test-results/theme-replay-dark-'+testInfo.project.name+'.png'});
  await page.screenshot({path:'test-results/theme-replay-workbench-dark-'+testInfo.project.name+'.png',fullPage:true});
});
