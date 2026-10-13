import * as THREE from 'three';
import { QA_GLOBALS_ENABLED, qaGlobals } from './qa-globals.ts';
import { setM2MaterialOpacityLayer } from './rendering/model-opacity.ts';
import { bindM2SelectionUniform } from './rendering/m2-per-draw-uniforms.ts';
export { M2_MAX_LOCAL_LIGHTS, type M2LocalLight } from './rendering/m2-world-lighting.ts';
/** Asset conversion utility. */
export type M2Light = {
  sunDir: THREE.Vector3; // direction the sun's rays travel, Z-up world space
  sunColor: [number, number, number]; // sRGB 0..1
  skyAmbient: [number, number, number]; // client constant ambient coefficient (LightIntBand type 1)
  groundAmbient: [number, number, number]; // retained for diagnostics/terrain parity; not mixed into M2 SH
  fogColor: [number, number, number]; // sRGB 0..1
  fogNear: number;
  fogFar: number;
};

const sharedLight = {
  uSunDir: { value: new THREE.Vector3(0, -0.687, -0.688).normalize() },
  uSunColor: { value: new THREE.Vector3(1, 0.95, 0.85) },
  uSkyAmbient: { value: new THREE.Vector3(0.45, 0.5, 0.55) },
  uGroundAmbient: { value: new THREE.Vector3(0.22, 0.2, 0.17) },
  uFogColor: { value: new THREE.Vector3(0.56, 0.72, 0.88) },
  uFogNear: { value: 480 },
  uFogFar: { value: 1280 },
  // Comparison controls retained for live A/B; the reversed client M2 light path does not use
  // half-Lambert. Sun-side fog remains shared with the terrain shader.
  uHalfLambert: { value: 0 },
  uSunFogDir: { value: new THREE.Vector3(0, 0.687, 0.688).normalize() },
  uSunFogStrength: { value: 0 },
  uSunFogColor: { value: new THREE.Vector3(1, 0.95, 0.85) },
  /** 0 legacy texture tint, 1 reversed-client WMO doodad lighting, 2/3 comparison curves. */
  uModdLightMode: { value: 1 },
  /** Comparison mode 3 only; client mode selects its branch from the owning group. */
  uModdSun: { value: 0 },
  /** Live comparison controls; reversed-client mode 1 does not use inferred gain/floor curves. */
  uModdScale: { value: 1 },
  uModdFloor: { value: 0 },
};

// Characters/creatures read the same DBC ambient as terrain, but that ambient is a saturated blue
// at many zones — and since a creature's camera-facing side is lit by ambient only (sun is usually
// behind/above), full-blue ambient makes fur/skin read blue-gray. Vanilla's effective character
// ambient is far less saturated, so we de-saturate it toward luminance for M2 models (not terrain).
const desat = (c: [number, number, number], s: number): [number, number, number] => {
  const lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  return [lum + (c[0] - lum) * s, lum + (c[1] - lum) * s, lum + (c[2] - lum) * s];
};

/**
 * Live A/B for the WMO doodad lighting model — `__wowDoodadLight(0|1|2|3)`, no reload.
 *
 *   0 = the behaviour that shipped (MODD colour multiplies the texture, scene light on top)
 *   1 = Build 5875 CMapDoodadDef path [default]
 *   2 = sampled/raw colour as a flat light (comparison)
 *   3 = old tunable floor/sun curve (comparison)
 *
 * Every material shares this uniform holder, so one call re-lights every doodad on the next frame.
 */
export function setM2DoodadLightMode(mode: number): number {
  const clamped = mode >= 0 && mode <= 3 ? Math.floor(mode) : 1;
  sharedLight.uModdLightMode.value = clamped;
  // Only comparison mode 3 adds the old explicit sun term.
  sharedLight.uModdSun.value = clamped === 3 ? 1 : 0;
  return clamped;
}

/**
 * Live tuner for the doodad light curve — `__wowDoodadTune({ scale, floor })`, no reload.
 * Comparison light = clamp(sample * scale + floor [+ sun in mode 3]).
 */
