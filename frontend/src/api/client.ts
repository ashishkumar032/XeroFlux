import { useQuery } from '@tanstack/react-query';
import type { paths } from './schema';
export type JsonPath = Exclude<keyof paths, '/api/v1/reports/state/{state_id}'>;
type Operation<P extends keyof paths> = paths[P]['get'];
export type ResponseOf<P extends JsonPath> = Operation<P> extends {responses:{200:{content:{'application/json':infer R}}}} ? R : never;
type Parameter<P extends keyof paths, K extends string> = Operation<P> extends {parameters:infer A} ? K extends keyof A ? Exclude<A[K],undefined> : never : never;
export class ApiError extends Error { constructor(message:string, public status:number, public code:string) {super(message); this.name='ApiError';} }
export function apiUrl(path:string,query?:object,pathParameters?:object):string {
  let resolved=path;
  for(const [key,value] of Object.entries(pathParameters ?? {})) resolved=resolved.replace('{'+key+'}',encodeURIComponent(String(value)));
  if(resolved.includes('{')) throw new Error('A required API identifier is missing.');
  const base=(import.meta.env.VITE_API_BASE_URL?.trim() || '/api/v1').replace(/\/$/,'');
  const url=base+resolved.replace(/^\/api\/v1/,'');
  const search=new URLSearchParams();
  for(const [key,value] of Object.entries(query ?? {})) if(value !== undefined && value !== null && value !== '') search.set(key,String(value));
  return url+(search.size?'?'+search.toString():'');
}
async function responseError(response:Response):Promise<ApiError> {
  let message='Backend request failed (HTTP '+response.status+').'; let code='HTTP_ERROR';
  try {const body:unknown=await response.json(); if(body && typeof body==='object' && 'error' in body){const error=body.error; if(error && typeof error==='object'){if('message' in error && typeof error.message==='string')message=error.message; if('code' in error && typeof error.code==='string')code=error.code;}}} catch { /* Non-JSON proxy/server errors retain HTTP status. */ }
  return new ApiError(message,response.status,code);
}
export async function getApi<P extends JsonPath>(path:P, query?:Parameter<P,'query'>, pathParameters?:Parameter<P,'path'>, signal?:AbortSignal):Promise<ResponseOf<P>> {
  const response=await fetch(apiUrl(path,query,pathParameters),{signal,headers:{Accept:'application/json'}});
  if(!response.ok)throw await responseError(response);
  if(!response.headers.get('content-type')?.includes('application/json'))throw new ApiError('The API returned a non-JSON response. Check backend URL/proxy configuration.',502,'INVALID_RESPONSE');
  const body:unknown=await response.json();
  if(!body || typeof body!=='object' || !('status' in body) || (body.status!=='ok' && body.status!=='no_data'))throw new ApiError('The API returned an invalid response envelope.',502,'INVALID_RESPONSE');
  if(path!=='/api/v1/health' && (!('data' in body)||!('meta' in body)||!body.meta||typeof body.meta!=='object'))throw new ApiError('The API response is missing data or evidence metadata.',502,'INVALID_RESPONSE');
  if(path !== '/api/v1/health' && 'data' in body && 'meta' in body) {
    const meta=body.meta as Record<string,unknown>;
    if(typeof meta.metric!=='string'||typeof meta.geographic_level!=='string'||typeof meta.time_resolution!=='string'||typeof meta.observation_count!=='number'||!Number.isFinite(meta.observation_count)||meta.observation_count<0)throw new ApiError('The API returned invalid evidence metadata.',502,'INVALID_RESPONSE');
    const collectionPaths:string[]=['/api/v1/states','/api/v1/sources','/api/v1/map/rainfall','/api/v1/trends/rainfall','/api/v1/trends/drought','/api/v1/trends/temperature','/api/v1/insights','/api/v1/multi-hazard','/api/v1/cyclones/{storm_id}/track'];
    if(collectionPaths.includes(path)&&!Array.isArray(body.data))throw new ApiError('The API returned an invalid observation collection.',502,'INVALID_RESPONSE');
    if(path==='/api/v1/boundaries'&&(!body.data||typeof body.data!=='object'||!('type'in body.data)||body.data.type!=='FeatureCollection'||!('features'in body.data)||!Array.isArray(body.data.features)))throw new ApiError('The API returned invalid official boundary data.',502,'INVALID_RESPONSE');
  }
  return body as ResponseOf<P>;
}
export function useApi<P extends JsonPath>(path:P, query?:Parameter<P,'query'>, pathParameters?:Parameter<P,'path'>, enabled=true) {
  return useQuery({
    queryKey:[path,query??null,pathParameters??null],
    queryFn:({signal})=>getApi(path,query,pathParameters,AbortSignal.any([signal,AbortSignal.timeout(120_000)])),
    enabled,
    staleTime:path==='/api/v1/health'?0:300_000,
    refetchInterval:path==='/api/v1/health'?30_000:false,
    retry:(failureCount,error)=>failureCount<1 && (!(error instanceof ApiError)||(error.status>=500&&!['DATASET_UNAVAILABLE','DATASET_INVALID','ANALYTICS_UNAVAILABLE'].includes(error.code))),
  });
}
export async function downloadReport(stateId:string,startYear:number,endYear:number,signal?:AbortSignal):Promise<void>{
  const response=await fetch(apiUrl('/api/v1/reports/state/{state_id}',{start_year:startYear,end_year:endYear,format:'pdf'},{state_id:stateId}),{signal,headers:{Accept:'application/pdf'}});
  if(!response.ok)throw await responseError(response);
  if(!response.headers.get('content-type')?.includes('application/pdf'))throw new ApiError('The report endpoint did not return a PDF.',502,'INVALID_REPORT');
  const blob=await response.blob(); if(!blob.size)throw new ApiError('The report was empty.',502,'INVALID_REPORT');
  const url=URL.createObjectURL(blob); const anchor=document.createElement('a'); anchor.href=url; anchor.download='climatelens-'+stateId.replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+startYear+'-'+endYear+'.pdf'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
