/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ClientArchiveSet } from '@vanillagl/assets';
import { Map as WowMap, MapArea, Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { IoMode, openStream } from '@wowserhq/io';
import { encodePng } from '../utils/png.ts';
import { terrainTypeForTexture } from '../utils/terrain-sound-types.ts';

// @wowserhq drops MCSH (baked terrain shadows); reach into its ADT parser via file URL (bypasses
// the package "exports" restriction) to pull the raw 64x64 1-bit shadow map per chunk.
const fmtBase = new URL('../../node_modules/@wowserhq/format/dist/esm/', import.meta.url);
const adtIo: any = await import(new URL('map/io/adt.js', fmtBase).href);
const { indexChunks } = (await import(new URL('util.js', fmtBase).href)) as { indexChunks: (c: any) => any };

/** Per-chunk MCSH (512 bytes = 64x64 bits, 1 = shadowed), keyed by indexY*16+indexX; null if absent. */
function extractShadows(adtBytes: Uint8Array): (Uint8Array | null)[] {
  const out: (Uint8Array | null)[] = new Array(256).fill(null);
  try {
    const stream = openStream(adtBytes, IoMode.Read);
    const data = indexChunks(adtIo.adt.read(stream));
    stream.close();
    for (const mcnk of data.get('MCNK') ?? []) {
      const cd = indexChunks(mcnk.data);
      const mcsh = cd.get('MCSH') as Uint8Array | undefined;
      const ix = mcnk.header.indexX, iy = mcnk.header.indexY;
      if (mcsh && mcsh.length >= 512 && ix < 16 && iy < 16) out[iy * 16 + ix] = mcsh;
    }
  } catch { /* leave all-null -> fully lit */ }
  return out;
}

/** Per-chunk MCNK terrain hole masks. Vanilla uses 16 bits: a 4x4 grid, each bit hides a 2x2 quad region. */
function extractHoles(adtBytes: Uint8Array): Uint16Array {
  const out = new Uint16Array(256);
  try {
    const dv = new DataView(adtBytes.buffer, adtBytes.byteOffset, adtBytes.byteLength);
    const mcinRel = dv.getUint32(0x14 + 4, true);
    const mcin = 0x14 + mcinRel;
    if (mcin <= 0 || mcin + 8 + 16 * 256 > adtBytes.length) return out;
    for (let i = 0; i < 256; i++) {
      const chunkOff = dv.getUint32(mcin + 8 + i * 16, true);
      if (!chunkOff || chunkOff + 8 + 64 > adtBytes.length) continue;
      const header = chunkOff + 8;
      const ix = dv.getUint32(header + 4, true);
      const iy = dv.getUint32(header + 8, true);
      const holes = dv.getUint32(header + 60, true) & 0xffff;
      if (ix < 16 && iy < 16) out[iy * 16 + ix] = holes;
    }
  } catch {
    /* leave all zero */
  }
  return out;
}

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));
const TEX = 256; // each layer texture normalized to 256x256 (sampler2DArray needs uniform size)
const SPLAT = 64; // MCAL alpha is 64x64 per chunk
const ATLAS = 16 * SPLAT; // 1024

// (vertexStep * 0.125) * 8.0: UV 0..8 across one chunk, 16 chunks per tile.
const LAYER_SCALE = 16 * 8; // 128 repeats across the 533yd tile
const SURFACE = 512; // ~1.04 yards/cell: finer than a player footfall without bloating streamed tiles

/**
 * Vanilla TerrainType.Sound values used by FootstepTerrainLookup.dbc.
 * These are NOT TerrainType row IDs: e.g. Grass is row 5 but Sound=6.
 */
const wdtPath = (dir: string) => `World\\Maps\\${dir}\\${dir}.wdt`;

type CompressedMipFormat = 'dxt1' | 'dxt3';
type Tex = {
  w: number;
  h: number;
  data: Uint8Array;
  compressedFormat: CompressedMipFormat;
  compressedMips: Array<{ width: number; height: number; data: Uint8Array }>;
};

