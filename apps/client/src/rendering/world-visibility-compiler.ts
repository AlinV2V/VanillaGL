import * as THREE from 'three';
import { worldOccluderPolygons } from './world-occluder-triangles';

type Stamp={position:THREE.BufferAttribute;index:THREE.BufferAttribute;pv:number;iv:number;start:number;count:number};
type Compiled={stamp:Stamp;polygons:Float32Array[]};
const compiled=new WeakMap<THREE.BufferGeometry,Compiled>();
const stamp=(g:THREE.BufferGeometry):Stamp=>({position:g.getAttribute('position') as THREE.BufferAttribute,index:g.index!,pv:(g.getAttribute('position') as THREE.BufferAttribute).version,iv:g.index!.version,start:g.drawRange.start,count:g.drawRange.count});
const same=(a:Stamp,b:Stamp)=>a.position===b.position&&a.index===b.index&&a.pv===b.pv&&a.iv===b.iv&&a.start===b.start&&a.count===b.count;
export function seedWorldVisibility(geometry:THREE.BufferGeometry,polygons:Float32Array[]){
  if(!geometry.index||!geometry.hasAttribute('position'))return;
  if(polygons.some(p=>!(p instanceof Float32Array)||p.length<9||p.length>48||p.length%3||!p.every(Number.isFinite)))throw new Error('Invalid compiled wall patch');
  compiled.set(geometry,{stamp:stamp(geometry),polygons});
}
export function preparedWorldVisibility(geometry:THREE.BufferGeometry):Float32Array[]|undefined{
  const old=compiled.get(geometry);return old&&geometry.index&&geometry.hasAttribute('position')&&same(old.stamp,stamp(geometry))?old.polygons:undefined;
}

/** Asset preparation only. Merge exact coplanar neighbors into convex patches; never bridge a hole. */
export function compileWorldVisibility(geometry:THREE.BufferGeometry):Float32Array[]{
  const cached=preparedWorldVisibility(geometry);if(cached)return cached;
  const position=geometry.getAttribute('position') as THREE.BufferAttribute,index=geometry.index;
  if(!index||!position||position instanceof THREE.InterleavedBufferAttribute)return[];
  const start=geometry.drawRange.start,count=Math.min(index.count-start,geometry.drawRange.count);
  // Keep preparation bounded for unusually large assets; an incomplete occluder set only draws more.
  if(count>49152){const result=worldOccluderPolygons(geometry);seedWorldVisibility(geometry,result);return result;}
  const points:THREE.Vector3[]=[],ids=new Map<string,number>();
  const point=(i:number)=>{const p=new THREE.Vector3().fromBufferAttribute(position,i),key=`${p.x},${p.y},${p.z}`;let id=ids.get(key);if(id===undefined){id=points.length;ids.set(key,id);points.push(p);}return id;};
  type Patch={ids:number[];normal:THREE.Vector3;active:boolean};
  const patches:Patch[]=[],edges=new Map<string,Set<Patch>>();
  const key=(a:number,b:number)=>`${a}/${b}`;
  const register=(p:Patch,add:boolean)=>{for(let i=0;i<p.ids.length;i++){const k=key(p.ids[i],p.ids[(i+1)%p.ids.length]);if(add){let set=edges.get(k);if(!set){set=new Set();edges.set(k,set);}set.add(p);}else edges.get(k)?.delete(p);}};
  for(let i=start;i+2<start+count;i+=3){
    const vertices=[point(index.getX(i)),point(index.getX(i+1)),point(index.getX(i+2))],a=points[vertices[0]],normal=points[vertices[1]].clone().sub(a).cross(points[vertices[2]].clone().sub(a));
    if(!normal.lengthSq())continue;const patch={ids:vertices,normal,active:true};patches.push(patch);register(patch,true);
  }
  const convex=(vertices:number[],normal:THREE.Vector3)=>{
    if(new Set(vertices).size!==vertices.length)return false;
    for(let i=0;i<vertices.length;i++){const a=points[vertices[i]],b=points[vertices[(i+1)%vertices.length]],c=points[vertices[(i+2)%vertices.length]];if(b.clone().sub(a).cross(c.clone().sub(b)).dot(normal)<0)return false;}
    return true;
  };
  for(const patch of patches){
    if(!patch.active)continue;let changed=true;
    while(changed){changed=false;
      for(let edge=0;edge<patch.ids.length&&!changed;edge++){
        const a=patch.ids[edge],b=patch.ids[(edge+1)%patch.ids.length];
        for(const other of edges.get(key(b,a))??[]){
          if(other===patch||!other.active||patch.normal.dot(other.normal)<=0)continue;
          // Exact zero deliberately rejects approximately coplanar surfaces.
          if(other.ids.some(id=>points[id].clone().sub(points[a]).dot(patch.normal)!==0))continue;
          const reverse=other.ids.indexOf(b);if(other.ids[(reverse+1)%other.ids.length]!==a)continue;
          const merged:number[]=[];
          for(let n=1;n<patch.ids.length;n++)merged.push(patch.ids[(edge+1+n)%patch.ids.length]);
          for(let n=1;n<other.ids.length;n++)merged.push(other.ids[(reverse+1+n)%other.ids.length]);
          for(let n=merged.length-1;n>=0&&merged.length>3;n--){const a=points[merged[(n+merged.length-1)%merged.length]],b=points[merged[n]],c=points[merged[(n+1)%merged.length]],ab=b.clone().sub(a),bc=c.clone().sub(b);if(ab.clone().cross(bc).lengthSq()===0&&ab.dot(bc)>=0)merged.splice(n,1);}
          if(merged.length>16||!convex(merged,patch.normal))continue;
          register(patch,false);register(other,false);other.active=false;patch.ids=merged;register(patch,true);changed=true;break;
        }
      }
    }
  }
  const area=(p:Patch)=>{let sum=0;const origin=points[p.ids[0]];for(let i=1;i+1<p.ids.length;i++)sum+=points[p.ids[i]].clone().sub(origin).cross(points[p.ids[i+1]].clone().sub(origin)).length();return sum;};
  const result=patches.filter(p=>p.active).map(p=>({p,area:area(p)})).sort((a,b)=>b.area-a.area).slice(0,64).map(({p})=>Float32Array.from(p.ids.flatMap(id=>points[id].toArray())));
  seedWorldVisibility(geometry,result);return result;
}
