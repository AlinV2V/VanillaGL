import * as THREE from 'three';
import { pageView,worldPagePartKey,worldPageSourceChecksum,type WorldPage,type WorldPageCatalog } from './world-page-format';
import { registerWmoFamilyRoom } from './wmo-live-families';
import { compactWmoBatchGeometry } from './wmo-batched-experiment';
import { worldStreamingEnabled,initialWorldPagesEnabled } from './world-streaming-options';
import { seedWorldVisibility } from './world-visibility-compiler';
import { releaseWmoFamilies } from './wmo-family-ownership';
import { wmoFamilyTexturePool } from './wmo-family-texture-pool';
import { registerWorldDistrictRoom,releaseWorldDistrict } from './world-district-visibility';

export type LiveWorldMesh=THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>;
export type LiveWorldRoom={root:THREE.Group;objects:THREE.Object3D[];originals:Map<LiveWorldMesh,THREE.BufferGeometry>;sphere:THREE.Sphere;index:number;checksum:number;page?:WorldPage;resident?:{bytes:number;geometries:Map<LiveWorldMesh,THREE.BufferGeometry>};pending?:Promise<void>;lastWanted:number;released:boolean;failed:boolean};
export { worldStreamingEnabled as liveWorldEnabled } from './world-streaming-options';
let pagesEnabled=initialWorldPagesEnabled;
export const liveWorldRooms=new Set<LiveWorldRoom>();
export const liveWorldRoots=new Set<THREE.Group>();
const budget=32*1024*1024,frustum=new THREE.Frustum(),matrix=new THREE.Matrix4();
const catalogs=new Map<string,Promise<WorldPageCatalog|null>>();
let active=0,bytes=0,peakBytes=0,requests=0,failures=0,evictions=0,lastUpdate=0,runtimePages=0,missingCatalogs=0;
let lastCamera:THREE.Camera|undefined,forceRefresh=true;
const limits={maxRequests:4,graceMs:5000};
export const attachedTo=(root:THREE.Object3D,scene:THREE.Scene)=>{let node:THREE.Object3D=root;while(node.parent)node=node.parent;return node===scene;};
export const treeVisible=(object:THREE.Object3D):boolean=>{for(let node:THREE.Object3D|null=object;node;node=node.parent)if(!node.visible)return false;return true;};
const getCatalog=(tile:string)=>{
  const old=catalogs.get(tile);if(old)return old;
  const pending=fetch(`/terrain/world-pages/${encodeURIComponent(tile)}/catalog.json`,{signal:AbortSignal.timeout(3000)}).then(async response=>{
  if(response.status===404){missingCatalogs++;return null;}
  if(!response.ok)throw new Error(`World pages HTTP ${response.status}`);
  const value=await response.json() as WorldPageCatalog;if(value.format!=='vgl-world-pages-v1')throw new Error('World page format');return value;
}).catch(()=>{missingCatalogs++;return null;});
  catalogs.set(tile,pending);if(catalogs.size>64)catalogs.delete(catalogs.keys().next().value!);return pending;
};

