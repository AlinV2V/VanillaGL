import { updateDynamicAttributePrefix } from './dynamic-attribute-prefix';
import * as THREE from 'three';
import {
  createWeatherParticleMaterial,
  createWeatherQuadGeometry,
  syncWeatherParticleFog,
} from './weather-particle-material';

export type WeatherGroundSampler = (x: number, y: number, fromZ: number) => number | undefined;

type Splash = {
  x: number;
  y: number;
  z: number;
  age: number;
  duration: number;
  size: number;
  frame: number;
  active: boolean;
};

const MAX_SPLASHES = 96;
const SPLASH_RADIUS = 20;
// Keep patter sparse: it is an accent beneath dense rain, not a second particle field.
const SPLASH_RATE = 12;
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Build-5875 Rain::Patter presentation using the original 4x4 splash atlas. */
export class WeatherRainPatter {
  private readonly surface = createWeatherQuadGeometry(MAX_SPLASHES);
  private readonly material = createWeatherParticleMaterial('/weather/rain-splash.png', 0xe9eef1, 0.78);
  private readonly mesh: THREE.Mesh;
  private readonly splashes: Splash[] = Array.from({ length: MAX_SPLASHES }, () => ({
    x: 0, y: 0, z: 0, age: 0, duration: 0, size: 0, frame: 0, active: false,
  }));
  private sampler?: WeatherGroundSampler;
  private spawnBudget = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(this.surface.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 81;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
  }

  setGroundSampler(sampler: WeatherGroundSampler) {
    this.sampler = sampler;
  }

  update(dt: number, camera: THREE.Camera, grade: number, right: THREE.Vector3, up: THREE.Vector3) {
    syncWeatherParticleFog(this.material, this.scene);
    if (grade > 0.001 && this.sampler) {
      this.spawnBudget += SPLASH_RATE * grade * Math.min(dt, 0.05);
      const spawnCount = Math.min(4, Math.floor(this.spawnBudget));
      this.spawnBudget -= spawnCount;
      for (let i = 0; i < spawnCount; i++) this.spawn(camera.position);
    } else {
      this.spawnBudget = 0;
    }

    let output = 0;
    for (const splash of this.splashes) {
      if (!splash.active) continue;
      splash.age += dt;
      if (splash.age >= splash.duration) {
        splash.active = false;
        continue;
      }
      const t = splash.age / splash.duration;
      const alpha = Math.sin(Math.PI * t) * (1 - 0.35 * t);
      const scale = splash.size * (0.72 + 0.35 * t);
      const halfWidth = scale * 0.5;
      const height = scale;
      const cx = splash.x;
      const cy = splash.y;
      const cz = splash.z + 0.025 + height * 0.46;
      const sx = right.x * halfWidth, sy = right.y * halfWidth, sz = right.z * halfWidth;
      const ux = up.x * height * 0.5, uy = up.y * height * 0.5, uz = up.z * height * 0.5;
      const p = output * 12;
      this.surface.positions[(p) + 0] = cx - sx - ux;
this.surface.positions[(p) + 1] = cy - sy - uy;
this.surface.positions[(p) + 2] = cz - sz - uz;
this.surface.positions[(p) + 3] = cx + sx - ux;
this.surface.positions[(p) + 4] = cy + sy - uy;
this.surface.positions[(p) + 5] = cz + sz - uz;
this.surface.positions[(p) + 6] = cx + sx + ux;
this.surface.positions[(p) + 7] = cy + sy + uy;
this.surface.positions[(p) + 8] = cz + sz + uz;
this.surface.positions[(p) + 9] = cx - sx + ux;
this.surface.positions[(p) + 10] = cy - sy + uy;
this.surface.positions[(p) + 11] = cz - sz + uz;
      this.surface.alphas.fill(alpha, output * 4, output * 4 + 4);
      // RainDropSplash01 is a 4x4 set of impact variants. The cells are not in
      // temporal order (rings, crowns and vertical splashes occupy separate rows).
      this.writeFrameUvs(output, splash.frame);
      output++;
    }
    updateDynamicAttributePrefix(this.surface.geometry.attributes.position as THREE.BufferAttribute, output * 4);
    updateDynamicAttributePrefix(this.surface.geometry.attributes.uv as THREE.BufferAttribute, output * 4);
    updateDynamicAttributePrefix(this.surface.geometry.attributes.aAlpha as THREE.BufferAttribute, output * 4);
    this.surface.geometry.setDrawRange(0, output * 6);
  }

  private spawn(center: THREE.Vector3) {
    const angle = rand(0, Math.PI * 2);
    const distance = Math.sqrt(Math.random()) * SPLASH_RADIUS;
    const x = center.x + Math.cos(angle) * distance;
    const y = center.y + Math.sin(angle) * distance;
    const z = this.sampler?.(x, y, center.z + 28);
    if (!Number.isFinite(z)) return;
    const splash = this.splashes.find((candidate) => !candidate.active)
      ?? this.splashes.reduce((oldest, candidate) => candidate.age > oldest.age ? candidate : oldest);
    splash.x = x;
    splash.y = y;
    splash.z = z!;
    splash.age = 0;
    splash.duration = rand(0.28, 0.44);
    splash.size = rand(0.22, 0.46);
    splash.frame = Math.floor(Math.random() * 16);
    splash.active = true;
  }

  private writeFrameUvs(output: number, frame: number) {
    const column = frame & 3;
    const row = frame >> 2;
    const u0 = column * 0.25;
    const u1 = u0 + 0.25;
    const v0 = 1 - (row + 1) * 0.25;
    const v1 = v0 + 0.25;
    this.surface.uvs[(output * 8) + 0] = u0;
this.surface.uvs[(output * 8) + 1] = v0;
this.surface.uvs[(output * 8) + 2] = u1;
this.surface.uvs[(output * 8) + 3] = v0;
this.surface.uvs[(output * 8) + 4] = u1;
this.surface.uvs[(output * 8) + 5] = v1;
this.surface.uvs[(output * 8) + 6] = u0;
this.surface.uvs[(output * 8) + 7] = v1;
  }
}
