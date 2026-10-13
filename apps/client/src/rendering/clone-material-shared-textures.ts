import * as THREE from 'three';

/** Clone editable material state while borrowing textures from their existing owner/cache. */
export function cloneMaterialWithSharedTextures<T extends THREE.Material>(material: T): T {
  const clone = material.clone();
  if (!(material instanceof THREE.ShaderMaterial) || !(clone instanceof THREE.ShaderMaterial)) return clone;
  // UniformsUtils.clone clones Texture values too. Material.dispose does not dispose those
  // wrappers, so uploading them pins the source's WebGLTexture after its owner releases it.
  // Arrays already retain their elements in UniformsUtils; vectors/colors remain independent.
  for (const [name, uniform] of Object.entries(material.uniforms)) {
    if (uniform.value?.isTexture) clone.uniforms[name].value = uniform.value;
  }
  return clone;
}
