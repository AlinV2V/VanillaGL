import { updateDynamicAttributePrefix } from './dynamic-attribute-prefix';
import * as THREE from 'three';
import {
  createWeatherParticleMaterial,
  createWeatherQuadGeometry,
  syncWeatherParticleFog,
} from './weather-particle-material';
import { WeatherRainPatter, type WeatherGroundSampler } from './weather-rain-patter';

type RainDrop = { x: number; y: number; z: number; alpha: number };
type MistParticle = { x: number; y: number; z: number; size: number; phase: number };

// The native Rain packet holds triangles in 0x1800-entry batches. Two thousand
// pooled quads provide the same dense field without per-drop scene objects.
export const MAX_RAIN_DROPS = 2048;
export const MAX_RAIN_MISTS = 128;
const RAIN_RADIUS = 44;
const RAIN_HEIGHT = 25;
const RAIN_BOTTOM = -7;
const RAIN_SPEED = 30;
const RAIN_TRAIL_SECONDS = 0.078;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const smoothstep = (start: number, end: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
};

/** Layered Build-5875 rain: Drop packets, Patter splashes, and 128 SnowMist particles. */
export class WeatherRainLayer {
  private readonly rain = createWeatherQuadGeometry(MAX_RAIN_DROPS);
  // RainDrop01 already carries the authored grey-blue values. A second 0x808080
  // modulation made the post-gamma result read as black streaks in daylight.
  private readonly rainMaterial = createWeatherParticleMaterial('/weather/rain-drop.png', 0xe8f0f5, 0.82);
  private readonly rainMesh: THREE.Mesh;
  private readonly mist = createWeatherQuadGeometry(MAX_RAIN_MISTS);
  private readonly mistMaterial = createWeatherParticleMaterial(
    '/weather/rain-mist.png', 0xc5cdd2, 0.52, { depthTest: false, fogFade: false },
  );
  private readonly mistMesh: THREE.Mesh;
  private readonly patter: WeatherRainPatter;
  private readonly drops: RainDrop[] = Array.from({ length: MAX_RAIN_DROPS }, () => ({
    x: Number.NaN, y: Number.NaN, z: Number.NaN, alpha: rand(0.62, 1),
  }));
  private readonly mists: MistParticle[] = Array.from({ length: MAX_RAIN_MISTS }, () => ({
    x: rand(-1, 1), y: rand(-1, 1), z: rand(0, 1), size: rand(4.5, 8.5), phase: rand(0, Math.PI * 2),
  }));
  private readonly cameraRight = new THREE.Vector3();
  private readonly cameraUp = new THREE.Vector3();
  private readonly cameraVelocity = new THREE.Vector3();
  private readonly previousCamera = new THREE.Vector3();
  private readonly rainVelocity = new THREE.Vector3(-1.1, 0.45, -RAIN_SPEED);
  private readonly relativeVelocity = new THREE.Vector3();
  private readonly trail = new THREE.Vector3();
  private cameraInitialized = false;
  private clock = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.rainMesh = new THREE.Mesh(this.rain.geometry, this.rainMaterial);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 80;
    this.rainMesh.matrixAutoUpdate = false;
    scene.add(this.rainMesh);

