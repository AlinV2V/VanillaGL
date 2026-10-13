import * as THREE from 'three';
import { admitTextureUpload } from './rendering/texture-upload-admission';
import { loadTerrainTextureArray } from './rendering/terrain-texture-array';
import { qaGlobals } from './qa-globals.ts';
/** Asset conversion utility. */
export type TerrainShaderAssets = {
  texArrayUrl: string;
  chunkMapUrl: string;
  splatUrl: string;
  shadowUrl: string;
  texCount: number;
  texSize: number;
  layerScale: number;
  compressedMipUrl?: string;
  compressedArrayUrl?: string;
  compressedMipFormat?: 'dxt1' | 'dxt3' | null;
  mipLevels?: number;
};

export type TerrainLight = {
  fogColor: [number, number, number]; // sRGB 0..1
  fogNear: number;
  fogFar: number;
  sunDir: THREE.Vector3;
  sunColor: [number, number, number]; // sRGB 0..1
  ambient: [number, number, number]; // sRGB 0..1 — up-facing/sky ambient (LightIntBand type 1)
  groundAmbient: [number, number, number]; // sRGB 0..1 — down-facing ground ambient (type 3)
  /**
   * 0 in full daylight, 1 in full dark — `1 - dayFactor(time)` from rendering/wmo-night.ts.
   * Clock-driven on purpose: the Light.dbc sun turns moonlight blue at night but keeps ~half its
   * luminance, so its colour cannot distinguish day from night. Consumed by WMO SIDN/WINDOW
   * self-illumination (lit windows); terrain and grass ignore it.
   */
  night: number;
};

/**
 * How much of the direct sun the authored MCSH mask is allowed to remove: 0 = shadows invisible,
 * 1 = shadowed ground keeps ambient only. The baked grass instanceColor was authored against this
 * value, so grass-material.ts un-bakes it before re-applying the live one — keep them in step.
 *
 * DO NOT "fix" the 0.3 to 1.0. It is byte-evidenced: the disassembled ARB terrain fragment shaders
 * both spell it out as `fresnel = alphaMap.w * 0.3 + 0.7` — the 3-layer variant
 * (docs/research/wow_world_render_research/agent_03/shader_translations/0015.glsl) and the 5-layer
 * specular variant (0021.glsl). Two 2026-07-21 audits demanded a full 0..1 cut; the second one
 * quoted this very formula as the native behaviour and then contradicted itself in the same
 * paragraph. The knob exists for A/B only.
 *
 * Known open discrepancy: the ARB shaders apply this factor to the FULL vertex-lit colour
 * (`blended.rgb * fresnel * v_colorPrimary.rgb`), i.e. ambient is attenuated too, whereas this
 * shader attenuates only the direct sun term. That split was a deliberate call (see the FRAG
 * comment) made on visual comparison; it has not been re-tested against the ARB form.
 */
export const DEFAULT_SHADOW_STRENGTH = 0.3;

/** Live A/B hooks for the softening/fog fidelity passes (QA: window.__wowLightTune). */
type LightTune = { halfLambert?: number; sunFog?: number; shadowStrength?: number };
const lightTune = (): LightTune =>
  (qaGlobals.__wowLightTune as LightTune | undefined) ?? {};

/** Resolved MCSH strength for this frame, clamped to the meaningful range. */
export const resolveShadowStrength = (): number => {
  const v = lightTune().shadowStrength;
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : DEFAULT_SHADOW_STRENGTH;
};

/** Production terrain path. `?terrainpath=legacy` restores pre-Fix-7 behavior for A/B. */
export const DEFAULT_TERRAIN_PATH = 'optimized' as const;

export type TerrainPath = 'legacy' | 'optimized';

/**
 * Startup-only diagnostic switch (parsed per tile creation, never per frame).
 * Unrecognized values fall back to the production default so a bad link can
 * never silently change rendering. Node-safe (takes the search string).
 */
export function resolveTerrainPath(search: string): TerrainPath {
  const value = new URLSearchParams(search).get('terrainpath');
  if (value === 'legacy' || value === 'optimized') return value;
  return DEFAULT_TERRAIN_PATH;
}

