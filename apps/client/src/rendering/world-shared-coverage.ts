import { WorldOcclusionCoverage,projectedCover,type Cover,type Edge } from './world-occlusion-coverage';
import type { ProjectedPoint } from './world-occlusion-grid';

const vertices=64,stride=vertices*2,pieceLimit=128;
/** Bounded convex subtraction. Exhausting scratch space always retains the draw. */
export class WorldSharedCoverage extends WorldOcclusionCoverage {
  private selected:Cover[]=[];
  private ordered:Cover[]=[];
  private all:Cover[]=[];
  private boxes=new WeakMap<Cover,{minX:number;minY:number;maxX:number;maxY:number}>();
  private work:Cover[]=[];
  private dirty=true;
  private prepared=false;
  private pieces=new Float64Array(pieceLimit*stride);
  private remaining=new Float64Array(pieceLimit*stride);
  private lengths=new Uint16Array(pieceLimit);
  private nextLengths=new Uint16Array(pieceLimit);
  private inside=new Float64Array(stride);
  private positive=new Float64Array(stride);
  private negative=new Float64Array(stride);
  readonly scratchBytes=2*pieceLimit*stride*8+2*pieceLimit*2+3*stride*8;
  override clear(){this.covers?.clear();this.dirty=true;this.prepared=false;this.selected?.splice(0);this.ordered?.splice(0);this.all?.splice(0);this.work?.splice(0);}
  override polygon(points:ProjectedPoint[],padX:number,padY:number,id=0){
    const cover=projectedCover(points,padX,padY,id);this.covers.set(id,cover);this.all.push(cover);this.dirty=true;this.prepared=false;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of points){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}this.boxes.set(cover,{minX,minY,maxX,maxY});
  }
  override beginTarget(ids?:number[]){
    this.prepared=true;
    this.selected.length=0;
    if(ids){for(const id of ids){const cover=this.covers.get(id);if(cover&&!this.selected.includes(cover))this.selected.push(cover);}this.selected.sort((a,b)=>a.far-b.far);}
    else{
      if(this.dirty){this.ordered.length=0;for(const cover of this.all)this.ordered.push(cover);this.ordered.sort((a,b)=>a.far-b.far);this.dirty=false;}
      for(const cover of this.ordered)this.selected.push(cover);
    }
  }
  private area(p:Float64Array,n:number,offset=0){let sum=0;for(let i=0;i<n;i++){const a=offset+i*2,b=offset+((i+1)%n)*2;sum+=p[a]*p[b+1]-p[b]*p[a+1];}return sum;}
  /** Split the current convex piece; buffers are reused across all target faces. */
  private split(n:number,a:number,b:number,c:number):[number,number]|null{
    let pos=0,neg=0;
    for(let i=0;i<n;i++){
      const j=(i+1)%n,x=this.inside[i*2],y=this.inside[i*2+1],qx=this.inside[j*2],qy=this.inside[j*2+1],d=a*x+b*y+c,e=a*qx+b*qy+c;
      if(d>=0){if(pos===vertices)return null;this.positive[pos*2]=x;this.positive[pos++*2+1]=y;}
      else{if(neg===vertices)return null;this.negative[neg*2]=x;this.negative[neg++*2+1]=y;}
      if((d<0)!==(e<0)){
        if(pos===vertices||neg===vertices)return null;const t=d/(d-e),ix=x+(qx-x)*t,iy=y+(qy-y)*t;
        this.positive[pos*2]=this.negative[neg*2]=ix;this.positive[pos++*2+1]=this.negative[neg++*2+1]=iy;
      }
    }
    return[pos,neg];
  }
  protected override query(shape:{x:number;y:number}[],near:Edge,allowOffscreen=false):boolean{
    if(!this.prepared)this.beginTarget();
    this.lastWitnesses.length=0;
    if(![near.a,near.b,near.c].every(Number.isFinite)||shape.length>vertices)return false;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,n=shape.length;
    for(let i=0;i<n;i++){const {x,y}=shape[i];if(!Number.isFinite(x)||!Number.isFinite(y))return false;this.inside[i*2]=x;this.inside[i*2+1]=y;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
    if(minX>=maxX||minY>=maxY)return false;
    if(maxX<0||maxY<0||minX>=this.width||minY>=this.height)return allowOffscreen;
    this.work.length=0;for(const cover of this.selected){const b=this.boxes.get(cover)!;if(b.minX<=maxX&&b.maxX>=minX&&b.minY<=maxY&&b.maxY>=minY)this.work.push(cover);}
    // Keep precisely the same viewport margins and half-plane intersections as the reference.
    for(let edge=0;edge<4;edge++){
      const a=edge===0?-1:edge===1?1:0,b=edge===2?-1:edge===3?1:0,c=edge===1?-this.width+1e-8:edge===3?-this.height+1e-8:0;
      const split=this.split(n,a,b,c);if(!split)return false;n=split[1];
      if(n<3||this.area(this.negative,n)<=0)return allowOffscreen;
      this.inside.set(this.negative.subarray(0,n*2));
    }
    for(let i=0;i<n;i++){
      const x=this.inside[i*2],y=this.inside[i*2+1];let covered=false;
      if(Math.floor(x)<0||Math.floor(y)<0||Math.floor(x)>=this.width||Math.floor(y)>=this.height)return false;
      for(const cover of this.work){
        if(cover.edges.every(e=>e.a*x+e.b*y+e.c>=-1e-10)&&cover.planes.every(p=>(p.a-near.a)*x+(p.b-near.b)*y+p.c-near.c<-this.depthEpsilon*2)){covered=true;break;}
      }
      if(!covered)return false;
    }
    this.pieces.set(this.inside.subarray(0,n*2));this.lengths[0]=n;let count=1;
    for(const cover of this.work){
      let next=0,oldArea=0,newArea=0;
      for(let piece=0;piece<count;piece++){
        n=this.lengths[piece];oldArea+=this.area(this.pieces,n,piece*stride);
        this.inside.set(this.pieces.subarray(piece*stride,piece*stride+n*2));
        const edges=cover.edges.length+cover.planes.length;
        for(let k=0;k<edges;k++){
          const e=k<cover.edges.length?cover.edges[k]:cover.planes[k-cover.edges.length],depth=k>=cover.edges.length;
          const split=this.split(n,depth?near.a-e.a:e.a,depth?near.b-e.b:e.b,depth?near.c-e.c-this.depthEpsilon*2:e.c);if(!split)return false;
          const [pos,neg]=split,area=neg>=3?this.area(this.negative,neg):0;
          if(area>0){if(next===pieceLimit)return false;this.remaining.set(this.negative.subarray(0,neg*2),next*stride);this.nextLengths[next++]=neg;newArea+=area;}
          n=pos;if(n<3)break;this.inside.set(this.positive.subarray(0,n*2));
        }
      }
      if(newArea<oldArea){
        [this.pieces,this.remaining]=[this.remaining,this.pieces];[this.lengths,this.nextLengths]=[this.nextLengths,this.lengths];count=next;this.lastWitnesses.push(cover.id);
      }
      if(!count)return true;
    }
    return false;
  }
}