    this.mistMesh = new THREE.Mesh(this.mist.geometry, this.mistMaterial);
    this.mistMesh.frustumCulled = false;
    this.mistMesh.renderOrder = 79;
    this.mistMesh.matrixAutoUpdate = false;
    scene.add(this.mistMesh);
    this.patter = new WeatherRainPatter(scene);
  }

  setGroundSampler(sampler: WeatherGroundSampler) {
    this.patter.setGroundSampler(sampler);
  }

  update(dt: number, camera: THREE.Camera, grade: number) {
    this.clock += dt;
    this.updateCameraBasis(camera, dt);
    this.patter.update(dt, camera, grade, this.cameraRight, this.cameraUp);
    if (grade <= 0.001) {
      this.rain.geometry.setDrawRange(0, 0);
      this.mist.geometry.setDrawRange(0, 0);
      return;
    }
    syncWeatherParticleFog(this.rainMaterial, this.scene);
    this.updateRain(dt, camera.position, grade);
    this.updateMist(camera.position, grade);
  }

  private updateCameraBasis(camera: THREE.Camera, dt: number) {
    const e = camera.matrixWorld.elements;
    this.cameraRight.set(e[0], e[1], e[2]).normalize();
    this.cameraUp.set(e[4], e[5], e[6]).normalize();
    if (!this.cameraInitialized || dt <= 0 || dt > 0.2) {
      this.previousCamera.copy(camera.position);
      this.cameraVelocity.set(0, 0, 0);
      this.cameraInitialized = true;
      return;
    }
    const distance = this.previousCamera.distanceTo(camera.position);
    if (distance > 20) {
      this.cameraVelocity.set(0, 0, 0);
    } else {
      this.relativeVelocity.copy(camera.position).sub(this.previousCamera).divideScalar(dt).clampLength(0, 18);
      this.cameraVelocity.lerp(this.relativeVelocity, 1 - Math.exp(-8 * dt));
    }
    this.previousCamera.copy(camera.position);
  }

  private updateRain(dt: number, center: THREE.Vector3, grade: number) {
    const count = Math.floor(MAX_RAIN_DROPS * Math.max(0, Math.min(1, grade)));
    this.relativeVelocity.copy(this.rainVelocity).sub(this.cameraVelocity);
    this.trail.copy(this.relativeVelocity).multiplyScalar(-RAIN_TRAIL_SECONDS);
    const right = this.cameraRight;
    let output = 0;
    for (let i = 0; i < count; i++) {
      const drop = this.drops[i];
      if (!Number.isFinite(drop.x)) this.resetDrop(drop, center, false);
      drop.x += this.rainVelocity.x * dt;
      drop.y += this.rainVelocity.y * dt;
      drop.z += this.rainVelocity.z * dt;
      const dx = drop.x - center.x;
      const dy = drop.y - center.y;
      const distanceSquared = dx * dx + dy * dy;
      if (drop.z < center.z + RAIN_BOTTOM || distanceSquared > RAIN_RADIUS * RAIN_RADIUS) {
        this.resetDrop(drop, center, true);
      }
      const distance = Math.sqrt(distanceSquared);
      const distanceAlpha = 1 - smoothstep(RAIN_RADIUS * 0.66, RAIN_RADIUS, distance);
      const halfWidth = 0.032;
      const sx = right.x * halfWidth, sy = right.y * halfWidth, sz = right.z * halfWidth;
      const tx = drop.x + this.trail.x, ty = drop.y + this.trail.y, tz = drop.z + this.trail.z;
      this.rain.positions[(output * 12) + 0] = drop.x - sx;
      this.rain.positions[(output * 12) + 1] = drop.y - sy;
      this.rain.positions[(output * 12) + 2] = drop.z - sz;
      this.rain.positions[(output * 12) + 3] = drop.x + sx;
      this.rain.positions[(output * 12) + 4] = drop.y + sy;
      this.rain.positions[(output * 12) + 5] = drop.z + sz;
      this.rain.positions[(output * 12) + 6] = tx + sx;
      this.rain.positions[(output * 12) + 7] = ty + sy;
      this.rain.positions[(output * 12) + 8] = tz + sz;
      this.rain.positions[(output * 12) + 9] = tx - sx;
      this.rain.positions[(output * 12) + 10] = ty - sy;
      this.rain.positions[(output * 12) + 11] = tz - sz;
      this.rain.alphas.fill(drop.alpha * distanceAlpha, output * 4, output * 4 + 4);
      output++;
    }
    updateDynamicAttributePrefix(this.rain.geometry.attributes.position as THREE.BufferAttribute, output * 4);
    updateDynamicAttributePrefix(this.rain.geometry.attributes.aAlpha as THREE.BufferAttribute, output * 4);
    this.rain.geometry.setDrawRange(0, output * 6);
  }

  private resetDrop(drop: RainDrop, center: THREE.Vector3, atTop: boolean) {
    const angle = rand(0, Math.PI * 2);
    const distance = Math.sqrt(Math.random()) * RAIN_RADIUS;
    drop.x = center.x + Math.cos(angle) * distance;
    drop.y = center.y + Math.sin(angle) * distance;
    drop.z = center.z + RAIN_BOTTOM + (atTop ? RAIN_HEIGHT : Math.random() * RAIN_HEIGHT);
    drop.alpha = rand(0.62, 1);
  }

  private updateMist(center: THREE.Vector3, grade: number) {
    const count = Math.floor(MAX_RAIN_MISTS * Math.max(0, Math.min(1, grade)));
    if (this.scene.fog instanceof THREE.Fog) {
      (this.mistMaterial.uniforms.uColor.value as THREE.Color).copy(this.scene.fog.color).lerp(new THREE.Color(0xc5cdd2), 0.55);
    }
    const right = this.cameraRight;
    const up = this.cameraUp;
    for (let i = 0; i < count; i++) {
      const mist = this.mists[i];
      const drift = Math.sin(this.clock * 0.32 + mist.phase);
      const x = center.x + mist.x * 22 + drift * 1.2;
      const y = center.y + mist.y * 22 + Math.cos(this.clock * 0.27 + mist.phase) * 0.8;
      const z = center.z - 5 + mist.z * RAIN_HEIGHT;
      const half = mist.size * 0.5;
      const sx = right.x * half, sy = right.y * half, sz = right.z * half;
      const ux = up.x * half, uy = up.y * half, uz = up.z * half;
      this.mist.positions[(i * 12) + 0] = x - sx - ux;
      this.mist.positions[(i * 12) + 1] = y - sy - uy;
      this.mist.positions[(i * 12) + 2] = z - sz - uz;
      this.mist.positions[(i * 12) + 3] = x + sx - ux;
      this.mist.positions[(i * 12) + 4] = y + sy - uy;
      this.mist.positions[(i * 12) + 5] = z + sz - uz;
      this.mist.positions[(i * 12) + 6] = x + sx + ux;
      this.mist.positions[(i * 12) + 7] = y + sy + uy;
      this.mist.positions[(i * 12) + 8] = z + sz + uz;
      this.mist.positions[(i * 12) + 9] = x - sx + ux;
      this.mist.positions[(i * 12) + 10] = y - sy + uy;
      this.mist.positions[(i * 12) + 11] = z - sz + uz;
      const radial = Math.sqrt(mist.x * mist.x + mist.y * mist.y);
      const alpha = (1 - smoothstep(0.72, 1.3, radial)) * (0.5 + 0.25 * Math.sin(this.clock * 0.2 + mist.phase));
      this.mist.alphas.fill(alpha, i * 4, i * 4 + 4);
    }
    updateDynamicAttributePrefix(this.mist.geometry.attributes.position as THREE.BufferAttribute, count * 4);
    updateDynamicAttributePrefix(this.mist.geometry.attributes.aAlpha as THREE.BufferAttribute, count * 4);
    this.mist.geometry.setDrawRange(0, count * 6);
  }
}
