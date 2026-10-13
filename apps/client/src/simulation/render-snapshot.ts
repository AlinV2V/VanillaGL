import type { WorldState } from './world-state';

const growCapacity = (current: number, required: number) => {
  let next = Math.max(16, current);
  while (next < required) next *= 2;
  return next;
};

/**
 * Reusable structure-of-arrays snapshot for the renderer/worker boundary. Numeric render IDs avoid
 * repeating GUID strings in the hot path; lifecycle events carry GUIDs only when entities change.
 */
export class RenderSnapshotBuffer {
  private sourceWorld?: WorldState;
  revision = -1;
  tick = 0;
  timeMs = 0;
  count = 0;
  capacity = 0;

  renderIds = new Uint32Array(0);
  positions = new Float32Array(0); // xyz, count * 3
  orientations = new Float32Array(0);
  displayIds = new Uint32Array(0);
  scales = new Float32Array(0);
  health = new Uint32Array(0);
  maxHealth = new Uint32Array(0);
  unitFlags = new Uint32Array(0);
  dynamicFlags = new Uint32Array(0);
  teleportSequences = new Uint32Array(0);
  transformVersions = new Uint32Array(0);
  appearanceVersions = new Uint32Array(0);
  combatVersions = new Uint32Array(0);

  ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    const capacity = growCapacity(this.capacity, required);
    this.capacity = capacity;
    this.renderIds = new Uint32Array(capacity);
    this.positions = new Float32Array(capacity * 3);
    this.orientations = new Float32Array(capacity);
    this.displayIds = new Uint32Array(capacity);
    this.scales = new Float32Array(capacity);
    this.health = new Uint32Array(capacity);
    this.maxHealth = new Uint32Array(capacity);
    this.unitFlags = new Uint32Array(capacity);
    this.dynamicFlags = new Uint32Array(capacity);
    this.teleportSequences = new Uint32Array(capacity);
    this.transformVersions = new Uint32Array(capacity);
    this.appearanceVersions = new Uint32Array(capacity);
    this.combatVersions = new Uint32Array(capacity);
  }

  write(world: WorldState, tick: number, timeMs: number, revision = tick): this {
    this.ensureCapacity(world.size);
    this.tick = tick;
    this.timeMs = timeMs;
    this.revision = revision;
    this.sourceWorld = world;
    let index = 0;
    for (const entity of world.values()) {
      this.renderIds[index] = entity.renderId;
      const p = index * 3;
      this.positions[p] = entity.position.x;
      this.positions[p + 1] = entity.position.y;
      this.positions[p + 2] = entity.position.z;
      this.orientations[index] = entity.orientation;
      this.displayIds[index] = entity.displayId >>> 0;
      this.scales[index] = entity.scale;
      this.health[index] = entity.health >>> 0;
      this.maxHealth[index] = entity.maxHealth >>> 0;
      this.unitFlags[index] = entity.unitFlags >>> 0;
      this.dynamicFlags[index] = entity.dynamicFlags >>> 0;
      this.teleportSequences[index] = entity.teleportSeq >>> 0;
      this.transformVersions[index] = entity.versions.transform >>> 0;
      this.appearanceVersions[index] = entity.versions.appearance >>> 0;
      this.combatVersions[index] = entity.versions.combat >>> 0;
      index++;
    }
    this.count = index;
    return this;
  }

  matchesState(world: WorldState, revision: number): boolean {
    return this.sourceWorld === world && this.revision === revision && this.count === world.size;
  }
}

export type InterpolatedTransform = {
  x: number;
  y: number;
  z: number;
  orientation: number;
  hardSnap: boolean;
};

const lerp = (a: number, b: number, alpha: number) => a + (b - a) * alpha;
const lerpAngle = (a: number, b: number, alpha: number) => {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * alpha;
};

/** Allocation-free transform sampling into a caller-owned object. */
export function interpolateSnapshotTransform(
  previous: RenderSnapshotBuffer,
  current: RenderSnapshotBuffer,
  previousIndex: number,
  currentIndex: number,
  alpha: number,
  out: InterpolatedTransform,
): InterpolatedTransform {
  const clamped = Math.max(0, Math.min(1, alpha));
  const discontinuity = previous.teleportSequences[previousIndex] !== current.teleportSequences[currentIndex];
  const c = currentIndex * 3;
  if (discontinuity) {
    out.x = current.positions[c];
    out.y = current.positions[c + 1];
    out.z = current.positions[c + 2];
    out.orientation = current.orientations[currentIndex];
    out.hardSnap = true;
    return out;
  }
  const p = previousIndex * 3;
  out.x = lerp(previous.positions[p], current.positions[c], clamped);
  out.y = lerp(previous.positions[p + 1], current.positions[c + 1], clamped);
  out.z = lerp(previous.positions[p + 2], current.positions[c + 2], clamped);
  out.orientation = lerpAngle(previous.orientations[previousIndex], current.orientations[currentIndex], clamped);
  out.hardSnap = false;
  return out;
}