export function tuneM2DoodadLight(next: { scale?: number; floor?: number }): { scale: number; floor: number } {
  if (Number.isFinite(next.scale)) sharedLight.uModdScale.value = Math.max(0, next.scale as number);
  if (Number.isFinite(next.floor)) sharedLight.uModdFloor.value = Math.max(0, next.floor as number);
  return { scale: sharedLight.uModdScale.value, floor: sharedLight.uModdFloor.value };
}

if (QA_GLOBALS_ENABLED) {
  qaGlobals.__wowDoodadTune = (next?: { scale?: number; floor?: number }) =>
    tuneM2DoodadLight(next ?? {});
  qaGlobals.__wowDoodadLight = (mode?: number) => {
    if (mode === undefined) {
      return {
        current: sharedLight.uModdLightMode.value,
        scale: sharedLight.uModdScale.value,
        floor: sharedLight.uModdFloor.value,
        modes: {
          0: 'legacy (tint x scene light) — the black-statue behaviour',
          1: 'Build 5875 CMapDoodadDef lighting [default]',
          2: 'sampled/raw color as flat light (comparison)',
          3: 'old scale + floor + sun curve (comparison)',
        },
      };
    }
    return `doodad light mode -> ${setM2DoodadLightMode(mode)}`;
  };
}

/** Update the sun/ambient/fog for every M2 model in the scene (player, NPCs, mobs). */
export function setM2Light(light: M2Light): void {
  sharedLight.uSunDir.value.copy(light.sunDir).normalize();
  sharedLight.uSunColor.value.set(...light.sunColor);
  // Character ambient saturation. The raw captured M2 ARB programs feed the DBC ambient into the
  // constant SH coefficient with no desaturation step anywhere,
  // so this is a tuning knob rather than client behaviour. It sat at 0.45 — cutting character
  // ambient saturation by 55% — which is why armour and tabards read pale and muddy next to a
  // reference shot of the same NPC. Restored to 1.0 (untouched DBC ambient); live A/B via
  // __wowLightTune.charAmbientSat if it ever needs revisiting.
  const charAmbientSat = (() => {
    const v = (qaGlobals.__wowLightTune as { charAmbientSat?: number } | undefined)?.charAmbientSat;
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : 1;
  })();
  const sky = desat(light.skyAmbient, charAmbientSat);
  sharedLight.uSkyAmbient.value.set(...sky);
  // Keep the authored ground band in the shared block for diagnostics and other render paths. The
  // raw M2 ARB programs do not blend this value by the vertex normal.
  sharedLight.uGroundAmbient.value.set(...desat(light.groundAmbient, charAmbientSat));
  sharedLight.uFogColor.value.set(...light.fogColor);
  sharedLight.uFogNear.value = light.fogNear;
  sharedLight.uFogFar.value = light.fogFar;
  const tune = (qaGlobals.__wowLightTune ?? {}) as { halfLambert?: number; sunFog?: number };
  sharedLight.uHalfLambert.value = tune.halfLambert ?? 0;
  const sunUp = light.sunDir.z < -0.05; // rays travel downward = sun above horizon
  sharedLight.uSunFogDir.value.copy(light.sunDir).normalize().multiplyScalar(-1);
  sharedLight.uSunFogStrength.value = sunUp ? (tune.sunFog ?? 0) : 0;
  sharedLight.uSunFogColor.value.set(...light.sunColor);
}

