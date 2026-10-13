import * as THREE from 'three';
import { attachedTo,treeVisible,liveWorldRooms,type LiveWorldMesh,type LiveWorldRoom } from './world-live-pages';
import { compileWorldVisibility } from './world-visibility-compiler';
import { rigidWmoMaterial } from './world-visibility-projection';

type Page={owner:LiveWorldMesh;source:THREE.BufferGeometry;index:THREE.BufferAttribute;position:THREE.BufferAttribute;iv:number;pv:number;start:number;count:number;geometry:THREE.BufferGeometry;group:THREE.Group;parts:LiveWorldMesh[];membership:Uint16Array;mask:Uint8Array;bytes:number};
/** Exact triangle partition. Compaction retains original triangle order and one draw per source batch. */
export function partitionWorldGeometry(source:THREE.BufferGeometry,cellSize=12){
  const index=source.index,position=source.getAttribute('position') as THREE.BufferAttribute;
  if(!index||!position||position instanceof THREE.InterleavedBufferAttribute)return null;
  const start=source.drawRange.start,count=Math.min(index.count-start,source.drawRange.count);
  if(start%3||count%3||count<1536)return null;
  let buckets:Map<string,number[]>;
  do{
    buckets=new Map();
    for(let offset=start;offset<start+count;offset+=3){
      let x=0,y=0,z=0;for(let v=0;v<3;v++){const i=index.getX(offset+v);x+=position.getX(i);y+=position.getY(i);z+=position.getZ(i);}
      const key=`${Math.floor(x/(3*cellSize))},${Math.floor(y/(3*cellSize))},${Math.floor(z/(3*cellSize))}`;
      let list=buckets.get(key);if(!list){list=[];buckets.set(key,list);}list.push(offset);
    }
    cellSize*=2;
  }while(buckets.size>64);
  if(buckets.size<2)return null;
  const membership=new Uint16Array(count/3),parts:THREE.BufferGeometry[]=[];
  for(const offsets of buckets.values()){
    const indices=new Uint32Array(offsets.length*3),bounds=new THREE.Box3(),point=new THREE.Vector3();
    offsets.forEach((offset,i)=>{membership[(offset-start)/3]=parts.length;for(let v=0;v<3;v++){const vertex=index.getX(offset+v);indices[i*3+v]=vertex;bounds.expandByPoint(point.fromBufferAttribute(position,vertex));}});
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',position);geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.boundingBox=bounds;geometry.boundingSphere=bounds.getBoundingSphere(new THREE.Sphere());parts.push(geometry);
  }
  return{parts,membership,start,count};
}

