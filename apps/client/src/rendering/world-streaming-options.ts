const params=typeof location==='undefined'?new URLSearchParams():new URLSearchParams(location.search);
const storageKey='vanillagl.worldstream.enabled';
const saved=()=>{try{return localStorage.getItem(storageKey)!=='off';}catch{return true;}};
export let worldStreamingEnabled=params.has('worldstream')?params.get('worldstream')!=='off':saved();
export const initialWorldPagesEnabled=params.get('worldpages')!=='off';
export const initialWorldOcclusionEnabled=params.get('worldocclusion')!=='off';
export const worldOcclusionQueryMode=params.get('worldocclusion')==='queries';
export const worldOcclusionMovingMode=params.get('worldocclusion')==='moving';
// Rejected variants remain in the bounded comparison probe rather than the live selection.
export const worldExactFrustumMode=params.get('worldocclusion')==='tight';
export const worldOcclusionFacingMode=params.get('worldocclusion')==='facing';
export function setWorldStreamingEnabled(enabled:boolean,persist=false){worldStreamingEnabled=enabled;if(persist)try{localStorage.setItem(storageKey,enabled?'on':'off');}catch{/* URL and session controls still work. */}}
