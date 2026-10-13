/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { ClientArchiveSet, openClientArchive, openClientArchives, MpqArchive } from '@vanillagl/assets';
import { Map as WowMap, MapArea, Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));

const N = 129; // height grid side
const TILE_YARDS = 533.33333;
const SPLAT_PX = 64; // vanilla MCAL alpha maps are 64x64 per chunk
const CHUNK_PX = Math.max(SPLAT_PX, Number(process.env.BAKE_CHUNK_PX ?? 128) | 0);
const TILE_PX = 16 * CHUNK_PX;
const TEX_REPEAT = 64; // how many times a tileset texture tiles across the whole tile

const wdtPath = (dir: string) => `World\\Maps\\${dir}\\${dir}.wdt`;
const adtPath = (dir: string, x: number, y: number) => `World\\Maps\\${dir}\\${dir}_${x}_${y}.adt`;

// vMaNGOS numeric map ids -> WDT directory name (the maps the user's characters live on).
const MAP_DIR: Record<number, string> = {
  0: 'Azeroth', 1: 'Kalimdor', 30: 'PVPZone01', 33: 'Shadowfang', 34: 'StormwindJail',
  36: 'DeadminesInstance', 43: 'WailingCaverns', 189: 'MonasteryInstances',
};
const DIR_MAP: Record<string, number> = {
  Azeroth: 0, Kalimdor: 1, PVPZone01: 30, Shadowfang: 33, StormwindJail: 34,
  DeadminesInstance: 36, WailingCaverns: 43, MonasteryInstances: 189,
};

/**
 * Find the ADT tile that contains a world (X, Y). The 64x64 grid runs from +17066 to -17066;
 * chunk[0] of a tile is its max-corner, so the tile covers [corner-TILE, corner]. We compute
 * the index, try both filename orderings, and keep the one whose origin actually brackets the
 * point — robust against the row/col naming ambiguity.
 */
function findTileForWorld(
  terrain: ClientArchiveSet,
  map: WowMap,
  dir: string,
  wx: number,
  wy: number,
): { name: string; area: MapArea; x: number; y: number; origin: Float32Array | number[] } | null {
  const ix = Math.floor(32 - wx / TILE_YARDS);
  const iy = Math.floor(32 - wy / TILE_YARDS);
  const eps = 1;
  for (const [a, b] of [[ix, iy], [iy, ix]] as Array<[number, number]>) {
    const name = adtPath(dir, a, b);
    if (!terrain.has(name)) continue;
    try {
      const area = new MapArea(map.layerSplatDepth).load(terrain.extract(name));
      const c0 = area.chunks[0]?.position;
      if (!c0) continue;
      if (wx <= c0[0] + eps && wx >= c0[0] - TILE_YARDS - eps && wy <= c0[1] + eps && wy >= c0[1] - TILE_YARDS - eps) {
        return { name, area, x: a, y: b, origin: c0 };
      }
    } catch {
      /* try next ordering */
    }
  }
  return null;
}

type Tex = { w: number; h: number; data: Uint8Array };

function buildHeights(area: MapArea): { grid: Float32Array; min: number; max: number } {
  const grid = new Float32Array(N * N);
  let min = Infinity;
  let max = -Infinity;
  const chunks = area.chunks;
  for (let ci = 0; ci < chunks.length; ci++) {
    const cx = ci % 16;
    const cy = (ci / 16) | 0;
    const base = chunks[ci].position?.[2] ?? 0;
    const mcvt = chunks[ci].vertexHeights;
    if (!mcvt) continue;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const h = base + mcvt[r * 17 + c];
        grid[(cy * 8 + r) * N + (cx * 8 + c)] = h;
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
  }
  return { grid, min, max };
}

function decodeTexture(mpq: ClientArchiveSet, path: string, cache: Map<string, Tex | null>): Tex | null {
  if (cache.has(path)) return cache.get(path)!;
  let result: Tex | null = null;
  try {
    if (mpq.has(path)) {
      const blp = new Blp().load(mpq.extract(path));
      const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888); // RGBA byte order
      result = { w: img.width, h: img.height, data: img.data };
    }
  } catch {
    result = null;
  }
  cache.set(path, result);
  return result;
}