/**
 * Pack the MCAL splat atlas (RGB payload) with the MCSH shadow atlas (R
 * payload) into one RGBA image: R/G/B = layers 1/2/3 alpha, A = shadow.
 * Both atlases share dimensions, orientation, Linear/Linear filtering and
 * ClampToEdge wrapping (see bake-terrain-shader.ts: same ATLAS loop writes
 * both; both alphas are authored 255 so canvas round-trips are faithful),
 * and the shader samples them at identical UVs — so one fetch reproduces
 * both samples exactly. Returns null when dimensions mismatch (caller falls
 * back to separate textures for that tile).
 */
export function packSplatShadow(
  splat: { data: Uint8Array; width: number; height: number },
  shadow: { data: Uint8Array; width: number; height: number },
): Uint8Array | null {
  if (splat.width !== shadow.width || splat.height !== shadow.height) return null;
  if (splat.data.length < splat.width * splat.height * 4) return null;
  if (shadow.data.length < shadow.width * shadow.height * 4) return null;
  const count = splat.width * splat.height;
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const s = i * 4;
    out[s] = splat.data[s];
    out[s + 1] = splat.data[s + 1];
    out[s + 2] = splat.data[s + 2];
    out[s + 3] = shadow.data[s];
  }
  return out;
}

/**
 * Clamp an anisotropy request into the sampler range the runtime enforces.
 * The authoritative effective value arrives from main.ts (`textureAnisotropy`,
 * already CVar x profile x hardware capped); this only guards the sampler.
 */
export function resolveTerrainAnisotropy(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.max(1, Math.min(16, parsed));
}

/**
 * Apply the authoritative effective anisotropy to a live terrain material.
 * Retargets the texture-array sampler so graphics-menu changes reach tiles
 * that are already loaded. Returns true when a sampler was updated.
 */
export function applyTerrainMaterialAnisotropy(material: THREE.ShaderMaterial | null | undefined, anisotropy: number): boolean {
  const texArray = material?.uniforms?.uTexArray?.value as THREE.Texture | undefined;
  if (!(texArray instanceof THREE.Texture)) return false;
  const next = resolveTerrainAnisotropy(anisotropy);
  // Sampler updates re-upload the whole array — skip when nothing changed so
  // unrelated video applies don't pay for a multi-megabyte re-upload per tile.
  if (texArray.anisotropy === next) return false;
  texArray.anisotropy = next;
  texArray.needsUpdate = true;
  return true;
}

export function updateTerrainMaterialLight(material: THREE.ShaderMaterial, light: TerrainLight): void {
  material.uniforms.uFogColor.value.set(...light.fogColor);
  material.uniforms.uFogNear.value = light.fogNear;
  material.uniforms.uFogFar.value = light.fogFar;
  material.uniforms.uSunDir.value.copy(light.sunDir).normalize();
  material.uniforms.uSunColor.value.set(...light.sunColor);
  material.uniforms.uAmbient.value.set(...light.ambient);
  material.uniforms.uGroundAmbient.value.set(...light.groundAmbient);
  // These effects came from an unverified graphics handoff, not recovered 1.12.1 code.
  // Keep the A/B hooks, but do not silently alter the default Vanilla lighting path.
  material.uniforms.uHalfLambert.value = lightTune().halfLambert ?? 0;
  material.uniforms.uShadowStrength.value = resolveShadowStrength();
  // Sun-side fog tint: direction TOWARD the sun; suppressed while the sun is below the
  // horizon (sunDir.z >= 0 means it shines upward, i.e. night) so moonlight fog stays neutral.
  const sunUp = light.sunDir.z < -0.05;
  material.uniforms.uSunFogDir.value.copy(light.sunDir).normalize().multiplyScalar(-1);
  material.uniforms.uSunFogStrength.value = sunUp ? (lightTune().sunFog ?? 0) : 0;
  material.uniforms.uSunFogColor.value.set(...light.sunColor);
}

async function loadPixels(url: string): Promise<{ data: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('image load failed: ' + url));
    im.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  return { data: new Uint8Array(id.data.buffer, id.data.byteOffset, id.data.byteLength), width: img.width, height: img.height };
}

