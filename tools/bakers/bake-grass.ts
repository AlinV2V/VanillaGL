/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  BUILD_5875_GROUND_EFFECT_CELL_WIDTH,
  BUILD_5875_GROUND_EFFECT_CELL_SIDE,
  BUILD_5875_GROUND_EFFECT_DEFAULT_DENSITY,
  BUILD_5875_GROUND_EFFECT_HALF_CELL_WIDTH,
  BUILD_5875_GROUND_EFFECT_SENTINEL,
  BUILD_5875_GROUND_EFFECT_MODEL_SLOTS,
  BUILD_5875_WORLD_DETAIL,
  Build5875GroundEffectRandom,
  ClientArchiveSet,
  DbcFile,
  build5875CellIsHole,
  build5875CellSuppressesDoodads,
  build5875GroundEffectCellPasses,
  build5875PredTexLayer,
  groundEffectDetailTierForPass,
  readVanillaM2,
} from '@vanillagl/assets';
import { Map as WowMap, MapArea, Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { IoMode, openStream } from '@wowserhq/io';
import { encodePng } from '../utils/png.ts';

// Reach into @wowserhq's ADT parser (bypassing the package "exports" restriction) to read MCSH baked
// terrain shadows — the same source bake-terrain-shader.ts uses for shadow_atlas.png. Lets grass
// inherit the exact per-chunk shadow so a blade darkens like the ground it grows from.
const fmtBase = new URL('../../node_modules/@wowserhq/format/dist/esm/', import.meta.url);
const adtIo: any = await import(new URL('map/io/adt.js', fmtBase).href);
const { indexChunks } = (await import(new URL('util.js', fmtBase).href)) as { indexChunks: (c: any) => any };

type RawChunkDetailMaps = {
  indexX: number;
  indexY: number;
  index: number;
  predTex: number[];
  noEffectDoodad: Uint8Array;
  shadow: Uint8Array | null;
};


function extractRawChunkDetailMaps(adtBytes: Uint8Array): RawChunkDetailMaps[] {
  const stream = openStream(adtBytes, IoMode.Read);
  const data = indexChunks(adtIo.adt.read(stream));
  stream.close();
  const chunks = (data.get('MCNK') ?? []).map((mcnk: any) => {
    const indexX = Number(mcnk.header.indexX);
    const indexY = Number(mcnk.header.indexY);
    const predTex = Array.from(mcnk.header.predTex ?? [], Number);
    const noEffectDoodad = Uint8Array.from(mcnk.header.noEffectDoodad ?? []);
    if (indexX >= 16 || indexY >= 16 || predTex.length !== 8 || noEffectDoodad.length !== 8) {
      throw new Error(`invalid MCNK detail maps at ${indexX},${indexY}`);
    }
    const mcsh = indexChunks(mcnk.data).get('MCSH') as Uint8Array | undefined;
    return {
      indexX,
      indexY,
      index: indexY * 16 + indexX,
      predTex,
      noEffectDoodad,
      shadow: mcsh && mcsh.length >= 512 ? mcsh : null,
    };
  });
  if (chunks.length !== 256) throw new Error(`expected 256 MCNK detail maps, got ${chunks.length}`);
  return chunks;
}

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));
const TILE = 533.33333;

//      ---
// The client does NOT use a GRID^2 grid with one probabilistic spawn per cell. Per chunk it runs
// `frillDensity` cell-passes (CVar default 16, range 1..256), and each qualifying cell spawns the
// GroundEffectTexture `density` field as a literal COUNT of clumped doodads (default 8). Scale is a
// near-uniform 1.0 +/- 0.1, NOT 0.5..1.5 and NOT *0.7.


//


//


// against DAT_00c7b494 (frillDensity). High therefore means 48 sampled 8x8 cells PER CHUNK.
const FRILL_DENSITY_BY_DETAIL = BUILD_5875_WORLD_DETAIL.map((v) => v.frillDensity);
const FRILL_DENSITY = BUILD_5875_WORLD_DETAIL[2].frillDensity;
const wdtPath = (dir: string) => `World\\Maps\\${dir}\\${dir}.wdt`;
const GET_DBC_PATH = 'DBFilesClient\\GroundEffectTexture.dbc';
const GED_DBC_PATH = 'DBFilesClient\\GroundEffectDoodad.dbc';

