import * as THREE from 'three';
import type { LiveWorldMesh } from './world-live-pages';
import { preparedWorldVisibility } from './world-visibility-compiler';
import { witness,type WallWitness } from './world-visibility-projection';

type Entry={wall:WallWitness;center:THREE.Vector3;area:number};
type RecordState={mesh:LiveWorldMesh;geometry:THREE.BufferGeometry;polygons:Float32Array[]|undefined;matrix:THREE.Matrix4};
const cellSize=32;
const cell=(x:number,y:number,z:number)=>`${x},${y},${z}`;
/** Camera-independent wall neighborhoods. These are candidates, never cached visibility answers. */
export class WorldVisibilityCandidates {
  private records:RecordState[]=[];
  private cells=new Map<string,Entry[]>();
  private large:Entry[]=[];
  private neighborhoods=new Map<string,WallWitness[]>();
  private targets:LiveWorldMesh[]=[];
  private cursor=0;
  builds=0;patches=0;
  clear(){this.records=[];this.cells.clear();this.large=[];this.neighborhoods.clear();this.targets=[];this.cursor=0;}
  update(meshes:LiveWorldMesh[]){
    this.targets=meshes;
    const changed=meshes.length!==this.records.length||meshes.some((mesh,i)=>{const r=this.records[i];return !r||r.mesh!==mesh||r.geometry!==mesh.geometry||r.polygons!==preparedWorldVisibility(mesh.geometry)||!r.matrix.equals(mesh.matrixWorld);});
    if(!changed)return;
    this.records=meshes.map(mesh=>({mesh,geometry:mesh.geometry,polygons:preparedWorldVisibility(mesh.geometry),matrix:mesh.matrixWorld.clone()}));
    this.cells.clear();this.large=[];this.neighborhoods.clear();this.builds++;this.patches=0;
    for(const r of this.records)for(const polygon of r.polygons??[]){
      const bounds=new THREE.Box3(),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
      for(let i=0;i<polygon.length;i+=3)bounds.expandByPoint(a.fromArray(polygon,i).applyMatrix4(r.matrix));
      let area=0;a.fromArray(polygon,0).applyMatrix4(r.matrix);
      for(let i=3;i+5<polygon.length;i+=3)area+=b.fromArray(polygon,i).applyMatrix4(r.matrix).sub(a).cross(c.fromArray(polygon,i+3).applyMatrix4(r.matrix).sub(a)).length();
      const center=bounds.getCenter(new THREE.Vector3()),entry={wall:witness(r.mesh,polygon),center,area},key=cell(Math.floor(center.x/cellSize),Math.floor(center.y/cellSize),Math.floor(center.z/cellSize));
      let entries=this.cells.get(key);if(!entries){entries=[];this.cells.set(key,entries);}entries.push(entry);this.large.push(entry);this.patches++;
    }
    this.large.sort((a,b)=>b.area-a.area);this.large.length=Math.min(16,this.large.length);
  }
  next(limit=6):Array<{mesh:LiveWorldMesh;walls:WallWitness[]}>{
    const result:Array<{mesh:LiveWorldMesh;walls:WallWitness[]}>=[];
    for(let i=0;i<Math.min(limit,this.targets.length);i++){
      const mesh=this.targets[this.cursor++%this.targets.length],bounds=mesh.geometry.boundingBox;if(!bounds)continue;
      const center=bounds.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld),x=Math.floor(center.x/cellSize),y=Math.floor(center.y/cellSize),z=Math.floor(center.z/cellSize),key=cell(x,y,z);
      let walls=this.neighborhoods.get(key);
      if(!walls){
        const entries=new Set(this.large);
        for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(const e of this.cells.get(cell(x+dx,y+dy,z+dz))??[])entries.add(e);
        const cellCenter=new THREE.Vector3((x+.5)*cellSize,(y+.5)*cellSize,(z+.5)*cellSize);
        walls=[...entries].map(e=>({e,score:e.area/(64+e.center.distanceToSquared(cellCenter))})).sort((a,b)=>b.score-a.score).slice(0,32).map(({e})=>e.wall);this.neighborhoods.set(key,walls);
      }
      result.push({mesh,walls});
    }
    return result;
  }
}
