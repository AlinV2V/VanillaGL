import { updateDynamicAttributePrefix } from './rendering/dynamic-attribute-prefix';
import * as THREE from 'three';
import { WeatherRainLayer } from './rendering/weather-rain-layer';
import type { WeatherGroundSampler } from './rendering/weather-rain-patter';

export type WeatherRenderState = {
  type: number;
  grade: number;
  soundId: number;
  instant: boolean;
};

const WEATHER_FINE = 0;
const WEATHER_RAIN = 1;
const WEATHER_SNOW = 2;
const WEATHER_STORM = 3;

type Drop = {
  x: number;
  y: number;
  z: number;
  phase: number;
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);
/** Asset conversion utility. */
const makeRainStreakTexture = (): THREE.Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const vertical = ctx.createLinearGradient(0, 0, 0, 64);
  vertical.addColorStop(0, 'rgba(255,255,255,0)');
  vertical.addColorStop(0.45, 'rgba(255,255,255,1)');
  vertical.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, 16, 64);
  const horizontal = ctx.createLinearGradient(0, 0, 16, 0);
  horizontal.addColorStop(0, 'rgba(0,0,0,1)');
  horizontal.addColorStop(0.5, 'rgba(0,0,0,0)');
  horizontal.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = horizontal;
  ctx.fillRect(0, 0, 16, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
};

