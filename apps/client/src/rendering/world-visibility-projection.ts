import * as THREE from 'three';
import type { ProjectedPoint } from './world-occlusion-grid';
import type { LiveWorldMesh } from './world-live-pages';

export type WallWitness={mesh:LiveWorldMesh;geometry:THREE.BufferGeometry;polygon:Float32Array;position:THREE.BufferAttribute;index:THREE.BufferAttribute;pv:number;iv:number;start:number;count:number};
const witnesses=new WeakMap<LiveWorldMesh,{geometry:THREE.BufferGeometry;polygons:Map<Float32Array,WallWitness>}>();
export const witness=(mesh:LiveWorldMesh,polygon:Float32Array):WallWitness=>{
  const geometry=mesh.geometry,position=geometry.getAttribute('position') as THREE.BufferAttribute,index=geometry.index!;
  let entry=witnesses.get(mesh);if(!entry||entry.geometry!==geometry){entry={geometry,polygons:new Map()};witnesses.set(mesh,entry);}
  const old=entry.polygons.get(polygon);if(old&&currentWitness(old))return old;
  const value={mesh,geometry,polygon,position,index,pv:position.version,iv:index.version,start:geometry.drawRange.start,count:geometry.drawRange.count};entry.polygons.set(polygon,value);return value;
};
export const currentWitness=(w:WallWitness)=>w.mesh.geometry===w.geometry&&w.geometry.getAttribute('position')===w.position&&w.geometry.index===w.index&&w.position.version===w.pv&&w.index.version===w.iv&&w.geometry.drawRange.start===w.start&&w.geometry.drawRange.count===w.count;
const shaders=new WeakMap<THREE.ShaderMaterial,{vertex:string;valid:boolean}>();
export function rigidWmoMaterial(mat:THREE.ShaderMaterial):boolean{
  let cached=shaders.get(mat);if(!cached||cached.vertex!==mat.vertexShader){cached={vertex:mat.vertexShader,valid:mat.vertexShader.includes('vec4 wp = modelMatrix * vec4(position, 1.0);')&&mat.vertexShader.includes('gl_Position = projectionMatrix * viewPos;')};shaders.set(mat,cached);}return cached.valid;
}
export const opaqueWall=(mesh:LiveWorldMesh)=>mesh.userData.wmoPick.blendMode===0&&(mesh.material.uniforms.uAlphaTest?.value??0)===0&&!mesh.material.alphaTest&&!mesh.material.alphaToCoverage;
export class WorldVisibilityProjection {
  private matrix=new THREE.Matrix4();
  constructor(private projection:THREE.Matrix4,readonly width:number,readonly height:number){}
  private point(x:number,y:number,z:number,slack:number):ProjectedPoint|null{
    const e=this.matrix.elements,w=e[3]*x+e[7]*y+e[11]*z+e[15],cz=e[2]*x+e[6]*y+e[10]*z+e[14];
    if(w<=.05||cz<=-w+1e-5||cz>=w-1e-5)return null;
    return{x:((e[0]*x+e[4]*y+e[8]*z+e[12])/w+1)*this.width/2,y:((e[1]*x+e[5]*y+e[9]*z+e[13])/w+1)*this.height/2,z:-1/(w+slack)};
  }
  wall(w:WallWitness):ProjectedPoint[]|null{
    const {mesh,polygon}=w;this.matrix.multiplyMatrices(this.projection,mesh.matrixWorld);
    const points:ProjectedPoint[]=[];
    for(let i=0;i<polygon.length;i+=3){const p=this.point(polygon[i],polygon[i+1],polygon[i+2],.05);if(!p)return null;points.push(p);}
    const [a,b,c]=points,area=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    if(mesh.material.side!==THREE.DoubleSide&&((area>0)!==(mesh.matrixWorld.determinant()<0))!==(mesh.material.side===THREE.FrontSide))return null;
    if(area<0)points.splice(1,points.length-1,...points.slice(1).reverse());
    if(!points.every((p,i)=>{const q=points[(i+1)%points.length],r=points[(i+2)%points.length];return(q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x)>1e-7;}))return null;
    return points;
  }
  bounds(mesh:LiveWorldMesh,padX:number,padY:number):[number,number,number,number,number]|null{
    const bounds=mesh.geometry.boundingBox;if(!bounds)return null;this.matrix.multiplyMatrices(this.projection,mesh.matrixWorld);
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,near=Infinity;
    for(let i=0;i<8;i++){
      const p=this.point(i&1?bounds.max.x:bounds.min.x,i&2?bounds.max.y:bounds.min.y,i&4?bounds.max.z:bounds.min.z,-.05);if(!p)return null;
      minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);near=Math.min(near,p.z);
    }
    return[minX-padX,minY-padY,maxX+padX,maxY+padY,near];
  }
  corners(mesh:LiveWorldMesh):ProjectedPoint[]|null{
    const b=mesh.geometry.boundingBox;if(!b)return null;this.matrix.multiplyMatrices(this.projection,mesh.matrixWorld);
    const corners:ProjectedPoint[]=[];
    for(let i=0;i<8;i++){const p=this.point(i&1?b.max.x+.01:b.min.x-.01,i&2?b.max.y+.01:b.min.y-.01,i&4?b.max.z+.01:b.min.z-.01,-.05);if(!p)return null;corners.push(p);}
    return corners;
  }
  box(mesh:LiveWorldMesh,corners=this.corners(mesh)):ProjectedPoint[][]|null{
    if(!corners)return null;
    const result:ProjectedPoint[][]=[],flipped=mesh.matrixWorld.determinant()<0;
    for(const face of [[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]]){
      const [a,b,c]=face.map(i=>corners[i]),area=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
      if((area>0)===flipped||Math.abs(area)<1e-8)continue;
      const p=face.map(i=>corners[i]);if(area<0)p.splice(1,3,...p.slice(1).reverse());result.push([p[0],p[1],p[2]],[p[0],p[2],p[3]]);
    }
    return result.length?result:null;
  }
}