function sample(t: Tex, u: number, v: number, out: number[]) {
  u -= Math.floor(u);
  v -= Math.floor(v);
  const x = u * t.w - 0.5;
  const y = v * t.h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const ix0 = ((x0 % t.w) + t.w) % t.w;
  const iy0 = ((y0 % t.h) + t.h) % t.h;
  const ix1 = ((x1 % t.w) + t.w) % t.w;
  const iy1 = ((y1 % t.h) + t.h) % t.h;
  const i00 = (iy0 * t.w + ix0) * 4;
  const i10 = (iy0 * t.w + ix1) * 4;
  const i01 = (iy1 * t.w + ix0) * 4;
  const i11 = (iy1 * t.w + ix1) * 4;
  for (let k = 0; k < 3; k++) {
    const a = t.data[i00 + k] + (t.data[i10 + k] - t.data[i00 + k]) * fx;
    const b = t.data[i01 + k] + (t.data[i11 + k] - t.data[i01 + k]) * fx;
    out[k] = a + (b - a) * fy;
  }
}

function sampleSplat(splat: Uint8Array, lx: number, ly: number) {
  const ax = Math.min(SPLAT_PX - 1, (lx * SPLAT_PX / CHUNK_PX) | 0);
  const ay = Math.min(SPLAT_PX - 1, (ly * SPLAT_PX / CHUNK_PX) | 0);
  return splat[ay * SPLAT_PX + ax] / 255;
}

/** Blend all chunk texture layers by their splat alpha maps into one tile texture. */
function buildBlendedTexture(area: MapArea, texMpq: ClientArchiveSet): { data: Uint8Array; size: number; layerTextures: number } {
  const cache = new Map<string, Tex | null>();
  const chunks = area.chunks;
  // Pre-decode each chunk's layer textures.
  const chunkTexs: (Tex | null)[][] = chunks.map((c) =>
    (c.layers as any[]).map((l) => decodeTexture(texMpq, l.texture, cache)),
  );

  const out = new Uint8Array(TILE_PX * TILE_PX * 4);
  const c = [0, 0, 0];
  const cc = [0, 0, 0];

  for (let oy = 0; oy < TILE_PX; oy++) {
    const cy = (oy / CHUNK_PX) | 0;
    const ly = oy % CHUNK_PX;
    const gV = (oy / TILE_PX) * TEX_REPEAT;
    for (let ox = 0; ox < TILE_PX; ox++) {
      const cx = (ox / CHUNK_PX) | 0;
      const lx = ox % CHUNK_PX;
      const gU = (ox / TILE_PX) * TEX_REPEAT;

      const ci = cy * 16 + cx;
      const layers = chunks[ci].layers as any[];
      const texs = chunkTexs[ci];

      // Base layer
      let r = 110, g = 110, b = 110;
      if (texs[0]) {
        sample(texs[0]!, gU, gV, c);
        r = c[0]; g = c[1]; b = c[2];
      }
      // Blend layers 1..3 by their splat alpha
      for (let k = 1; k < layers.length; k++) {
        const splat = layers[k].splat as Uint8Array | null;
        const t = texs[k];
        if (!splat || !t) continue;
        const a = sampleSplat(splat, lx, ly);
        if (a <= 0) continue;
        sample(t, gU, gV, cc);
        r += (cc[0] - r) * a;
        g += (cc[1] - g) * a;
        b += (cc[2] - b) * a;
      }

      const oi = (oy * TILE_PX + ox) * 4;
      out[oi] = r;
      out[oi + 1] = g;
      out[oi + 2] = b;
      out[oi + 3] = 255;
    }
  }
  return { data: out, size: TILE_PX, layerTextures: cache.size };
}

function resolveAdt(mpq: ClientArchiveSet, dir: string, x: number, y: number): string | null {
  let name = adtPath(dir, x, y);
  if (mpq.has(name)) return name;
  name = adtPath(dir, y, x);
  return mpq.has(name) ? name : null;
}

