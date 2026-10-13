import * as THREE from 'three';
import { texturePayloadBytes } from './rendering/texture-upload-admission';
/** Asset conversion utility. */
const FRAME_RATE = 15;
const FRAME_COUNT = 30;
const MAX_FRAME_DIMENSION = 512;
const MAX_WATER_FRAME_TEXTURES = 4 * FRAME_COUNT;
const MAX_WATER_FRAME_GPU_BYTES = MAX_WATER_FRAME_TEXTURES * MAX_FRAME_DIMENSION * MAX_FRAME_DIMENSION * 4 * 4 / 3;

type LiquidConfig = {
  dir: string;
  base: string;
  transparent: boolean;
  depthWrite: boolean;
  typeUniform: number;
};

const LIQUIDS: Record<number, LiquidConfig> = {
  1: { dir: 'river', base: 'lake_a', transparent: true, depthWrite: false, typeUniform: 1 },
  2: { dir: 'ocean', base: 'ocean_h', transparent: true, depthWrite: false, typeUniform: 2 },
  3: { dir: 'lava', base: 'lava', transparent: false, depthWrite: true, typeUniform: 3 },
  4: { dir: 'slime', base: 'slime', transparent: false, depthWrite: true, typeUniform: 4 },
};

const loader = new THREE.TextureLoader();
type LiquidFrames = {
  config: LiquidConfig;
  textures: Array<THREE.Texture | undefined>;
  retryAt: Float64Array;
  failures: Uint8Array;
};
const textureCache = new Map<string, LiquidFrames>();
const materialCache = new Map<number, THREE.ShaderMaterial>();
const shared = { time: 0 };
// Day/night scene light applied to every water surface so liquid darkens at night like the rest of the
// world (a flat up-facing surface gets sky ambient + sun). Driven from applyLighting via updateWaterLight.
const sharedDayLight = { value: new THREE.Vector3(1, 1, 1) };
const sharedFogColor = { value: new THREE.Vector3(0.56, 0.72, 0.88) };
const sharedFogNear = { value: 480 };
const sharedFogFar = { value: 1280 };
const neutralFrame = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); neutralFrame.needsUpdate = true;
let requestedFrames = 0, loadedFrames = 0, failedFrames = 0, rejectedFrames = 0;
let waterFrameGpuBytes = 0, peakWaterFrameGpuBytes = 0;

const configureTexture = (tex: THREE.Texture): THREE.Texture => {
  if ('colorSpace' in tex) (tex as { colorSpace: string }).colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = (tex as THREE.Texture & { isCompressedTexture?: boolean }).isCompressedTexture !== true;
  return tex;
};

