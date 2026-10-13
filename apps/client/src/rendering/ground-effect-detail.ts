import type { InstancedMesh, Object3D } from 'three';
export function clampBuild5875WorldDetail(value: number | undefined): 0 | 1 | 2 {
  const level = Math.max(0, Math.min(2, Math.round(value ?? 2)));
  return level as 0 | 1 | 2;
}

/**
 * Baked ground-effect instances carry the lowest Environment Detail tier at
 * which the 1.12.1 client would have emitted them. Runtime filtering is a tiny
 * browser concern and intentionally lives here instead of importing the
 * offline MPQ/StormLib asset package into the Vite graph.
 */
export function groundEffectInstanceVisibleAtDetail(
  instance: { d?: number },
  worldDetail: number | undefined,
): boolean {
  return instance.d === undefined || instance.d <= clampBuild5875WorldDetail(worldDetail);
}

// Keep matrices in tier order once; slider changes only alter the submitted prefix.
const detailCounts = new WeakMap<InstancedMesh, readonly number[]>();
export function groundEffectTier(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, value);
}
export function bindGroundEffectDetail(mesh: InstancedMesh, tiers: Iterable<number>, level: number | undefined): void {
  const counts = [0, 0, 0];
  for (const tier of tiers) for (let level = 0; level < 3; level++) if (tier <= level) counts[level]++;
  detailCounts.set(mesh, counts);
  mesh.count = counts[clampBuild5875WorldDetail(level)];
}
export function applyGroundEffectDetail(root: Object3D, level: number): void {
  const tier = clampBuild5875WorldDetail(level);
  root.traverse((object) => {
    const mesh = object as InstancedMesh;
    const counts = detailCounts.get(mesh);
    if (counts) mesh.count = counts[tier];
  });
}
