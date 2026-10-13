import * as THREE from 'three';
import { attachedTo,liveWorldRooms,treeVisible,type LiveWorldMesh } from './world-live-pages';
import { WorldOcclusionGrid,type ProjectedPoint } from './world-occlusion-grid';
import { worldOccluderPolygons } from './world-occluder-triangles';

/** Existing inexpensive-at-backoff live path; the fuller wall-witness trial is opt-in. */
export class CoarseWorldOcclusion {
  enabled=true;private grid=new WorldOcclusionGrid();private failed=false;
  private counts={passes:0,hiddenDraws:0,hiddenTriangles:0,testedMeshes:0,occluderTriangles:0,lastFrameCpuMs:0,failures:0};
  invalidate(){this.counts.hiddenDraws=0;this.grid.clear();}
  dispose(){this.invalidate();}
  stats(){return{enabled:this.enabled,...this.counts,pendingQueries:0,settled:true,mode:'current-frame-conservative-coverage',scope:'all registered WMO assets',depthTargetBytes:0,gridBytes:this.grid.depth.byteLength};}
  before(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera):()=>void {
    const start=performance.now();this.counts.hiddenDraws=0;this.counts.hiddenTriangles=0;
    if(!this.enabled||this.failed||liveWorldRooms.size===0)return()=>{};
    const changed:LiveWorldMesh[]=[];
    try{
      camera.updateMatrixWorld(true);this.grid.clear();
      const size=renderer.getDrawingBufferSize(new THREE.Vector2()),target=renderer.getRenderTarget(),width=target?.width??size.x,height=target?.height??size.y;
      const projection=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),frustum=new THREE.Frustum().setFromProjectionMatrix(projection);
      const meshes:LiveWorldMesh[]=[],roots=new Set<THREE.Object3D>(),matrix=new THREE.Matrix4();
      for(const room of liveWorldRooms){
        if(!attachedTo(room.root,scene)||!treeVisible(room.root))continue;
        if(!roots.has(room.root)){room.root.updateWorldMatrix(true,false);roots.add(room.root);}
        if(!frustum.intersectsSphere(room.sphere.clone().applyMatrix4(room.root.matrixWorld)))continue;
        for(const object of room.objects){const mesh=object as LiveWorldMesh,mat=mesh.material;
          if(!mesh.isMesh||mesh.userData.wmoPick?.kind!=='wmoBatch'||!mesh.visible||!(mat instanceof THREE.ShaderMaterial)||!mat.visible||mat.transparent||!mat.depthWrite||!mat.depthTest||mat.depthFunc!==THREE.LessEqualDepth||mat.wireframe||mat.polygonOffset||mat.clippingPlanes?.length||mesh.morphTargetInfluences?.length||!mat.vertexShader.includes('vec4 wp = modelMatrix * vec4(position, 1.0);')||!mat.vertexShader.includes('gl_Position = projectionMatrix * viewPos;'))continue;
          mesh.updateWorldMatrix(true,false);if(frustum.intersectsObject(mesh))meshes.push(mesh);
        }
      }
      this.counts.testedMeshes=meshes.length;this.counts.occluderTriangles=0;
      const projected:Array<{points:ProjectedPoint[];area:number}>=[];
      const project=(x:number,y:number,z:number,m:THREE.Matrix4):ProjectedPoint|null=>{
        const e=m.elements,w=e[3]*x+e[7]*y+e[11]*z+e[15],cz=e[2]*x+e[6]*y+e[10]*z+e[14];
        if(w<=1e-5||cz<=-w+1e-5||cz>=w-1e-5)return null;
        return{x:((e[0]*x+e[4]*y+e[8]*z+e[12])/w+1)*this.grid.width/2,y:((e[1]*x+e[5]*y+e[9]*z+e[13])/w+1)*this.grid.height/2,z:cz/w};
      };
      for(const mesh of meshes){
        const mat=mesh.material;
        if(mesh.userData.wmoPick.blendMode!==0||(mat.uniforms.uAlphaTest?.value??0)>0||mat.alphaTest||mat.alphaToCoverage||mat.vertexShader.includes('displacement'))continue;
        matrix.multiplyMatrices(projection,mesh.matrixWorld);const polygons=worldOccluderPolygons(mesh.geometry),flipped=mesh.matrixWorld.determinant()<0;
        for(const polygon of polygons){
          const points:ProjectedPoint[]=[];for(let i=0;i<polygon.length;i+=3){const p=project(polygon[i],polygon[i+1],polygon[i+2],matrix);if(!p)break;points.push(p);}if(points.length!==polygon.length/3)continue;
          const [a,b,c]=points,area=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
          if(mat.side!==THREE.DoubleSide&&((area>0)!==flipped)!==(mat.side===THREE.FrontSide))continue;
          if(area<0)points.splice(1,points.length-1,...points.slice(1).reverse());
          if(!points.every((p,i)=>{const q=points[(i+1)%points.length],r=points[(i+2)%points.length];return(q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x)>1e-7;}))continue;
          if(Math.abs(area)>2)projected.push({points,area:Math.abs(area)});
        }
      }
      projected.sort((a,b)=>b.area-a.area);
      for(const polygon of projected.slice(0,512)){this.grid.polygon(polygon.points,this.grid.width/width*2,this.grid.height/height*2);this.counts.occluderTriangles+=polygon.points.length-2;}
      for(const mesh of meshes){
        const bounds=mesh.geometry.boundingBox;if(!bounds)continue;matrix.multiplyMatrices(projection,mesh.matrixWorld);
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,near=Infinity,valid=true;
        for(let corner=0;corner<8;corner++){
          const p=project(corner&1?bounds.max.x:bounds.min.x,corner&2?bounds.max.y:bounds.min.y,corner&4?bounds.max.z:bounds.min.z,matrix);
          if(!p){valid=false;break;}minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);near=Math.min(near,p.z);
        }
        const padX=this.grid.width/width*2,padY=this.grid.height/height*2;
        if(valid&&this.grid.hidden(minX-padX,minY-padY,maxX+padX,maxY+padY,near)){changed.push(mesh);mesh.visible=false;this.counts.hiddenTriangles+=Math.min(mesh.geometry.index?.count??0,mesh.geometry.drawRange.count)/3;}
      }
      this.counts.passes++;this.counts.hiddenDraws=changed.length;this.counts.lastFrameCpuMs=performance.now()-start;
      return()=>{for(const mesh of changed)mesh.visible=true;};
    }catch(error){for(const mesh of changed)mesh.visible=true;this.failed=true;this.counts.failures++;console.warn('Moving world occlusion disabled; drawing retained',error);return()=>{};}
  }
}