function decodeTexture(mpq: ClientArchiveSet, path: string, cache: Map<string, Tex | null>): Tex | null {
  if (cache.has(path)) return cache.get(path)!;
  let result: Tex | null = null;
  try {
    if (mpq.has(path)) {
      const blp = new Blp().load(mpq.extract(path));
      const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888); // RGBA byte order
      const compressed = blp.getImages();
      const compressedFormat =
        compressed[0]?.format === BLP_IMAGE_FORMAT.IMAGE_DXT1 ? 'dxt1'
        : compressed[0]?.format === BLP_IMAGE_FORMAT.IMAGE_DXT3 ? 'dxt3'
        : null;
      if (!compressedFormat || compressed.some((mip) =>
        mip.format !== (compressedFormat === 'dxt1' ? BLP_IMAGE_FORMAT.IMAGE_DXT1 : BLP_IMAGE_FORMAT.IMAGE_DXT3)
      )) throw new Error(`terrain texture ${path} is not a uniform DXT1/DXT3 mip chain`);
      result = {
        w: img.width,
        h: img.height,
        data: img.data,
        compressedFormat,
        compressedMips: compressed.map((mip) => ({ width: mip.width, height: mip.height, data: mip.data })),
      };
    }
  } catch {
    result = null;
  }
  cache.set(path, result);
  return result;
}

