import * as THREE from 'three';
import { SpatialBoundsIndex2D } from '../platform/spatial-index';
import type { WmoVisibilityInstance } from './wmo-visibility';

type Index = { spatial: SpatialBoundsIndex2D<WmoVisibilityInstance>; fallback: WmoVisibilityInstance[]; count: number };
const indices = new WeakMap<readonly WmoVisibilityInstance[], Index>();
const box = new THREE.Box3(), groupBox = new THREE.Box3();

/** Tile commit, eviction and render-origin changes invalidate this immutable-world index. */
export function invalidateWmoLightCandidates(instances: readonly WmoVisibilityInstance[]): void {
  indices.delete(instances);
}

export function wmoLightCandidates(instances: readonly WmoVisibilityInstance[], point: THREE.Vector3, out: WmoVisibilityInstance[]): WmoVisibilityInstance[] {
  let index = indices.get(instances);
  if (!index || index.count !== instances.length) {
    index = { spatial: new SpatialBoundsIndex2D(64), fallback: [], count: instances.length };
    for (const inst of instances) {
      box.makeEmpty();
      for (const group of inst.groups) if (group.bbox) {
        groupBox.min.fromArray(group.bbox[0]); groupBox.max.fromArray(group.bbox[1]);
        box.union(groupBox);
      }
      inst.root.updateWorldMatrix(true, false);
      // Match the membership query's local-space tolerance conservatively.
      box.expandByScalar(2).applyMatrix4(inst.root.matrixWorld);
      if (box.isEmpty() || !Number.isFinite(box.min.x + box.max.x + box.min.y + box.max.y)) index.fallback.push(inst);
      else index.spatial.update(inst.root.uuid, inst, box.min.x, box.min.y, box.max.x, box.max.y);
    }
    indices.set(instances, index);
  }
  index.spatial.queryPoint(point.x, point.y, out);
  for (const inst of index.fallback) out.push(inst);
  return out;
}
