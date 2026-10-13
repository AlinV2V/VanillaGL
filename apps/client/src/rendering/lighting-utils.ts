import * as THREE from 'three';

export type RGB = [number, number, number];

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const scaleColor = (c: RGB, k: number): RGB => [clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k)];

// Desaturate toward perceptual luminance, then scale brightness. Used to tame the blue ambient.
export const adjustAmbient = (c: RGB, sat: number, k: number): RGB => {
  const lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const mix = (a: number) => lum + (a - lum) * sat;
  return [clamp01(mix(c[0]) * k), clamp01(mix(c[1]) * k), clamp01(mix(c[2]) * k)];
};

export const mixColor = (a: RGB, b: RGB, w: number): RGB => [
  a[0] + (b[0] - a[0]) * w,
  a[1] + (b[1] - a[1]) * w,
  a[2] + (b[2] - a[2]) * w,
];

// Rain is a neutral veil in the Build-5875 captures. Scaling the existing fog
// toward black made distant scenery darker instead of being washed into haze.
export const applyWeatherFogColor = (c: RGB, grade: number): RGB => mixColor(c, [0.42, 0.44, 0.46], 0.65 * clamp01(grade));

export const applyWeatherSky = (c: RGB, grade: number): RGB => mixColor(c, [0.45, 0.45, 0.45], 0.75 * grade);

const SKY_VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vec3 p = normalize(position);
  vDir = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
in vec3 vDir;
out vec4 outColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uSkyHorizon;
uniform vec3 uFogColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTwilight;
void main() {
  vec3 dir = normalize(vDir);
  float up = dir.z;
  vec2 horizontal = dir.xy;
  float horizontalLength = length(horizontal);
  float sunAlign = horizontalLength > 0.00001
    ? dot(horizontal / horizontalLength, normalize(uSunDir.xy))
    : 0.0;
  float sunsetSector = smoothstep(-0.35, 0.85, sunAlign);
  vec3 directionalHorizon = mix(uSkyMid, uSkyHorizon, sunsetSector);
  vec3 horizon = mix(uSkyHorizon, directionalHorizon, uTwilight);
  vec3 c;
  if (up >= 0.42) {
    c = mix(uSkyMid, uSkyTop, clamp((up - 0.42) / 0.58, 0.0, 1.0));
  } else if (up >= 0.08) {
    c = mix(horizon, uSkyMid, clamp((up - 0.08) / 0.34, 0.0, 1.0));
  } else if (up >= 0.0) {
    // Meet the active distance-fog colour at the geometric horizon. The dome itself remains
    // unfogged (it is at infinity); this narrow colour bridge removes the terrain/sky seam.
    c = mix(uFogColor, horizon, clamp(up / 0.08, 0.0, 1.0));
  } else {
    c = uFogColor;
  }
  float glow = pow(max(sunAlign, 0.0), 10.0) * uTwilight * (1.0 - smoothstep(0.05, 0.45, max(up, 0.0)));
  c = mix(c, uSunColor, glow * 0.35);
  outColor = vec4(c, 1.0);
}
`;

export const createSkyDome = (radius: number) => {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uSkyTop: { value: new THREE.Vector3(0.43, 0.62, 0.86) },
      uSkyMid: { value: new THREE.Vector3(0.56, 0.72, 0.88) },
      uSkyHorizon: { value: new THREE.Vector3(0.70, 0.78, 0.82) },
      uFogColor: { value: new THREE.Vector3(0.70, 0.78, 0.82) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Vector3(1, 0.75, 0.45) },
      uTwilight: { value: 0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  const update = (
    top: RGB,
    mid: RGB,
    horizon: RGB,
    fog: RGB = horizon,
    sunDir = new THREE.Vector3(-1, 0, 0),
    sunColor: RGB = [1, 0.75, 0.45],
    twilight = 0,
  ) => {
    material.uniforms.uSkyTop.value.set(top[0], top[1], top[2]);
    material.uniforms.uSkyMid.value.set(mid[0], mid[1], mid[2]);
    material.uniforms.uSkyHorizon.value.set(horizon[0], horizon[1], horizon[2]);
    material.uniforms.uFogColor.value.set(fog[0], fog[1], fog[2]);
    material.uniforms.uSunDir.value.copy(sunDir).normalize().multiplyScalar(-1);
    material.uniforms.uSunColor.value.set(sunColor[0], sunColor[1], sunColor[2]);
    material.uniforms.uTwilight.value = clamp01(twilight);
  };
  return { mesh, material, update };
};
