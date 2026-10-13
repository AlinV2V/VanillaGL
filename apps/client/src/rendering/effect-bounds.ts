import type * as THREE from 'three';

/** Conservative particle/ribbon bounds; malformed extents keep the draw eligible. */
export function setSphereFromExtents(
  sphere: THREE.Sphere,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
) {
  if (minX === Number.POSITIVE_INFINITY) {
    sphere.center.set(0, 0, 0);
    sphere.radius = 0;
    return;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ) ||
      !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)) {
    sphere.center.set(0, 0, 0);
    sphere.radius = Number.POSITIVE_INFINITY;
    return;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  sphere.center.set(cx, cy, cz);
  sphere.radius = Math.hypot(maxX - cx, maxY - cy, maxZ - cz);
}
