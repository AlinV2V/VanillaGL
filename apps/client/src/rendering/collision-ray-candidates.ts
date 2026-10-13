import type * as THREE from 'three';

const axes = ['x', 'y', 'z'] as const;
/** Conservative finite-ray slab test. Unknown/invalid bounds must not reject geometry. */
export function rayReachesBounds(ray: THREE.Ray, near: number, far: number, bounds: THREE.Box3): boolean {
  let entry = Math.max(0, near), exit = far;
  for (const axis of axes) {
    const origin = ray.origin[axis], direction = ray.direction[axis];
    const low = bounds.min[axis], high = bounds.max[axis];
    if (!Number.isFinite(origin + direction + low + high)) return true;
    const epsilon = 1e-7 * Math.max(1, Math.abs(low), Math.abs(high));
    if (direction === 0) { if (origin < low - epsilon || origin > high + epsilon) return false; continue; }
    let a = (low - epsilon - origin) / direction, b = (high + epsilon - origin) / direction;
    if (a > b) { const swap = a; a = b; b = swap; }
    entry = Math.max(entry, a); exit = Math.min(exit, b);
    if (entry > exit) return false;
  }
  return true;
}

export class CollisionRayCandidates {
  private readonly bounds = new WeakMap<THREE.Mesh, THREE.Box3>();
  private readonly retained: THREE.Mesh[] = [];
  tested = 0;
  rejected = 0;
  release(): void { this.retained.length = 0; }
  register(mesh: THREE.Mesh, bounds: THREE.Box3): void { this.bounds.set(mesh, bounds); }
  filter(raycaster: THREE.Raycaster, candidates: THREE.Mesh[]): THREE.Mesh[] {
    this.retained.length = 0;
    for (const mesh of candidates) {
      this.tested++;
      const bounds = this.bounds.get(mesh);
      if (bounds && !rayReachesBounds(raycaster.ray, raycaster.near, raycaster.far, bounds)) { this.rejected++; continue; }
      this.retained.push(mesh);
    }
    return this.retained;
  }
}
