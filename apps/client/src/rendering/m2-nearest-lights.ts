import * as THREE from 'three';
import type { WmoVisibilityInstance } from './wmo-visibility';
import type { M2LocalLight } from './m2-world-lighting';

const world = new THREE.Vector3();
const nearest = new Int32Array(4), distances = new Float64Array(4);

/** Retain only the nearest four candidates; allocate output only for selected lights. */
export function mappedLocalLights(inst: WmoVisibilityInstance, point: THREE.Vector3): M2LocalLight[] {
  const lights = inst.model?.lights ?? [];
  nearest.fill(-1); distances.fill(Infinity);
  for (let i = 0; i < lights.length; i++) {
    const light = lights[i];
    if (!light || light.type !== 0 || !Array.isArray(light.pos)) continue;
    world.fromArray(light.pos).applyMatrix4(inst.root.matrixWorld);
    const distance = world.distanceToSquared(point), radius = Number(light.attenEnd ?? 8) + 2;
    if (radius <= 0 || distance >= radius * radius || distance >= distances[3]) continue;
    let slot = 3;
    while (slot > 0 && distance < distances[slot - 1]) {
      nearest[slot] = nearest[slot - 1]; distances[slot] = distances[slot - 1]; slot--;
    }
    nearest[slot] = i; distances[slot] = distance;
  }
  const result: M2LocalLight[] = [];
  for (const index of nearest) {
    if (index < 0) break;
    const light = lights[index];
    world.fromArray(light.pos).applyMatrix4(inst.root.matrixWorld);
    result.push({ pos: [world.x, world.y, world.z], color: light.color ?? [1, 1, 1],
      attenStart: Number(light.attenStart ?? 0), attenEnd: Number(light.attenEnd ?? 8) });
  }
  return result;
}