const requestFrame = (frames: LiquidFrames, index: number): THREE.Texture => {
  const normalized = ((index % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
  let texture = frames.textures[normalized];
  if (!texture) {
    if (performance.now() < frames.retryAt[normalized]) return frames.textures.find(Boolean) ?? neutralFrame;
    const frame = normalized + 1;
    const url = `/XTextures/${frames.config.dir}/${frames.config.base}.${frame}.png`;
    requestedFrames++;
    texture = configureTexture(loader.load(url, (loaded) => {
      if (frames.textures[normalized] !== loaded) { loaded.dispose(); return; }
      const image = loaded.image as { width?: number; height?: number } | undefined;
      const width = Number(image?.width ?? 0), height = Number(image?.height ?? 0);
      const payload = texturePayloadBytes(loaded);
      const gpuBytes = Math.ceil(payload * (loaded.generateMipmaps ? 4 / 3 : 1));
      if (width > MAX_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION || waterFrameGpuBytes + gpuBytes > MAX_WATER_FRAME_GPU_BYTES) {
        frames.textures[normalized] = undefined; frames.retryAt[normalized] = Number.POSITIVE_INFINITY;
        rejectedFrames++; loaded.dispose(); return;
      }
      loadedFrames++; waterFrameGpuBytes += gpuBytes;
      peakWaterFrameGpuBytes = Math.max(peakWaterFrameGpuBytes, waterFrameGpuBytes);
      frames.failures[normalized] = 0;
    }, undefined, () => {
      if (frames.textures[normalized] === texture) frames.textures[normalized] = undefined;
      texture?.dispose(); failedFrames++;
      const failures = Math.min(8, ++frames.failures[normalized]);
      frames.retryAt[normalized] = performance.now() + Math.min(30_000, 500 * 2 ** (failures - 1));
    }));
    frames.textures[normalized] = texture;
  }
  return texture;
};

const getFrames = (cfg: LiquidConfig): LiquidFrames => {
  const key = `${cfg.dir}/${cfg.base}`;
  const cached = textureCache.get(key);
  if (cached) return cached;
  const frames: LiquidFrames = { config: cfg, textures: new Array(FRAME_COUNT), retryAt: new Float64Array(FRAME_COUNT), failures: new Uint8Array(FRAME_COUNT) };
  textureCache.set(key, frames);
  return frames;
};

const VERT = /* glsl */ `
in float waterDepth;
out vec2 vUv1;
out vec2 vUv2;
out float vDepth;
out float vFog;
uniform float uTime;
uniform int uLiquidType;
uniform float uFogNear;
uniform float uFogFar;

void main() {
  vDepth = waterDepth;

  if (uLiquidType == 3 || uLiquidType == 4) {
    vUv1 = uv + vec2(uTime * 0.06, 0.0);
    vUv2 = vUv1;
  } else {
    vUv1 = uv + vec2(0.08, 0.08) * uTime;
    vUv2 = uv + vec2(-0.05, 0.08) * uTime;
  }

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  float fogDepth = max(0.0, -mvPosition.z);
  vFog = clamp((fogDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv1;
in vec2 vUv2;
in float vDepth;
in float vFog;
out vec4 outColor;
uniform sampler2D tFrame0;
uniform sampler2D tFrame1;
uniform float uFrameBlend;
uniform int uLiquidType;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uDayLight;
uniform vec3 uFogColor;

void main() {
  vec4 f0a = texture(tFrame0, vUv1);
  vec4 f1a = texture(tFrame1, vUv1);
  vec4 texA = mix(f0a, f1a, uFrameBlend);

  if (uLiquidType == 1 || uLiquidType == 2) {
    // The river/ocean XTextures are near-black caustic SPARKLE overlays (avg rgb ~3/255), not the
    // full water surface. Vanilla composites them on top of a flat liquid tint, so we do the same:
    // a depth-deepened base color carries the water's blue, the animated caustics ride on top as the
    // bright shimmer/foam. Two crossing UV samples keep the sparkle directionless.
    vec4 f0b = texture(tFrame0, vUv2);
    vec4 f1b = texture(tFrame1, vUv2);
    vec4 texB = mix(f0b, f1b, uFrameBlend);
    vec3 sparkle = (texA.rgb + texB.rgb) * 0.5;
    vec3 base = mix(uShallow, uDeep, clamp(vDepth * 1.5, 0.0, 1.0));
    vec3 c = (base + sparkle * 1.7) * uDayLight;
    // The baked MCLQ depth grid reads near-zero across whole river spans (measured
    // mean 0.04-0.11 on the StartingZone_01 streams, with large interior areas at exactly
    // 0), so a pure depth fade renders rivers invisible. Until the depth bake is
    // fixed, water needs an alpha FLOOR: visibly present in the shallows, deepening
    // with what depth data there is.
    float alpha = mix(0.42, 0.75, clamp(vDepth * 1.5, 0.0, 1.0));
    c = mix(c, uFogColor, vFog * alpha);
    outColor = vec4(c, alpha);
  } else {
    // Lava (3) and slime (4) are self-lit (emissive) — they stay bright at night, no day/night modulation.
    vec3 c = mix(texA.rgb, uFogColor, vFog);
    outColor = vec4(c, 1.0);
  }
}
`;

const updateMaterialFrame = (material: THREE.ShaderMaterial, frames: LiquidFrames): void => {
  const f = shared.time * FRAME_RATE;
  const frame0 = Math.floor(f) % FRAME_COUNT;
  const frame1 = (frame0 + 1) % FRAME_COUNT;
  material.uniforms.tFrame0.value = requestFrame(frames, frame0);
  material.uniforms.tFrame1.value = requestFrame(frames, frame1);
  // Keep one frame ahead without issuing the old 30-request first-use burst. At 15 Hz this admits
  // at most one new image per animation step after the three-frame initial working set.
  requestFrame(frames, frame1 + 1);
  material.uniforms.uFrameBlend.value = f - Math.floor(f);
  material.uniforms.uTime.value = shared.time;
};

/**
 * Feed the resolved day/night light into every water surface. A liquid surface faces up, so it gets
 * the sky ambient plus the sun contribution for an up-facing normal (sunDir ~ -0.69 on Z). This makes
 * water track the world's lighting — bright blue at noon, dark and muted at night.
 */
export function updateWaterLight(light: {
  ambient: readonly number[];
  sunColor: readonly number[];
  fogColor: readonly number[];
  fogNear: number;
  fogFar: number;
}): void {
  const a = light.ambient;
  const s = light.sunColor;
  sharedDayLight.value.set(
    Math.min(a[0] + s[0] * 0.69, 1.3),
    Math.min(a[1] + s[1] * 0.69, 1.3),
    Math.min(a[2] + s[2] * 0.69, 1.3),
  );
  sharedFogColor.value.set(light.fogColor[0] ?? 0.56, light.fogColor[1] ?? 0.72, light.fogColor[2] ?? 0.88);
  sharedFogNear.value = light.fogNear;
  sharedFogFar.value = light.fogFar;
}

export function updateWaterTime(dt: number): void {
  shared.time += dt;
  for (const [type, material] of materialCache) {
    const frames = getFrames(LIQUIDS[type] ?? LIQUIDS[1]);
    updateMaterialFrame(material, frames);
  }
}

/** Fixed Vanilla corpus: at most four 30-frame sequences, permanently pinned and explicitly budgeted. */
export const waterFrameTextureDiagnostics = () => ({
  requestedFrames, loadedFrames, failedFrames, rejectedFrames,
  residentTextures: [...textureCache.values()].reduce((sum, frames) => sum + frames.textures.filter(Boolean).length, 0),
  gpuEstimatedBytes: waterFrameGpuBytes,
  peakGpuEstimatedBytes: peakWaterFrameGpuBytes,
  maxTextures: MAX_WATER_FRAME_TEXTURES,
  maxGpuEstimatedBytes: MAX_WATER_FRAME_GPU_BYTES,
});

export function createWaterMaterial(type: number): THREE.ShaderMaterial {
  const normalizedType = type === 2 || type === 3 || type === 4 ? type : 1;
  const existing = materialCache.get(normalizedType);
  if (existing) return existing;

  const cfg = LIQUIDS[normalizedType] ?? LIQUIDS[1];
  const frames = getFrames(cfg);
  // Flat liquid tint the caustic sparkles ride on (river vs ocean). Lava/slime ignore these (opaque texture).
  const shallow = normalizedType === 2 ? [0.16, 0.40, 0.50] : [0.22, 0.42, 0.45];
  const deep = normalizedType === 2 ? [0.04, 0.16, 0.31] : [0.06, 0.20, 0.28];
  const initialFrame = Math.floor(shared.time * FRAME_RATE) % FRAME_COUNT;
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      tFrame0: { value: requestFrame(frames, initialFrame) },
      tFrame1: { value: requestFrame(frames, initialFrame + 1) },
      uFrameBlend: { value: 0 },
      uTime: { value: shared.time },
      uLiquidType: { value: cfg.typeUniform },
      uShallow: { value: new THREE.Vector3(...shallow) },
      uDeep: { value: new THREE.Vector3(...deep) },
      uDayLight: sharedDayLight,
      uFogColor: sharedFogColor,
      uFogNear: sharedFogNear,
      uFogFar: sharedFogFar,
    },
    transparent: cfg.transparent,
    depthWrite: cfg.depthWrite,
    side: THREE.DoubleSide,
  });
  // One material/animated texture set is cached per liquid type and shared by
  // every loaded tile. Tile pruning must release only the mesh geometry.
  material.userData.wowSharedMaterial = true;
  materialCache.set(normalizedType, material);
  updateMaterialFrame(material, frames);
  return material;
}
