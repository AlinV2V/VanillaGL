import * as THREE from 'three';
type Plane={x:number;y:number;z:number;lo:number;hi:number;error:number};
type Record={position:THREE.BufferAttribute;index:THREE.BufferAttribute;pv:number;iv:number;start:number;count:number;planes:Plane[]|null;last:number};
const records=new WeakMap<THREE.BufferGeometry,Record>();
const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normal=new THREE.Vector3();

/** Whole-batch backface rejection. Quantization error is retained as an outward bound. */
export function worldBatchFacesAway(geometry:THREE.BufferGeometry,eye:THREE.Vector3,side:THREE.Side):boolean{
  if(side===THREE.DoubleSide)return false;
  const position=geometry.getAttribute('position') as THREE.BufferAttribute,index=geometry.index;
  if(!position||!index||position instanceof THREE.InterleavedBufferAttribute)return false;
  const start=geometry.drawRange.start,count=Math.min(index.count-start,geometry.drawRange.count);
  let record=records.get(geometry);
  if(!record||record.position!==position||record.index!==index||record.pv!==position.version||record.iv!==index.version||record.start!==start||record.count!==count){
    const planes=new Map<string,Plane>();let valid=true;
    for(let i=start;i+2<start+count;i+=3){
      a.fromBufferAttribute(position,index.getX(i));b.fromBufferAttribute(position,index.getX(i+1));c.fromBufferAttribute(position,index.getX(i+2));
      normal.subVectors(b,a).cross(c.sub(a));const length=normal.length();
      if(!Number.isFinite(length)){valid=false;break;}if(length<1e-10)continue;normal.multiplyScalar(1/length);
      const x=Math.round(normal.x*1e5)/1e5,y=Math.round(normal.y*1e5)/1e5,z=Math.round(normal.z*1e5)/1e5;
      const key=`${x},${y},${z}`,d=-normal.dot(a),error=Math.abs(x-normal.x)+Math.abs(y-normal.y)+Math.abs(z-normal.z),old=planes.get(key);
      if(old){old.lo=Math.min(old.lo,d);old.hi=Math.max(old.hi,d);old.error=Math.max(old.error,error);}
      else planes.set(key,{x,y,z,lo:d,hi:d,error});
      if(planes.size>256){valid=false;break;}
    }
    record={position,index,pv:position.version,iv:index.version,start,count,planes:valid?[...planes.values()]:null,last:0};records.set(geometry,record);
  }
  const planes=record.planes;if(!planes?.length)return false;
  const magnitude=Math.max(Math.abs(eye.x),Math.abs(eye.y),Math.abs(eye.z)),sign=side===THREE.BackSide?-1:1;
  for(let i=0;i<planes.length;i++){
    const offset=(i+record.last)%planes.length,p=planes[offset];
    if(sign*(p.x*eye.x+p.y*eye.y+p.z*eye.z+(sign>0?p.hi:p.lo))+p.error*magnitude>=-.05){record.last=offset;return false;}
  }
  return true;
}
