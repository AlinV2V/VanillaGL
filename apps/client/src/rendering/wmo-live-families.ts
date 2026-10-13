import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type Draw, familyKey, packWmoTextureLayers, arrayMaterial } from './wmo-material-family';
import { compactWmoBatchGeometry } from './wmo-batched-experiment';
import { admitTextureUpload, texturePayloadBytes } from './texture-upload-admission';
import { instrumentWmoBatch } from './performance-detail-diagnostics';
import { districtMaterialsEnabled as districtEnabled } from './world-district-format';
import { wmoFamilyTexturePool, type FamilyTextureLease } from './wmo-family-texture-pool';
import { ownWmoFamily } from './wmo-family-ownership';
import { createWorldHydrationCheckpoint } from './world-hydration-scheduler';

// Exact A/B pixel captures: these rooms contain order-sensitive overlapping surfaces.
const excluded = new Set([106, 112, 156, 157, 158, 163, 164, 213]);
const enabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('wmofamilies') !== 'off';
type Room = { root: THREE.Group; objects: THREE.Object3D[]; camera: THREE.Camera };
const pending: Room[] = [];
let timer: ReturnType<typeof setTimeout> | undefined, running = false;
let bytes = 0, batches = 0, sourceDraws = 0, failures = 0;
const budget = 32 * 1024 * 1024;
const attached = (object: THREE.Object3D): boolean => { let root = object; while(root.parent) root=root.parent; return root instanceof THREE.Scene; };
const visible = (object: THREE.Object3D): boolean => { for(let node: THREE.Object3D|null=object;node;node=node.parent)if(!node.visible)return false;return true; };
if (typeof window !== 'undefined') Object.assign(window, { __wowWmoFamilies: () => ({ enabled, district:districtEnabled, batches, sourceDraws, savedDraws: sourceDraws-batches, bytes:bytes+wmoFamilyTexturePool.stats().bytes, sharedPages:wmoFamilyTexturePool.stats(), budget, failures, queued:pending.length, running }) });

