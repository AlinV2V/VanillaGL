/** Conservative full-cell coverage. A hole, uncertain clip or depth tie always keeps the object. */
export type ProjectedPoint={x:number;y:number;z:number};
export class WorldOcclusionGrid {
  readonly depth:Float64Array;
  constructor(readonly width=128,readonly height=72,readonly depthEpsilon=1e-5){this.depth=new Float64Array(width*height);this.clear();}
  clear(){this.depth.fill(Infinity);}
  triangle(a:ProjectedPoint,b:ProjectedPoint,c:ProjectedPoint,padX:number,padY:number){
    const area=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);if(!Number.isFinite(area)||Math.abs(area)<1e-8)return;
    if(area<0){const swap=b;b=c;c=swap;}
    this.polygon([a,b,c],padX,padY);
  }
  polygon(points:ProjectedPoint[],padX:number,padY:number){
    const minX=Math.max(0,Math.floor(Math.min(...points.map(p=>p.x)))),maxX=Math.min(this.width-1,Math.floor(Math.max(...points.map(p=>p.x))));
    const minY=Math.max(0,Math.floor(Math.min(...points.map(p=>p.y)))),maxY=Math.min(this.height-1,Math.floor(Math.max(...points.map(p=>p.y))));
    const edges=points.map((p,i)=>{const q=points[(i+1)%points.length],dx=q.x-p.x,dy=q.y-p.y;return{A:-dy,B:dx,C:dy*p.x-dx*p.y,margin:Math.abs(dy)*padX+Math.abs(dx)*padY+1e-7};});
    // Window depth is affine on each projected source triangle. Using a whole
    // wall's farthest vertex loses almost all useful coverage at oblique angles.
    const planes=points.slice(1,-1).map((b,i)=>{const a=points[0],c=points[i+2],dx=b.x-a.x,dy=b.y-a.y,ex=c.x-a.x,ey=c.y-a.y,d=dx*ey-dy*ex;
      const A=((b.z-a.z)*ey-(c.z-a.z)*dy)/d,B=(dx*(c.z-a.z)-ex*(b.z-a.z))/d;return{A,B,C:a.z-A*a.x-B*a.y};});
    const globalFar=Math.max(...points.map(p=>p.z));
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      let inside=true;
      for(const e of edges)if(e.A*(e.A<0?x+1:x)+e.B*(e.B<0?y+1:y)+e.C<=e.margin){inside=false;break;}
      if(inside){const far=Math.min(globalFar,Math.max(...planes.map(p=>p.A*(p.A>0?x+1:x)+p.B*(p.B>0?y+1:y)+p.C)))+this.depthEpsilon;
        const index=y*this.width+x;if(Number.isFinite(far)&&far<this.depth[index])this.depth[index]=far;}
    }
  }
  hidden(minX:number,minY:number,maxX:number,maxY:number,near:number):boolean {
    if(![minX,minY,maxX,maxY,near].every(Number.isFinite)||minX>maxX||minY>maxY||near<=-1||near>=1)return false;
    if(maxX<0||maxY<0||minX>=this.width||minY>=this.height)return false;
    const left=Math.max(0,Math.floor(minX)),right=Math.min(this.width-1,Math.floor(maxX));
    const bottom=Math.max(0,Math.floor(minY)),top=Math.min(this.height-1,Math.floor(maxY));
    for(let y=bottom;y<=top;y++)for(let x=left;x<=right;x++)if(this.depth[y*this.width+x]>=near-this.depthEpsilon)return false;
    return true;
  }
}
