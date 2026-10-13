import * as THREE from 'three';
import { xrIntersectsSphere } from './xr-view-state';
import type { SpellModelAsset } from '../spell-visuals';

const maxAbs = (values: readonly number[], fallback = 0): number => {
  let value = Math.abs(fallback);
  for (const key of values) value = Math.max(value, Math.abs(key));
  return value;
};

/** Conservative reach of the implemented emitter, including every authored bone/particle track. */
export function environmentEffectRadius(asset: SpellModelAsset, scale: number): number {
  if (asset.geometry || !Number.isFinite(scale)) return Infinity;
  const bones = asset.animation?.bones ?? [], bounds: { radius: number; scale: number }[] = [];
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    if (bone.parentIndex >= i || [bone.translation, bone.rotation, bone.scale].some((t) => t.interpolation > 1)) return Infinity;
    // Billboard rotations may replace ancestor orientation; keep these on the full-rate path.
    if (bone.flags & 0x78) return Infinity;
    const parent = bone.parentIndex >= 0 ? bounds[bone.parentIndex] : { radius: 0, scale: 1 };
    if (!parent) return Infinity;
    const stretch = maxAbs(bone.scale.values, 1), translation = Math.sqrt(3) * maxAbs(bone.translation.values);
    const pivot = Math.hypot(...bone.pivot);
    bounds.push({ radius: parent.radius + parent.scale * (pivot * (1 + stretch) + translation), scale: parent.scale * stretch });
  }
  const originReach = (bone: number, position: number[], area = 0) => {
    const transform = bounds[bone] ?? { radius: 0, scale: 1 };
    return Math.abs(scale) * (transform.radius + transform.scale * (Math.hypot(...position) + area));
  };
  let radius = 0;
  for (const particle of asset.particles) {
    if (particle.tracks?.some((track) => track.interpolation > 1)) return Infinity;
    const bound = (index: number, fallback: number) => maxAbs(particle.tracks?.[index]?.values ?? [], fallback);
    const life = Math.max(0.05, bound(5, particle.life));
    const speed = bound(0, particle.speed) * (1 + bound(1, particle.speedVar));
    const gravity = bound(4, particle.gravity);
    const area = Math.hypot(bound(7, particle.areaL), bound(8, particle.areaW)) / 2;
    const size = maxAbs(particle.scales ?? [0.55, 0.55, 0]) * Math.abs(scale) * Math.SQRT1_2;
    // Semi-implicit integration can advance up to one bounded step beyond the analytic g*t²/2.
    radius = Math.max(radius, originReach(particle.bone, particle.pos, area) + speed * life + gravity * life * (life + 0.1) + size);
  }
  for (const ribbon of asset.ribbons) {
    radius = Math.max(radius, originReach(ribbon.bone, ribbon.pos)
      + Math.max(Math.abs(ribbon.above || 0.15), Math.abs(ribbon.below || 0.15)) * Math.abs(scale));
  }
  return Number.isFinite(radius) ? radius + 2 : Infinity;
}

/** Offscreen persistent effects tick at 10Hz; visible effects resume immediately with elapsed time. */
export class EnvironmentEffectBudget {
  private readonly frustum = new THREE.Frustum();
  private readonly matrix = new THREE.Matrix4();
  private ready = false;
  private serial = 0;
  skipped = 0; sampled = 0;
  constructor(private readonly enabled = true) {}
  prepare(camera: THREE.PerspectiveCamera) {
    camera.updateWorldMatrix(true, false);
    this.frustum.setFromProjectionMatrix(this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.ready = true;
  }
  admission(position: THREE.Vector3, radius: number): (elapsed: number) => number | null {
    const sphere = new THREE.Sphere(position, radius);
    let pending = 0, countdown = (++this.serial % 6) / 60;
    return (elapsed) => {
      pending += elapsed; countdown -= elapsed;
      const visible = !this.enabled || !this.ready || !Number.isFinite(radius) || xrIntersectsSphere(sphere, this.frustum);
      if (!visible && countdown > 0) { this.skipped++; return null; }
      const step = pending; pending = 0; countdown = 0.1; this.sampled++; return step;
    };
  }
}
