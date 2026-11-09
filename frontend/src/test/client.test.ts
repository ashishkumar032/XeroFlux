import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrl, downloadReport, getApi } from '../api/client';
// Isolated synthetic responses only; no production climate fixtures.
const meta={metric:'test_only',unit:null,geographic_level:'state',time_resolution:'year',observation_count:0,source_ids:[],limitations:[]};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('Contract transport',()=>{
 it('encodes opaque identifiers and query values without changing the endpoint',()=>{
  vi.stubEnv('VITE_API_BASE_URL','https://backend.example.test/api/v1/');
  const url=apiUrl('/api/v1/cyclones/{storm_id}/track',{region:'A & B'},{storm_id:'storm/a?#'});
  expect(url).toBe('https://backend.example.test/api/v1/cyclones/storm%2Fa%3F%23/track?region=A+%26+B');
 });
 it('preserves explicit no_data and does not fabricate an observation',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({status:'no_data',data:[],meta})));
  const result=await getApi('/api/v1/map/rainfall',{year:2000});
  expect(result.status).toBe('no_data');expect(result.data).toEqual([]);expect(result.meta.observation_count).toBe(0);
 });
 it('keeps a measured zero distinct from absence',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({status:'ok',data:[{state_id:'SYNTHETIC',year:2000,value:0,date:null}],meta:{...meta,observation_count:1}})));
  expect((await getApi('/api/v1/map/rainfall',{year:2000})).data[0].value).toBe(0);
 });
 it.each([Response.json({status:'ok',data:null,meta}),Response.json({status:'ok',data:[],meta:{...meta,observation_count:-1}}),new Response('<html/>',{headers:{'Content-Type':'text/html'}})])('rejects malformed API data instead of rendering it as climate evidence',async response=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response));
  await expect(getApi('/api/v1/map/rainfall',{year:2000})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 });
 it('exposes backend scientific unavailability, not a fake fallback',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'DATASET_UNAVAILABLE',message:'Undefined drought columns',details:{}}},{status:503})));
  await expect(getApi('/api/v1/trends/drought')).rejects.toMatchObject({status:503,code:'DATASET_UNAVAILABLE',message:'Undefined drought columns'});
 });
 it('passes cancellation through to the request',async()=>{
  const controller=new AbortController();const fetcher=vi.fn().mockRejectedValue(new DOMException('Aborted','AbortError'));vi.stubGlobal('fetch',fetcher);controller.abort();
  await expect(getApi('/api/v1/states',undefined,undefined,controller.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
 });
 it.each([new Response('{}',{headers:{'content-type':'application/json'}}),new Response('',{headers:{'content-type':'application/pdf'}})])('refuses non-PDF or empty downloads',async response=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response));
  await expect(downloadReport('SYNTHETIC',2000,2001)).rejects.toMatchObject({code:'INVALID_REPORT'});
 });
});
