import * as THREE from 'three';

/** Shared presentation state; never used as movement or server authority. */
export const xrViewState = { active: false, views: [] as THREE.Camera[] };
const matrix = new THREE.Matrix4();
const frustum = new THREE.Frustum();

export function xrIntersectsSphere(sphere: THREE.Sphere, fallback: THREE.Frustum): boolean {
  if (!xrViewState.active) return fallback.intersectsSphere(sphere);
  if (!xrViewState.views.length) return true;
  return xrViewState.views.some(view => {
    frustum.setFromProjectionMatrix(matrix.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
    return frustum.intersectsSphere(sphere);
  });
}

export function xrIntersectsBox(box: THREE.Box3, world: THREE.Matrix4, fallback: THREE.Frustum): boolean {
  if (!xrViewState.active) return fallback.intersectsBox(box);
  if (!xrViewState.views.length) return true;
  return xrViewState.views.some(view => {
    matrix.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse).multiply(world);
    frustum.setFromProjectionMatrix(matrix);
    return frustum.intersectsBox(box);
  });
}
