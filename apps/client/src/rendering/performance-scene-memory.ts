import * as THREE from 'three';

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
type TextureDetail = {
  name: string;
  width: number;
  height: number;
  format: number;
  type: number;
  mipLevels: number;
  compressed: boolean;
  estimatedBytes: number;
};

let lastCollectedAt = -Infinity;
let cached = {
  estimatedGeometryBytes: 0,
  estimatedTextureBytes: 0,
  textures: [] as TextureDetail[],
  collectionMs: 0,
  note: 'Estimates use unique CPU buffers and compressed payloads or RGBA8-equivalent texture dimensions; driver allocations are unavailable.',
};

const attributeArray = (attribute: Attribute): ArrayBufferView => {
  const interleaved = attribute as THREE.InterleavedBufferAttribute;
  return interleaved.isInterleavedBufferAttribute ? interleaved.data.array : (attribute as THREE.BufferAttribute).array;
};

export function estimateSceneMemory(
  geometries: ReadonlySet<THREE.BufferGeometry>,
  materials: ReadonlySet<THREE.Material>,
  extraAttributes: readonly Attribute[],
) {
  const now = performance.now();
  if (now - lastCollectedAt < 10_000) return cached;
  const started = now;
  const buffers = new Set<ArrayBufferLike>();
  let estimatedGeometryBytes = 0;
  const addAttribute = (attribute?: Attribute | null) => {
    if (!attribute) return;
    const array = attributeArray(attribute);
    if (!buffers.has(array.buffer)) { buffers.add(array.buffer); estimatedGeometryBytes += array.buffer.byteLength; }
  };
  for (const geometry of geometries) {
    addAttribute(geometry.index);
    for (const attribute of Object.values(geometry.attributes)) addAttribute(attribute);
    for (const attributes of Object.values(geometry.morphAttributes)) for (const attribute of attributes) addAttribute(attribute);
  }
  for (const attribute of extraAttributes) addAttribute(attribute);

  const textures = new Set<THREE.Texture>();
  const addTexture = (value: unknown) => { if ((value as THREE.Texture | undefined)?.isTexture) textures.add(value as THREE.Texture); };
  for (const material of materials) {
    for (const value of Object.values(material)) addTexture(value);
    const uniforms = (material as THREE.ShaderMaterial).uniforms;
    if (uniforms) for (const uniform of Object.values(uniforms)) addTexture((uniform as { value?: unknown }).value);
  }
  let estimatedTextureBytes = 0;
  const details: TextureDetail[] = [];
  for (const texture of textures) {
    const image = (Array.isArray(texture.image) ? texture.image[0] : texture.image) as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | undefined;
    const width = Number(image?.width ?? image?.naturalWidth ?? 0);
    const height = Number(image?.height ?? image?.naturalHeight ?? 0);
    const mipBytes = (texture.mipmaps ?? []).reduce((sum, mip) => sum + (((mip as { data?: ArrayBufferView }).data?.byteLength) ?? 0), 0);
    const estimatedBytes = mipBytes || Math.round(width * height * 4 * (texture.generateMipmaps ? 4 / 3 : 1));
    estimatedTextureBytes += estimatedBytes;
    details.push({ name: texture.name || texture.uuid, width, height, format: texture.format, type: texture.type,
      mipLevels: (texture.mipmaps?.length ?? 0), compressed: Boolean((texture as THREE.CompressedTexture).isCompressedTexture), estimatedBytes });
  }
  details.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
  lastCollectedAt = now;
  cached = { ...cached, estimatedGeometryBytes, estimatedTextureBytes, textures: details.slice(0, 24), collectionMs: Number((performance.now() - started).toFixed(3)) };
  return cached;
}
