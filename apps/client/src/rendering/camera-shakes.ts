import * as THREE from 'three';
/** Asset conversion utility. */
export interface CameraShakeComponent {
  id: number;
  shakeType: number;
  direction: number;
  amplitude: number;
  frequency: number;
  duration: number;
  phase: number;
  coefficient: number;
}

type ActiveCameraShake = {
  component: CameraShakeComponent;
  source: THREE.Vector3;
  startedAtMs: number;
};

type DirectionWinner = {
  component: CameraShakeComponent;
  amplitude: number;
  elapsed: number;
};

export const CAMERA_SHAKE_AMPLITUDE_SCALE = 1 / 36;
export const CAMERA_SHAKE_INNER_RADIUS = 9;
export const CAMERA_SHAKE_OUTER_RADIUS = 80;
export const CAMERA_SHAKE_ATTENUATION_BASE = 0.7;

const INNER_RADIUS_SQ = CAMERA_SHAKE_INNER_RADIUS * CAMERA_SHAKE_INNER_RADIUS;
const OUTER_RADIUS_SQ = CAMERA_SHAKE_OUTER_RADIUS * CAMERA_SHAKE_OUTER_RADIUS;
const TWO_PI = Math.PI * 2;

/**
 * Byte-faithful Build 5875 camera-shake sampler.
 *
 * Components remain independent active records. At sample time the original client chooses the
 * strongest distance-attenuated amplitude for each of its three directions; it does not sum every
 * active record. Equal-amplitude ties prefer the newest record because the client inserts new
 * AUCameraShake nodes at the front of its list.
 */
export class CameraShakeSampler {
  private readonly active: ActiveCameraShake[] = [];

  get activeCount() {
    return this.active.length;
  }

  add(components: readonly CameraShakeComponent[], source: THREE.Vector3, startedAtMs = performance.now()) {
    for (const component of components) {
      if (
        component.direction < 0
        || component.direction > 2
        || component.duration <= 0
        || !Number.isFinite(component.amplitude)
        || !Number.isFinite(component.frequency)
        || !Number.isFinite(component.duration)
        || !Number.isFinite(component.phase)
        || !Number.isFinite(component.coefficient)
      ) continue;
      this.active.push({ component, source: source.clone(), startedAtMs });
    }
  }

  clear() {
    this.active.length = 0;
  }

  sample(
    cameraPosition: THREE.Vector3,
    cameraForward: THREE.Vector3,
    nowMs = performance.now(),
    out = new THREE.Vector3(),
  ) {
    out.set(0, 0, 0);
    const winners: Array<DirectionWinner | undefined> = [undefined, undefined, undefined];

    // Newest-to-oldest matches the original intrusive-list order and its strict amplitude compare.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const active = this.active[i];
      const component = active.component;
      const elapsed = (nowMs - active.startedAtMs) * 0.001 + component.phase;
      if (elapsed >= component.duration) {
        this.active.splice(i, 1);
        continue;
      }

      const dx = cameraPosition.x - active.source.x;
      const dy = cameraPosition.y - active.source.y;
      const dz = cameraPosition.z - active.source.z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq > OUTER_RADIUS_SQ) continue;

      let amplitude = component.amplitude * CAMERA_SHAKE_AMPLITUDE_SCALE;
      if (distanceSq > INNER_RADIUS_SQ) {
        const distance = Math.sqrt(distanceSq);
        amplitude *= Math.pow(
          CAMERA_SHAKE_ATTENUATION_BASE,
          (distance - CAMERA_SHAKE_INNER_RADIUS) / CAMERA_SHAKE_INNER_RADIUS,
        );
      }

      const current = winners[component.direction];
      if (!current || current.amplitude < amplitude) {
        winners[component.direction] = { component, amplitude, elapsed };
      }
    }

    let forwardX = cameraForward.x;
    let forwardY = cameraForward.y;
    const horizontalLength = Math.hypot(forwardX, forwardY);
    if (horizontalLength > 1e-6) {
      forwardX /= horizontalLength;
      forwardY /= horizontalLength;
    } else {
      forwardX = 1;
      forwardY = 0;
    }

    for (let direction = 0; direction < winners.length; direction++) {
      const winner = winners[direction];
      if (!winner) continue;
      const { component, amplitude, elapsed } = winner;
      let displacement = Math.sin(elapsed * component.frequency * TWO_PI) * amplitude;
      if (component.shakeType === 1) {
        displacement *= Math.exp(-elapsed * component.coefficient);
      }
      if (direction === 0) {
        out.x += forwardX * displacement;
        out.y += forwardY * displacement;
      } else if (direction === 1) {
        out.x -= forwardY * displacement;
        out.y += forwardX * displacement;
      } else {
        out.z += displacement;
      }
    }

    return out;
  }
}
