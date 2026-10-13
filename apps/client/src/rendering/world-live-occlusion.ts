import * as THREE from 'three';
import { attachedTo,liveWorldRooms,liveWorldRoots,treeVisible,type LiveWorldMesh } from './world-live-pages';

export const sameVisibilityState=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every((value,index)=>value===b[index]);
type Query={handle:WebGLQuery;meshes:LiveWorldMesh[]};
/** Static WMO occluders only. Camera/state changes discard all results before drawing. */
export class LiveWorldOcclusion {
  enabled=true;private state:number[]=[];private since=0;private issued=false;private queries:Query[]=[];
  private cameraState:number[]=[];
  private uniformKeys=new WeakMap<THREE.ShaderMaterial,{version:number;keys:string[]}>();
  private tracked?:{roots:THREE.Group[];meshes:LiveWorldMesh[]};
  private depthMaterials=new WeakMap<THREE.ShaderMaterial,{key:string;material:THREE.ShaderMaterial}>();
  private ownedMaterials=new Set<THREE.ShaderMaterial>();
  private hidden=new Set<LiveWorldMesh>();private target?:THREE.WebGLRenderTarget;private gl?:WebGL2RenderingContext;
  private queryFrame=0;private samples=0;private failed=false;
  private counts={passes:0,invalidations:0,queries:0,hiddenDraws:0,lastIssueCpuMs:0,lastFrameCpuMs:0,failures:0};
  invalidate(){if(this.gl)for(const query of this.queries)this.gl.deleteQuery(query.handle);this.queries=[];this.hidden.clear();this.issued=false;this.state=[];this.tracked=undefined;this.counts.hiddenDraws=0;}
  dispose(){this.invalidate();this.target?.dispose();this.target=undefined;this.ownedMaterials.forEach(material=>material.dispose());this.ownedMaterials.clear();this.depthMaterials=new WeakMap();}
  stats(){return{enabled:this.enabled,...this.counts,pendingQueries:this.queries.length,settled:this.issued&&this.queries.length===0,trackedMeshes:this.tracked?.meshes.length??0,policy:'static-camera/static-WMO only; moving and uncertain sections render normally',depthTargetBytes:this.target?this.target.width*this.target.height*8*Math.max(1,this.samples):0};}
  before(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera):()=>void {
    const start=performance.now();if(!this.enabled||this.failed)return()=>{};
    if(liveWorldRooms.size===0){this.dispose();return()=>{};}
    const gl=renderer.getContext() as WebGL2RenderingContext;this.gl=gl;
    if(gl.isContextLost()){this.dispose();return()=>{};}
    try{
      camera.updateMatrixWorld(true);
      const size=renderer.getDrawingBufferSize(new THREE.Vector2()),current=renderer.getRenderTarget();
      const width=current?.width??size.x,height=current?.height??size.y,samples=current?.samples??gl.getParameter(gl.SAMPLES);
      // Compare the actual Float32 GPU transforms, including composed WMO model-view matrices.
      // OrbitControls can change doubles indefinitely while submitting identical GPU transforms.
      const state=[width,height,samples,...camera.projectionMatrix.elements.map(Math.fround),...camera.matrixWorldInverse.elements.map(Math.fround),...camera.matrixWorld.elements.map(Math.fround)];
      const modelView=new THREE.Matrix4();
      for(const root of liveWorldRoots)if(attachedTo(root,scene)){root.updateWorldMatrix(true,false);state.push(root.id,...root.matrixWorld.elements.map(Math.fround),...modelView.multiplyMatrices(camera.matrixWorldInverse,root.matrixWorld).elements.map(Math.fround));}
      if(!sameVisibilityState(state,this.cameraState)){this.invalidate();this.cameraState=[...state];this.since=start;this.counts.invalidations++;this.counts.lastFrameCpuMs=performance.now()-start;return()=>{};}
      if(start-this.since<250){this.counts.lastFrameCpuMs=performance.now()-start;return()=>{};}
      // A cached rejection depends only on the surfaces queried or used as occluders.
      // New/untracked geometry is still drawn normally and cannot invalidate an existing rejection.
      if(!this.tracked){
        const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
        const roots=new Set<THREE.Group>(),meshes:LiveWorldMesh[]=[];
        for(const room of liveWorldRooms){
          if(!attachedTo(room.root,scene)||!treeVisible(room.root))continue;
          for(const object of room.objects){const mesh=object as LiveWorldMesh;
            if(!mesh.isMesh||mesh.userData.wmoPick?.kind!=='wmoBatch'||!(mesh.material instanceof THREE.ShaderMaterial)||!mesh.visible||!mesh.material.visible||mesh.material.transparent||!mesh.material.depthWrite||!mesh.material.depthTest)continue;
            mesh.updateWorldMatrix(true,false);if(frustum.intersectsObject(mesh)){roots.add(room.root);meshes.push(mesh);}
          }
        }
        this.tracked={roots:[...roots],meshes};
      }
      const tracked=this.tracked;
      const seenMaterials=new Set<THREE.ShaderMaterial>();
      for(const root of tracked.roots){root.updateWorldMatrix(true,false);state.push(root.id,+attachedTo(root,scene),+treeVisible(root),...root.matrixWorld.elements);}
      for(const mesh of tracked.meshes){
          // Registered WMO batches have identity local transforms. Unexpected motion disables reuse.
          if(mesh.position.lengthSq()!==0||mesh.quaternion.x||mesh.quaternion.y||mesh.quaternion.z||mesh.quaternion.w!==1||mesh.scale.x!==1||mesh.scale.y!==1||mesh.scale.z!==1){this.invalidate();return()=>{};}
          const material=mesh.material,geometry=mesh.geometry;
          state.push(mesh.id,mesh.parent?.id??-1,+mesh.visible,geometry.id,geometry.index?.version??0,(geometry.getAttribute('position') as THREE.BufferAttribute)?.version??0,material.id);
          if(seenMaterials.has(material))continue;seenMaterials.add(material);
          state.push(material.version,+material.visible,+material.transparent,+material.depthWrite,+material.depthTest,material.depthFunc,material.side,+material.polygonOffset,material.polygonOffsetFactor,material.polygonOffsetUnits);
          let cached=this.uniformKeys.get(material);
          if(!cached||cached.version!==material.version){cached={version:material.version,keys:Object.keys(material.uniforms).filter(key=>/alpha|opacity|uv|map|texture/i.test(key))};this.uniformKeys.set(material,cached);}
          for(const key of cached.keys){
            const value=material.uniforms[key]?.value;
            if(typeof value==='number')state.push(value);
            else if(value instanceof THREE.Texture)state.push(value.id,value.version);
            else if(value?.toArray)state.push(...value.toArray());
          }
      }
      if(!sameVisibilityState(state,this.state)){this.invalidate();this.state=state;this.since=start;this.counts.invalidations++;}
      if(!this.issued&&start-this.since>=250){if(tracked.meshes.length)this.issue(renderer,scene,camera,width,height,samples);this.issued=true;}
      this.queryFrame++;
      for(let i=this.queries.length-1;i>=0;i--){const query=this.queries[i];
        if(gl.getQueryParameter(query.handle,gl.QUERY_RESULT_AVAILABLE)){
          if(!gl.getQueryParameter(query.handle,gl.QUERY_RESULT))query.meshes.forEach(mesh=>this.hidden.add(mesh));
          gl.deleteQuery(query.handle);this.queries.splice(i,1);
        }else if(this.queryFrame>30){gl.deleteQuery(query.handle);this.queries.splice(i,1);}
      }
      const changed:LiveWorldMesh[]=[];for(const mesh of this.hidden)if(mesh.visible){changed.push(mesh);mesh.visible=false;}
      this.counts.hiddenDraws=changed.length;this.counts.lastFrameCpuMs=performance.now()-start;
      return()=>{for(const mesh of changed)mesh.visible=true;};
    }catch(error){this.invalidate();this.failed=true;this.counts.failures++;console.warn('World occlusion disabled; normal drawing retained',error);return()=>{};}
  }
  private issue(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera,width:number,height:number,samples:number){
    const start=performance.now(),gl=this.gl!,depth=new THREE.Scene(),proxies=new THREE.Scene();
    const groups=new Map<string,{targets:LiveWorldMesh[];bounds:THREE.Box3}>();
    const boxGeometry=new THREE.BoxGeometry(),boxMaterial=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false,side:THREE.DoubleSide});
    const cameraPoint=camera.getWorldPosition(new THREE.Vector3());
    for(const mesh of this.tracked?.meshes??[]){
        mesh.updateWorldMatrix(true,false);
        const groupKey=`${mesh.parent?.id}:${mesh.userData.wmoPick.groupIndex}`,group=groups.get(groupKey)??{targets:[],bounds:new THREE.Box3()};
        if(!mesh.geometry.boundingBox)mesh.geometry.computeBoundingBox();group.bounds.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));group.targets.push(mesh);groups.set(groupKey,group);
        // Only opaque static WMO surfaces supply depth. NPCs, doors, terrain and alpha-tested surfaces cannot become stale occluders.
        if(mesh.userData.wmoPick?.blendMode!==0||mesh.material.uniforms.uAlphaTest?.value>0)continue;
        const source=mesh.material;
        const key=[source.version,source.side,source.depthFunc,source.polygonOffset,source.polygonOffsetFactor,source.polygonOffsetUnits,source.alphaTest,source.alphaToCoverage,source.wireframe].join(':');
        let cached=this.depthMaterials.get(source);
        if(!cached||cached.key!==key){if(cached){cached.material.dispose();this.ownedMaterials.delete(cached.material);}const material=source.clone();material.colorWrite=false;cached={key,material};this.depthMaterials.set(source,cached);this.ownedMaterials.add(material);}
        const material=cached.material;material.uniforms=source.uniforms;
        const clone=new THREE.Mesh(mesh.geometry,material);clone.matrixAutoUpdate=false;clone.matrix.copy(mesh.matrixWorld);clone.renderOrder=mesh.renderOrder;depth.add(clone);
    }
    for(const {targets,bounds}of groups.values()){
      if(!targets.length||bounds.containsPoint(cameraPoint))continue;
      const handle=gl.createQuery();if(!handle)continue;
      const proxy=new THREE.Mesh(boxGeometry,boxMaterial);bounds.getCenter(proxy.position);bounds.getSize(proxy.scale);proxy.scale.addScalar(.02);proxy.frustumCulled=false;
      proxy.onBeforeRender=()=>gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,handle);proxy.onAfterRender=()=>gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      proxies.add(proxy);this.queries.push({handle,meshes:targets});
    }
    const previous=renderer.getRenderTarget(),autoClear=renderer.autoClear;
    try{
      if(!this.target||this.target.width!==width||this.target.height!==height||this.samples!==samples){this.target?.dispose();this.target=new THREE.WebGLRenderTarget(width,height,{samples});this.samples=samples;}
      renderer.setRenderTarget(this.target);renderer.autoClear=true;renderer.render(depth,camera);
      renderer.autoClear=false;renderer.render(proxies,camera);this.queryFrame=0;this.counts.passes++;this.counts.queries+=this.queries.length;
    }finally{
      renderer.setRenderTarget(previous);renderer.autoClear=autoClear;
      boxGeometry.dispose();boxMaterial.dispose();this.counts.lastIssueCpuMs=performance.now()-start;
    }
  }
}