export class WorldSpatialPages {
  constructor(private readonly proofs=true){}
  private pages=new Map<LiveWorldMesh,Page>();
  private skipped=new WeakMap<THREE.BufferGeometry,number>();
  private frustum=new THREE.Frustum();
  private matrix=new THREE.Matrix4();
  private active:Page[]=[];
  private changes:Array<{room:LiveWorldRoom;objects:THREE.Object3D[]}>=[];
  private restored:Array<{page:Page;visible:boolean}>=[];
  bytes=0;hiddenParts=0;uploads=0;lastCpuMs=0;
  private release(page:Page){page.group.removeFromParent();page.parts.forEach(p=>p.geometry.dispose());page.geometry.dispose();this.bytes-=page.bytes;this.pages.delete(page.owner);}
  dispose(){this.restore();for(const page of [...this.pages.values()])this.release(page);}
  stats(){return{spatialPages:this.pages.size,spatialParts:[...this.pages.values()].reduce((n,p)=>n+p.parts.length,0),spatialBytes:this.bytes,spatialHiddenParts:this.hiddenParts,spatialIndexUploads:this.uploads,spatialCpuMs:this.lastCpuMs};}
  prepare(scene:THREE.Scene,camera:THREE.Camera){
    const start=performance.now();this.active.length=0;this.hiddenParts=0;let admissions=0;
    camera.updateMatrixWorld(true);this.frustum.setFromProjectionMatrix(this.matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
    for(const page of [...this.pages.values()])if(!attachedTo(page.owner,scene)||page.owner.geometry!==page.source||page.source.index!==page.index||page.source.getAttribute('position')!==page.position||page.index.version!==page.iv||page.position.version!==page.pv||page.source.drawRange.start!==page.start||Math.min(page.index.count-page.start,page.source.drawRange.count)!==page.count)this.release(page);
    for(const room of liveWorldRooms){
      if(!attachedTo(room.root,scene)||!treeVisible(room.root))continue;
      room.root.updateWorldMatrix(true,false);if(!this.frustum.intersectsSphere(room.sphere.clone().applyMatrix4(room.root.matrixWorld)))continue;
      const objects:THREE.Object3D[]=[];let changed=false;
      for(const object of room.objects){
        const mesh=object as LiveWorldMesh,material=mesh.material;
        if(!mesh.isMesh||!mesh.visible||mesh.userData.wmoPick?.kind!=='wmoBatch'||!(material instanceof THREE.ShaderMaterial)||material.transparent||material.wireframe||material.clippingPlanes?.length||mesh.morphTargetInfluences?.length||!rigidWmoMaterial(material)){objects.push(object);continue;}
        mesh.updateWorldMatrix(true,false);if(!this.frustum.intersectsObject(mesh)){objects.push(object);continue;}
        let page=this.pages.get(mesh);
        if(!page&&admissions<2&&this.bytes<16*1024*1024&&this.skipped.get(mesh.geometry)!==mesh.geometry.index?.version){
          const source=mesh.geometry,partition=partitionWorldGeometry(source);
          if(partition){
            admissions++;
            const geometry=new THREE.BufferGeometry();for(const [name,attribute]of Object.entries(source.attributes))geometry.setAttribute(name,attribute);
            geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(partition.count),1).setUsage(THREE.DynamicDrawUsage));geometry.boundingBox=source.boundingBox;geometry.boundingSphere=source.boundingSphere;
            const group=new THREE.Group();group.matrixAutoUpdate=false;
            const parts=partition.parts.map(geometry=>{if(this.proofs)compileWorldVisibility(geometry);const proxy=new THREE.Mesh(geometry,material);proxy.userData={wmoPick:mesh.userData.wmoPick};proxy.layers.set(31);proxy.matrixAutoUpdate=false;group.add(proxy);return proxy;});
            const bytes=partition.count*8+partition.membership.byteLength;
            page={owner:mesh,source,index:source.index!,position:source.getAttribute('position') as THREE.BufferAttribute,iv:source.index!.version,pv:(source.getAttribute('position') as THREE.BufferAttribute).version,start:partition.start,count:partition.count,geometry,group,parts,membership:partition.membership,mask:new Uint8Array(parts.length).fill(255),bytes};
            this.pages.set(mesh,page);this.bytes+=bytes;
          }else this.skipped.set(source,source.index?.version??-1);
        }
        if(!page){objects.push(object);continue;}
        if(mesh.matrixAutoUpdate)mesh.updateMatrix();
        if(this.proofs&&page.group.parent!==mesh.parent)mesh.parent!.add(page.group);
        for(const proxy of page.parts){proxy.material=material;proxy.visible=mesh.visible;if(this.proofs){proxy.matrix.copy(mesh.matrix);proxy.updateWorldMatrix(true,false);objects.push(proxy);}else proxy.matrixWorld.copy(mesh.matrixWorld);}
        if(!this.proofs)objects.push(object);this.active.push(page);changed ||=this.proofs;
      }
      if(changed){this.changes.push({room,objects:room.objects});room.objects=objects;}
    }
    camera.updateMatrixWorld(true);this.frustum.setFromProjectionMatrix(this.matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
    this.lastCpuMs=performance.now()-start;
  }
  apply(){
    const start=performance.now();
    for(const page of this.active){
      let count=0,changed=false;
      for(let i=0;i<page.parts.length;i++){const visible=page.parts[i].visible&&this.frustum.intersectsObject(page.parts[i])?1:0;changed ||=page.mask[i]!==visible;page.mask[i]=visible;count+=visible;}
      this.hiddenParts+=page.parts.length-count;
      if(count===page.parts.length)continue;
      this.restored.push({page,visible:page.owner.visible});
      if(!count){page.owner.visible=false;continue;}
      if(changed){
        const array=page.geometry.index!.array as Uint32Array;let output=0;
        for(let triangle=0;triangle<page.membership.length;triangle++)if(page.mask[page.membership[triangle]])for(let v=0;v<3;v++)array[output++]=page.index.getX(page.start+triangle*3+v);
        page.geometry.setDrawRange(0,output);page.geometry.index!.clearUpdateRanges();page.geometry.index!.addUpdateRange(0,output);page.geometry.index!.needsUpdate=true;this.uploads++;
      }
      page.owner.geometry=page.geometry;
    }
    this.lastCpuMs+=performance.now()-start;
  }
  restore(){for(const {page,visible}of this.restored){page.owner.geometry=page.source;page.owner.visible=visible;}this.restored.length=0;for(const {room,objects}of this.changes)room.objects=objects;this.changes.length=0;for(const page of this.active)page.group.removeFromParent();}
}
