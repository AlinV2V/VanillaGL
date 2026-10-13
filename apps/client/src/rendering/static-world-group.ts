import * as THREE from 'three';

/**
 * A tile subtree is immutable between render-origin shifts. Three's renderer normally forces a
 * complete updateMatrixWorld walk before every render pass, even for invisible static children.
 * A city tile has thousands of those children, so the repeated walk was measurable CPU work.
 *
 * Refresh explicitly after construction or an origin shift, then make the renderer's automatic
 * walk stop at the tile root. GPU-skinned doodads and scrolling materials remain dynamic because
 * their animation lives in textures/uniforms; their Object3D transforms stay fixed.
 */
export class StaticWorldGroup extends THREE.Group {
  private frozen = false;

  override updateMatrixWorld(force?: boolean): void {
    if (this.frozen) return;
    super.updateMatrixWorld(force);
  }

  refreshStaticWorldMatrices(): void {
    this.frozen = false;
    // The tile root position changes during render-origin shifts. Descendant local matrices do not,
    // but their world matrices must be recomposed from the new root.
    this.matrixAutoUpdate = true;
    this.traverse((object) => { object.matrixWorldAutoUpdate = true; });
    super.updateMatrixWorld(true);
    this.traverse((object) => {
      object.matrixAutoUpdate = false;
      object.matrixWorldAutoUpdate = false;
      object.matrixWorldNeedsUpdate = false;
    });
    this.frozen = true;
  }
}
