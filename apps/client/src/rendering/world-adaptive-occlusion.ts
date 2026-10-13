import * as THREE from 'three';
import { LiveWorldOcclusion } from './world-live-occlusion';
import { CoarseWorldOcclusion } from './world-coarse-occlusion';

/** Movement uses current-frame proofs; settled views also retain the more effective GPU queries. */
export class AdaptiveWorldOcclusion {
  enabled=true;
  private moving=new CoarseWorldOcclusion();private queries=new LiveWorldOcclusion();
  private cooldown=0;private movingActive=false;private lastCpuMs=0;
  invalidate(){this.moving.invalidate();this.queries.invalidate();this.cooldown=0;this.movingActive=false;}
  dispose(){this.moving.dispose();this.queries.dispose();this.cooldown=0;this.movingActive=false;}
  stats(){const moving=this.moving.stats(),query=this.queries.stats();return{
    enabled:this.enabled,mode:'adaptive-current-frame-and-settled-queries',scope:moving.scope,
    hiddenDraws:query.hiddenDraws+(this.movingActive?moving.hiddenDraws:0),
    hiddenTriangles:this.movingActive?moving.hiddenTriangles:0,
    currentFrameHiddenDraws:this.movingActive?moving.hiddenDraws:0,settledHiddenDraws:query.hiddenDraws,
    passes:moving.passes+query.passes,failures:moving.failures+query.failures,pendingQueries:query.pendingQueries,
    settled:query.settled,lastFrameCpuMs:this.lastCpuMs,depthTargetBytes:query.depthTargetBytes,gridBytes:moving.gridBytes,
    movingCooldownFrames:this.cooldown,
  };}
  before(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera):()=>void{
    const start=performance.now();this.movingActive=false;this.queries.enabled=this.enabled;
    if(!this.enabled)return()=>{};
    const restoreQueries=this.queries.before(renderer,scene,camera);
    let restoreMoving=()=>{};
    if(this.cooldown>0)this.cooldown--;
    else if(!this.queries.stats().hiddenDraws){
      restoreMoving=this.moving.before(renderer,scene,camera);this.movingActive=true;
      const result=this.moving.stats();
      // Never reuse a rejection during backoff. All geometry draws on skipped
      // frames; unproductive coverage work costs at most one attempt per 30 frames.
      if(result.hiddenDraws<8&&result.hiddenTriangles<2000)this.cooldown=29;
    }
    this.lastCpuMs=performance.now()-start;
    return()=>{restoreMoving();restoreQueries();};
  }
}