const VERT = /* glsl */ `
out vec2 vUv;
out vec3 vAmbient;
out vec3 vSun;
out float vFog;
out vec3 vViewDir;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;        // ambient (LightIntBand type 1) — up-facing sky ambient
uniform vec3 uGroundAmbient;  // ground ambient (LightIntBand type 3) — down-facing
uniform float uHalfLambert;   // 1 = soften diffuse (pipeline handoff §2.C), 0 = plain Lambert (QA A/B)
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
  float ndl = clamp(dot(worldNormal, normalize(-uSunDir)), 0.0, 1.0);
  // Half-Lambert diffuse (GFX-12): w = 0.5 + 0.5*clamp(N·L) softens backface shading instead of
  // clipping to black. Source doc (wow_graphics_pipeline_handoff §2.C) failed the MCCV byte check
  // elsewhere, so this stays behind uHalfLambert for live A/B (window.__wowLightTune.halfLambert).
  float diffuseW = mix(ndl, 0.5 + 0.5 * ndl, uHalfLambert);
  // Hemispheric ambient: blend sky/ground by the normal's up component (vanilla 1.12.1
  // confirmed by agent_09 LIGHTING_SPEC and the M2 character material which already uses
  // this formula). This warms shadow areas (golden ground bounce) and reduces the harsh
  // green/gold contrast that makes Mulgore's per-chunk alpha blocks hyper-visible.
  // NOTE: this world is Z-UP (camera.up=(0,0,1)) — the up component is worldNormal.z, matching
  // m2-material.ts (n.z). Using .y blended the hemisphere by north/south facing instead of up.
  float up = worldNormal.z * 0.5 + 0.5;
  vec3 hemi = mix(uGroundAmbient, uAmbient, up);
  // Keep ambient and direct light separate. The authored MCSH mask attenuates only
  // direct sunlight; multiplying their sum makes shaded terrain lose its ambient
  // fill and is visibly too dark compared with the fixed-function client.
  vAmbient = hemi;
  vSun = uSunColor * diffuseW;
  vec4 viewPos = viewMatrix * wp;
  float fogDepth = max(0.0, -viewPos.z);
  vViewDir = wp.xyz - cameraPosition;
  // Vanilla fixed-function fog uses eye-space Z, not radial camera distance.
  // Radial fog over-fogs screen corners and flattens the scene at wide aspect ratios.
  vFog = clamp((fogDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
  gl_Position = projectionMatrix * viewPos;
}
`;

const LEGACY_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
in vec3 vAmbient;
in vec3 vSun;
in float vFog;
in vec3 vViewDir;
out vec4 outColor;
uniform sampler2DArray uTexArray;
uniform sampler2D uChunkMap;   // 16x16, RGBA = 4 layer indices / 255 (255 = none)
uniform sampler2D uSplat;      // 1024x1024, RGB = MCAL alpha for layers 1/2/3
uniform sampler2D uShadow;     // 1024x1024, R = authored MCSH shadow (1 lit, 0 shadowed)
uniform float uLayerScale;
uniform float uMipBias;
uniform float uDetail;         // 0..1 scale on the upper-layer (highlight/dirt/road) blend strength
uniform float uShadowStrength; // 0..1 — how much direct sun the MCSH mask removes (see DEFAULT_SHADOW_STRENGTH)
uniform vec3 uFogColor;        // sRGB
uniform vec3 uSunFogDir;       // normalized direction TOWARD the sun (world space)
uniform float uSunFogStrength; // 0..1 — how much fog warms toward the sun color (GFX-85)
uniform vec3 uSunFogColor;     // sRGB — sun-side fog tint (sun color until band 9 is baked)

bool sampleLayer(float idx, vec2 uv, out vec3 rgb) {
  if (idx > 250.0) { rgb = vec3(0.0); return false; }
  rgb = texture(uTexArray, vec3(uv, idx), uMipBias).rgb;
  return true;
}