/** Wider shared pages are opt-in. Keep measured depth-sensitive rooms native. */
export function registerWmoFamilyRoom(model: string, index: number, root: THREE.Group, objects: THREE.Object3D[], camera: THREE.Camera): void {
  const stormwind=model.toLowerCase().replaceAll('\\','/').endsWith('/stormwind/stormwind.wmo');
  const abbey=model.toLowerCase().replaceAll('\\','/').endsWith('/nsabbey/nsabbey.wmo');
  if(!enabled || (stormwind&&excluded.has(index)) || (abbey&&(index===0||index===11)) || (!stormwind&&!districtEnabled))return;
  let queued=false;
  for(const object of objects) {
    const mesh=object as THREE.Mesh;if(!mesh.isMesh)continue;
    const previous=mesh.onAfterRender;
    mesh.onAfterRender=function(...args) {
      previous.apply(this,args);mesh.onAfterRender=previous;
      if(queued)return;queued=true;
      // Prime only rendered rooms, so distant loaded buildings do not pad an active page.
      if(districtEnabled){
        const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
        wmoFamilyTexturePool.register(root,objects.flatMap(object=>{const draw=object as Draw;return draw.isMesh&&visible(draw)&&frustum.intersectsObject(draw)&&familyKey(draw)!==null?[draw.material.uniforms.uMap.value as THREE.CompressedTexture]:[];}));
      }
      pending.push({root,objects,camera});
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{timer=undefined;void drain();},2000);
    };
  }
}
async function drain(): Promise<void> {
  if(running)return;
  running=true;
  const work=districtEnabled?createWorldHydrationCheckpoint('wmo-shared-families','background'):undefined;
  try { while(pending.length) await batchRoom(pending.shift()!,()=>work?.checkpoint()??Promise.resolve()); }
  finally {work?.finish();running=false;}
}
async function batchRoom(room: Room, checkpoint:()=>Promise<void>): Promise<void> {
  if(!attached(room.root))return;
  room.root.updateWorldMatrix(true,true); room.camera.updateMatrixWorld(true);
  const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(room.camera.projectionMatrix,room.camera.matrixWorldInverse));
  const buckets=new Map<string,Draw[]>();
  for(const object of room.objects) {
    const mesh=object as Draw;
    if(!mesh.isMesh || mesh.userData.wmoPick?.kind!=='wmoBatch' || !visible(mesh) || !frustum.intersectsObject(mesh))continue;
    const key=familyKey(mesh);if(key===null)continue;
    const bucket=buckets.get(key)??[];bucket.push(mesh);buckets.set(key,bucket);
  }
  for(const bucket of buckets.values()) {
    if(bucket.length<2 || !attached(room.root))continue;
    bucket.sort((a,b)=>a.material.id-b.material.id);
    let textures=[...new Set(bucket.map(mesh=>mesh.material.uniforms.uMap.value as THREE.CompressedTexture))];
    const size=textures.reduce((sum,t)=>sum+texturePayloadBytes(t),0);
    if(textures.length>64 || (!districtEnabled&&bytes+size>budget))continue;
    let array: THREE.CompressedArrayTexture|undefined, geometry: THREE.BufferGeometry|null=null, material: THREE.ShaderMaterial|undefined;
    let lease:FamilyTextureLease|null=null;
    const parts: THREE.BufferGeometry[]=[];
    try {
      if(districtEnabled){lease=await wmoFamilyTexturePool.acquire(textures);if(!lease)continue;array=lease.array;textures=lease.textures;}
      else{array=packWmoTextureLayers(textures);await admitTextureUpload(array,'wmo-family-array',{validate:renderer=>{const gl=renderer.getContext();if(gl.getError()!==gl.NO_ERROR)throw new Error('WMO array upload failed');}});}
      if(!attached(room.root)){if(lease)lease.release();else array.dispose();continue;}
      for(const mesh of bucket) {
        const part=compactWmoBatchGeometry(mesh.geometry);
        part.setAttribute('wmoLayer',new THREE.Float32BufferAttribute(new Float32Array(part.getAttribute('position').count).fill(textures.indexOf(mesh.material.uniforms.uMap.value)),1));
        parts.push(part);
      }
      geometry=mergeGeometries(parts);if(!geometry)throw new Error('Incompatible WMO attributes');
      geometry.computeBoundingBox();geometry.computeBoundingSphere();
      material=arrayMaterial(bucket[0].material,array);
      const mesh=new THREE.Mesh(geometry,material);
      mesh.layers.mask=bucket[0].layers.mask;
      mesh.renderOrder=bucket[0].renderOrder;
      mesh.userData.wmoPick={...bucket[0].userData.wmoPick, familyBatches:bucket.length};
      instrumentWmoBatch(mesh,`${room.root.uuid}:${mesh.userData.wmoPick.groupIndex}:family`);
      const beforeRender=mesh.onBeforeRender;
      const sharedMap=textures[0], arrayMap=array;
      mesh.onBeforeRender=function(...args) {
        if(arrayMap.anisotropy!==sharedMap.anisotropy){arrayMap.anisotropy=sharedMap.anisotropy;arrayMap.needsUpdate=true;}
        beforeRender.apply(this,args);
      };
      mesh.visible=bucket.some(original=>original.visible);
      const heldLease=lease,heldArray=array;
      let released=false;
      ownWmoFamily(room.root,mesh,bucket,room.objects,()=>{if(released)return;released=true;batches--;sourceDraws-=bucket.length;if(heldLease)heldLease.release();else{bytes-=size;heldArray.dispose();}});
      // Keep originals hidden in the ownership tree for normal tile disposal and
      // shared lighting uniforms. Only the room visibility list switches to the new mesh.
      for(const original of bucket){original.visible=false;original.userData.wmoFamilySource=true;const index=room.objects.indexOf(original);if(index>=0)room.objects.splice(index,1);}
      room.objects.push(mesh);room.root.add(mesh);
      if(!lease)bytes+=size;batches++;sourceDraws+=bucket.length;
    } catch(error) {
      failures++;if(lease)lease.release();else array?.dispose();geometry?.dispose();material?.dispose();
      console.warn('WMO family trial retained original batches',error);
    } finally {parts.forEach(part=>part.dispose());}
    await checkpoint();
  }
}
