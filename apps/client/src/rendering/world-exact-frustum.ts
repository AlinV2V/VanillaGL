import * as THREE from 'three';
import { attachedTo,treeVisible,liveWorldRooms,type LiveWorldMesh } from './world-live-pages';

type Entry={position:THREE.BufferAttribute;index:THREE.BufferAttribute;pv:number;iv:number;start:number;count:number;box:THREE.Box3};
const bounds=new WeakMap<THREE.BufferGeometry,Entry>();
/** Exact active-index bounds kept separate from the renderer's sorting bounds. */
export function worldExactBounds(geometry:THREE.BufferGeometry):THREE.Box3|null{
  const position=geometry.getAttribute('position') as THREE.BufferAttribute,index=geometry.index;
  if(!position||!index||position instanceof THREE.InterleavedBufferAttribute)return null;
  const start=geometry.drawRange.start,count=Math.min(index.count-start,geometry.drawRange.count),cached=bounds.get(geometry);
  if(cached&&cached.position===position&&cached.index===index&&cached.pv===position.version&&cached.iv===index.version&&cached.start===start&&cached.count===count)return cached.box;
  const box=new THREE.Box3(),point=new THREE.Vector3();
  for(let i=start;i<start+count;i++)box.expandByPoint(point.fromBufferAttribute(position,index.getX(i)));
  if(![box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z].every(Number.isFinite))return null;
  // A small expansion keeps borderline rasterization and depth comparisons conservative.
  box.expandByScalar(.01);bounds.set(geometry,{position,index,pv:position.version,iv:index.version,start,count,box});return box;
}
export class ExactWorldFrustum {
  enabled=true;
  private projection=new THREE.Matrix4();
  private previous=new THREE.Matrix4();
  private local=new THREE.Matrix4();
  private frustum=new THREE.Frustum();
  private worldFrustum=new THREE.Frustum();
  private sphere=new THREE.Sphere();
  private counts={hiddenDraws:0,hiddenTriangles:0,lastFrameCpuMs:0,failures:0};
  invalidate(){}
  dispose(){}
  stats(){return{enabled:this.enabled,...this.counts,currentFrameHiddenDraws:this.counts.hiddenDraws,mode:'exact-active-index-frustum',settled:true};}
  before(_renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera){
    const start=performance.now(),changed:LiveWorldMesh[]=[];this.counts.hiddenDraws=0;this.counts.hiddenTriangles=0;
    if(!this.enabled)return()=>{};
    camera.updateMatrixWorld(true);this.projection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this.worldFrustum.setFromProjectionMatrix(this.projection);let first=true;const roots=new Map<THREE.Object3D,boolean>();
    for(const room of liveWorldRooms){
      let active=roots.get(room.root);if(active===undefined){active=attachedTo(room.root,scene)&&treeVisible(room.root);roots.set(room.root,active);if(active)room.root.updateWorldMatrix(true,false);}if(!active)continue;
      if(!this.worldFrustum.intersectsSphere(this.sphere.copy(room.sphere).applyMatrix4(room.root.matrixWorld)))continue;
      for(const object of room.objects){
        const mesh=object as LiveWorldMesh,material=mesh.material;
        if(!mesh.isMesh||!mesh.visible||!mesh.frustumCulled||mesh.userData.wmoPick?.kind!=='wmoBatch'||!(material instanceof THREE.ShaderMaterial)||mesh.morphTargetInfluences?.length||!material.vertexShader.includes('vec4 wp = modelMatrix * vec4(position, 1.0);'))continue;
        mesh.updateWorldMatrix(mesh.parent!==room.root,false);const box=worldExactBounds(mesh.geometry);if(!box)continue;
        if(first||!this.previous.equals(mesh.matrixWorld)){first=false;this.previous.copy(mesh.matrixWorld);this.frustum.setFromProjectionMatrix(this.local.multiplyMatrices(this.projection,mesh.matrixWorld));}
        if(!this.frustum.intersectsBox(box)){changed.push(mesh);this.counts.hiddenTriangles+=Math.min(mesh.geometry.index?.count??0,mesh.geometry.drawRange.count)/3;}
      }
    }
    for(const mesh of changed)mesh.visible=false;this.counts.hiddenDraws=changed.length;this.counts.lastFrameCpuMs=performance.now()-start;
    return()=>{for(const mesh of changed)mesh.visible=true;};
  }
}