void main() {
  vec2 mapUv = vec2(vUv.x, 1.0 - vUv.y);          // data textures aren't flipped like image textures
  vec2 tileUv = clamp(mapUv, vec2(0.0), vec2(1.0 - 1.0 / 65536.0));
  vec2 chunk = floor(tileUv * 16.0);
  vec2 chunkUv = (chunk + 0.5) / 16.0;
  // Sample the MCAL alpha/shadow atlas CONTINUOUSLY (not clamped per chunk) so linear filtering
  // blends alpha across chunk borders — removes the hard 33yd "puzzle-piece" chunk seams. The
  // atlas is laid out contiguously (16x16 cells of 64px), so this matches Vanilla's smooth borders.
  vec2 dataUv = tileUv;
  vec4 cm = floor(texture(uChunkMap, chunkUv) * 255.0 + 0.5);
  vec3 a = texture(uSplat, dataUv).rgb * uDetail; // uDetail softens the per-chunk highlight blocks
  vec2 tuv = vUv * uLayerScale;

  vec3 col, l;
  if (!sampleLayer(cm.r, tuv, col)) col = vec3(0.42, 0.45, 0.30);
  if (sampleLayer(cm.g, tuv, l)) col = mix(col, l, a.r);
  if (sampleLayer(cm.b, tuv, l)) col = mix(col, l, a.g);
  if (sampleLayer(cm.a, tuv, l)) col = mix(col, l, a.b);

  // MCSH attenuates the direct sun term only. Ambient remains present in tree/building
  // shadows, matching the Vanilla fixed-function lighting equation.
  float shadowFactor = 1.0 - uShadowStrength * (1.0 - texture(uShadow, dataUv).r);
  // The ARB terrain shaders apply the shadow to the FULL vertex-lit colour, not to the sun term
  // alone: diffuse = blended.rgb * fresnel * v_colorPrimary.rgb, where primary is the
  // fixed-function T&L result (ambient + N.L combined). Both 0015.glsl and 0021.glsl agree, and a
  // second independent audit confirmed it. This shader previously attenuated only vSun, which left
  // shadowed ground carrying full ambient and reading too flat.
  vec3 lit = col * shadowFactor * clamp(vAmbient + vSun, 0.0, 1.0);
  // Sun fog (GFX-85): fog looking toward the sun picks up the sun tint — the vanilla horizon
  // glow. Narrow lobe (pow 8) so only the sun-facing sector warms, scaled by fog amount.
  float sunAlign = clamp(dot(normalize(vViewDir), uSunFogDir), 0.0, 1.0);
  vec3 fogColor = mix(uFogColor, uSunFogColor, pow(sunAlign, 8.0) * uSunFogStrength);
  lit = mix(lit, fogColor, vFog);
  outColor = vec4(lit, 1.0);
}
`;

// FIX 7 optimized path — pixel-identical to LEGACY_FRAG in production:
//  - uSplatShadow packs MCAL RGB + MCSH R (see packSplatShadow): 7→6 fetches.
//    The packed fetch itself still runs on every chunk (its alpha carries the
//    shadow, which production needs everywhere); on single-layer chunks only
//    the MCAL RGB × uDetail use is skipped (~44% of baked chunks, measured).
//  - sun-fog math (normalize/dot/pow) is skipped while uSunFogStrength is 0,
//    which holds for every production frame (QA-only override enables it).
//    mix(x, y, 0) === x exactly, so the skip changes nothing when off.
//    The QA branch keeps the original pow(sunAlign, 8.0): re-implementing it
//    would buy no production performance for a needless numeric difference.
const FRAG_OPT = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
in vec3 vAmbient;
in vec3 vSun;
in float vFog;
in vec3 vViewDir;
out vec4 outColor;
uniform sampler2DArray uTexArray;
uniform sampler2D uChunkMap;   // 16x16, RGBA = 4 layer indices / 255 (255 = none)
uniform sampler2D uSplatShadow; // 1024x1024 RGBA: RGB = MCAL alpha layers 1/2/3, A = MCSH shadow
uniform float uLayerScale;
uniform float uMipBias;
uniform float uDetail;         // 0..1 scale on the upper-layer (highlight/dirt/road) blend strength
uniform float uShadowStrength; // 0..1 — how much direct sun the MCSH mask removes (see DEFAULT_SHADOW_STRENGTH)
uniform vec3 uFogColor;        // sRGB
uniform vec3 uSunFogDir;       // normalized direction TOWARD the sun (world space)
uniform float uSunFogStrength; // 0..1 — how much fog warms toward the sun color (GFX-85)
uniform vec3 uSunFogColor;     // sRGB — sun-side fog tint (sun color until band 9 is baked)

bool sampleLayer(float idx, vec2 uv, out vec3 rgb) {
  if (idx > 250.0) { rgb = vec3(0.0); return false; }
  rgb = texture(uTexArray, vec3(uv, idx), uMipBias).rgb;
  return true;
}

void main() {
  vec2 mapUv = vec2(vUv.x, 1.0 - vUv.y);          // data textures aren't flipped like image textures
  vec2 tileUv = clamp(mapUv, vec2(0.0), vec2(1.0 - 1.0 / 65536.0));
  vec2 chunk = floor(tileUv * 16.0);
  vec2 chunkUv = (chunk + 0.5) / 16.0;
  // Sample the MCAL alpha/shadow atlas CONTINUOUSLY (not clamped per chunk) so linear filtering
  // blends alpha across chunk borders — removes the hard 33yd "puzzle-piece" chunk seams. The
  // atlas is laid out contiguously (16x16 cells of 64px), so this matches Vanilla's smooth borders.
  vec2 dataUv = tileUv;
  vec4 cm = floor(texture(uChunkMap, chunkUv) * 255.0 + 0.5);
  // The packed fetch below serves double duty: its alpha is the MCSH shadow
  // (needed on every chunk while uShadowStrength > 0), its RGB the MCAL
  // blend (needed only where an upper layer exists). 37%+ of baked chunks
  // carry only the base layer (measured over 326k chunks); there the RGB use
  // is skipped. Chunk-constant membership keeps this coherent; border quads
  // may diverge harmlessly. The fetch itself is NOT skipped — shadow applies
  // to base color too — only the MCAL RGB × uDetail work is.
  vec4 splatShadow = texture(uSplatShadow, dataUv);
  vec3 a = vec3(0.0);
  if (cm.g <= 250.0 || cm.b <= 250.0 || cm.a <= 250.0) {
    a = splatShadow.rgb * uDetail; // uDetail softens the per-chunk highlight blocks
  }
  vec2 tuv = vUv * uLayerScale;

  vec3 col, l;
  if (!sampleLayer(cm.r, tuv, col)) col = vec3(0.42, 0.45, 0.30);
  if (sampleLayer(cm.g, tuv, l)) col = mix(col, l, a.r);
  if (sampleLayer(cm.b, tuv, l)) col = mix(col, l, a.g);
  if (sampleLayer(cm.a, tuv, l)) col = mix(col, l, a.b);

  // MCSH attenuates the direct sun term only. Ambient remains present in tree/building
  // shadows, matching the Vanilla fixed-function lighting equation.
  float shadowFactor = 1.0 - uShadowStrength * (1.0 - splatShadow.a);
  // The ARB terrain shaders apply the shadow to the FULL vertex-lit colour, not to the sun term
  // alone: diffuse = blended.rgb * fresnel * v_colorPrimary.rgb, where primary is the
  // fixed-function T&L result (ambient + N.L combined). Both 0015.glsl and 0021.glsl agree, and a
  // second independent audit confirmed it. This shader previously attenuated only vSun, which left
  // shadowed ground carrying full ambient and reading too flat.
  vec3 lit = col * shadowFactor * clamp(vAmbient + vSun, 0.0, 1.0);
  // Sun fog (GFX-85): fog looking toward the sun picks up the sun tint — the vanilla horizon
  // glow. Narrow lobe (x^8) so only the sun-facing sector warms, scaled by fog amount.
  // Production frames always carry uSunFogStrength == 0 (QA-only override), so the
  // normalize/dot/pow below are skipped without changing any pixel.
  vec3 fogColor = uFogColor;
  if (uSunFogStrength > 0.0) {
    float sunAlign = clamp(dot(normalize(vViewDir), uSunFogDir), 0.0, 1.0);
    fogColor = mix(uFogColor, uSunFogColor, pow(sunAlign, 8.0) * uSunFogStrength);
  }
  lit = mix(lit, fogColor, vFog);
  outColor = vec4(lit, 1.0);
}
`;