// --- ground effect DBC chain ---
type EffectProfile = {
  id: number;
  slots: number[];
  doodads: number[];
  rawDensity: number;
  density: number;
};
type DbcEvidence = {
  groundEffectTexture: { path: string; sha256: string; records: number; fields: number };
  groundEffectDoodad: { path: string; sha256: string; records: number; fields: number };
};

function resolveModelPath(model: ClientArchiveSet, mdl: string): string | null {
  const base = mdl.replace(/\.(mdl|mdx|m2)$/i, '');
  for (const p of [`World\\NoDXT\\Detail\\${base}.m2`, `World\\Detail\\${base}.m2`, `World\\NoDLC\\Detail\\${base}.m2`]) {
    if (model.has(p)) return p;
  }
  return null;
}

type Tex = { w: number; h: number; data: Uint8Array };
type Part = { indices: number[]; tex: number };
type Mesh = { source: string; positions: number[]; uvs: number[]; parts: Part[] };

async function bakeTile(
  key: string,
  terrain: ClientArchiveSet,
  model: ClientArchiveSet,
  texture: ClientArchiveSet,
  mapCache: Map<string, WowMap>,
  effect: Map<number, EffectProfile>,
  doodadModel: Map<number, string>,
  dbcEvidence: DbcEvidence,
) {
  const dir = `${PUBLIC}/tiles/${key}`;
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
  if (!/\.adt$/i.test(meta.source ?? '')) {
    const diagnostics = {
      status: 'not-applicable',
      reason: 'tile is represented by a WDT global object rather than an ADT',
      source: meta.source ?? null,
      rawChunkCount: 0,
      rawTextureLayerCount: 0,
      rawGroundEffectLayerCount: 0,
      generatedInstances: 0,
      frillDensityByDetail: FRILL_DENSITY_BY_DETAIL,
      dbc: dbcEvidence,
    };
    writeFileSync(`${dir}/grass.json`, JSON.stringify({
      schemaVersion: 3,
      source: { map: meta.dir ?? null, adt: null },
      profiles: [],
      meshes: [],
      textures: [],
      instances: [],
      diagnostics,
    }));
    return { key, chunksWithGrass: 0, instances: 0, models: 0, diagnostics };
  }
  const mapDir: string = meta.dir ?? meta.source.split('\\')[2];
  let map = mapCache.get(mapDir);
  if (!map) { map = new WowMap().load(terrain.extract(wdtPath(mapDir))); mapCache.set(mapDir, map); }
  const adtBytes = terrain.extract(meta.source);
  const area = new MapArea(map.layerSplatDepth).load(adtBytes);
  const rawChunkMaps = extractRawChunkDetailMaps(adtBytes);
  if (area.chunks.length !== rawChunkMaps.length) {
    throw new Error(`MapArea/raw MCNK order mismatch: ${area.chunks.length}/${rawChunkMaps.length}`);
  }
  const heightBytes = readFileSync(`${dir}/heights.f32`);
  const innerHeightBytes = readFileSync(`${dir}/heights_inner.f32`);
  const heights = new Float32Array(
    heightBytes.buffer,
    heightBytes.byteOffset,
    heightBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const innerHeights = new Float32Array(
    innerHeightBytes.buffer,
    innerHeightBytes.byteOffset,
    innerHeightBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const N = meta.n, step = TILE / (N - 1), HALF = TILE / 2;
  const centerX = meta.originX - HALF, centerY = meta.originY - HALF;
  const triangleHeight = (
    x: number,
    y: number,
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
  ): number | null => {
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const wa = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator;
    const wb = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator;
    const wc = 1 - wa - wb;
    return wa >= -1e-6 && wb >= -1e-6 && wc >= -1e-6 ? wa * a[2] + wb * b[2] + wc * c[2] : null;
  };
  const sampleH = (rx: number, ry: number): number => {
    const rf = Math.max(0, Math.min(N - 1, (HALF - rx) / step));
    const cf = Math.max(0, Math.min(N - 1, (HALF - ry) / step));
    const r0 = Math.max(0, Math.min(N - 2, Math.floor(rf)));
    const c0 = Math.max(0, Math.min(N - 2, Math.floor(cf)));
    const r1 = Math.min(N - 1, r0 + 1), c1 = Math.min(N - 1, c0 + 1), fr = rf - r0, fc = cf - c0;
    const a: [number, number, number] = [0, 0, heights[r0 * N + c0]];
    const b: [number, number, number] = [1, 0, heights[r1 * N + c0]];
    const c: [number, number, number] = [1, 1, heights[r1 * N + c1]];
    const d: [number, number, number] = [0, 1, heights[r0 * N + c1]];
    const m: [number, number, number] = [0.5, 0.5, innerHeights[r0 * (N - 1) + c0]];
    return (
      triangleHeight(fr, fc, a, b, m)
      ?? triangleHeight(fr, fc, b, c, m)
      ?? triangleHeight(fr, fc, c, d, m)
      ?? triangleHeight(fr, fc, d, a, m)
      ?? m[2]
    );
  };
  // mesh + texture cache for grass models
  mkdirSync(`${dir}/grass_tex`, { recursive: true });
  const meshIndex = new Map<string, number>();
  const meshes: Mesh[] = [];
  const texIndex = new Map<string, number>();
  const textureUrls: string[] = [];
  const texCache = new Map<string, Tex | null>();
  const resolveTex = (name: string): number => {
    if (!name) return -1;
    if (texIndex.has(name)) return texIndex.get(name)!;
    let idx = -1;
    for (const mpq of [texture, model]) {
      if (!mpq.has(name)) continue;
      try {
        const blp = new Blp().load(mpq.extract(name));
        const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
        idx = textureUrls.length;
        writeFileSync(`${dir}/grass_tex/${idx}.png`, encodePng(img.width, img.height, img.data));
        textureUrls.push(`grass_tex/${idx}.png`);
      } catch { idx = -1; }
      break;
    }
    texIndex.set(name, idx);
    return idx;
  };
  const meshFor = (path: string): number => {
    if (meshIndex.has(path)) return meshIndex.get(path)!;
    let mi = -1;
    try {
      const m = readVanillaM2(model.extract(path));
      const parts: Part[] = [];
      const subs = m.submeshes.length ? m.submeshes : [{ triangleStart: 0, triangleCount: m.indices.length, textureIndex: 0 } as any];
      for (const sub of subs) {
        const end = sub.triangleStart + sub.triangleCount;
        if (sub.triangleCount <= 0 || end > m.indices.length) continue;
        const texName = m.textures[sub.textureIndex]?.filename || m.textures.find((t) => t.filename)?.filename || '';
        parts.push({ indices: Array.from(m.indices.subarray(sub.triangleStart, end)), tex: resolveTex(texName) });
      }
      meshes.push({ source: path, positions: Array.from(m.positions), uvs: Array.from(m.uvs), parts });
      mi = meshes.length - 1;
    } catch { mi = -1; }
    meshIndex.set(path, mi);
    return mi;
  };

  const instances: {
    m: number; x: number; y: number; z: number;
    qx: number; qy: number; qz: number; qw: number;
    s: number; sh: number; d: number; ge: number; gd: number; c: number;
  }[] = [];
  let chunksWithGrass = 0;
  const drops = {
    holes: 0,
    noEffect: 0,
    noPredTexEffect: 0,
    emptyModelSlot: 0,
    noDoodadRecord: 0,
    noModelPath: 0,
    noMesh: 0,
  };
  let candidateCells = 0;
  let qualifyingCells = 0;
  const chunkDiagnostics: Array<{
    index: number; indexX: number; indexY: number;
    textureLayers: number; groundEffectLayers: number; groundEffectIds: number[];
    predTex: number[]; noEffectDoodad: number[]; cellPasses: number[]; uniqueCells: number;
    candidateCells: number; qualifyingCells: number; generatedInstances: number;
  }> = [];
  const rawEffectLayerCounts = new Map<number, number>();
  for (const chunk of area.chunks.slice(0, 256)) {
    for (const layer of ((chunk.layers as any[]) ?? [])) {
      const id = Number(layer.effectId ?? layer.effect ?? BUILD_5875_GROUND_EFFECT_SENTINEL) & 0xffff;
      if (id !== BUILD_5875_GROUND_EFFECT_SENTINEL) {
        rawEffectLayerCounts.set(id, (rawEffectLayerCounts.get(id) ?? 0) + 1);
      }
    }
  }

  type Resolution = {
    doodadId: number; rawModel: string | null; resolvedPath: string | null;
    status: 'resolved' | 'missing-doodad-record' | 'missing-model' | 'parse-failed';
    mesh: number | null;
  };
  const resolutionByDoodad = new Map<number, Resolution>();
  for (const effectId of rawEffectLayerCounts.keys()) {
    const profile = effect.get(effectId);
    if (!profile) continue;
    for (const doodadId of profile.doodads) {
      if (resolutionByDoodad.has(doodadId)) continue;
      const rawModel = doodadModel.get(doodadId) ?? null;
      const resolvedPath = rawModel ? resolveModelPath(model, rawModel) : null;
      if (!rawModel) {
        resolutionByDoodad.set(doodadId, { doodadId, rawModel, resolvedPath, status: 'missing-doodad-record', mesh: null });
        continue;
      }
      if (!resolvedPath) {
        resolutionByDoodad.set(doodadId, { doodadId, rawModel, resolvedPath, status: 'missing-model', mesh: null });
        continue;
      }
      const mesh = meshFor(resolvedPath);
      resolutionByDoodad.set(doodadId, {
        doodadId, rawModel, resolvedPath,
        status: mesh >= 0 ? 'resolved' : 'parse-failed',
        mesh: mesh >= 0 ? mesh : null,
      });
    }
  }

  for (let ci = 0; ci < area.chunks.length && ci < 256; ci++) {
    const chunk = area.chunks[ci];
    const raw = rawChunkMaps[ci];
    const pos = chunk.position;
    if (!pos) continue;
    const layers = (chunk.layers as any[]) ?? [];
    if (!layers.length) continue;
    const layerEffectIds = layers.map(
      (layer) => Number(layer.effectId ?? layer.effect ?? BUILD_5875_GROUND_EFFECT_SENTINEL) & 0xffff,
    );
    const layerEffect = layerEffectIds.map((id) => effect.get(id));
    const random = new Build5875GroundEffectRandom(raw.indexX, raw.indexY);
    // Vanilla draws with replacement. Duplicate passes intentionally create local clusters.
    const cellPasses = build5875GroundEffectCellPasses(random, FRILL_DENSITY);
    const holes = (chunk as any).holes ?? 0;
    const beforeChunk = instances.length;
    let chunkQualifying = 0;
    for (let pass = 0; pass < FRILL_DENSITY; pass++) {
      candidateCells++;
      const { column, row } = cellPasses[pass];
      if (build5875CellIsHole(holes, column, row)) { drops.holes++; continue; }
      if (build5875CellSuppressesDoodads(raw.noEffectDoodad, column, row)) {
        drops.noEffect++;
        continue;
      }
      const layerIndex = build5875PredTexLayer(raw.predTex, column, row);
      const profile = layerEffect[layerIndex];
      const effectId = layerEffectIds[layerIndex] ?? BUILD_5875_GROUND_EFFECT_SENTINEL;
      if (!profile || effectId === BUILD_5875_GROUND_EFFECT_SENTINEL) {
        drops.noPredTexEffect++;
        continue;
      }
      qualifyingCells++;
      chunkQualifying++;
      for (let k = 0; k < profile.density; k++) {

        const localColumn = column * BUILD_5875_GROUND_EFFECT_CELL_WIDTH
          + random.nextSignedUnit() * BUILD_5875_GROUND_EFFECT_HALF_CELL_WIDTH
          + BUILD_5875_GROUND_EFFECT_HALF_CELL_WIDTH;
        const localRow = row * BUILD_5875_GROUND_EFFECT_CELL_WIDTH
          + random.nextSignedUnit() * BUILD_5875_GROUND_EFFECT_HALF_CELL_WIDTH
          + BUILD_5875_GROUND_EFFECT_HALF_CELL_WIDTH;
        const worldX = pos[0] - localRow;
        const worldY = pos[1] - localColumn;
        const rx = worldX - centerX, ry = worldY - centerY;
        const id = profile.slots[(k + pass) & (BUILD_5875_GROUND_EFFECT_MODEL_SLOTS - 1)];
        if (id < 0) { drops.emptyModelSlot++; continue; }
        const resolution = resolutionByDoodad.get(id);
        if (!resolution || resolution.status === 'missing-doodad-record') { drops.noDoodadRecord++; continue; }
        if (resolution.status === 'missing-model') { drops.noModelPath++; continue; }
        if (resolution.status !== 'resolved' || resolution.mesh === null) { drops.noMesh++; continue; }
        const mi = resolution.mesh;
        const shadowColumn = Math.min(63, Math.max(0, Math.round(localColumn * 1.92 - 0.5)));
        const shadowRow = Math.min(63, Math.max(0, Math.round(localRow * 1.92 - 0.5)));
        const litBit = raw.shadow
          ? (((raw.shadow[shadowRow * 8 + (shadowColumn >> 3)] >> (shadowColumn & 7)) & 1) ? 0 : 1)
          : 1;
        const shadowFactor = litBit * 0.3 + 0.7;
        const scale = 1 + random.nextSignedUnit() * 0.1;
        const yaw = random.nextSignedUnit() * Math.PI;
        // `d` = lowest Environment Detail setting at which the client would spawn this clump.
        instances.push({
          m: mi, x: rx, y: ry, z: sampleH(rx, ry),
          qx: 0, qy: 0, qz: Math.sin(yaw / 2), qw: Math.cos(yaw / 2),
          s: scale,
          sh: shadowFactor,
          d: groundEffectDetailTierForPass(pass),
          ge: effectId,
          gd: id,
          c: raw.index,
        });
      }
    }
    if (instances.length > beforeChunk) chunksWithGrass++;
    chunkDiagnostics.push({
      index: raw.index,
      indexX: raw.indexX,
      indexY: raw.indexY,
      textureLayers: layers.length,
      groundEffectLayers: layerEffectIds.filter((id) => id !== BUILD_5875_GROUND_EFFECT_SENTINEL).length,
      groundEffectIds: [...new Set(layerEffectIds.filter((id) => id !== BUILD_5875_GROUND_EFFECT_SENTINEL))],
      predTex: raw.predTex,
      noEffectDoodad: Array.from(raw.noEffectDoodad),
      cellPasses: cellPasses.map(({ column, row }) => row * BUILD_5875_GROUND_EFFECT_CELL_SIDE + column),
      uniqueCells: new Set(
        cellPasses.map(({ column, row }) => row * BUILD_5875_GROUND_EFFECT_CELL_SIDE + column),
      ).size,
      candidateCells: FRILL_DENSITY,
      qualifyingCells: chunkQualifying,
      generatedInstances: instances.length - beforeChunk,
    });
  }

  const profiles = [...rawEffectLayerCounts.entries()].sort((a, b) => a[0] - b[0]).map(([effectId, rawLayerCount]) => {
    const profile = effect.get(effectId);
    return {
      effectId,
      rawLayerCount,
      rawDensity: profile?.rawDensity ?? null,
      density: profile?.density ?? null,
      slots: profile?.slots ?? [],
      resolutions: (profile?.doodads ?? []).map((id) => resolutionByDoodad.get(id)),
      status: profile ? 'resolved' : 'missing-profile',
    };
  });
  const diagnostics = {
    status: 'ok',
    source: meta.source,
    rawChunkCount: Math.min(256, area.chunks.length),
    rawTextureLayerCount: area.chunks.slice(0, 256).reduce((sum, chunk) => sum + (((chunk.layers as any[]) ?? []).length), 0),
    rawGroundEffectLayerCount: [...rawEffectLayerCounts.values()].reduce((sum, value) => sum + value, 0),
    uniqueGroundEffectIds: rawEffectLayerCounts.size,
    candidateCells,
    qualifyingCells,
    generatedInstances: instances.length,
    generatedByDetail: FRILL_DENSITY_BY_DETAIL.map((_, level) => instances.filter((instance) => instance.d <= level).length),
    unresolvedProfiles: profiles.filter((profile) => profile.status !== 'resolved').map((profile) => profile.effectId),
    unresolvedDoodads: [...resolutionByDoodad.values()].filter((resolution) => resolution.status !== 'resolved'),
    drops,
    chunks: chunkDiagnostics,
    frillDensityByDetail: FRILL_DENSITY_BY_DETAIL,
    selectionRule: {
      cellGrid: '8x8 sampled with replacement; duplicate passes intentionally form clumps',
      modelSlot: '(spawnIndex + passIndex) & 3',
      rng: 'Build 5875 FUN_0044ea80/FUN_004531e0, seed (indexY << 16) | indexX',
      terrainLayer: 'MCNK.predTex[row] two-bit selector at column*2',
      suppression: 'MCNK.noEffectDoodad[row] bit column, plus row-major 4x4 hole mask',
    },
    dbc: dbcEvidence,
  };
  writeFileSync(`${dir}/grass.json`, JSON.stringify({
    schemaVersion: 3,
    source: { map: mapDir, adt: meta.source },
    profiles,
    meshes,
    textures: textureUrls,
    instances,
    diagnostics,
  }));
  return { key, chunksWithGrass, instances: instances.length, models: meshes.length, diagnostics };
}

async function main() {
  // Each set owns independent patch handles. Reusing one MpqArchive in three sets and closing every
  // set double-closes the shared StormLib handle.
  const terrain = await ClientArchiveSet.open(CACHE, ['terrain.MPQ']);
  const model = await ClientArchiveSet.open(CACHE, ['model.MPQ']);
  const texture = await ClientArchiveSet.open(CACHE, ['texture.MPQ']);
  const dbc = await ClientArchiveSet.open(CACHE, ['dbc.MPQ']);
  const getBytes = dbc.extract(GET_DBC_PATH);
  const gedBytes = dbc.extract(GED_DBC_PATH);
  const getDbc = new DbcFile(getBytes);
  const gedDbc = new DbcFile(gedBytes);
  const doodadModel = new Map<number, string>();
  // GroundEffectTexture slots are the model-table index at GroundEffectDoodad column 1, not that


  for (let i = 0; i < gedDbc.recordCount; i++) {
    doodadModel.set(gedDbc.getUint(i, 1), gedDbc.getString(i, 2));
  }
  const effect = new Map<number, EffectProfile>();
  for (let i = 0; i < getDbc.recordCount; i++) {
    const id = getDbc.getUint(i, 0);
    const slots = [1, 2, 3, 4].map((column) => getDbc.getInt(i, column));
    const rawDensity = getDbc.getInt(i, 5);
    effect.set(id, {
      id,
      slots,
      doodads: [...new Set(slots.filter((value) => value >= 0))],
      rawDensity,
      density: rawDensity === 0 ? BUILD_5875_GROUND_EFFECT_DEFAULT_DENSITY : rawDensity,
    });
  }
  const dbcEvidence: DbcEvidence = {
    groundEffectTexture: {
      path: GET_DBC_PATH,
      sha256: createHash('sha256').update(getBytes).digest('hex'),
      records: getDbc.recordCount,
      fields: getDbc.fieldCount,
    },
    groundEffectDoodad: {
      path: GED_DBC_PATH,
      sha256: createHash('sha256').update(gedBytes).digest('hex'),
      records: gedDbc.recordCount,
      fields: gedDbc.fieldCount,
    },
  };
  const mapCache = new Map<string, WowMap>();
  let keys = process.argv.slice(2);
  if (!keys.length) keys = JSON.parse(readFileSync(`${PUBLIC}/index.json`, 'utf8')).map((e: any) => e.key);
  let failures = 0;
  for (const key of keys) {
    try {
      const r = await bakeTile(key, terrain, model, texture, mapCache, effect, doodadModel, dbcEvidence);
      const unresolved = r.diagnostics.unresolvedDoodads?.length ?? 0;
      console.log(`${key}: ${r.chunksWithGrass} chunks, ${r.instances} grass instances, ${r.models} models, ${unresolved} unresolved doodads`);
    } catch (e) {
      failures++;
      console.error(`${key}: FAILED ${(e as Error).message}`);
    }
  }
  terrain.close();
  model.close();
  texture.close();
  dbc.close();
  if (failures) throw new Error(`${failures} grass tile bake(s) failed`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
