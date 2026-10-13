import * as THREE from 'three';

const supported = new WeakMap<THREE.WebGLRenderer, boolean>();

/** A cold-path pixel test, through the same renderer/initTexture path used by tile admission. */
export function terrainCompressionSupported(renderer: THREE.WebGLRenderer): boolean {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('terraincompression') === 'off') return false;
  const cached = supported.get(renderer);
  if (cached !== undefined) return cached;
  const gl = renderer.getContext();
  if (!gl.getExtension('WEBGL_compressed_texture_s3tc')) { supported.set(renderer, false); return false; }
  // Two distinct layers, with all mip levels down to 1x1. DXT endpoints use pure red/green,
  // avoiding decoder rounding ambiguity; both format availability and array sampling are tested.
  const mipmaps = [4, 2, 1].map((size) => {
    const data = new Uint8Array(16);
    data.set([0, 248, 0, 248, 0, 0, 0, 0], 0);
    data.set([224, 7, 224, 7, 0, 0, 0, 0], 8);
    return { data, width: size, height: size };
  });
  const textures = [new THREE.CompressedArrayTexture(mipmaps, 4, 4, 2, THREE.RGBA_S3TC_DXT1_Format),
    new THREE.CompressedArrayTexture(mipmaps.map(({ width, height, data }) => {
      const rgba = new Uint8Array(32).fill(255);
      rgba.set(data.subarray(0, 8), 8); rgba.set(data.subarray(8), 24);
      return { width, height, data: rgba };
    }), 4, 4, 2, THREE.RGBA_S3TC_DXT3_Format)];
  for (const texture of textures) texture.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
    uniforms: { map: { value: textures[0] }, level: { value: 0 } },
    vertexShader: 'void main(){gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: 'precision highp sampler2DArray; uniform sampler2DArray map; uniform int level; out vec4 color; void main(){color=texelFetch(map,ivec3(0,0,int(gl_FragCoord.x)),level);}',
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geometry, material));
  const target = new THREE.WebGLRenderTarget(2, 1, { depthBuffer: false, stencilBuffer: false });
  const previous = renderer.getRenderTarget();
  const autoClear = renderer.autoClear;
  let valid = true;
  try {
    // A prior unrelated GL error makes this probe fail conservatively; never enable from enums alone.
    valid = gl.getError() === gl.NO_ERROR;
    renderer.autoClear = true;
    renderer.setRenderTarget(target);
    const pixels = new Uint8Array(8), expected = [255, 0, 0, 255, 0, 255, 0, 255];
    const camera = new THREE.Camera();
    for (const texture of textures) {
      renderer.initTexture(texture);
      material.uniforms.map.value = texture;
      for (let level = 0; level < mipmaps.length && valid; level++) {
        material.uniforms.level.value = level;
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, 2, 1, pixels);
        valid = gl.getError() === gl.NO_ERROR && pixels.every((value, index) => value === expected[index]);
      }
    }
  } catch { valid = false; }
  finally {
    renderer.setRenderTarget(previous); renderer.autoClear = autoClear;
    for (const texture of textures) texture.dispose();
    material.dispose(); geometry.dispose(); target.dispose();
  }
  supported.set(renderer, valid);
  renderer.domElement.addEventListener('webglcontextrestored', () => supported.delete(renderer), { once: true });
  return valid;
}