export type M2MaterialOptions = {
  texture?: THREE.Texture | null;
  /** M2 blend: 0 opaque, 1 alpha-key, 2 alpha, 3/4 additive, 5/6 modulate. */
  blendMode?: number;
  /** M2 flags: 0x01 unlit, 0x02 unfogged, 0x04 two-sided, 0x10 no depth write. */
  renderFlags?: number;
  /** Tint used when there is no texture (placeholder/untextured submeshes). */
  fallbackColor?: number;
  /**
   * Spherical environment mapping: generate UVs from the view-space normal instead of the model UVs.
   * Weapon/armor "shine" submeshes (additive, a small env texture) are env-mapped in vanilla — a subtle
   * glint that tracks the camera. Pasting that env texture on the model UVs instead produces a fixed
   * bright streak across the blade, which is the bug this fixes.
   */
  envMap?: boolean;
  /** Render only item attachments two-sided; reflected bone bases otherwise reverse winding. */
  forceDoubleSided?: boolean;
  /** Compile the dedicated InstancedMesh vertex path used by static world doodads. */
  instanced?: boolean;
  /**
   * Model-space pivot of the M2 bone carrying spherical-billboard flag 0x08. Present only for
   * submeshes whose vertices ride such a bone — the glow quads on lamps, braziers and moonwells.
   * The rig animator turns these for skinned models; instanced doodads share one geometry across
   * every copy, so they have to be turned per instance in the vertex shader instead.
   */
  billboardPivot?: [number, number, number] | null;
  /** Read a per-instance RGBA MODD tint attribute (WMO doodads only). */
  instanceTint?: boolean;
  /** The M2 colour/weight tracks may drive alpha below one. */
  animatedOpacity?: boolean;
  /** Compile the immutable-bind-buffer GPU skinning path used by animated M2 rigs. */
  gpuSkinning?: boolean;
};

