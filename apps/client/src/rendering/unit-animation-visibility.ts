import * as THREE from 'three';
import { xrIntersectsSphere } from './xr-view-state';

/**
 * Allocation-free camera-frustum query used to avoid sampling/uploading bones for units that the
 * active world camera cannot see. The sphere is deliberately generous: false positives cost CPU,
 * while false negatives could expose a stale pose when a large creature reaches into the view.
 */
export class UnitAnimationVisibility {
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private prepared = false;

  prepare(camera?: THREE.Camera) {
    this.prepared = !!camera;
    if (!camera) return false;
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
    return true;
  }

  intersects(position: THREE.Vector3, height: number, horizontalRadius: number) {
    if (!this.prepared) return true;
    const safeHeight = Math.max(0.5, Math.abs(height));
    this.sphere.center.set(position.x, position.y, position.z + safeHeight * 0.5);
    this.sphere.radius = Math.max(2, safeHeight * 0.75, Math.abs(horizontalRadius) * 2);
    return xrIntersectsSphere(this.sphere, this.frustum);
  }
}
