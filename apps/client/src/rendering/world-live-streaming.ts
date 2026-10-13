import * as THREE from 'three';
import { renderWithBlobShadowBatch } from './blob-shadow-batch';
import { beforeWorldDistrict } from './world-district-visibility';
import { liveWorldEnabled,liveWorldPageStats,updateLiveWorldPages,setLiveWorldPagesEnabled } from './world-live-pages';
import { LiveWorldOcclusion } from './world-live-occlusion';
import { AdaptiveWorldOcclusion } from './world-adaptive-occlusion';
import { MovingWorldOcclusion } from './world-moving-occlusion';
import { ExactWorldFrustum } from './world-exact-frustum';
import { initialWorldOcclusionEnabled,setWorldStreamingEnabled,worldOcclusionQueryMode,worldOcclusionMovingMode,worldOcclusionFacingMode,worldExactFrustumMode } from './world-streaming-options';

type Controller=LiveWorldOcclusion|AdaptiveWorldOcclusion|MovingWorldOcclusion|ExactWorldFrustum;
const controllers=new WeakMap<THREE.WebGLRenderer,Controller>();
let latest:Controller|undefined;
let occlusionEnabled=initialWorldOcclusionEnabled;
if(typeof window!=='undefined')Object.assign(window,{
  __wowWorldStreaming:()=>({pages:liveWorldPageStats(),occlusion:latest?.stats()??{enabled:occlusionEnabled&&liveWorldEnabled}}),
  __wowWorldStreamingControl:(options:{enabled?:boolean;persist?:boolean;occlusion?:boolean;pages?:boolean})=>{
    if(options.enabled!==undefined){setWorldStreamingEnabled(options.enabled,options.persist);setLiveWorldPagesEnabled(options.enabled);occlusionEnabled=options.enabled;}
    if(options.pages!==undefined)setLiveWorldPagesEnabled(options.pages);if(options.occlusion!==undefined)occlusionEnabled=options.occlusion;
    if(latest){latest.enabled=occlusionEnabled&&liveWorldEnabled;latest.invalidate();}
  },
});
/** Called only for the actual world pass, not UI, shadows, bloom or query scenes. */
export function renderLiveWorld(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera){
  if(renderer.xr.isPresenting){renderer.render(scene,camera);return;}
  if(!liveWorldEnabled){renderWithBlobShadowBatch(renderer,scene,camera);return;}
  updateLiveWorldPages(scene,camera);
  let controller=controllers.get(renderer);
  if(!controller){controller=worldExactFrustumMode?new ExactWorldFrustum():worldOcclusionQueryMode?new LiveWorldOcclusion():worldOcclusionFacingMode?new MovingWorldOcclusion(false):worldOcclusionMovingMode?new MovingWorldOcclusion():new AdaptiveWorldOcclusion();controllers.set(renderer,controller);renderer.domElement.addEventListener('webglcontextlost',()=>controller!.dispose());}
  latest=controller;controller.enabled=occlusionEnabled;
  const restore=controller.before(renderer,scene,camera);
  const restoreDistrict=beforeWorldDistrict(scene,camera,renderer);
  try{renderWithBlobShadowBatch(renderer,scene,camera);}finally{restoreDistrict();restore();}
}