const VERT = /* glsl */ `
out vec2 vUv;
out vec3 vLit;
out float vFog;
out vec3 vViewDir;
out vec4 vInstanceTint;
out vec3 vDoodadLit;
out float vDoodadClass;
#ifdef WOW_INSTANCE_TINT
  in vec4 instanceTint;
  // Lighting class of the WMO group that owns this doodad, baked from that group's MODR:
  // 0 = lit interior (sample MOCV / MODD fallback), 1 = outdoors (take live world light).
  // See tools/bake-wmos.ts. Emitted alongside instanceTint, so it exists whenever the tint does.
  in float instanceLightClass;
#endif
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uModdLightMode;
uniform float uModdSun;
uniform float uModdScale;
uniform float uModdFloor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uHalfLambert;
uniform float uFogNear;
uniform float uFogFar;
uniform float uUnlit;
uniform float uSelected;
uniform float uObjectLight;
uniform vec3 uObjectAmbient;
uniform vec3 uObjectDirectional;
uniform vec3 uObjectLightDir;
uniform float uEnvMap;
uniform vec2 uTexOffset;
uniform int uLocalCount;
uniform vec3 uLocalPos[4];
uniform vec3 uLocalColor[4];
uniform vec2 uLocalAtten[4]; // x = attenStart, y = attenEnd (yards)
uniform vec3 uBillboardPivot;
#ifdef WOW_GPU_SKINNING
  in vec4 wowBoneIndex;
  in vec4 wowBoneWeight;
  uniform sampler2D uBoneTexture;
  mat4 wowBoneMatrix(float boneIndex) {
    int row = int(boneIndex + 0.5);
    return mat4(
      texelFetch(uBoneTexture, ivec2(0, row), 0),
      texelFetch(uBoneTexture, ivec2(1, row), 0),
      texelFetch(uBoneTexture, ivec2(2, row), 0),
      texelFetch(uBoneTexture, ivec2(3, row), 0)
    );
  }
  mat3 wowBoneNormalMatrix(float boneIndex) {
    int row = int(boneIndex + 0.5);
    return mat3(
      texelFetch(uBoneTexture, ivec2(4, row), 0).xyz,
      texelFetch(uBoneTexture, ivec2(5, row), 0).xyz,
      texelFetch(uBoneTexture, ivec2(6, row), 0).xyz
    );
  }
#endif
float clientDirectionalSh(float lightDot) {
  return max(0.0, 0.09375 + 0.5 * lightDot + 0.46875 * lightDot * lightDot);
}
void main() {
  vInstanceTint = vec4(1.0);
  vDoodadClass = 0.0;
  vec4 localPosition = vec4(position, 1.0);
  vec3 localNormal = normal;
  #ifdef WOW_GPU_SKINNING
  {
    vec4 skinnedPosition = vec4(0.0);
    vec3 skinnedNormal = vec3(0.0);
    float skinWeightTotal = 0.0;
    for (int influence = 0; influence < 4; influence++) {
      float weight = wowBoneWeight[influence];
      if (weight <= 0.0) continue;
      skinnedPosition += wowBoneMatrix(wowBoneIndex[influence]) * localPosition * weight;
      skinnedNormal += wowBoneNormalMatrix(wowBoneIndex[influence]) * localNormal * weight;
      skinWeightTotal += weight;
    }
    if (skinWeightTotal > 0.0) {
      localPosition = skinnedPosition / skinWeightTotal;
      localNormal = normalize(skinnedNormal / skinWeightTotal);
    }
  }
  #endif
  #ifdef WOW_INSTANCED
    localPosition = instanceMatrix * localPosition;
    localNormal = mat3(instanceMatrix) * localNormal;
  #endif
  #ifdef WOW_INSTANCE_TINT
    vInstanceTint = instanceTint;
    vDoodadClass = instanceLightClass;
  #endif
  vec4 wp = modelMatrix * localPosition;
  vec3 n = normalize(mat3(modelMatrix) * localNormal);
  #ifdef WOW_BILLBOARD
  {
    // M2 bone flag 0x08 (spherical billboard). Instanced doodads cannot use the rig animator's
    // billboard: one shared geometry feeds every copy of a model, so the turn has to happen per
    // instance, here. Reproduces the animator's Rz(yaw)*Ry(-pitch) basis exactly — model +X is the
    // quad normal and turns to the camera, +Y sweeps right, +Z stays the quad's up.
    vec4 pivotLocal = vec4(uBillboardPivot, 1.0);
    float instScale = 1.0;
    #ifdef WOW_INSTANCED
      pivotLocal = instanceMatrix * pivotLocal;
      instScale = length(instanceMatrix[0].xyz);
    #endif
    vec3 pivotWorld = (modelMatrix * pivotLocal).xyz;
    vec3 fwd = normalize(cameraPosition - pivotWorld);
    // Degenerate only when the camera is exactly on the bone's vertical axis; the quad is a
    // hairline there anyway, so bias to +X rather than emitting NaNs.
    vec3 right = cross(vec3(0.0, 0.0, 1.0), fwd);
    float rightLen = length(right);
    right = rightLen > 1e-5 ? right / rightLen : vec3(0.0, 1.0, 0.0);
    vec3 up = cross(fwd, right);
    vec3 offset = (position - uBillboardPivot) * instScale;
    wp = vec4(pivotWorld + fwd * offset.x + right * offset.y + up * offset.z, 1.0);
    n = fwd;
  }
  #endif
  // No eye-glow depth push lives here any more. Build 5875 seats the glow with an authored
  // global-sequence bone translation and blinks it by retracting behind the face; a push fought
  // that data on both counts. See EYE_GLOW_SEATING in model-loader.ts for the byte trace.
  // Fixed-function sphere mapping uses the reflected eye vector, not a normal-only matcap.
  // Including view position makes the glint move correctly as either camera or attachment moves.
  if (uEnvMap > 0.5) {
    vec3 eyePos = (viewMatrix * wp).xyz;
    vec3 eyeNormal = normalize(mat3(viewMatrix) * n);
    vec3 reflected = reflect(normalize(eyePos), eyeNormal);
    float sphereDenom = 2.0 * sqrt(max(0.000001, reflected.x * reflected.x + reflected.y * reflected.y + (reflected.z + 1.0) * (reflected.z + 1.0)));
    vUv = reflected.xy / sphereDenom + 0.5;
  } else {
    // Animated UV (M2TextureTransform). Every texture transform in the shipped 1.12.1 corpus is
    // translation-only — 63/63 sampled carry a translation track and none carry rotation or
    // scaling — so a scrolling offset reproduces them exactly. This is what moves waterfalls,
    // Undercity slime falls and City_03 lava. Static parts keep uTexOffset at (0,0).
    vUv = uv + uTexOffset;
  }
  // Build 5875 M2 lighting is a constant ambient coefficient plus directional SH sources. The raw
  // ARB program evaluates all seven c[10] coefficients; it does not contain a hemispheric mix.
  // Retain ndl for the explicit comparison mode; the client world-light branch uses sunSh below.
  float rawNdl = max(dot(n, normalize(-uSunDir)), 0.0);
  float ndl = mix(rawNdl, 0.5 + 0.5 * rawNdl, uHalfLambert);
  float sunDot = dot(n, normalize(-uSunDir));
  float sunSh = clientDirectionalSh(sunDot);

  vec3 localSum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uLocalCount) break;
    vec3 ld = uLocalPos[i] - wp.xyz;
    float dist = length(ld);
    float attenStart = max(0.001, uLocalAtten[i].x);
    float attenEnd = max(attenStart + 0.001, uLocalAtten[i].y);
    float attenMid = (attenStart + attenEnd) * 0.5;
    float attenRatio = (attenMid * attenMid) / (attenStart * attenStart);
    float attenLinear = (2.0 - attenRatio) / (attenMid - attenRatio * attenStart);
    float attenQuadratic = (1.0 - attenLinear * attenStart) / (attenStart * attenStart);
    float attenDenom = attenLinear * dist + attenQuadratic * dist * dist;
    // The captured ARB executes RCP directly. Its negative denominator stays negative; the old
    // max(0.001, denom) changed that into +1000 and whitened every M2 sharing this light block.
    // Bound the positive side at native full intensity and stop the light at its authored radius,
    // while preserving the signed reciprocal that the Build 5875 program feeds into its final clamp.
    float att = 0.0;
    if (dist < attenEnd) {
      att = min(1.0 / attenDenom, 1.0);
    }
    float lndl = max(dot(n, ld / max(dist, 0.001)), 0.0);
    localSum += uLocalColor[i] * (att * lndl);
  }
  float objectSh = clientDirectionalSh(dot(n, normalize(uObjectLightDir)));
  vec3 worldLit = uSkyAmbient + uSunColor * sunSh;
  vec3 interiorLit = uObjectAmbient + uObjectDirectional * objectSh + localSum;
  // Build 5875 binds a light provider per M2 draw. Outdoor models use the live world block;
  // enclosed models use their positional MOCV pair plus nearest-four MOLT lights.
  vec3 ambient = mix(uSkyAmbient, uObjectAmbient, uObjectLight);
  vec3 lit = clamp(mix(worldLit, interiorLit, uObjectLight) + uSelected * ambient, 0.0, 1.0);
  vLit = mix(lit, vec3(1.0), uUnlit); // unlit (0x01) parts render fullbright




  // normalized ray direction (-0.30822,-0.30822,-0.9) into three-band irradiance SH; the compact
  // quadratic is that clamped-cosine lobe (3/32 + t/2 + 15*t*t/32).
  float moddMax = max(max(vInstanceTint.r, vInstanceTint.g), max(vInstanceTint.b, 1.0 / 255.0));
  vec3 clientAmbient = vInstanceTint.rgb * min(1.0, (96.0 / 255.0) / moddMax);
  vec3 clientDirectional = vInstanceTint.rgb * max(1.0, (168.0 / 255.0) / moddMax);
  vec3 fixedLightDir = normalize(vec3(0.30822, 0.30822, 0.9));
  float fixedDot = dot(n, fixedLightDir);
  float fixedSh = clientDirectionalSh(fixedDot);
  vec3 clientInterior = clamp(clientAmbient + clientDirectional * fixedSh, 0.0, 1.0);
  vec3 comparisonCurve = clamp(
    vInstanceTint.rgb * uModdScale + vec3(uModdFloor) + uSunColor * ndl * uModdSun,
    0.0,
    1.0
  );
  // 0x08/0x40 groups take the live world light; neither-bit rooms use the sampled static path.
  vDoodadLit = vDoodadClass > 0.5 ? lit : clientInterior;
  if (uModdLightMode > 2.5) vDoodadLit = comparisonCurve;
  vec4 viewPos = viewMatrix * wp;
  float fogDepth = max(0.0, -viewPos.z);
  vViewDir = wp.xyz - cameraPosition;
  vFog = clamp((fogDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
  gl_Position = projectionMatrix * viewPos;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vLit;
in float vFog;
in vec3 vViewDir;
in vec4 vInstanceTint;
in vec3 vDoodadLit;
out vec4 outColor;
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec3 uColor;
uniform float uAlphaTest;
uniform float uUnfogged;
uniform vec3 uFogColor;
uniform vec3 uSunFogDir;
uniform float uSunFogStrength;
uniform vec3 uSunFogColor;
uniform float uAdditive;
uniform float uBlendMode;
uniform vec4 uM2Color;
uniform float uModdLightMode;
// Used by mode 2's bare-doubling branch below. Declared in BOTH stages: the vertex shader
// reads it too, and a uniform referenced in a stage where it is not declared fails to
// compile the whole program -- which blanks every M2 in the world, characters included.
uniform float uModdScale;
uniform float uHasInstanceTint;
// M2 render flag 0x01. Declared in BOTH stages: the vertex stage folds it into vLit, and the
// doodad branch below needs it too. Adding a use without the matching declaration compiles only
// when a frame is actually drawn, which no headless gate can see — verify-m2-shader-symbols.ts
// exists because that mistake once blanked every model in the world. Negative-tested: deleting
// this line takes that gate from 86 green to "2 FAILED of 83".
uniform float uUnlit;
uniform float uAnimatedOpacity;
uniform float uGhostAlpha; // 1.0 = normal; <1 fades the whole model for spirit/ghost form

void main() {
  vec4 base = (uHasMap > 0.5 ? texture(uMap, vUv) : vec4(uColor, 1.0)) * uM2Color;
  // Mode 0 keeps the legacy texture-tint behavior for A/B only. Mode 1 is the reversed-client
  // light path; the sampled color is lighting data and therefore does not tint the texture.
  vec4 tex = vec4(base.rgb * (uModdLightMode < 0.5 ? vInstanceTint.rgb : vec3(1.0)), base.a * vInstanceTint.a);
  if (uAlphaTest > 0.0 && tex.a < uAlphaTest) discard;
  // Mode 2 keeps a flat sampled/raw-color comparison; modes 1 and 3 were computed per vertex.
  vec3 doodadLight = uModdLightMode > 1.5 && uModdLightMode < 2.5
    ? clamp(vInstanceTint.rgb * uModdScale, 0.0, 1.0)   // no floor, no sun
    : vDoodadLit;
  // Render flag 0x01 (unlit) has to win on the doodad path too. It only ever reached vLit, which
  // this selection discards for anything carrying a MODD tint — so every lamp flame, torch and glow
  // quad inside a WMO was multiplied by its parent's static light instead of rendering fullbright.
  // Measured on Azeroth_30_48: STORMWINDSTREETLAMP01 and TORCH both carry an unlit submesh and a
  // MODD tint of 0.129, so their flames rendered at ~0.39x.
  vec3 doodadTerm = mix(doodadLight, vec3(1.0), uUnlit);
  vec3 lightTerm = (uModdLightMode < 0.5 || uHasInstanceTint < 0.5) ? vLit : doodadTerm;
  vec3 c = tex.rgb * lightTerm; // gamma-space multiply, matches terrain + vanilla
  // Sun fog (GFX-85): identical lobe to the terrain shader so distant models fade into the
  // same warmed horizon instead of popping gray against it.
  float sunAlign = clamp(dot(normalize(vViewDir), uSunFogDir), 0.0, 1.0);
  vec3 fogColor = mix(uFogColor, uSunFogColor, pow(sunAlign, 8.0) * uSunFogStrength);
  float fogAmount = vFog * (1.0 - uUnfogged);
  // Additive particles must fade toward black/transparent in fog. Mixing in the
  // fog RGB creates bright rectangular sprites because additive black is neutral,
  // while an added fog colour is not.
  if (uAdditive > 0.5) {
    float visibility = 1.0 - fogAmount;
    c *= visibility;
    outColor = vec4(c, tex.a * visibility);
  } else {
    c = mix(c, fogColor, fogAmount);
    // Blend 0 (opaque) and 1 (alpha-key) must write 1.0 alpha: on those materials the
    // BLP alpha channel stores the specular/gloss map, not diffuse opacity. Passing it
    // through left sword/axe blades writing 0.2-0.6 into the framebuffer alpha, which
    // reads as a semi-transparent blade wherever destination alpha matters.
    float finalAlpha = uBlendMode <= 1.5 && uAnimatedOpacity < 0.5 ? 1.0 : tex.a;
    outColor = vec4(c, finalAlpha);
  }
  // Spirit/ghost form fade. Default 1.0 leaves every existing material untouched.
  outColor.a *= uGhostAlpha;
}
`;

