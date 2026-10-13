import * as THREE from 'three';
import { admitTextureUpload } from './texture-upload-admission';
import { loadPortableTextureArray } from './optimized-texture-loader';

export type TerrainArrayAssets = {
  texArrayUrl: string;
  texCount: number;
  texSize: number;
  compressedMipUrl?: string;
  compressedArrayUrl?: string;
  compressedMipFormat?: 'dxt1' | 'dxt3' | null;
  mipLevels?: number;
};
type Pixels = { data: Uint8Array<ArrayBuffer>; width: number; height: number };

/** The baker writes mip-major payloads, with every array layer contiguous within each level. */
export function decodeTerrainMipLayout(assets: TerrainArrayAssets, buffer: ArrayBuffer): THREE.CompressedArrayTexture {
  const { texSize, texCount, compressedMipFormat, mipLevels } = assets;
  if (!Number.isInteger(texSize) || texSize < 4 || (texSize & (texSize - 1)) !== 0
    || !Number.isInteger(texCount) || texCount < 1 || (compressedMipFormat !== 'dxt1' && compressedMipFormat !== 'dxt3')
    || mipLevels !== Math.log2(texSize) + 1) throw new Error('Incomplete or incompatible authored terrain mip chain');
  const source = new Uint8Array(buffer), mipmaps = [];
  const blockBytes = compressedMipFormat === 'dxt1' ? 8 : 16;
  let offset = 0;
  for (let level = 0; level < mipLevels; level++) {
    const width = Math.max(1, texSize >> level);
    const levelBytes = Math.ceil(width / 4) ** 2 * blockBytes * texCount;
    if (offset + levelBytes > source.length) throw new Error('Truncated terrain mip payload');
    mipmaps.push({ data: source.subarray(offset, offset + levelBytes), width, height: width });
    offset += levelBytes;
  }
  if (offset !== source.length) throw new Error('Unexpected trailing terrain mip bytes');
  // The terrain shader consumes RGB only. RGBA DXT1 avoids the less portable RGB-only enum.
  return new THREE.CompressedArrayTexture(mipmaps, texSize, texSize, texCount,
    compressedMipFormat === 'dxt1' ? THREE.RGBA_S3TC_DXT1_Format : THREE.RGBA_S3TC_DXT3_Format);
}

export async function loadTerrainTextureArray(
  assets: TerrainArrayAssets,
  supportsCompression: boolean,
  loadPixels: (url: string) => Promise<Pixels>,
  anisotropy: number,
): Promise<THREE.Texture> {
  const configure = (texture: THREE.Texture) => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = anisotropy; texture.needsUpdate = true;
    return texture;
  };
  const admitCompressed = (texture: THREE.CompressedArrayTexture, url: string) => admitTextureUpload(texture, `terrain-array:${url}`, {
    validate: (renderer) => {
      const gl = renderer.getContext(), error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Terrain array GPU upload failed: 0x${error.toString(16)}`);
    },
  });
  if (supportsCompression && assets.compressedMipUrl && assets.compressedMipFormat && assets.mipLevels) {
    let texture: THREE.CompressedArrayTexture | undefined;
    try {
      const response = await fetch(assets.compressedMipUrl);
      if (!response.ok) throw new Error(`Terrain mip request failed: ${response.status}`);
      texture = decodeTerrainMipLayout(assets, await response.arrayBuffer());
      configure(texture);
      await admitCompressed(texture, assets.compressedMipUrl);
      return texture;
    } catch (error) {
      texture?.dispose();
      console.warn('Authored terrain compression failed; using decoded terrain.', assets.compressedMipUrl, error);
    }
  }
  const compressionOff = typeof location !== 'undefined' && new URLSearchParams(location.search).get('terraincompression') === 'off';
  if (!compressionOff && assets.compressedArrayUrl) {
    let texture: THREE.CompressedArrayTexture | undefined;
    try {
      texture = await loadPortableTextureArray(assets.compressedArrayUrl);
      const image = texture.image as { width: number; height: number; depth: number };
      if (image.width !== assets.texSize || image.height !== assets.texSize || image.depth !== assets.texCount
        || (texture.mipmaps?.length ?? 0) !== Math.floor(Math.log2(assets.texSize)) + 1) throw new Error('Portable terrain array layout mismatch');
      configure(texture); await admitCompressed(texture, assets.compressedArrayUrl); return texture;
    } catch (error) {
      texture?.dispose(); console.warn('Portable terrain compression failed; using decoded terrain.', assets.compressedArrayUrl, error);
    }
  }
  const pixels = await loadPixels(assets.texArrayUrl);
  if (pixels.width !== assets.texSize || pixels.height !== assets.texSize * assets.texCount
    || pixels.data.length !== assets.texSize ** 2 * assets.texCount * 4) throw new Error('Invalid terrain texture strip dimensions');
  const texture = new THREE.DataArrayTexture(pixels.data, assets.texSize, assets.texSize, assets.texCount);
  texture.generateMipmaps = true;
  configure(texture);
  try { await admitTextureUpload(texture, `terrain-array:${assets.texArrayUrl}`); }
  catch (error) { texture.dispose(); throw error; }
  return texture;
}
