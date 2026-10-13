import * as THREE from 'three';
type Cache={position:THREE.BufferAttribute;index:THREE.BufferAttribute;pv:number;iv:number;start:number;count:number;triangles:Float32Array};
const cache=new WeakMap<THREE.BufferGeometry,Cache>();
/** Select real large source triangles, never an enlarged occluder proxy. Missing triangles reduce culling only. */
export function worldOccluderTriangles(geometry:THREE.BufferGeometry):Float32Array {
  const position=geometry.getAttribute('position') as THREE.BufferAttribute,index=geometry.index;
  if(!position||!index||position instanceof THREE.InterleavedBufferAttribute)return new Float32Array();
  const start=geometry.drawRange.start,count=Math.min(index.count-start,geometry.drawRange.count),old=cache.get(geometry);
  if(old&&old.position===position&&old.index===index&&old.pv===position.version&&old.iv===index.version&&old.start===start&&old.count===count)return old.triangles;
  const selected:Array<{offset:number;area:number}>=[];const limit=32;
  const less=(a:{offset:number;area:number},b:{offset:number;area:number})=>a.area<b.area||(a.area===b.area&&a.offset>b.offset);
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
  // Bounded min-heap keeps enough triangles to cover tessellated walls.
  for(let offset=start;offset+2<start+count;offset+=3){
    a.fromBufferAttribute(position,index.getX(offset));b.fromBufferAttribute(position,index.getX(offset+1));c.fromBufferAttribute(position,index.getX(offset+2));
    const area=b.sub(a).cross(c.sub(a)).lengthSq();if(area<=0||(selected.length===limit&&area<=selected[0].area))continue;
    if(selected.length<limit){selected.push({offset,area});let i=selected.length-1;while(i>0){const p=(i-1)>>1;if(!less(selected[i],selected[p]))break;[selected[p],selected[i]]=[selected[i],selected[p]];i=p;}}
    else{selected[0]={offset,area};let i=0;while(i*2+1<limit){let c=i*2+1;if(c+1<limit&&less(selected[c+1],selected[c]))c++;if(!less(selected[c],selected[i]))break;[selected[c],selected[i]]=[selected[i],selected[c]];i=c;}}
  }
  selected.sort((a,b)=>b.area-a.area||a.offset-b.offset);const triangles=new Float32Array(selected.length*9);
  selected.forEach(({offset},i)=>{for(let v=0;v<3;v++){a.fromBufferAttribute(position,index.getX(offset+v));a.toArray(triangles,i*9+v*3);}});
  cache.set(geometry,{position,index,pv:position.version,iv:index.version,start,count,triangles});return triangles;
}
const polygons=new WeakMap<Float32Array,Float32Array[]>();
/** Merge only triangles sharing exactly the same edge with opposite winding; projected convexity is checked each frame. */
export function worldOccluderPolygons(geometry:THREE.BufferGeometry):Float32Array[]{
  const triangles=worldOccluderTriangles(geometry),cached=polygons.get(triangles);if(cached)return cached;
  const result:Float32Array[]=[],used=new Set<number>();
  const point=(i:number,v:number)=>Array.from(triangles.subarray(i+v*3,i+v*3+3));
  const edges=new Map<string,Array<{i:number;b:number}>>();
  const key=(i:number,a:number,b:number)=>`${point(i,a).join(',')}/${point(i,b).join(',')}`;
  for(let i=0;i<triangles.length;i+=9)for(let b=0;b<3;b++){const k=key(i,b,(b+1)%3),list=edges.get(k)??[];list.push({i,b});edges.set(k,list);}
  for(let i=0;i<triangles.length;i+=9){
    if(used.has(i))continue;let merged=false;
    let best:{a:number;i:number;b:number}|undefined;
    for(let a=0;a<3;a++){const other=edges.get(key(i,(a+1)%3,a))?.find(edge=>edge.i>i&&!used.has(edge.i));if(other&&(!best||other.i<best.i))best={a,...other};}
    if(best){const {a,i:j,b}=best;
      result.push(Float32Array.from([...point(i,a),...point(j,(b+2)%3),...point(i,(a+1)%3),...point(i,(a+2)%3)]));used.add(j);merged=true;
    }
    if(!merged)result.push(triangles.slice(i,i+9));
  }
  polygons.set(triangles,result);return result;
}