export const textureHasUploadPayload = (texture: THREE.Texture): boolean =>
  Boolean(texture.image || texture.mipmaps?.length);

export function createM2Material(options: M2MaterialOptions): THREE.ShaderMaterial {
  const blend = options.blendMode ?? 0;
  const flags = options.renderFlags ?? 0;
  const texture = options.texture ?? null;
  if (texture && (texture.colorSpace !== THREE.NoColorSpace || texture.version === 0)) {
    // Sample raw sRGB bytes in gamma space (no decode); three sRGB-encodes once on output,
    // identical to the terrain pipeline so the whole world stays color-consistent.
    texture.colorSpace = THREE.NoColorSpace;
    // A shared, already-correct texture must not be uploaded again for each spell/submesh.
    if (textureHasUploadPayload(texture)) texture.needsUpdate = true;
  }
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    // Do not key this on Three's injected USE_INSTANCING define. Animated M2 and static doodad
    // materials share this shader source, and program reuse could then bind an instanceMatrix
    // attribute to ordinary character meshes, crashing the first in-world render. The explicit
    // define gives the two paths distinct, deterministic program-cache keys.
    defines: {
      ...(options.instanced ? { WOW_INSTANCED: 1 } : {}),
      ...(options.instanceTint ? { WOW_INSTANCE_TINT: 1 } : {}),
      ...(options.billboardPivot ? { WOW_BILLBOARD: 1 } : {}),
      ...(options.gpuSkinning ? { WOW_GPU_SKINNING: 1 } : {}),
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uMap: { value: texture },
      uHasMap: { value: texture ? 1 : 0 },
      // Only WMO doodads carry a MODD colour. The vertex stage defaults vInstanceTint to
      // vec4(1.0), which as a LIGHT term would render fullbright — so every other M2 (players,
      // creatures, spell effects) must keep using vLit regardless of the mode.
      uHasInstanceTint: { value: options.instanceTint ? 1 : 0 },
      uColor: { value: new THREE.Color(options.fallbackColor ?? 0xb3a07a) },
      // Vanilla alpha-key (blend 1) discards below ~224/255, not 0.5 — gives crisp hair/fur/foliage
      // edges instead of a fuzzy half-transparent fringe. (Shared by player, NPC and creature M2s.)
      uAlphaTest: { value: blend === 1 ? 0.878 : 0 },
      uUnlit: { value: flags & 0x01 ? 1 : 0 },
      // Per draw, because character materials are cached and shared by many unit instances.
      uSelected: { value: 0 },
      uObjectLight: { value: 0 },
      uObjectAmbient: { value: new THREE.Vector3() },
      uObjectDirectional: { value: new THREE.Vector3() },
      uObjectLightDir: { value: new THREE.Vector3(0.30822, 0.30822, 0.9) },
      uUnfogged: { value: flags & 0x02 ? 1 : 0 },
      uBillboardPivot: { value: new THREE.Vector3(...(options.billboardPivot ?? [0, 0, 0])) },
      uBoneTexture: { value: null },
      uEnvMap: { value: options.envMap ? 1 : 0 },
      // Per-material, NOT shared: each animated submesh scrolls on its own clock/period.
      uTexOffset: { value: new THREE.Vector2() },
      uAdditive: { value: blend === 3 || blend === 4 ? 1 : 0 },
      uBlendMode: { value: blend },
      uM2Color: { value: new THREE.Vector4(1, 1, 1, 1) },
      uAnimatedOpacity: { value: options.animatedOpacity ? 1 : 0 },
      uGhostAlpha: { value: 1 },
      // Shared light holders — same object refs across every M2 material (see setM2Light).
      // Wired individually rather than spread, so a new shared uniform MUST be added here or it
      // silently never reaches the shader.
      uModdLightMode: sharedLight.uModdLightMode,
      uModdSun: sharedLight.uModdSun,
      uModdScale: sharedLight.uModdScale,
      uModdFloor: sharedLight.uModdFloor,
      uSunDir: sharedLight.uSunDir,
      uSunColor: sharedLight.uSunColor,
      uSkyAmbient: sharedLight.uSkyAmbient,
      uGroundAmbient: sharedLight.uGroundAmbient,
      uFogColor: sharedLight.uFogColor,
      uFogNear: sharedLight.uFogNear,
      uFogFar: sharedLight.uFogFar,
      uHalfLambert: sharedLight.uHalfLambert,
      uSunFogDir: sharedLight.uSunFogDir,
      uSunFogStrength: sharedLight.uSunFogStrength,
      uSunFogColor: sharedLight.uSunFogColor,
      // Per material and rewritten by onBeforeRender. Shared holders would couple every visible
      // NPC/prop to the camera's room, which is the indoor/outdoor pop this path exists to prevent.
      uLocalCount: { value: 0 },
      uLocalPos: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      uLocalColor: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      uLocalAtten: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
    },
    // Vanilla M2 render flag 0x04 is the explicit no-cull switch. Forcing every material
    // double-sided exposed internal socket/scalp polygons and made hair intersect the head.
    side: options.forceDoubleSided || (flags & 0x04) ? THREE.DoubleSide : THREE.FrontSide,
    transparent: blend >= 2 || !!options.animatedOpacity,
    depthWrite: !(flags & 0x10) && blend <= 2 && !options.animatedOpacity,
    // Vanilla M2 blend enum: 0 opaque, 1 alpha-key, 2 alpha, 3 no-alpha add, 4 add,
    // 5 modulate, 6 modulate2x. (NOT "4 = Mod2x" — the shine/envmap passes are blend
    // 3/4 additive and must stay additive.) Mod2x needs src*dst + dst*src = 2·src·dst,
    // which plain MultiplyBlending (src·dst) can't express.
    blending:
      blend === 3 || blend === 4
        ? THREE.AdditiveBlending
        : blend === 5
          ? THREE.MultiplyBlending
          : blend === 6
            ? THREE.CustomBlending
            : THREE.NormalBlending,
    ...(blend === 6
      ? {
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.DstColorFactor,
          blendDst: THREE.SrcColorFactor,
        }
      : {}),
  });
  bindM2SelectionUniform(material);
  return material;
}

/**
 * Toggle spirit/ghost fade on M2 material(s). The world already desaturates + tints blue via the
 * .wow-ghost-world CSS filter; this adds the see-through translucency so the body reads as an
 * ethereal ghost. Uses the gated uGhostAlpha uniform (default 1 = untouched) plus a transparent,
 * no-depth-write pass. Call only on state change (it forces a shader recompile via needsUpdate).
 */
export function setMaterialGhost(material: THREE.Material | THREE.Material[], enabled: boolean, alpha = 0.5) {
  setM2MaterialOpacityLayer(material, 'death-ghost', enabled ? alpha : 1);
}