const WEATHER_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const WEATHER_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  vec4 tex = texture(uMap, vUv);
  float alpha = tex.a * uOpacity;
  if (alpha < 0.01) discard;
  outColor = vec4(uColor * tex.rgb, alpha);
}
`;

export class WeatherRenderer {
  private readonly maxDrops = 900;
  private readonly drops: Drop[] = [];
  // 4 corners per drop billboard, indexed as two triangles.
  private readonly positions = new Float32Array(this.maxDrops * 4 * 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly rainTexture = makeRainStreakTexture();
  private snowTexture: THREE.Texture = this.rainTexture; // swapped once snowflake.png loads
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly rainLayer: WeatherRainLayer;
  private target: WeatherRenderState = { type: WEATHER_FINE, grade: 0, soundId: 0, instant: true };
  private grade = 0;
  private enabled = true;
  private densityScale = 1;
  private exteriorExposure = 1;
  private readonly camRight = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.rainLayer = new WeatherRainLayer(scene);
    for (let i = 0; i < this.maxDrops; i++) this.drops.push({ x: rand(-1, 1), y: rand(-1, 1), z: rand(0, 1), phase: Math.random() * Math.PI * 2 });

    const uvs = new Float32Array(this.maxDrops * 4 * 2);
    const index = new Uint32Array(this.maxDrops * 6);
    for (let i = 0; i < this.maxDrops; i++) {
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const v = i * 4;
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);

    // The authentic 1.12 snow particle (Spells\snowflake2.blp -> bake-weather-textures.ts).
    // Until it loads (or if it 404s) snow falls back to the streak gradient.
    new THREE.TextureLoader().load('/weather/snowflake.png', (tex) => {
      tex.colorSpace = THREE.NoColorSpace;
      this.snowTexture = tex;
    });

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: WEATHER_VERT,
      fragmentShader: WEATHER_FRAG,
      uniforms: {
        uMap: { value: this.rainTexture },
        uColor: { value: new THREE.Color(0xbfd8ff) },
        uOpacity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 80;
    this.mesh.matrixAutoUpdate = false; // positions are written in world space
    scene.add(this.mesh);
  }

  setCvars(useWeatherShaders: number, weatherDensity: number) {
    this.enabled = useWeatherShaders !== 0 && weatherDensity > 0;
    this.densityScale = Math.max(0, Math.min(1, weatherDensity / 3));
    if (!this.enabled) this.geometry.setDrawRange(0, 0);
  }

  setGroundSampler(sampler: WeatherGroundSampler) {
    this.rainLayer.setGroundSampler(sampler);
  }

  setWeather(state: WeatherRenderState) {
    this.target = {
      type: state.type,
      grade: Math.max(0, Math.min(1, state.grade)),
      soundId: state.soundId,
      instant: state.instant,
    };
    if (state.instant) this.grade = this.target.grade;
  }

  /** 1 outdoors, 0 while the camera/player occupies a WMO interior volume. */
  setExteriorExposure(value: number) {
    this.exteriorExposure = Math.max(0, Math.min(1, value));
    if (this.exteriorExposure <= 0) this.geometry.setDrawRange(0, 0);
  }

  update(dt: number, camera: THREE.Camera): number {
    if (this.target.type === WEATHER_FINE || this.target.grade <= 0) {
      this.grade = Math.max(0, this.grade - dt * 0.8);
    } else {
      const rate = this.target.instant ? 1 : 0.18;
      this.grade += (this.target.grade - this.grade) * Math.min(1, dt * rate);
    }

    // The server weather grade owns the sky/fog transition. WeatherDensity is a
    // particle-count quality cvar and must not weaken the world's atmosphere.
    const atmosphereGrade = Math.max(0, Math.min(1, this.grade));
    const particleGrade = this.enabled ? atmosphereGrade * this.densityScale : 0;
    // Keep the storm grade for sky/fog lighting while indoors, but do not draw
    // camera-centered precipitation through WMO roofs and ceilings.
    const precipitationGrade = particleGrade * this.exteriorExposure;
    const rain = this.target.type === WEATHER_RAIN;
    this.rainLayer.update(dt, camera, rain ? precipitationGrade : 0);
    const snow = this.target.type === WEATHER_SNOW;
    if (!snow) {
      this.geometry.setDrawRange(0, 0);
      return atmosphereGrade;
    }
    const count = Math.floor(this.maxDrops * precipitationGrade);
    this.material.uniforms.uOpacity.value = 0.85;
    (this.material.uniforms.uColor.value as THREE.Color).setHex(0xffffff);
    this.material.uniforms.uMap.value = this.snowTexture;
    if (count <= 0) {
      this.geometry.setDrawRange(0, 0);
      return atmosphereGrade;
    }

    const radius = 46;
    const height = 32;
    const bottom = -8;
    const top = bottom + height;
    const speed = 8;
    const halfWidth = 0.14;
    const center = camera.position;

    // Billboard axes from the camera's world matrix (column 0 = right, column 1 = up).
    const e = camera.matrixWorld.elements;
    this.camRight.set(e[0], e[1], e[2]).normalize();
    this.camUp.set(e[4], e[5], e[6]).normalize();
    const rx = this.camRight.x, ry = this.camRight.y, rz = this.camRight.z;
    const snowClock = snow ? performance.now() * 0.0015 : 0;

    let out = 0;
    for (let i = 0; i < count; i++) {
      const drop = this.drops[i];
      drop.z -= (speed * dt) / height;
      if (drop.z < 0) {
        drop.x = rand(-1, 1);
        drop.y = rand(-1, 1);
        drop.z += 1;
        drop.phase = Math.random() * Math.PI * 2;
      }

      const sway = snow ? Math.sin(snowClock + drop.phase) * 1.6 : 0;
      const x = center.x + drop.x * radius + sway;
      const y = center.y + drop.y * radius + sway * 0.35;
      const z = center.z + bottom + drop.z * (top - bottom);

      // Camera-facing square flake.
      const ux = this.camUp.x * halfWidth, uy = this.camUp.y * halfWidth, uz = this.camUp.z * halfWidth;
      const sx = rx * halfWidth, sy = ry * halfWidth, sz = rz * halfWidth;
      this.positions[out++] = x - sx - ux; this.positions[out++] = y - sy - uy; this.positions[out++] = z - sz - uz;
      this.positions[out++] = x + sx - ux; this.positions[out++] = y + sy - uy; this.positions[out++] = z + sz - uz;
      this.positions[out++] = x + sx + ux; this.positions[out++] = y + sy + uy; this.positions[out++] = z + sz + uz;
      this.positions[out++] = x - sx + ux; this.positions[out++] = y - sy + uy; this.positions[out++] = z - sz + uz;
    }

    updateDynamicAttributePrefix(this.geometry.attributes.position as THREE.BufferAttribute, count * 4);
    this.geometry.setDrawRange(0, count * 6);
    return atmosphereGrade;
  }
}
