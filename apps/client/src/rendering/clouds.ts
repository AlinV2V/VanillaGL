import * as THREE from 'three';
import type { RGB } from './lighting-utils';
/** Asset conversion utility. */
const VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Baked cloud pattern: the legacy fragment shader evaluated 5-octave
// value-noise FBM per pixel (~20 sin() hashes + interpolation per visible
// cloud fragment), a cost that scales with pixel count and hurts tile-based
// and integrated GPUs. The SAME math is evaluated ONCE here at layer creation
// into a small tileable texture; the fragment shader then performs a single
// filtered sample. Sampling density is derived, not guessed: every octave
// gets >= 2 texels per noise cell (see CLOUD_TEXELS_PER_CELL), so the full
// 5-octave spectrum — including the highest-frequency breakup detail — is
// representable instead of baked into aliased mush. Output distribution and
// feature scale match, so the coverage curve below responds identically; only
// the pattern repeats (every ~6 dome units, mirrored to ~12, horizon-faded).
// ---------------------------------------------------------------------------

/**
 * Pattern texel edge length. 512x512 R8 + mips ≈ 341 KiB GPU — small next to
 * any world tile, and the price of giving every octave >= 2 texels per cell.
 */
export const CLOUD_PATTERN_SIZE = 512;
/**
 * Value-noise lattice cells across the tile at octave 0 (doubles per octave).
 * 16 cells over 512 texels = 32 texels/cell at octave 0 down to 2 texels/cell
 * at octave 4 (see CLOUD_TEXELS_PER_CELL). A smaller domain was measured to
 * cost repetition without adding fidelity; a larger texture at the same ratio
 * costs 4x memory/bake time for zero measured gain.
 */
export const CLOUD_BASE_PERIOD = 16;
/** Texels per noise cell per octave, highest octave last. All must stay >= 2. */
export const CLOUD_TEXELS_PER_CELL: readonly number[] = [32, 16, 8, 4, 2];
/**
 * Dome-plane units per texture tile. Chosen so the baked octave-0 cell
 * (tile / 16) equals the legacy octave-0 cell (1 / 2.6 dome units), keeping
 * established cloud feature sizes. 2.6 / 16 = 0.1625.
 */
export const CLOUD_TEX_SCALE = 2.6 / 16;
/**
 * Base lattice offset. Arbitrary phase constants — but not freely so: octave 0
 * carries ~52% of the signal, so its frozen layout dominates tile balance.
 * These values were selected by measurement (quadrant coverage spread 0.034,
 * inside the legacy field's own natural 0.05-0.09 range) and are pinned by
 * the regression gate; do not "clean them up" to round numbers.
 */
const CLOUD_BASE_OFFSET_X = 21.4;
const CLOUD_BASE_OFFSET_Y = 9.7;

const cloudFract = (x: number): number => x - Math.floor(x);
/**
 * Legacy GLSL hash ported exactly (`fract(sin(dot) * 43758.5453)`).
 * Float64 Math.sin differs from mediump/highp GPU sin in exact bits but not
 * in statistics — and the coverage curve only ever sees the distribution.
 * Lattice coordinates wrap modulo the octave period so the tile is seamless.
 */
const cloudHash = (ix: number, iy: number, period: number): number => {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  return cloudFract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
};
const cloudSmooth = (t: number): number => t * t * (3 - 2 * t);
const cloudNoise = (x: number, y: number, period: number): number => {
  const ix = Math.floor(x), iy = Math.floor(y);
  const ux = cloudSmooth(x - ix), uy = cloudSmooth(y - iy);
  const a = cloudHash(ix, iy, period);
  const b = cloudHash(ix + 1, iy, period);
  const c = cloudHash(ix, iy + 1, period);
  const d = cloudHash(ix + 1, iy + 1, period);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
};

/**
 * Evaluate the legacy 5-octave FBM into a tileable 8-bit pattern.
 * Deterministic: same bytes on every boot, every machine.
 * NOTE: size and base period must travel together — bakeCloudPattern(size)
 * with a non-default size only preserves the spectrum if size / 16 keeps
 * every octave >= 2 texels per cell. The gate enforces the shipped pair.
 */
export function bakeCloudPattern(size: number = CLOUD_PATTERN_SIZE): Uint8Array {
  const out = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let v = 0, amp = 0.5;
      for (let o = 0; o < CLOUD_TEXELS_PER_CELL.length; o++) {
        const period = CLOUD_BASE_PERIOD * (1 << o);
        // Base offset re-rolls octave 0's frozen layout (see
        // CLOUD_BASE_OFFSET_*); per-octave steps decorrelate the octaves
        // (legacy added +7.3 in scaled space each iteration).
        const x = ((i + 0.5) / size) * period + CLOUD_BASE_OFFSET_X + o * 7.3;
        const y = ((j + 0.5) / size) * period + CLOUD_BASE_OFFSET_Y + o * 3.7;
        v += amp * cloudNoise(x, y, period);
        amp *= 0.5;
      }
      out[j * size + i] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return out;
}