function parseTileKey(value: string): { dir: string; x: number; y: number } | null {
  const match = /^(.+)_(\d+)_(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { dir: match[1], x: Number(match[2]), y: Number(match[3]) };
}

async function main() {
  console.log('=== bake-tile (splatted) ===');
  // 2,070 of 2,352 ADTs and 5,889 textures are superseded by patch.MPQ; read patch-first or the
  // terrain bake ships geometry the client never loads. See openClientArchives in @vanillagl/assets.
  const patches = await openClientArchives(CACHE, []);
  const terrain = new ClientArchiveSet([...patches, await openClientArchive(CACHE, 'terrain.MPQ')]);
  const texture = new ClientArchiveSet([...patches, await openClientArchive(CACHE, 'texture.MPQ')]);

  // Targeted bake:
  //   BAKE_TILE=Azeroth_32_48
  //   BAKE_DIR=Azeroth BAKE_TX=32 BAKE_TY=48
  //   BAKE_MAP=<id> BAKE_WX=<worldX> BAKE_WY=<worldY>
  // Otherwise auto-select a scenic Azeroth tile (BAKE_DIR overrides the directory).
  const wx = process.env.BAKE_WX !== undefined ? Number(process.env.BAKE_WX) : undefined;
  const wy = process.env.BAKE_WY !== undefined ? Number(process.env.BAKE_WY) : undefined;
  const mapId = process.env.BAKE_MAP !== undefined ? Number(process.env.BAKE_MAP) : undefined;
  const explicitTile = process.env.BAKE_TILE ? parseTileKey(process.env.BAKE_TILE) : null;
  const explicitX = process.env.BAKE_TX !== undefined ? Number(process.env.BAKE_TX) : undefined;
  const explicitY = process.env.BAKE_TY !== undefined ? Number(process.env.BAKE_TY) : undefined;
  let dir = explicitTile?.dir ?? (mapId !== undefined ? (MAP_DIR[mapId] ?? 'Azeroth') : (process.env.BAKE_DIR ?? 'Azeroth'));
  const map = new WowMap().load(terrain.extract(wdtPath(dir)));

  let best: { name: string; area: MapArea; origin: Float32Array | number[] } | null = null;

  if (explicitTile || (explicitX !== undefined && explicitY !== undefined)) {
    const tileX = explicitTile?.x ?? explicitX;
    const tileY = explicitTile?.y ?? explicitY;
    if (tileX === undefined || tileY === undefined || !Number.isFinite(tileX) || !Number.isFinite(tileY)) {
      console.log('invalid explicit tile target; use BAKE_TILE=Azeroth_32_48 or BAKE_TX/BAKE_TY');
      terrain.close();
      texture.close();
      return;
    }
    const name = resolveAdt(terrain, dir, tileX, tileY);
    if (!name) {
      console.log(`no ${dir} ADT exists for tile (${tileX}, ${tileY})`);
      terrain.close();
      texture.close();
      return;
    }
    const area = new MapArea(map.layerSplatDepth).load(terrain.extract(name));
    best = { name, area, origin: area.chunks[0]?.position ?? [0, 0, 0] };
    console.log(`targeted tile: ${name}  origin=(${best.origin[0].toFixed(0)}, ${best.origin[1].toFixed(0)})`);
  } else if (wx !== undefined && wy !== undefined && Number.isFinite(wx) && Number.isFinite(wy)) {
    const found = findTileForWorld(terrain, map, dir, wx, wy);
    if (!found) {
      console.log(`no ${dir} tile brackets world (${wx}, ${wy})`);
      terrain.close();
      texture.close();
      return;
    }
    best = { name: found.name, area: found.area, origin: found.origin };
    console.log(`targeted tile: ${found.name}  origin=(${found.origin[0].toFixed(0)}, ${found.origin[1].toFixed(0)})  for world (${wx.toFixed(0)}, ${wy.toFixed(0)})`);
  } else {
    const tiles: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < map.availableAreas.length; i++) {
      if (map.availableAreas[i]) tiles.push({ x: i % 64, y: (i / 64) | 0 });
    }
    const sampleStep = Math.max(1, Math.floor(tiles.length / 60));
    let pick: { name: string; area: MapArea; relief: number; dd: number; layers: number } | null = null;
    for (let k = 0; k < tiles.length; k += sampleStep) {
      const name = resolveAdt(terrain, dir, tiles[k].x, tiles[k].y);
      if (!name) continue;
      let area: MapArea;
      try {
        area = new MapArea(map.layerSplatDepth).load(terrain.extract(name));
      } catch {
        continue;
      }
      const { min, max } = buildHeights(area);
      const relief = max - min;
      if (relief < 40 || relief > 500) continue;
      const distinct = new Set<string>();
      for (const ch of area.chunks) for (const l of ch.layers as any[]) distinct.add(l.texture);
      const score = area.doodadDefs.length + distinct.size * 40;
      if (!pick || score > pick.dd + pick.layers * 40) {
        pick = { name, area, relief, dd: area.doodadDefs.length, layers: distinct.size };
      }
    }
    if (!pick) {
      console.log('no suitable tile found');
      terrain.close();
      texture.close();
      return;
    }
    best = { name: pick.name, area: pick.area, origin: pick.area.chunks[0]?.position ?? [0, 0, 0] };
    console.log(`auto tile: ${pick.name}  relief=${pick.relief.toFixed(0)}yd  doodads=${pick.dd}  distinctTextures=${pick.layers}`);
  }

  // Per-tile output folder, keyed by the ADT filename (e.g. "Kalimdor_32_37").
  const key = best.name.split('\\').pop()!.replace(/\.adt$/i, '');
  const OUT = `${PUBLIC}/tiles/${key}`;
  mkdirSync(OUT, { recursive: true });

  const { grid, min, max } = buildHeights(best.area);
  writeFileSync(`${OUT}/heights.f32`, Buffer.from(grid.buffer));

  const blend = buildBlendedTexture(best.area, texture);
  const groundPng = encodePng(blend.size, blend.size, blend.data);
  writeFileSync(`${OUT}/ground.png`, groundPng);
  writeFileSync(`${CACHE}/_bake_ground.png`, groundPng);
  console.log(`ground.png: ${blend.size}x${blend.size} splatted (${blend.layerTextures} tileset textures)`);

  const mapNum = dir in DIR_MAP ? DIR_MAP[dir] : (mapId ?? -1);
  const meta = {
    key,
    n: N,
    tileSizeYards: TILE_YARDS,
    minHeight: min,
    maxHeight: max,
    source: best.name,
    map: mapNum,
    dir,
    // World coords of this tile's max-corner (chunk[0]); the client maps a character's
    // world (X,Y) into render space via centerX = originX - TILE/2, etc.
    originX: best.origin[0],
    originY: best.origin[1],
    doodads: best.area.doodadDefs.length,
    textureRepeat: 1, // ground.png already covers the whole tile (splat baked in)
  };
  writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));
  writeFileSync(`${PUBLIC}/.last-baked`, key);

  // Upsert into the tile index the client reads to find a character's tile.
  const indexPath = `${PUBLIC}/index.json`;
  const index: any[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
  const entry = { key, map: mapNum, dir, originX: best.origin[0], originY: best.origin[1], minHeight: min, maxHeight: max, source: best.name };
  const at = index.findIndex((e) => e.key === key);
  if (at >= 0) index[at] = entry;
  else index.push(entry);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));

  // local verification heightmap
  const rgba = new Uint8Array(N * N * 4);
  const range = max - min || 1;
  for (let i = 0; i < N * N; i++) {
    const v = Math.round(((grid[i] - min) / range) * 255);
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  writeFileSync(`${CACHE}/_bake_heightmap.png`, encodePng(N, N, rgba));

  terrain.close();
  texture.close();
  console.log(`\nbaked tile "${key}" -> ${OUT}  (height ${min.toFixed(0)}..${max.toFixed(0)} yd)`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
