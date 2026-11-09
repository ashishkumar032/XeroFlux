import { useEffect, useState } from 'react';
export function useFilters(){
 const [hash,setHash]=useState(window.location.hash);
 useEffect(()=>{const update=()=>setHash(window.location.hash);window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);
 const filters=new URLSearchParams(hash.split('?')[1]??'');
 function setFilters(patch:Record<string,string|undefined>){const next=new URLSearchParams(window.location.hash.split('?')[1]??'');for(const [key,value]of Object.entries(patch)){if(value===undefined||value==='')next.delete(key);else next.set(key,value);}const route=window.location.hash.split('?')[0]||'#/overview';window.location.hash=route+(next.size?'?'+next.toString():'');}
 return {filters,setFilters};
}
