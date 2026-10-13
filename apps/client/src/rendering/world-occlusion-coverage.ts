import { WorldOcclusionGrid,type ProjectedPoint } from './world-occlusion-grid';
type Point={x:number;y:number};
export type Edge={a:number;b:number;c:number};
export type Cover={edges:Edge[];planes:Edge[];far:number;padX:number;padY:number;id:number};
const area=(p:Point[])=>p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a.x*b.y-b.x*a.y;},0);
export function projectedCover(points:ProjectedPoint[],padX:number,padY:number,id:number):Cover{
  return{padX,padY,id,far:Math.max(...points.map(p=>p.z)),
    edges:points.map((p,i)=>{const q=points[(i+1)%points.length],dx=q.x-p.x,dy=q.y-p.y;return{a:-dy,b:dx,c:dy*p.x-dx*p.y};}),
    planes:points.slice(1,-1).map((p,i)=>{const o=points[0],q=points[i+2],dx=p.x-o.x,dy=p.y-o.y,ex=q.x-o.x,ey=q.y-o.y,d=dx*ey-dy*ex;const a=((p.z-o.z)*ey-(q.z-o.z)*dy)/d,b=(dx*(q.z-o.z)-ex*(p.z-o.z))/d;return{a,b,c:o.z-a*o.x-b*o.y};}),
  };
}

/** Subtract a convex source surface without closing the gaps between surfaces. */
function subtract(subject:Point[],edges:Edge[]):Point[][]{
  let inside=subject;const result:Point[][]=[];
  for(const edge of edges){
    const positive:Point[]=[],negative:Point[]=[];
    for(let i=0;i<inside.length;i++){
      const p=inside[i],q=inside[(i+1)%inside.length],d=edge.a*p.x+edge.b*p.y+edge.c,e=edge.a*q.x+edge.b*q.y+edge.c;
      (d>=0?positive:negative).push(p);
      if((d<0)!==(e<0)){const t=d/(d-e),intersection={x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t};positive.push(intersection);negative.push(intersection);}
    }
    if(negative.length>=3&&area(negative)>0)result.push(negative);
    inside=positive;if(inside.length<3)break;
  }
  return result;
}

