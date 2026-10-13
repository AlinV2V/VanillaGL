import * as THREE from 'three';
import { DEFAULT_SHADOW_STRENGTH, resolveShadowStrength, type TerrainLight } from '../terrain-shader';
/** Asset conversion utility. */
// One shared time holder referenced by every grass material — a single
// updateGrassTime() call per frame animates all clutter (same pattern as the
// shared M2 light block).
const sharedGrassTime = { value: 0 };

/** Advance the grass wind clock (call once per frame with the frame delta). */
export function updateGrassTime(dt: number): void {
  sharedGrassTime.value += dt;
}

/** Only reject whole batches beyond every material's fade, including the shader's wind offset. */
export function grassBatchDrawDistance(materials: readonly THREE.Material[]): number | undefined {
  let farthest = 0;
  for (const material of materials) {
    if (!(material instanceof THREE.ShaderMaterial)) return undefined;
    const end = Number(material.uniforms.uFadeEnd?.value);
    if (!Number.isFinite(end) || end <= 0 || !(Number(material.uniforms.uAlphaTest?.value) > 0)) return undefined;
    farthest = Math.max(farthest, end);
  }
  return farthest > 0 ? farthest + Math.hypot(0.10, 0.07) + 0.001 : undefined;
}

const VERT = /* glsl */ `
out vec2 vUv;
out vec3 vAmbient;
out vec3 vSun;
out float vFog;
out float vShadow;
out float vCamDist;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
uniform float uShadowStrength; // live MCSH strength (terrain-shader.ts DEFAULT_SHADOW_STRENGTH)
uniform float uBakedShadowStrength; // the strength instanceColor was baked at
void main() {
  vUv = uv;
  // Per-instance baked terrain shadow (grayscale instanceColor) so the clump darkens with the ground
  // beneath it instead of popping. The baker folded the terrain curve into the value
  // (baked = 1 - S*(1 - mcsh)); un-bake it back to the raw MCSH mask and re-apply the LIVE strength,
  // so the __wowLightTune.shadowStrength A/B moves grass and ground together with no re-bake.
  #ifdef USE_INSTANCING_COLOR
    float mcsh = uBakedShadowStrength > 0.0
      ? clamp(1.0 - (1.0 - instanceColor.r) / uBakedShadowStrength, 0.0, 1.0)
      : 1.0;
    vShadow = 1.0 - uShadowStrength * (1.0 - mcsh);
  #else
    vShadow = 1.0;
  #endif
  // Grass is drawn via InstancedMesh: a custom ShaderMaterial must apply instanceMatrix itself
  // (built-in materials do this in project_vertex; we don't get it for free). Without it every
  // blade collapses onto the tile origin and the grass vanishes.
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  // Wind sway: the clutter M2s ship an authored wind idle animation that the static
  // instanced path drops; approximate it with a gentle tip-weighted oscillation.
  // Height mask keeps roots planted (clump-local z=0 at the ground); world-position
  // phase de-synchronizes neighboring clumps so the field ripples instead of marching.
  float heightMask = clamp(position.z * 1.4, 0.0, 1.0);
  float sway = heightMask * sin(uTime * 1.6 + wp.x * 0.35 + wp.y * 0.27);
  wp.xy += vec2(0.10, 0.07) * sway;
  float ndl = clamp(dot(vec3(0.0, 0.0, 1.0), normalize(-uSunDir)), 0.0, 1.0);
  vAmbient = uAmbient;
  vSun = uSunColor * ndl;
  float dist = length(wp.xyz - cameraPosition);
  vCamDist = dist;
  vec4 viewPos = viewMatrix * wp;
  float fogDepth = max(0.0, -viewPos.z);
  vFog = clamp((fogDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
  gl_Position = projectionMatrix * viewPos;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vAmbient;
in vec3 vSun;
in float vFog;
in float vShadow;
in float vCamDist;
out vec4 outColor;
uniform sampler2D uMap;
uniform float uAlphaTest;
uniform vec3 uFogColor;
uniform float uFadeStart;
uniform float uFadeEnd;
void main() {
  vec4 tex = texture(uMap, vUv);
  // Vanilla culls ground clutter at a much shorter range than terrain. Raising the effective alpha
  // cutout with distance erodes the blades and fades them out by uFadeEnd, instead of grass rendering
  // to the far tile edge (or popping). Works with the cutout (no translucency / sort order needed).
  float fade = clamp((uFadeEnd - vCamDist) / max(1.0, uFadeEnd - uFadeStart), 0.0, 1.0);
  if (tex.a * fade < uAlphaTest) discard;     // alpha-test cutout (vanilla 84/255) + distance fade
  // As on terrain, the authored MCSH value attenuates direct sun only. Keeping
  // ambient outside the mask prevents grass from becoming unnaturally black in shade.
  // Match the terrain shader: the ARB programs attenuate the FULL vertex-lit colour by the MCSH
  // factor, not the sun term alone. Grass must darken with the ground it grows from or clumps
  // float bright against their own shadow.
  vec3 lit = tex.rgb * vShadow * clamp(vAmbient + vSun, 0.0, 1.0);
  lit = mix(lit, uFogColor, vFog);
  outColor = vec4(lit, 1.0);
}
`;

export function createGrassMaterial(map: THREE.Texture, light: TerrainLight): THREE.ShaderMaterial {
  // Sample the BLP-derived texture raw (gamma space), exactly like the terrain texture array — no
  // sRGB decode — or grass would be brighter/different-hued than the ground it grows from.
  map.colorSpace = THREE.NoColorSpace;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    uniforms: {
      uMap: { value: map },
      uAlphaTest: { value: 84 / 255 },
      uSunDir: { value: light.sunDir.clone().normalize() },
      uSunColor: { value: new THREE.Vector3(...light.sunColor) },
      uAmbient: { value: new THREE.Vector3(...light.ambient) },
      uFogColor: { value: new THREE.Vector3(...light.fogColor) },
      uFogNear: { value: light.fogNear },
      uFogFar: { value: light.fogFar },
      // Clutter fade range in yards (scene units). Tunable; vanilla groundEffectDist is in this ballpark.
      uFadeStart: { value: 65 },
      uFadeEnd: { value: 95 },
      uTime: sharedGrassTime,
      uShadowStrength: { value: resolveShadowStrength() },
      uBakedShadowStrength: { value: DEFAULT_SHADOW_STRENGTH },
    },
  });
}

export function updateGrassMaterialLight(material: THREE.ShaderMaterial, light: TerrainLight): void {
  material.uniforms.uSunDir.value.copy(light.sunDir).normalize();
  material.uniforms.uSunColor.value.set(...light.sunColor);
  material.uniforms.uAmbient.value.set(...light.ambient);
  material.uniforms.uFogColor.value.set(...light.fogColor);
  material.uniforms.uFogNear.value = light.fogNear;
  material.uniforms.uFogFar.value = light.fogFar;
  material.uniforms.uShadowStrength.value = resolveShadowStrength();
}