/** Native geometry is retained for immediate fallback; collision is never adopted or disposed here. */
export async function registerLiveWorldRoom(model:string,index:number,root:THREE.Group,objects:THREE.Object3D[],camera:THREE.Camera,source:Parameters<typeof worldPageSourceChecksum>[0]){
  try{await prepareRoom(model,index,root,objects,camera,source);}catch(error){failures++;console.warn('World page registration retained native geometry',error);}
  registerWorldDistrictRoom(model,index,root,objects,source);
  registerWmoFamilyRoom(model,index,root,objects,camera);
}
async function prepareRoom(model:string,index:number,root:THREE.Group,objects:THREE.Object3D[],camera:THREE.Camera,source:Parameters<typeof worldPageSourceChecksum>[0]){
  const tile=root.userData.wmoPick?.tile;if(typeof tile!=='string')return;
  const room:LiveWorldRoom={root,objects,originals:new Map(),sphere:new THREE.Sphere(),index,checksum:pagesEnabled&&worldStreamingEnabled?worldPageSourceChecksum(source):0,lastWanted:performance.now(),released:false,failed:false};
  const bounds=new THREE.Box3();
  for(const object of objects){const mesh=object as LiveWorldMesh;if(mesh.isMesh&&mesh.material instanceof THREE.ShaderMaterial){room.originals.set(mesh,mesh.geometry);if(mesh.geometry.boundingBox)bounds.union(mesh.geometry.boundingBox);}}
  bounds.getBoundingSphere(room.sphere);
  liveWorldRooms.add(room);liveWorldRoots.add(root);forceRefresh=true;
  if(!worldStreamingEnabled||!pagesEnabled)return;
  const data=await getCatalog(tile);
  room.page=data?.pages.find(page=>page.model===model&&page.group===index);
  if(room.page&&room.page.sourceChecksum!==room.checksum){room.page=undefined;failures++;}
  root.updateWorldMatrix(true,true);camera.updateMatrixWorld(true);frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  if([...room.originals.keys()].some(mesh=>mesh.visible&&frustum.intersectsObject(mesh)))await loadRoom(room);
}
async function loadRoom(room:LiveWorldRoom):Promise<void>{
  if(room.pending)return room.pending;
  if(room.resident||room.released||room.failed||!worldStreamingEnabled||!pagesEnabled)return;
  if(!room.page){buildRuntimePage(room);return;}
  const page=room.page;active++;
  room.pending=(async()=>{
    const response=await fetch(page.url,{signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error(`Page HTTP ${response.status}`);
    const buffer=await response.arrayBuffer();if(buffer.byteLength!==page.bytes)throw new Error('Page length');
    if(room.released||!worldStreamingEnabled||!pagesEnabled)return;
    const geometries=new Map<LiveWorldMesh,THREE.BufferGeometry>();
    try{
      for(const [mesh,source]of room.originals){
        if(mesh.userData.wmoFamilySource)continue;
        const index=source.index!,start=source.drawRange.start,count=Math.min(index.count-start,source.drawRange.count);
        const part=page.parts.find(part=>part.key===worldPagePartKey(index.array,start,count,mesh.userData.wmoPick.tex,mesh.userData.wmoPick.blendMode));
        if(!part||part.errors[0]!==0)throw new Error('Exact page part missing');
        const geometry=new THREE.BufferGeometry();geometries.set(mesh,geometry);
        for(const [name,range]of Object.entries(part.attributes))geometry.setAttribute(name,new THREE.BufferAttribute(pageView(range,buffer),range.itemSize));
        if(geometry.hasAttribute('wmoColor'))geometry.setAttribute('color',geometry.getAttribute('wmoColor'));
        geometry.setIndex(new THREE.BufferAttribute(pageView(part.indices[0],buffer),1));
        // Preserve original sorting/culling bounds as well as original material and object IDs.
        geometry.boundingBox=source.boundingBox?.clone()??null;geometry.boundingSphere=source.boundingSphere?.clone()??null;
        if(part.visibility)seedWorldVisibility(geometry,part.visibility.map(range=>pageView(range,buffer) as Float32Array));
      }
    }catch(error){geometries.forEach(geometry=>geometry.dispose());throw error;}
    room.resident={bytes:buffer.byteLength,geometries};bytes+=buffer.byteLength;peakBytes=Math.max(peakBytes,bytes);requests++;
    for(const [mesh,geometry]of geometries)if(!mesh.userData.wmoFamilySource){mesh.geometry=geometry;}
    forceRefresh=true;
  })().catch(error=>{room.failed=true;failures++;console.warn('Exact world page retained native geometry',error);}).finally(()=>{active--;room.pending=undefined;});
  return room.pending;
}
function buildRuntimePage(room:LiveWorldRoom){
  const geometries=new Map<LiveWorldMesh,THREE.BufferGeometry>();let size=0;
  try{
    for(const [mesh,source]of room.originals){if(mesh.userData.wmoFamilySource)continue;
      const geometry=compactWmoBatchGeometry(source);geometries.set(mesh,geometry);
      if(geometry.hasAttribute('wmoColor'))geometry.setAttribute('color',geometry.getAttribute('wmoColor'));
      const arrays=new Set<ArrayBufferLike>();for(const attribute of Object.values(geometry.attributes))arrays.add((attribute as THREE.BufferAttribute).array.buffer);if(geometry.index)arrays.add(geometry.index.array.buffer);
      for(const buffer of arrays)size+=buffer.byteLength;
    }
    room.resident={bytes:size,geometries};bytes+=size;peakBytes=Math.max(peakBytes,bytes);runtimePages++;
    for(const [mesh,geometry]of geometries)mesh.geometry=geometry;
  }catch(error){geometries.forEach(geometry=>geometry.dispose());room.failed=true;failures++;console.warn('Runtime exact page retained native geometry',error);}
}
function evict(room:LiveWorldRoom){
  if(!room.resident)return;
  for(const [mesh,geometry]of room.resident.geometries){if(mesh.geometry===geometry)mesh.geometry=room.originals.get(mesh)!;geometry.dispose();}
  bytes-=room.resident.bytes;room.resident=undefined;evictions++;
}
export function releaseLiveWorldGroup(group:THREE.Object3D){
  releaseWorldDistrict(group);releaseWmoFamilies(group);wmoFamilyTexturePool.unregister(group);
  for(const room of liveWorldRooms){let node:THREE.Object3D|null=room.root;while(node&&node!==group)node=node.parent;if(!node)continue;
    room.released=true;evict(room);liveWorldRooms.delete(room);liveWorldRoots.delete(room.root);
  }
  forceRefresh=true;
}
export function updateLiveWorldPages(scene:THREE.Scene,camera:THREE.Camera){
  if(!worldStreamingEnabled||!pagesEnabled)return;
  const now=performance.now();if(!forceRefresh&&camera===lastCamera&&now-lastUpdate<150)return;
  forceRefresh=false;lastUpdate=now;lastCamera=camera;camera.updateMatrixWorld(true);frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const wanted=new Set<LiveWorldRoom>();let admissions=0;
  for(const room of liveWorldRooms){
    if(room.released||!attachedTo(room.root,scene))continue;
    room.root.updateWorldMatrix(true,false);
    if(treeVisible(room.root)&&frustum.intersectsSphere(room.sphere.clone().applyMatrix4(room.root.matrixWorld))&&[...room.originals.keys()].some(mesh=>!mesh.userData.wmoFamilySource&&mesh.visible)){wanted.add(room);room.lastWanted=now;if(!room.resident&&!room.failed&&!room.pending&&active<limits.maxRequests&&admissions<2){admissions++;void loadRoom(room);}}
  }
  for(const room of [...liveWorldRooms].sort((a,b)=>a.lastWanted-b.lastWanted))if(!wanted.has(room)&&(bytes>budget||now-room.lastWanted>limits.graceMs))evict(room);
}
export function setLiveWorldPagesEnabled(enabled:boolean){pagesEnabled=enabled;forceRefresh=true;if(!enabled)for(const room of liveWorldRooms)evict(room);}
export const liveWorldPageStats=()=>({enabled:pagesEnabled&&worldStreamingEnabled,scope:'all WMO assets; baked or runtime exact visual pages',registeredRooms:liveWorldRooms.size,residentRooms:[...liveWorldRooms].filter(room=>room.resident).length,bytes,peakBytes,budget,requests,runtimePages,missingCatalogs,active,failures,evictions,overBudget:bytes>budget,retainsNativeCpuFallback:true,lod:false});