/** Nearest-resize an RGBA texture to size x size. */
function resizeTo(src: Tex, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(src.h - 1, ((y * src.h) / size) | 0);
    for (let x = 0; x < size; x++) {
      const sx = Math.min(src.w - 1, ((x * src.w) / size) | 0);
      const si = (sy * src.w + sx) * 4;
      const di = (y * size + x) * 4;
      out[di] = src.data[si];
      out[di + 1] = src.data[si + 1];
      out[di + 2] = src.data[si + 2];
      out[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

async function bakeTile(key: string, terrain: ClientArchiveSet, texture: ClientArchiveSet, mapCache: Map<string, WowMap>) {
  const dir = `${PUBLIC}/tiles/${key}`;
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
  if (/\.wdt$/i.test(meta.source)) {
    // Global-WMO map entries have no ADT terrain layers. Keep the shader metadata explicit so a
    // prior incremental bake cannot masquerade as authored terrain coverage.
    meta.shader = {
      ...(meta.shader ?? {}),
      layerScale: LAYER_SCALE,
      compressedMipFormat: null,
      mipLevels: 0,
      authoredMipStatus: 'not-applicable',
      surfaceTextures: [],
    };
    const compressedMipPath = `${dir}/tex_array_mips.bin`;
    if (existsSync(compressedMipPath)) rmSync(compressedMipPath);
    writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
    return { key, textures: 0 };
  }
  const mapDir: string = meta.dir ?? meta.source.split('\\')[2];
  let map = mapCache.get(mapDir);
  if (!map) {
    map = new WowMap().load(terrain.extract(wdtPath(mapDir)));
    mapCache.set(mapDir, map);
  }
  const area = new MapArea(map.layerSplatDepth).load(terrain.extract(meta.source));
  const adtBytes = terrain.extract(meta.source);
  const chunks = area.chunks;
  const shadows = extractShadows(adtBytes);
  const holes = extractHoles(adtBytes);

  const texCache = new Map<string, Tex | null>();
  const texIndex = new Map<string, number>();
  const texLayers: Uint8Array[] = [];
  const texSources: Tex[] = [];
  const texTerrainTypes: number[] = [];
  const texNames: string[] = [];
  const resolveTex = (name: string): number => {
    if (!name) return 255;
    if (texIndex.has(name)) return texIndex.get(name)!;
    const dec = decodeTexture(texture, name, texCache);
    if (!dec) {
      texIndex.set(name, 255);
      return 255;
    }
    const idx = texLayers.length;
    texLayers.push(resizeTo(dec, TEX));
    texSources.push(dec);
    texTerrainTypes.push(terrainTypeForTexture(name));
    texNames.push(name);
    texIndex.set(name, idx);
    return idx;
  };

  const chunkMap = new Uint8Array(16 * 16 * 4).fill(255);
  const splatAtlas = new Uint8Array(ATLAS * ATLAS * 4);
  // Separate atlas (not packed in splat alpha — a canvas getImageData round-trip clobbers RGB
  // where alpha is low, which would corrupt the splat blend). R = MCSH shadow: 255 lit, 0 shadowed.
  const shadowAtlas = new Uint8Array(ATLAS * ATLAS * 4);

  for (let ci = 0; ci < chunks.length && ci < 256; ci++) {
    const cx = ci % 16;
    const cy = (ci / 16) | 0;
    const layers = (chunks[ci].layers as any[]) ?? [];
    const cmi = (cy * 16 + cx) * 4;
    for (let k = 0; k < 4; k++) chunkMap[cmi + k] = k < layers.length ? resolveTex(layers[k].texture) : 255;

    const sh = shadows[cy * 16 + cx];
    for (let ly = 0; ly < SPLAT; ly++) {
      for (let lx = 0; lx < SPLAT; lx++) {
        const ai = ((cy * SPLAT + ly) * ATLAS + (cx * SPLAT + lx)) * 4;
        for (let k = 1; k <= 3; k++) {
          const sp = layers[k]?.splat as Uint8Array | null;
          splatAtlas[ai + (k - 1)] = sp ? sp[ly * SPLAT + lx] : 0;
        }
        splatAtlas[ai + 3] = 255;
        // MCSH: row-major 64x64 bits, LSB = westmost column; bit set = shadowed.
        const lit = sh ? (((sh[ly * 8 + (lx >> 3)] >> (lx & 7)) & 1) ? 0 : 255) : 255;
        shadowAtlas[ai] = shadowAtlas[ai + 1] = shadowAtlas[ai + 2] = lit;
        shadowAtlas[ai + 3] = 255;
      }
    }
  }

  const n = Math.max(1, texLayers.length);
  const strip = new Uint8Array(TEX * TEX * 4 * n);
  for (let i = 0; i < texLayers.length; i++) strip.set(texLayers[i], i * TEX * TEX * 4);

  writeFileSync(`${dir}/tex_array.png`, encodePng(TEX, TEX * n, strip));
  // Retain the authored BLP mip chain instead of asking WebGL to synthesize it from decoded mip 0.
  // Build 5875 terrain textures are DXT1 except one DXT3 alpha texture. A mixed array is promoted
  // losslessly to DXT3 by prefixing each DXT1 colour block with an opaque 64-bit alpha block.
  const sourceMipLevels = texSources.length
    ? Math.min(...texSources.map((source) => source.compressedMips.length))
    : 0;
  // sampler2DArray requires every layer at a mip level to have identical dimensions. Preserve the
  // raw authored chain only when the tile's BLPs already satisfy that requirement; otherwise leave
  // an explicit status and use the decoded compatibility array rather than mis-slicing source bytes.
  const authoredMipsCompatible = texSources.length > 0 && texSources.every((source) =>
    source.w === TEX
    && source.h === TEX
    && source.compressedMips.slice(0, sourceMipLevels).every((mip, level) =>
      mip.width === Math.max(1, TEX >> level) && mip.height === Math.max(1, TEX >> level)
    )
  );
  const compressedMipFormat: CompressedMipFormat | null = authoredMipsCompatible
    ? (texSources.some((source) => source.compressedFormat === 'dxt3') ? 'dxt3' : 'dxt1')
    : null;
  const mipLevels = authoredMipsCompatible ? sourceMipLevels : 0;
  const authoredMipStatus = texSources.length === 0
    ? 'not-applicable'
    : authoredMipsCompatible
      ? 'exact'
      : 'incompatible-source-dimensions';
  const compressedParts: Uint8Array[] = [];
  for (let level = 0; level < mipLevels; level++) {
    for (const source of texSources) {
      const mip = source.compressedMips[level];
      if (compressedMipFormat === 'dxt1' || source.compressedFormat === 'dxt3') {
        compressedParts.push(mip.data);
        continue;
      }
      const dxt3 = new Uint8Array((mip.data.length / 8) * 16);
      for (let sourceOffset = 0, targetOffset = 0; sourceOffset < mip.data.length; sourceOffset += 8, targetOffset += 16) {
        dxt3.fill(0xff, targetOffset, targetOffset + 8);
        dxt3.set(mip.data.subarray(sourceOffset, sourceOffset + 8), targetOffset + 8);
      }
      compressedParts.push(dxt3);
    }
  }
  const compressedBytes = new Uint8Array(compressedParts.reduce((sum, part) => sum + part.length, 0));
  let compressedOffset = 0;
  for (const part of compressedParts) {
    compressedBytes.set(part, compressedOffset);
    compressedOffset += part.length;
  }
  const compressedMipPath = `${dir}/tex_array_mips.bin`;
  if (compressedMipFormat && mipLevels > 0) {
    writeFileSync(compressedMipPath, compressedBytes);
  } else if (existsSync(compressedMipPath)) {
    // An incremental rebake of a source-empty placeholder must not retain a payload from an
    // older/non-empty source selection. The manifest records the explicit not-applicable state.
    rmSync(compressedMipPath);
  }
  // chunk_map as RAW bytes (16x16 RGBA = 4 layer-texture indices/chunk). Must stay raw: the client
  // can't round-trip it through a canvas (premultiplied storage corrupts RGB where the alpha = 4th
  // layer index is low). PNG kept too for debugging/preview only.
  writeFileSync(`${dir}/chunk_map.bin`, Buffer.from(chunkMap.buffer, chunkMap.byteOffset, chunkMap.byteLength));
  writeFileSync(`${dir}/holes.bin`, Buffer.from(holes.buffer, holes.byteOffset, holes.byteLength));
  writeFileSync(`${dir}/chunk_map.png`, encodePng(16, 16, chunkMap));
  writeFileSync(`${dir}/splat_atlas.png`, encodePng(ATLAS, ATLAS, splatAtlas));
  writeFileSync(`${dir}/shadow_atlas.png`, encodePng(ATLAS, ATLAS, shadowAtlas));
  const surfaceMap = new Uint8Array(SURFACE * SURFACE);
  const cellsPerChunk = SURFACE / 16;
  for (let sy = 0; sy < SURFACE; sy++) {
    const chunkY = Math.min(15, Math.floor(sy / cellsPerChunk));
    const localY = sy - chunkY * cellsPerChunk;
    const splatY = Math.min(63, Math.floor((localY + 0.5) * SPLAT / cellsPerChunk));
    for (let sx = 0; sx < SURFACE; sx++) {
      const chunkX = Math.min(15, Math.floor(sx / cellsPerChunk));
      const localX = sx - chunkX * cellsPerChunk;
      const splatX = Math.min(63, Math.floor((localX + 0.5) * SPLAT / cellsPerChunk));
      const cmi = (chunkY * 16 + chunkX) * 4;
      const ai = ((chunkY * SPLAT + splatY) * ATLAS + (chunkX * SPLAT + splatX)) * 4;
      const a1 = splatAtlas[ai] / 255;
      const a2 = splatAtlas[ai + 1] / 255;
      const a3 = splatAtlas[ai + 2] / 255;
      const weights = [
        (1 - a1) * (1 - a2) * (1 - a3),
        a1 * (1 - a2) * (1 - a3),
        a2 * (1 - a3),
        a3,
      ];
      let dominant = 0;
      for (let layer = 1; layer < 4; layer++) if (weights[layer] > weights[dominant]) dominant = layer;
      const textureIndex = chunkMap[cmi + dominant];
      surfaceMap[sy * SURFACE + sx] = textureIndex === 255 ? 0 : (texTerrainTypes[textureIndex] ?? 0);
    }
  }
  writeFileSync(`${dir}/surface_map.bin`, Buffer.from(surfaceMap.buffer, surfaceMap.byteOffset, surfaceMap.byteLength));
  meta.shader = {
    texCount: n, texSize: TEX, atlas: ATLAS, layerScale: LAYER_SCALE, surfaceResolution: SURFACE,
    compressedMipFormat, mipLevels, authoredMipStatus,
    surfaceTextures: texNames.map((name, index) => ({
      name,
      terrainType: texTerrainTypes[index],
      sourceWidth: texSources[index].w,
      sourceHeight: texSources[index].h,
      sourceMipLevels: texSources[index].compressedMips.length,
      compressedFormat: texSources[index].compressedFormat,
    })),
  };
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
  return { key, textures: texLayers.length };
}

async function main() {
  // Build 5875 resolves patch-4 -> patch-3 -> patch-2 -> patch -> base. Terrain and texture
  // shader assets must use the same archive precedence as the geometry/placement bakes.
  const terrain = await ClientArchiveSet.open(CACHE, ['terrain.MPQ']);
  const texture = await ClientArchiveSet.open(CACHE, ['texture.MPQ']);
  const mapCache = new Map<string, WowMap>();

  let keys: string[] = process.argv.slice(2);
  if (!keys.length) {
    const index = JSON.parse(readFileSync(`${PUBLIC}/index.json`, 'utf8'));
    keys = index.map((e: any) => e.key);
  }

  let failures = 0;
  for (const key of keys) {
    try {
      const r = await bakeTile(key, terrain, texture, mapCache);
      console.log(`${key}: ${r.textures} distinct textures -> tex_array/chunk_map/splat_atlas`);
    } catch (e) {
      failures++;
      console.log(`${key}: FAILED ${(e as Error).message}`);
    }
  }
  terrain.close();
  texture.close();
  if (failures > 0) throw new Error(`${failures} terrain shader tile(s) failed`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