/** Build coverage only for cells actually queried, including unions of adjacent wall triangles. */
export class WorldOcclusionCoverage extends WorldOcclusionGrid {
  private bins:Cover[][]=[];
  protected covers=new Map<number,Cover>();
  lastWitnesses:number[]=[];
  beginTarget(_ids?:number[]){}
  clear(){this.depth.fill(NaN);this.covers?.clear();if(this.bins)for(const bin of this.bins)if(bin)bin.length=0;}
  polygon(points:ProjectedPoint[],padX:number,padY:number,id=0){
    const cover=projectedCover(points,padX,padY,id);
    this.covers.set(id,cover);
    const x0=Math.max(0,Math.floor(Math.min(...points.map(p=>p.x)))),x1=Math.min(this.width-1,Math.floor(Math.max(...points.map(p=>p.x))));
    const y0=Math.max(0,Math.floor(Math.min(...points.map(p=>p.y)))),y1=Math.min(this.height-1,Math.floor(Math.max(...points.map(p=>p.y))));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)(this.bins[y*this.width+x]??=[]).push(cover);
  }
  surface(points:ProjectedPoint[],padX:number,padY:number):boolean{
    const [a,b,c]=points,dx=b.x-a.x,dy=b.y-a.y,ex=c.x-a.x,ey=c.y-a.y,d=dx*ey-dy*ex;if(d<=1e-8)return false;
    const A=((b.z-a.z)*ey-(c.z-a.z)*dy)/d,B=(dx*(c.z-a.z)-ex*(b.z-a.z))/d,plane={a:A,b:B,c:a.z-A*a.x-B*a.y};
    const edges=points.map((p,i)=>{const q=points[(i+1)%points.length],dx=q.x-p.x,dy=q.y-p.y;return{a:-dy,b:dx,c:dy*p.x-dx*p.y+Math.abs(dy)*padX+Math.abs(dx)*padY};});
    const expanded:Point[]=[];
    for(let i=0;i<edges.length;i++){const p=edges[(i+edges.length-1)%edges.length],q=edges[i],det=p.a*q.b-q.a*p.b;if(Math.abs(det)<1e-8)return false;expanded.push({x:(p.b*q.c-q.b*p.c)/det,y:(q.a*p.c-p.a*q.c)/det});}
    return this.query(expanded,plane,true);
  }
  direct(points:ProjectedPoint[],ids:number[],padX:number,padY:number):boolean{
    for(const id of ids){const cover=this.covers.get(id);if(!cover)continue;
      if(points.every(p=>cover.edges.every(e=>e.a*p.x+e.b*p.y+e.c>Math.abs(e.a)*padX+Math.abs(e.b)*padY+1e-8)&&cover.planes.every(e=>e.a*p.x+e.b*p.y+e.c<p.z-this.depthEpsilon*2))){this.lastWitnesses=[id];return true;}
    }
    return false;
  }
  hidden(minX:number,minY:number,maxX:number,maxY:number,near:number):boolean{
    if(near<=-1||near>=1)return false;
    return this.query([{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}],{a:0,b:0,c:near});
  }
  protected query(shape:Point[],nearPlane:Edge,allowOffscreen=false):boolean{
    this.lastWitnesses=[];
    let minX=Math.min(...shape.map(p=>p.x)),minY=Math.min(...shape.map(p=>p.y)),maxX=Math.max(...shape.map(p=>p.x)),maxY=Math.max(...shape.map(p=>p.y));
    if(![minX,minY,maxX,maxY,...Object.values(nearPlane)].every(Number.isFinite)||minX>=maxX||minY>=maxY)return false;
    if(maxX<0||maxY<0||minX>=this.width||minY>=this.height)return allowOffscreen;
    minX=Math.max(0,minX);minY=Math.max(0,minY);maxX=Math.min(this.width-1e-8,maxX);maxY=Math.min(this.height-1e-8,maxY);
    // Clip the target to the viewport by subtracting its four outside half planes.
    for(const edge of [{a:-1,b:0,c:0},{a:1,b:0,c:-this.width+1e-8},{a:0,b:-1,c:0},{a:0,b:1,c:-this.height+1e-8}]){const pieces=subtract(shape,[edge]);if(!pieces.length)return allowOffscreen;if(pieces.length!==1)return false;shape=pieces[0];}
    const covered=(x:number,y:number)=>this.bins[Math.floor(y)*this.width+Math.floor(x)]?.some(cover=>cover.edges.every(e=>e.a*x+e.b*y+e.c>=-1e-10)&&cover.planes.every(p=>(p.a-nearPlane.a)*x+(p.b-nearPlane.b)*y+p.c-nearPlane.c<-this.depthEpsilon*2));
    if(!shape.every(p=>covered(p.x,p.y)))return false;
    const covers=new Set<Cover>();
    for(let y=Math.floor(minY);y<=Math.floor(maxY);y++)for(let x=Math.floor(minX);x<=Math.floor(maxX);x++)for(const cover of this.bins[y*this.width+x]??[])covers.add(cover);
    let pieces:Point[][]=[shape];
    const witnesses:number[]=[];
    for(const cover of [...covers].sort((a,b)=>a.far-b.far)){
      const edges=cover.edges.concat(cover.planes.map(p=>({a:nearPlane.a-p.a,b:nearPlane.b-p.b,c:nearPlane.c-p.c-this.depthEpsilon*2})));
      const remaining:Point[][]=[];
      for(const piece of pieces)remaining.push(...subtract(piece,edges));
      if(remaining.length>128)return false;
      const oldArea=pieces.reduce((sum,p)=>sum+area(p),0),newArea=remaining.reduce((sum,p)=>sum+area(p),0);
      if(newArea<oldArea){pieces=remaining;witnesses.push(cover.id);}
      if(!pieces.length){this.lastWitnesses=witnesses;return true;}
    }
    return false;
  }
}
