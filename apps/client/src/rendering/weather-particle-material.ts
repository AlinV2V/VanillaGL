import * as THREE from 'three';

const WEATHER_PARTICLE_VERT = /* glsl */ `
in float aAlpha;
out vec2 vUv;
out float vAlpha;
out float vViewDepth;
void main() {
  vUv = uv;
  vAlpha = aAlpha;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -viewPosition.z;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const WEATHER_PARTICLE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vAlpha;
in float vViewDepth;
out vec4 outColor;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogFade;
void main() {
  vec4 texel = texture(uMap, vUv);
  float fog = smoothstep(uFogNear, max(uFogNear + 1.0, uFogFar), vViewDepth);
  float alpha = texel.a * uOpacity * vAlpha * mix(1.0, 1.0 - fog, uFogFade);
  if (alpha < 0.004) discard;
  outColor = vec4(texel.rgb * uColor, alpha);
}
`;

export type WeatherQuadGeometry = {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  uvs: Float32Array;
  alphas: Float32Array;
};

export const createWeatherQuadGeometry = (count: number): WeatherQuadGeometry => {
  const positions = new Float32Array(count * 4 * 3);
  const uvs = new Float32Array(count * 4 * 2);
  const alphas = new Float32Array(count * 4);
  const indices = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
    const vertex = i * 4;
    indices.set([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  return { geometry, positions, uvs, alphas };
};

export const loadWeatherTexture = (path: string) => {
  const texture = new THREE.TextureLoader().load(path);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
};

export const createWeatherParticleMaterial = (
  texturePath: string,
  color: number,
  opacity: number,
  options: { depthTest?: boolean; fogFade?: boolean } = {},
) => new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: WEATHER_PARTICLE_VERT,
  fragmentShader: WEATHER_PARTICLE_FRAG,
  uniforms: {
    uMap: { value: loadWeatherTexture(texturePath) },
    uColor: { value: new THREE.Color(color) },
    uOpacity: { value: opacity },
    uFogNear: { value: 0 },
    uFogFar: { value: 500 },
    uFogFade: { value: options.fogFade === false ? 0 : 1 },
  },
  transparent: true,
  depthWrite: false,
  depthTest: options.depthTest ?? true,
});

export const syncWeatherParticleFog = (material: THREE.ShaderMaterial, scene: THREE.Scene) => {
  if (!(scene.fog instanceof THREE.Fog)) {
    material.uniforms.uFogNear.value = 0;
    material.uniforms.uFogFar.value = 10_000;
    return;
  }
  material.uniforms.uFogNear.value = scene.fog.near;
  material.uniforms.uFogFar.value = scene.fog.far;
};
