import * as THREE from 'three';
import { MovingWorldOcclusion } from './world-moving-occlusion';
import { WorldSpatialPages } from './world-spatial-pages';

export class SpatialWorldOcclusion {
  private pages:WorldSpatialPages;
  constructor(private readonly proofs=true){this.pages=new WorldSpatialPages(proofs);}
  private controller=new MovingWorldOcclusion(true,{shared:true,compiled:true});
  enabled=true;
  invalidate(){this.controller.invalidate();}
  dispose(){this.controller.dispose();this.pages.dispose();}
  stats(){return{...this.controller.stats(),...this.pages.stats(),mode:this.proofs?'spatial-current-frame-proofs':'spatial-current-frustum'};}
  before(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera){
    if(!this.enabled)return()=>{};
    let restore=()=>{};
    try{this.pages.prepare(scene,camera);if(this.proofs)restore=this.controller.before(renderer,scene,camera);this.pages.apply();return()=>{this.pages.restore();restore();};}
    catch(error){this.pages.restore();restore();this.enabled=false;console.warn('Spatial visibility retained native geometry',error);return()=>{};}
  }
}
