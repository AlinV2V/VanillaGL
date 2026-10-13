import * as THREE from 'three';
import { attachedTo,liveWorldRooms,treeVisible,type LiveWorldMesh } from './world-live-pages';
import { worldOccluderPolygons } from './world-occluder-triangles';
import { WorldOcclusionCoverage } from './world-occlusion-coverage';
import { WorldSharedCoverage } from './world-shared-coverage';
import { WorldVisibilityCandidates } from './world-visibility-candidates';
import { worldBatchFacesAway } from './world-facing-cull';
import { WorldVisibilityProjection,currentWitness,opaqueWall,rigidWmoMaterial,witness,type WallWitness } from './world-visibility-projection';

/** Retain occluder witnesses, never visibility answers: every rejection is proved against the current camera. */
export class MovingWorldOcclusion {
  constructor(private readonly coverage=true,readonly options:{shared?:boolean;compiled?:boolean}={}){this.grid=options.shared?new WorldSharedCoverage(64,36,2e-6):new WorldOcclusionCoverage(64,36,2e-6);}
  enabled=true;private grid:WorldOcclusionCoverage;private failed=false;
  private candidates=new WorldVisibilityCandidates();
  private witnesses=new Map<LiveWorldMesh,WallWitness[]>();private frame=0;
  private counts={passes:0,hiddenDraws:0,hiddenTriangles:0,testedMeshes:0,occluderTriangles:0,lastFrameCpuMs:0,failures:0,facingHiddenDraws:0,witnessDraws:0,discovery:false,candidatePolygons:0,directProofs:0};
  invalidate(){this.witnesses.clear();this.candidates.clear();this.frame=0;this.counts.hiddenDraws=0;this.grid.clear();}
  dispose(){this.invalidate();}
  stats(){return{enabled:this.enabled,...this.counts,witnessTargets:this.witnesses.size,currentFrameHiddenDraws:this.counts.hiddenDraws,pendingQueries:0,settled:true,mode:'current-frame-wall-witnesses',scope:'all registered WMO assets',depthTargetBytes:0,gridBytes:this.grid.depth.byteLength};}
  before(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera):()=>void{
    const start=performance.now();this.counts.hiddenDraws=0;this.counts.hiddenTriangles=0;this.counts.witnessDraws=0;this.counts.facingHiddenDraws=0;
    if(liveWorldRooms.size===0){this.invalidate();return()=>{};}
    if(!this.enabled||this.failed||!(camera instanceof THREE.PerspectiveCamera))return()=>{};
    const changed:LiveWorldMesh[]=[];
    try{
      camera.updateMatrixWorld(true);this.grid.clear();
      const size=renderer.getDrawingBufferSize(new THREE.Vector2()),target=renderer.getRenderTarget(),width=target?.width??size.x,height=target?.height??size.y;
      const projection=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),frustum=new THREE.Frustum().setFromProjectionMatrix(projection);
      const meshes:LiveWorldMesh[]=[],roots=new Set<THREE.Object3D>(),discovery=this.frame++%30===0;this.counts.discovery=discovery;
      const pending=this.options.compiled&&!discovery?this.candidates.next():[];
      const consider=(mesh:LiveWorldMesh)=>{const mat=mesh.material;
        if(!mesh.isMesh||mesh.userData.wmoPick?.kind!=='wmoBatch'||!mesh.visible||!(mat instanceof THREE.ShaderMaterial)||!mat.visible||mat.transparent||!mat.depthWrite||!mat.depthTest||mat.depthFunc!==THREE.LessEqualDepth||mat.wireframe||mat.polygonOffset||mat.clippingPlanes?.length||mesh.morphTargetInfluences?.length||!rigidWmoMaterial(mat))return;
        mesh.updateWorldMatrix(true,false);if(frustum.intersectsObject(mesh))meshes.push(mesh);
      };
      if(discovery||!this.coverage)for(const room of liveWorldRooms){
        if(!attachedTo(room.root,scene)||!treeVisible(room.root))continue;
        if(!roots.has(room.root)){room.root.updateWorldMatrix(true,false);roots.add(room.root);}
        if(!frustum.intersectsSphere(room.sphere.clone().applyMatrix4(room.root.matrixWorld)))continue;
        for(const object of room.objects)consider(object as LiveWorldMesh);
      }else{
        const dependencies=new Set<LiveWorldMesh>();for(const [mesh,list]of this.witnesses){dependencies.add(mesh);for(const wall of list)dependencies.add(wall.mesh);}
        for(const {mesh,walls}of pending){dependencies.add(mesh);for(const wall of walls)dependencies.add(wall.mesh);}
        for(const mesh of dependencies)if(attachedTo(mesh,scene)&&treeVisible(mesh))consider(mesh);
      }
      if(this.options.compiled&&discovery){this.candidates.update(meshes);pending.push(...this.candidates.next());}
      const active=new Set(meshes),view=new WorldVisibilityProjection(projection,this.grid.width,this.grid.height),padX=this.grid.width/width*2,padY=this.grid.height/height*2;
      this.counts.testedMeshes=meshes.length;this.counts.occluderTriangles=0;
      const hide=(mesh:LiveWorldMesh)=>{changed.push(mesh);this.counts.hiddenTriangles+=Math.min(mesh.geometry.index?.count??0,mesh.geometry.drawRange.count)/3;};
      this.counts.directProofs=0;
      const hiddenByWalls=(mesh:LiveWorldMesh,ids?:number[])=>{
        this.grid.beginTarget(ids);
        const corners=view.corners(mesh);if(!corners)return false;
        if(ids&&this.grid.direct(corners,ids,padX,padY)){this.counts.directProofs++;return true;}
        const bounds=view.bounds(mesh,padX,padY);if(bounds&&this.grid.hidden(...bounds))return true;
        const box=view.box(mesh,corners);if(!box)return false;const used=new Set<number>();
        for(const face of box){if(!this.grid.surface(face,padX,padY))return false;for(const id of this.grid.lastWitnesses)used.add(id);}
        this.grid.lastWitnesses=[...used];return true;
      };
      if(!this.coverage){
        const eye=camera.getWorldPosition(new THREE.Vector3()),local=new THREE.Vector3(),inverse=new THREE.Matrix4();
        for(const mesh of meshes)if(worldBatchFacesAway(mesh.geometry,local.copy(eye).applyMatrix4(inverse.copy(mesh.matrixWorld).invert()),mesh.material.side)){hide(mesh);this.counts.facingHiddenDraws++;}
      }else{
        const current:WallWitness[]=[],ids=new Map<WallWitness,number>();
        // Re-project only walls that established prior proofs. Every geometry,
        // material, transform and visibility dependency is checked again this frame.
        for(const [mesh,list]of this.witnesses){
          if(!active.has(mesh)){this.witnesses.delete(mesh);continue;}
          for(const wall of list)if(!ids.has(wall)&&active.has(wall.mesh)&&currentWitness(wall)&&opaqueWall(wall.mesh)){
            const points=view.wall(wall);if(!points)continue;const id=current.length;current.push(wall);ids.set(wall,id);this.grid.polygon(points,padX,padY,id);
          }
        }
        for(const [mesh,list]of this.witnesses)if(hiddenByWalls(mesh,list.flatMap(wall=>{const id=ids.get(wall);return id===undefined?[]:[id];}))){hide(mesh);this.counts.witnessDraws++;}
        if(this.options.compiled){
          const hidden=new Set(changed);
          for(const {mesh,walls}of pending){
            if(hidden.has(mesh)||!active.has(mesh))continue;
            this.grid.clear();current.length=0;
            for(const wall of walls){
              if(!active.has(wall.mesh)||!currentWitness(wall)||!opaqueWall(wall.mesh))continue;
              const points=view.wall(wall);if(!points)continue;const id=current.length;current.push(wall);this.grid.polygon(points,padX,padY,id);
            }
            if(hiddenByWalls(mesh)){this.witnesses.set(mesh,this.grid.lastWitnesses.map(id=>current[id]));hide(mesh);hidden.add(mesh);}
          }
        }else if(discovery){
          this.grid.clear();current.length=0;
          const projected:Array<{wall:WallWitness;points:NonNullable<ReturnType<WorldVisibilityProjection['wall']>>;area:number}>=[];
          for(const mesh of meshes)if(opaqueWall(mesh))for(const polygon of worldOccluderPolygons(mesh.geometry)){
            const wall=witness(mesh,polygon),points=view.wall(wall);if(!points)continue;
            const [a,b,c]=points,area=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x));if(area>.5)projected.push({wall,points,area});
          }
          this.counts.candidatePolygons=projected.length;projected.sort((a,b)=>b.area-a.area);
          for(const {wall,points}of projected.slice(0,1024)){const id=current.length;current.push(wall);this.grid.polygon(points,padX,padY,id);this.counts.occluderTriangles+=points.length-2;}
          const hidden=new Set(changed);
          for(const mesh of meshes){
            if(!hiddenByWalls(mesh))continue;
            this.witnesses.set(mesh,this.grid.lastWitnesses.map(id=>current[id]));if(!hidden.has(mesh))hide(mesh);
          }
        }
      }
      for(const mesh of changed)mesh.visible=false;
      this.counts.passes++;this.counts.hiddenDraws=changed.length;this.counts.lastFrameCpuMs=performance.now()-start;
      return()=>{for(const mesh of changed)mesh.visible=true;};
    }catch(error){for(const mesh of changed)mesh.visible=true;this.failed=true;this.counts.failures++;console.warn('Moving world occlusion disabled; drawing retained',error);return()=>{};}
  }
}