export async function createTerrainMaterial(
  assets: TerrainShaderAssets,
  light: TerrainLight,
  supportsS3tc = false,
  anisotropy = 1,
): Promise<THREE.ShaderMaterial> {
  const [arrayResult, masksResult] = await Promise.allSettled([
    loadTerrainTextureArray(assets, supportsS3tc, loadPixels, resolveTerrainAnisotropy(anisotropy)),
    Promise.all([
      // The chunk map holds 4 raw layer-texture indices per chunk in RGBA. Its ALPHA channel is the
      // 4th layer index (often a small number), so it must NOT go through a canvas getImageData round-
      // trip — the browser stores canvases premultiplied, which corrupts R/G/B (the first 3 indices)
      // wherever alpha is low. That silently shuffled the layer textures on every 4-layer chunk (e.g.
      // StartingZone_01's grass-over-rock chunks rendered as bare rock/dirt). Load it as raw bytes instead.
      fetch(assets.chunkMapUrl).then((r) => r.arrayBuffer()),
      loadPixels(assets.splatUrl),
      loadPixels(assets.shadowUrl),
    ]),
  ]);
  if (arrayResult.status === 'rejected') throw arrayResult.reason;
  if (masksResult.status === 'rejected') { arrayResult.value.dispose(); throw masksResult.reason; }
  const texArray = arrayResult.value;
  const [cmapBuf, splat, shadow] = masksResult.value;

  const cmapData = new Uint8Array(cmapBuf);
  const cmapSide = Math.round(Math.sqrt(cmapData.length / 4)); // 16x16
  const chunkMap = new THREE.DataTexture(cmapData, cmapSide, cmapSide, THREE.RGBAFormat);
  chunkMap.magFilter = chunkMap.minFilter = THREE.NearestFilter;
  chunkMap.needsUpdate = true;

  const splatTex = new THREE.DataTexture(splat.data, splat.width, splat.height, THREE.RGBAFormat);
  splatTex.magFilter = THREE.LinearFilter;
  splatTex.minFilter = THREE.LinearFilter;
  splatTex.needsUpdate = true;

  const shadowTex = new THREE.DataTexture(shadow.data, shadow.width, shadow.height, THREE.RGBAFormat);
  shadowTex.magFilter = THREE.LinearFilter;
  shadowTex.minFilter = THREE.LinearFilter;
  shadowTex.needsUpdate = true;

  // FIX 7: pack MCAL+MSCSH into one upload/fetch unless legacy was requested
  // (?terrainpath=legacy) or the atlases mismatch (falls back per tile).
  const terrainPath = typeof location !== 'undefined'
    ? resolveTerrainPath(location.search)
    : DEFAULT_TERRAIN_PATH;
  const packed = terrainPath === 'optimized' ? packSplatShadow(splat, shadow) : null;
  let splatShadowTex: THREE.DataTexture | null = null;
  if (packed) {
    splatShadowTex = new THREE.DataTexture(packed, splat.width, splat.height, THREE.RGBAFormat);
    splatShadowTex.magFilter = THREE.LinearFilter;
    splatShadowTex.minFilter = THREE.LinearFilter;
    splatShadowTex.needsUpdate = true;
  }

  await Promise.all([
    admitTextureUpload(chunkMap, `terrain-chunks:${assets.chunkMapUrl}`),
    ...(splatShadowTex
      ? [admitTextureUpload(splatShadowTex, `terrain-splatshadow:${assets.splatUrl}`)]
      : [
        admitTextureUpload(splatTex, `terrain-splat:${assets.splatUrl}`),
        admitTextureUpload(shadowTex, `terrain-shadow:${assets.shadowUrl}`),
      ]),
  ]);

  const fragmentShader = splatShadowTex ? FRAG_OPT : LEGACY_FRAG;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader,
    uniforms: {
      uTexArray: { value: texArray },
      uChunkMap: { value: chunkMap },
      ...(splatShadowTex
        ? { uSplatShadow: { value: splatShadowTex } }
        : { uSplat: { value: splatTex }, uShadow: { value: shadowTex } }),
      uLayerScale: { value: assets.layerScale },
      uMipBias: { value: 0 },
      uDetail: { value: 1 },
      uFogColor: { value: new THREE.Vector3(...light.fogColor) },
      uFogNear: { value: light.fogNear },
      uFogFar: { value: light.fogFar },
      uSunDir: { value: light.sunDir.clone().normalize() },
      uSunColor: { value: new THREE.Vector3(...light.sunColor) },
      uAmbient: { value: new THREE.Vector3(...light.ambient) },
      uGroundAmbient: { value: new THREE.Vector3(...light.groundAmbient) },
      uHalfLambert: { value: lightTune().halfLambert ?? 0 },
      uShadowStrength: { value: resolveShadowStrength() },
      uSunFogDir: { value: light.sunDir.clone().normalize().multiplyScalar(-1) },
      uSunFogStrength: { value: light.sunDir.z < -0.05 ? (lightTune().sunFog ?? 0) : 0 },
      uSunFogColor: { value: new THREE.Vector3(...light.sunColor) },
    },
  });
}