const createCloudPatternTexture = (): THREE.DataTexture => {
  const tex = new THREE.DataTexture(
    bakeCloudPattern(), CLOUD_PATTERN_SIZE, CLOUD_PATTERN_SIZE,
    THREE.RedFormat, THREE.UnsignedByteType,
  );
  // Mirrored repeat doubles the effective period (no translational wallpaper
  // repetition) while staying seamless: the mirrored joint is continuous by
  // construction. Mipped + bilinear so distant octaves fade instead of sparkle.
  tex.wrapS = THREE.MirroredRepeatWrapping;
  tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // Data payload, not color: keep raw byte space like the other world paths.
  if ('colorSpace' in tex) (tex as unknown as { colorSpace: unknown }).colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
};

const FRAG = /* glsl */ `
precision highp float;
in vec3 vDir;
out vec4 outColor;
uniform float uTime;
uniform vec3 uCloudColor;
uniform float uCoverage;  // 0..1 how much sky is clouded
uniform float uOpacity;   // overall fade (day/night/weather)
uniform sampler2D uCloudTex;

void main() {
  vec3 dir = normalize(vDir);
  if (dir.z < 0.015) discard;                       // below the horizon: no clouds
  vec2 uv = dir.xy / max(dir.z, 0.18);              // project the dome cap onto a plane
  // Same drift as the legacy shader; scale maps dome units onto pattern tiles.
  vec2 tuv = (uv + uTime * vec2(0.010, 0.006)) * ${CLOUD_TEX_SCALE.toFixed(5)};
  float n = texture(uCloudTex, tuv).r;
  float coverage = smoothstep(0.62 - uCoverage * 0.4, 0.9 - uCoverage * 0.25, n);
  float horizonFade = smoothstep(0.015, 0.28, dir.z); // clouds thin toward the horizon
  float a = coverage * horizonFade * uOpacity;
  if (a < 0.004) discard;
  outColor = vec4(uCloudColor, a);
}
`;

// Diagnostic A/B only: the pre-texture procedural shader, byte-identical math.
// Select with ?clouds=procedural (same precedent as ?doodadbatch=whole).
// Never the default; kept so the old path stays comparable without a rebuild.
const LEGACY_FRAG = /* glsl */ `
precision highp float;
in vec3 vDir;
out vec4 outColor;
uniform float uTime;
uniform vec3 uCloudColor;
uniform float uCoverage;  // 0..1 how much sky is clouded
uniform float uOpacity;   // overall fade (day/night/weather)

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.02 + 7.3; a *= 0.5; }
  return v;
}

void main() {
  vec3 dir = normalize(vDir);
  if (dir.z < 0.015) discard;                       // below the horizon: no clouds
  vec2 uv = dir.xy / max(dir.z, 0.18);              // project the dome cap onto a plane
  uv += uTime * vec2(0.010, 0.006);                 // slow drift
  float n = fbm(uv * 2.6);
  float coverage = smoothstep(0.62 - uCoverage * 0.4, 0.9 - uCoverage * 0.25, n);
  float horizonFade = smoothstep(0.015, 0.28, dir.z); // clouds thin toward the horizon
  float a = coverage * horizonFade * uOpacity;
  if (a < 0.004) discard;
  outColor = vec4(uCloudColor, a);
}
`;

/** True only for the explicit diagnostic override; Node/tests take the texture path. */
export function useLegacyProceduralClouds(): boolean {
  return typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('clouds') === 'procedural';
}

export function createCloudLayer(radius: number) {
  const legacy = useLegacyProceduralClouds();
  const patternTexture = legacy ? null : createCloudPatternTexture();
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: legacy ? LEGACY_FRAG : FRAG,
    uniforms: {
      uTime: { value: 0 },
      uCloudColor: { value: new THREE.Vector3(1, 1, 1) },
      uCoverage: { value: 0.5 },
      uOpacity: { value: 0.85 },
      // Unused by the legacy path; harmless, keeps one uniform layout.
      uCloudTex: { value: patternTexture },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    // Clouds are transparent and therefore render after opaque terrain. Preserve the terrain depth
    // test so the far sky cannot blend over mountains and buildings.
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.96, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -998; // sky dome -1000, clouds -998 (over the gradient, can pass before the sun)

  const cloudTimeParam = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('cloudtime');
  const fixedCloudTime = cloudTimeParam === null ? null : Number(cloudTimeParam);
  const tick = (dt: number) => { material.uniforms.uTime.value = fixedCloudTime !== null && Number.isFinite(fixedCloudTime) ? fixedCloudTime : material.uniforms.uTime.value + dt; };
  /** skyHorizon/skyMid give the cloud tint; dayFactor dims them at night. */
  const update = (cloudColor: RGB, dayFactor: number) => {
    material.uniforms.uCloudColor.value.set(cloudColor[0], cloudColor[1], cloudColor[2]);
    // Clouds stay visible day and night, just dimmer/greyer after dark.
    material.uniforms.uOpacity.value = 0.35 + 0.55 * Math.max(0, Math.min(1, dayFactor));
  };
  return { mesh, material, tick, update };
}
