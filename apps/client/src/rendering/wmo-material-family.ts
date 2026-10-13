import * as THREE from 'three';
export type Draw = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
export type Mip = { data: Uint8Array; width: number; height: number };
const samplerFields = ['format', 'type', 'colorSpace', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'flipY', 'premultiplyAlpha'] as const;
export function textureKey(texture: THREE.CompressedTexture): string {
  return JSON.stringify([texture.image.width, texture.image.height, ...samplerFields.map(key => texture[key]),
    (texture.mipmaps ?? []).map(m => [m.width, m.height, (m as Mip).data.byteLength])]);
}
export function familyKey(mesh: Draw): string | null {
  if (mesh.userData.wmoPick?.kind !== 'wmoBatch' || !(mesh.material instanceof THREE.ShaderMaterial) || mesh.morphTargetInfluences?.length) return null;
  const material = mesh.material, texture = material.uniforms.uMap?.value as THREE.CompressedTexture;
  if (!material.visible || !material.colorWrite || material.wireframe || material.stencilWrite || material.clippingPlanes?.length ||
    material.transparent || !texture?.isCompressedTexture || !texture.mipmaps?.length
    || texture.format === THREE.RGB_S3TC_DXT1_Format || material.userData.wowSecondaryTexture
    || !material.fragmentShader.includes('texture(uMap, vUv)')
    || !material.vertexShader.includes('vUv = uv;')) return null;
  return JSON.stringify([mesh.parent?.uuid, mesh.userData.wmoPick.groupIndex, mesh.renderOrder, material.vertexShader, material.fragmentShader,
    mesh.layers.mask, material.side, material.blending, material.depthTest, material.depthWrite, material.depthFunc, material.alphaTest, material.alphaToCoverage, material.polygonOffset,
    material.polygonOffsetFactor, material.polygonOffsetUnits, material.userData.wowShader,
    Object.entries(material.uniforms).filter(([key]) => key !== 'uMap'), textureKey(texture)]);
}
export function packWmoTextureLayers(textures: THREE.CompressedTexture[]): THREE.CompressedArrayTexture {
  if (!textures.length || textures.length > 64 || textures.some(t => textureKey(t) !== textureKey(textures[0]))) {
    throw new Error('Incompatible or oversized WMO texture family');
  }
  const source = textures[0];
  const mipmaps = source.mipmaps!.map((mip, level) => {
    const bytes = (mip as Mip).data.byteLength, data = new Uint8Array(bytes * textures.length);
    textures.forEach((texture, layer) => data.set((texture.mipmaps![level] as Mip).data, bytes * layer));
    return { data, width: mip.width, height: mip.height };
  });
  const array = new THREE.CompressedArrayTexture(mipmaps, source.image.width, source.image.height, textures.length, source.format, source.type);
  for (const key of samplerFields) (array as unknown as Record<string, unknown>)[key] = source[key];
  array.generateMipmaps = false; array.needsUpdate = true;
  return array;
}
export function arrayMaterial(source: THREE.ShaderMaterial, array: THREE.CompressedArrayTexture): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial();
  material.copy(source);
  // Share uniform objects so existing world lighting updates reach merged materials.
  material.uniforms = { ...source.uniforms, uMapArray: { value: array } }; delete material.uniforms.uMap;
  material.vertexShader = 'in float wmoLayer; flat out float vWmoLayer;\n' + source.vertexShader.replace('vUv = uv;', 'vUv = uv; vWmoLayer = wmoLayer;');
  material.fragmentShader = source.fragmentShader.replace('uniform sampler2D uMap;', 'uniform highp sampler2DArray uMapArray; flat in float vWmoLayer;')
    .replace('texture(uMap, vUv)', 'texture(uMapArray, vec3(vUv, vWmoLayer))');
  return material;
}
