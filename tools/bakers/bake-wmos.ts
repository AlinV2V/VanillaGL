/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import {
  ClientArchiveSet,
  openClientArchive,
  openClientArchives,
  readVanillaM2,
  readM2Emitters,
  readM2TextureFilenames,
  readVanillaWmoLiquid,
  MpqArchive,
  type VanillaWmoLiquid,
} from '@vanillagl/assets';
import { Map as WowMap, MapArea, MapObj, MapObjGroup, Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { IoMode, openStream } from '@wowserhq/io';
import { encodePng } from '../utils/png.ts';
import { terrainTypeForTexture } from '../utils/terrain-sound-types.ts';
import { canonicalizeWmoDoodads, encodeWmoBinary, validateWmoBinaryMeta } from '../utils/wmo-binary.ts';
import { bakeM2TextureTransforms, type BakedM2Transform } from '../utils/bake-m2-material-animation.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));
const TILE = 533.33333;
const wdtPath = (dir: string) => `World\\Maps\\${dir}\\${dir}.wdt`;
const normPath = (p: string) => p.replace(/\//g, '\\');
const fmtBase = new URL('../../node_modules/@wowserhq/format/dist/esm/', import.meta.url);
const rootIo: any = await import(new URL('mapobj/io/root.js', fmtBase).href);
const { indexChunks } = (await import(new URL('util.js', fmtBase).href)) as { indexChunks: (chunks: any) => Map<string, any> };

function rawMaterials(bytes: Uint8Array): any[] {
  const stream = openStream(bytes, IoMode.Read);
  const materials = indexChunks(rootIo.root.read(stream)).get('MOMT') ?? [];
  stream.close();
  return materials;
}

type WmoBatch = {
  indexStart: number;
  indexCount: number;
  tex: number;
  tex2: number;
  shader: number;
  blendMode: number;
  flags: number;
};

type WmoLight = {
  type: number;                       // 0 omni/point, 1 spot, 2 directional, 3 ambient (MOLT)
  color: [number, number, number];    // RGB 0..1
  pos: [number, number, number];      // model-local space (same space as group positions)
  intensity: number;
  attenStart: number;
  attenEnd: number;
};

type WmoPortal = {
  firstVertex: number;
  vertexCount: number;
  normal: [number, number, number];
  distance: number;
};

type WmoPortalRelation = {
  portalIndex: number;
  groupIndex: number;
  side: number;
};

// v17 CAaBspNode, 16 bytes — byte-proven vs GoldshireInn_000.wmo raw MOBN
// (scratch/probe-mobn.ts: 15/15 nodes sane under this layout, 0 under the old one).
// flags low bits carry the split axis (0=X, 1=Y, 2=Z) and 4 marks a leaf; there is
// no separate "planeType" field. The old read had no posChild at all and pulled
// planeDist out of the faceStart u32, so pre-fix bakes carry unusable node data.
type WmoBspNode = {
  flags: number;      // split axis 0/1/2, or 4 = leaf
  negChild: number;   // node index, -1 = none
  posChild: number;   // node index, -1 = none
  faceCount: number;  // leaf: MOBR face refs
  faceStart: number;  // leaf: first MOBR index
  planeDist: number;  // split plane distance along the axis
};

type WmoGroupGeometry = {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  rawMocv: number[];                 // raw MOCV BGRA for per-model interior light sampling
  mopyFlags: number[];               // raw per-face flags; 0x08 faces cannot supply light
  indices: number[];
  collisionIndices: number[];
  collisionGroups: { terrainType: number; indices: number[] }[];
  batches: WmoBatch[];
  flags: number;                      // MOGP group flags (0x2000 INTERIOR, 0x08/0x40 EXTERIOR/_LIT)
  lightRefs: number[];                // MOLR indices into the model's `lights`
  portalStart: number;                // MOGP portalStart into root portalRelations (MOPR)
  portalCount: number;                // MOGP portalCount
  bspNodes: WmoBspNode[];             // MOBN camera/collision BSP nodes
  bspFaces: number[];                 // MOBR triangle-face refs
  bbox: [[number, number, number], [number, number, number]]; // model-local [min, max]
  liquid: VanillaWmoLiquid | null;
  placeholder?: boolean;              // inert index-preserving stand-in for an unparseable source group
};

type WmoModelJson = {
  name: string;
  groups: WmoGroupGeometry[];
  ambient: [number, number, number];  // MOHD ambient RGB 0..1 (interior floor)
  lights: WmoLight[];                 // root MOLT local lights
  portalVertices: number[];           // root MOPV float3 vertices
  portals: WmoPortal[];               // root MOPT portal plane definitions
  portalRelations: WmoPortalRelation[]; // root MOPR adjacency relations
};

type Part = { indices: number[]; tex: number; blendMode: number; renderFlags: number; xf: number };
type ParticleDef = {
  pos: [number, number, number]; bone: number; tex: string | null;
  blend: number; type: number; rows: number; cols: number; flags: number;
  speed: number; speedVar: number; vRange: number; hRange: number; gravity: number;
  life: number; rate: number; areaL: number; areaW: number; zSource: number;
};
type RibbonDef = {
  pos: [number, number, number]; bone: number; tex: (string | null)[];
  color: [number, number, number]; alpha: number; above: number; below: number;
  edgesPerSec: number; edgeLife: number; gravity: number; rows: number; cols: number;
};
type Mesh = {
  source: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  parts: Part[];
  texXf?: BakedM2Transform[];
  gs?: number[];
  collision?: { positions: number[]; indices: number[] };
  particles?: ParticleDef[];
  ribbons?: RibbonDef[];
};
type WmoDoodadSet = { name: string; startIndex: number; count: number };
type WmoDoodadPlacement = {
  name: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: number;
  color: [number, number, number, number];
};
type WmoDoodadData = { doodadSets: WmoDoodadSet[]; doodadPlacements: WmoDoodadPlacement[] };

type WmoDoodadLightSample = { z: number; rgb: [number, number, number] };


function sampleDoodadMocv(
  point: readonly number[],
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  mocvBgra: ArrayLike<number>,
  mopyFlags: ArrayLike<number>,
): WmoDoodadLightSample | null {
  let bestZ = -Infinity;
  let bestRgb: [number, number, number] | null = null;
  const faceCount = Math.floor(indices.length / 3);
  for (let face = 0; face < faceCount; face++) {
    if (((mopyFlags[face] ?? 0) & 0x08) !== 0) continue;
    const ia = indices[face * 3], ib = indices[face * 3 + 1], ic = indices[face * 3 + 2];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const v0x = bx - ax, v0y = by - ay;
    const v1x = cx - ax, v1y = cy - ay;
    const px = point[0] - ax, py = point[1] - ay;
    const denom = v0x * v1y - v1x * v0y;
    if (Math.abs(denom) < 1e-8) continue;
    const wb = (px * v1y - v1x * py) / denom;
    const wc = (v0x * py - px * v0y) / denom;
    const wa = 1 - wb - wc;
    if (wa < -1e-5 || wb < -1e-5 || wc < -1e-5) continue;
    const z = az * wa + bz * wb + cz * wc;
    if (z > point[2] + 1.5 || z < point[2] - 1760 || z <= bestZ) continue;
    bestZ = z;

    // with 8-bit barycentric weights. This float equivalent differs by less
    // than one byte while retaining the same triangle and authored colors.
    const channel = (bgraChannel: number) => Math.max(0, Math.min(255, Math.floor(
      mocvBgra[ia * 4 + bgraChannel] * wa +
      mocvBgra[ib * 4 + bgraChannel] * wb +
      mocvBgra[ic * 4 + bgraChannel] * wc,
    )));
    bestRgb = [channel(2), channel(1), channel(0)];
  }
  return bestRgb ? { z: bestZ, rgb: bestRgb } : null;
}

function rawMopy(bytes: Uint8Array): { flags: Uint8Array; materials: Uint8Array } {
  for (let offset = 0; offset + 8 <= bytes.length; offset++) {
    if (bytes[offset] !== 0x59 || bytes[offset + 1] !== 0x50 || bytes[offset + 2] !== 0x4f || bytes[offset + 3] !== 0x4d) {
      continue;
    }
    const size =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);
    if (size < 0 || size % 2 !== 0 || offset + 8 + size > bytes.length) continue;
    const flags = new Uint8Array(size / 2);
    const materials = new Uint8Array(size / 2);
    for (let face = 0; face < flags.length; face++) {
      flags[face] = bytes[offset + 8 + face * 2];
      materials[face] = bytes[offset + 8 + face * 2 + 1];
    }
    return { flags, materials };
  }
  return { flags: new Uint8Array(), materials: new Uint8Array() };
}

// Vanilla SMOPoly::isCollidable(): explicit collision faces, plus rendered non-detail faces.
function isCollidableMopy(flags: number): boolean {
  return (flags & 0x08) !== 0 || ((flags & 0x20) !== 0 && (flags & 0x04) === 0);
}

function findWmoChunk(data: Uint8Array, sig: string): { off: number; sz: number } | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset + 8 <= data.length; offset += 8 + dv.getUint32(offset + 4, true)) {
    const magic = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]).split('').reverse().join('');
    if (magic === sig) return { off: offset + 8, sz: dv.getUint32(offset + 4, true) };
  }
  return null;
}

function findWmoChunkIn(data: Uint8Array, sig: string, start: number, end: number): { off: number; sz: number } | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = start; offset + 8 <= end; offset += 8 + dv.getUint32(offset + 4, true)) {
    const magic = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]).split('').reverse().join('');
    if (magic === sig) return { off: offset + 8, sz: dv.getUint32(offset + 4, true) };
  }
  return null;
}

// Root WMO lighting (MOHD ambient + MOLT local lights). Offsets verified vs GoldshireInn.wmo raw bytes:
// ambient (14,16,19) @0x1C BGRA, nLights @0x0C, 10 lights @48-byte stride. See wmo_interior_lighting spec.
function parseWmoLighting(data: Uint8Array): {
  ambient: [number, number, number]; lights: WmoLight[]; ambBgr: [number, number, number]; wmoFlags: number;
} {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mohd = findWmoChunk(data, 'MOHD');
  let nLights = 0, wmoFlags = 0;
  const ambBgr: [number, number, number] = [0, 0, 0]; // raw 0..255 [B, G, R]
  if (mohd) {
    nLights = dv.getUint32(mohd.off + 0x0c, true);
    wmoFlags = dv.getUint16(mohd.off + 0x3c, true);
    ambBgr[0] = data[mohd.off + 0x1c]; ambBgr[1] = data[mohd.off + 0x1d]; ambBgr[2] = data[mohd.off + 0x1e];
  }
  // SKIP_BASE_COLOR (0x02) zeroes the ambient floor.
  const ambient: [number, number, number] = (wmoFlags & 0x02)
    ? [0, 0, 0]
    : [ambBgr[2] / 255, ambBgr[1] / 255, ambBgr[0] / 255];
  const molt = findWmoChunk(data, 'MOLT');
  const lights: WmoLight[] = [];
  if (molt) {
    const count = Math.min(nLights, Math.floor(molt.sz / 48));
    for (let i = 0; i < count; i++) {
      const o = molt.off + i * 48;
      lights.push({
        type: data[o],
        color: [data[o + 6] / 255, data[o + 5] / 255, data[o + 4] / 255], // BGRA -> RGB
        pos: [dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true)],
        intensity: dv.getFloat32(o + 0x14, true),
        attenStart: dv.getFloat32(o + 0x28, true),
        attenEnd: dv.getFloat32(o + 0x2c, true),
      });
    }
  }
  return { ambient, lights, ambBgr, wmoFlags };
}

function parseWmoPortals(data: Uint8Array): {
  portalVertices: number[];
  portals: WmoPortal[];
  portalRelations: WmoPortalRelation[];
} {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const portalVertices: number[] = [];
  const portals: WmoPortal[] = [];
  const portalRelations: WmoPortalRelation[] = [];

  const mopv = findWmoChunk(data, 'MOPV');
  if (mopv) {
    for (let o = mopv.off; o + 12 <= mopv.off + mopv.sz; o += 12) {
      portalVertices.push(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
    }
  }

  const mopt = findWmoChunk(data, 'MOPT');
  if (mopt) {
    for (let o = mopt.off; o + 20 <= mopt.off + mopt.sz; o += 20) {
      portals.push({
        firstVertex: dv.getUint16(o, true),
        vertexCount: dv.getUint16(o + 2, true),
        normal: [dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)],
        distance: dv.getFloat32(o + 16, true),
      });
    }
  }

  const mopr = findWmoChunk(data, 'MOPR');
  if (mopr) {
    for (let o = mopr.off; o + 8 <= mopr.off + mopr.sz; o += 8) {
      portalRelations.push({
        portalIndex: dv.getUint16(o, true),
        groupIndex: dv.getUint16(o + 2, true),
        side: dv.getInt16(o + 4, true),
      });
    }
  }

  return { portalVertices, portals, portalRelations };
}

// Per-group MOGP flags + bbox + MOLR refs + the exterior/interior vertex split (nBatchesA / MOBA.lastVertex)
// + the RAW MOCV vertex colors (BGRA, MOVT order — parsed here, NOT via @wowserhq, per BAKE_SOURCE_OF_TRUTH
// rule #1; verified equal to MOVT count and to the spec's raw "before" vectors).
function parseGroupLighting(data: Uint8Array): {
  flags: number;
  lightRefs: number[];
  doodadRefs: number[];
  bbox: [[number, number, number], [number, number, number]];
  beginSecond: number;
  mocv: number[];
  portalStart: number;
  portalCount: number;
  bspNodes: WmoBspNode[];
  bspFaces: number[];
} {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mogp = findWmoChunk(data, 'MOGP');
  if (!mogp) return {
    flags: 0,
    lightRefs: [],
    doodadRefs: [],
    bbox: [[0, 0, 0], [0, 0, 0]],
    beginSecond: 0,
    mocv: [],
    portalStart: 0,
    portalCount: 0,
    bspNodes: [],
    bspFaces: [],
  };
  const flags = dv.getUint32(mogp.off + 0x08, true);
  const bbox: [[number, number, number], [number, number, number]] = [
    [dv.getFloat32(mogp.off + 0x0c, true), dv.getFloat32(mogp.off + 0x10, true), dv.getFloat32(mogp.off + 0x14, true)],
    [dv.getFloat32(mogp.off + 0x18, true), dv.getFloat32(mogp.off + 0x1c, true), dv.getFloat32(mogp.off + 0x20, true)],
  ];
  const portalStart = dv.getUint16(mogp.off + 0x24, true);
  const portalCount = dv.getUint16(mogp.off + 0x26, true);
  const nBatchesA = dv.getUint16(mogp.off + 0x28, true);
  const subStart = mogp.off + 68, subEnd = mogp.off + mogp.sz;
  const molr = findWmoChunkIn(data, 'MOLR', subStart, subEnd);
  const lightRefs: number[] = [];
  if (molr) for (let k = 0; k < molr.sz / 2; k++) lightRefs.push(dv.getUint16(molr.off + k * 2, true));
  // MODR: u16 indices into the ROOT MODD array — which doodads this group owns. The reversed client
  // uses that group to choose live outdoor lighting (0x08/0x40), or to ray-sample the group's MOCV

  const modr = findWmoChunkIn(data, 'MODR', subStart, subEnd);
  const doodadRefs: number[] = [];
  if (modr) for (let k = 0; k < modr.sz / 2; k++) doodadRefs.push(dv.getUint16(modr.off + k * 2, true));
  let beginSecond = 0;
  const moba = findWmoChunkIn(data, 'MOBA', subStart, subEnd);
  if (nBatchesA > 0 && moba && moba.sz >= nBatchesA * 24) {
    beginSecond = dv.getUint16(moba.off + (nBatchesA - 1) * 24 + 0x14, true) + 1;
  }
  const mocvChunk = findWmoChunkIn(data, 'MOCV', subStart, subEnd);
  const mocv: number[] = [];
  if (mocvChunk) for (let i = 0; i < mocvChunk.sz; i++) mocv.push(data[mocvChunk.off + i]);

  const bspNodes: WmoBspNode[] = [];
  const mobn = findWmoChunkIn(data, 'MOBN', subStart, subEnd);
  if (mobn) {
    for (let o = mobn.off; o + 16 <= mobn.off + mobn.sz; o += 16) {
      bspNodes.push({
        flags: dv.getUint16(o, true),
        negChild: dv.getInt16(o + 2, true),
        posChild: dv.getInt16(o + 4, true),
        faceCount: dv.getUint16(o + 6, true),
        faceStart: dv.getUint32(o + 8, true),
        planeDist: dv.getFloat32(o + 12, true),
      });
    }
  }

  const bspFaces: number[] = [];
  const mobr = findWmoChunkIn(data, 'MOBR', subStart, subEnd);
  if (mobr) for (let k = 0; k < mobr.sz / 2; k++) bspFaces.push(dv.getUint16(mobr.off + k * 2, true));

  return { flags, lightRefs, doodadRefs, bbox, beginSecond, mocv, portalStart, portalCount, bspNodes, bspFaces };
}

// fix_vertex_colors (verified vs Goldshire test vectors) — bake authored MOCV into display vertex
// lighting. Exterior verts [i < beginSecond] fade by alpha; interior verts blend toward the baked
// light minus the ambient floor. In/out are BGRA byte arrays.
function fixVertexColors(
  bgra: number[], ambB: number, ambG: number, ambR: number, beginSecond: number, isExterior: boolean, wmoFlags: number,
): number[] {
  const n = bgra.length / 4;
  const out = bgra.slice();
  if (wmoFlags & 0x08) { // LIGHTEN_INTERIORS: alpha override only
    for (let i = beginSecond; i < n; i++) out[i * 4 + 3] = isExterior ? 255 : 0;
    return out;
  }
  const aB = (wmoFlags & 0x02) ? 0 : ambB, aG = (wmoFlags & 0x02) ? 0 : ambG, aR = (wmoFlags & 0x02) ? 0 : ambR;
  const fl = Math.floor, mx = Math.max, mn = Math.min;
  for (let i = 0; i < Math.min(beginSecond, n); i++) {
    const c = i * 4;
    const B = mx(0, out[c] - aB), G = mx(0, out[c + 1] - aG), R = mx(0, out[c + 2] - aR), af = out[c + 3] / 255;
    out[c + 2] = mx(0, fl((R - af * R) / 2));
    out[c + 1] = mx(0, fl((G - af * G) / 2));
    out[c] = mx(0, fl((B - af * B) / 2));
  }
  for (let i = beginSecond; i < n; i++) {
    const c = i * 4;
    const B = out[c], G = out[c + 1], R = out[c + 2], A = out[c + 3];
    out[c + 2] = mn(255, mx(0, fl((R * A / 64 + R - aR) / 2)));
    out[c + 1] = mn(255, mx(0, fl((G * A / 64 + G - aG) / 2)));
    out[c] = mn(255, mx(0, fl((B * A / 64 + B - aB) / 2)));
    out[c + 3] = isExterior ? 255 : 0;
  }
  return out;
}

function readCString(data: Uint8Array, offset: number, limit = data.length): string {
  let end = offset;
  while (end < limit && data[end] !== 0) end++;
  return new TextDecoder('ascii').decode(data.slice(offset, end));
}

function parseWmoDoodads(data: Uint8Array): WmoDoodadData {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mohd = findWmoChunk(data, 'MOHD');
  const mods = findWmoChunk(data, 'MODS');
  const modn = findWmoChunk(data, 'MODN');
  const modd = findWmoChunk(data, 'MODD');
  const doodadSets: WmoDoodadSet[] = [];
  const doodadPlacements: WmoDoodadPlacement[] = [];
  const doodadSetCount = mohd ? dv.getUint32(mohd.off + 24, true) : 0;

  if (mods) {
    const count = Math.min(doodadSetCount || Math.floor(mods.sz / 32), Math.floor(mods.sz / 32));
    for (let i = 0; i < count; i++) {
      const off = mods.off + i * 32;
      doodadSets.push({
        name: readCString(data, off, off + 20),
        startIndex: dv.getUint32(off + 20, true),
        count: dv.getUint32(off + 24, true),
      });
    }
  }

  if (modd && modn) {
    const names = data.slice(modn.off, modn.off + modn.sz);
    const count = Math.floor(modd.sz / 40);
    for (let i = 0; i < count; i++) {
      const off = modd.off + i * 40;
      const nameOff = dv.getUint32(off, true);
      doodadPlacements.push({
        name: readCString(names, nameOff),
        pos: [dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true), dv.getFloat32(off + 12, true)],
        rot: [
          dv.getFloat32(off + 16, true),
          dv.getFloat32(off + 20, true),
          dv.getFloat32(off + 24, true),
          dv.getFloat32(off + 28, true),
        ],
        scale: dv.getFloat32(off + 32, true) || 1,
        color: [data[off + 36], data[off + 37], data[off + 38], data[off + 39]],
      });
    }
  }

  return { doodadSets, doodadPlacements };
}

const normM2Name = (name: string) => normPath(name).replace(/\.(mdx|mdl)$/i, '.m2');

const quatMul = (a: readonly number[], b: readonly number[]): [number, number, number, number] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const quatNormalize = (q: readonly number[]): [number, number, number, number] => {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
};

const quatApply = (q: readonly number[], v: readonly number[]): [number, number, number] => {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
};

async function main() {
  console.log('=== bake-wmos (building extraction) ===');
  const key = process.argv[2] || process.env.TILE_KEY || readFileSync(`${PUBLIC}/.last-baked`, 'utf8').trim();
  const TILE_DIR = `${PUBLIC}/tiles/${key}`;
  const meta = JSON.parse(readFileSync(`${TILE_DIR}/meta.json`, 'utf8'));
  const tileIndex = JSON.parse(readFileSync(`${PUBLIC}/index.json`, 'utf8'));
  const tilePath: string = meta.source;
  const dir: string = meta.dir ?? tilePath.split('\\')[2] ?? 'Azeroth';
  const globalWmo = process.env.GLOBAL_WMO === '1';
  console.log(`baking WMOs for tile "${key}"`);

  const wmoMpq = await openClientArchive(CACHE, 'wmo.MPQ');
  const terrain = await openClientArchive(CACHE, 'terrain.MPQ');
  const models = await openClientArchive(CACHE, 'model.MPQ');
  const texture = await openClientArchive(CACHE, 'texture.MPQ');
  const interfaceMpq = await openClientArchive(CACHE, 'interface.MPQ');
  // Patches shadow the base archives (11,470 files in patch.MPQ alone); search them first so the
  // bake reads what the client loads. See openClientArchives in @vanillagl/assets.
  const patches = await openClientArchives(CACHE, []);
  // The texture arrays below already scan `patches` first, but the geometry reads went straight at a
  // single handle and so missed the overrides that matter most: patch.MPQ replaces 2,325 WMOs and
  // 2,090 terrain ADTs. Wrap each handle in a patch-first set; `has`/`extract` are unchanged.
  const terrainSet = new ClientArchiveSet([...patches, terrain]);
  const wmoSet = new ClientArchiveSet([...patches, wmoMpq]);
  const modelSet = new ClientArchiveSet([...patches, models]);

  const wdtBytes = terrainSet.extract(wdtPath(dir));
  const map = new WowMap().load(wdtBytes);
  const area = globalWmo ? null : new MapArea(map.layerSplatDepth).load(terrainSet.extract(tilePath));
  const centerX = globalWmo ? Number(meta.originX) - TILE / 2 : area!.chunks[0].position![0] - TILE / 2;
  const centerY = globalWmo ? Number(meta.originY) - TILE / 2 : area!.chunks[0].position![1] - TILE / 2;

  // Vanilla (1.12.1) MODF rotation is authored as Euler angles in DEGREES: [rotX(pitch), rotY(yaw),
  // rotZ(roll)] — verified against our own client's raw ADT bytes (yaw values exceed 180°, so not
  // radians). @wowserhq is a WotLK 3.3.5a parser; its getNormalizedDefRotation (+180 + axis order)
  // plus the old `-qw` bake negation rendered every building at 180°-yaw (door facing backwards).
  // We parse MODF ourselves and build the quaternion the vanilla way, keyed by uniqueId.
  const adtBytes = globalWmo ? wdtBytes : terrainSet.extract(tilePath);
  const adv = new DataView(adtBytes.buffer, adtBytes.byteOffset, adtBytes.byteLength);
  const findAdtChunk = (sig: string): { off: number; sz: number } | null => {
    const rev = sig.split('').reverse().join('');
    for (let i = 0x14; i < adtBytes.length - 8; i++) {
      if (String.fromCharCode(adtBytes[i], adtBytes[i + 1], adtBytes[i + 2], adtBytes[i + 3]) === rev) {
        return { off: i + 8, sz: adv.getUint32(i + 4, true) };
      }
    }
    return null;
  };
  const rawRotById = new Map<number, [number, number, number]>();
  const rawDoodadSetById = new Map<number, number>();
  const modfChunk = findAdtChunk('MODF');
  if (modfChunk) {
    const n = Math.floor(modfChunk.sz / 64); // 64-byte MODF entries
    for (let i = 0; i < n; i++) {
      const o = modfChunk.off + i * 64;
      const uid = adv.getUint32(o + 4, true); // uniqueId
      rawRotById.set(uid, [adv.getFloat32(o + 20, true), adv.getFloat32(o + 24, true), adv.getFloat32(o + 28, true)]);
      rawDoodadSetById.set(uid, adv.getUint16(o + 58, true));
    }
  }
  let objectDefs: any[] = area ? [...area.objDefs as any[]] : [];
  if (globalWmo) {
    const mwmoChunk = findAdtChunk('MWMO');
    if (!mwmoChunk || !modfChunk) throw new Error(`${dir}.wdt has no MWMO/MODF global WMO placement`);
    const names = new Map<number, string>();
    for (let offset = 0; offset < mwmoChunk.sz;) {
      let end = offset;
      while (end < mwmoChunk.sz && adtBytes[mwmoChunk.off + end] !== 0) end++;
      if (end > offset) names.set(offset, new TextDecoder('latin1').decode(adtBytes.slice(mwmoChunk.off + offset, mwmoChunk.off + end)));
      offset = end + 1;
    }
    objectDefs = [];
    for (let i = 0; i < Math.floor(modfChunk.sz / 64); i++) {
      const o = modfChunk.off + i * 64;
      const nameOffset = adv.getUint32(o, true);
      objectDefs.push({
        name: names.get(nameOffset) ?? names.values().next().value,
        id: adv.getUint32(o + 4, true),
        position: [adv.getFloat32(o + 8, true), adv.getFloat32(o + 12, true), adv.getFloat32(o + 16, true)],
        rotation: [0, 0, 0, 1],
      });
    }
  }
  /** Vanilla MODF Euler (degrees) -> placement quaternion [x,y,z,w] in our Z-up render space. */
  const vanillaQuat = (rotDeg: [number, number, number] | undefined, fallback: number[]): [number, number, number, number] => {
    if (!rotDeg) return [fallback[0], fallback[1], fallback[2], -fallback[3]]; // legacy fallback
    // +180°: our render space's model-forward is opposite WoW's, so a building authored at yaw Y
    // must be placed at Y+180 to face the right way (verified in-engine on the Northshire Abbey —
    // raw yaw alone rendered the door 180° backwards). This is a single, consistent axis-convention
    // offset, NOT @wowserhq's broken per-component +180 (which also swizzled sin/cos).
    const YAW_OFFSET = Math.PI;
    const [pitch, yaw, roll] = rotDeg.map((d) => (d * Math.PI) / 180);
    if (pitch === 0 && roll === 0) {
      const h = (yaw + YAW_OFFSET) / 2; // pure yaw about world-up (Z) — 95%+ of surface placements
      return [0, 0, Math.sin(h), Math.cos(h)];
    }
    // General case (pitch/roll present, e.g. dungeon props): compose intrinsic Y(yaw)·X(pitch)·Z(roll).
    const mul = (a: number[], b: number[]): [number, number, number, number] => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    const ax = (axis: [number, number, number], ang: number): number[] => {
      const s = Math.sin(ang / 2);
      return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)];
    };
    const qY = ax([0, 0, 1], yaw + YAW_OFFSET); // world-up (+180° model-forward convention)
    // Match Map.getNormalizedDefRotation: quat.fromEuler(rotZ, rotX, rotY + 180). Keep this
    // identical to the MDDF path so tilted buildings and their attached doodads agree.
    const qX = ax([0, 1, 0], pitch);
    const qZ = ax([1, 0, 0], roll);
    return mul(mul(qY, qX), qZ);
  };

  mkdirSync(`${TILE_DIR}/wmo_tex`, { recursive: true });
  mkdirSync(`${TILE_DIR}/wmo_doodad_tex`, { recursive: true });
  mkdirSync(`${TILE_DIR}/wmo_doodad_fx_tex`, { recursive: true });

  const texIndex = new Map<string, number>();
  const textureUrls: string[] = [];

  const resolveTexture = (name: string): number => {
    if (!name) return -1;
    const cleanName = normPath(name);
    if (texIndex.has(cleanName)) return texIndex.get(cleanName)!;
    
    let idx = -1;
    for (const [mpqName, mpq] of [
      ['texture', texture],
      ['models', models],
      ['terrain', terrain],
      ['interface', interfaceMpq],
      ['wmo', wmoMpq]
    ] as [string, MpqArchive][]) {
      if (!mpq.has(cleanName)) continue;
      try {
        const blp = new Blp().load(mpq.extract(cleanName));
        const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
        idx = textureUrls.length;
        writeFileSync(`${TILE_DIR}/wmo_tex/${idx}.png`, encodePng(img.width, img.height, img.data));
        textureUrls.push(`wmo_tex/${idx}.png`);
      } catch (e: any) {
        // console.error(`Failed to decode BLP "${cleanName}" in ${mpqName}:`, e.message);
        idx = -1;
      }
      break;
    }
    texIndex.set(cleanName, idx);
    return idx;
  };

  const doodadTexIndex = new Map<string, number>();
  const doodadTextureUrls: string[] = [];
  const resolveDoodadTexture = (name: string): number => {
    if (!name) return -1;
    const cleanName = normPath(name);
    if (doodadTexIndex.has(cleanName)) return doodadTexIndex.get(cleanName)!;
    let idx = -1;
    for (const mpq of [...patches, texture, models, terrain, interfaceMpq, wmoMpq] as MpqArchive[]) {
      if (!mpq.has(cleanName)) continue;
      try {
        const blp = new Blp().load(mpq.extract(cleanName));
        const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
        idx = doodadTextureUrls.length;
        writeFileSync(`${TILE_DIR}/wmo_doodad_tex/${idx}.png`, encodePng(img.width, img.height, img.data));
        doodadTextureUrls.push(`wmo_doodad_tex/${idx}.png`);
      } catch {
        idx = -1;
      }
      break;
    }
    doodadTexIndex.set(cleanName, idx);
    return idx;
  };
  const doodadEffectTexIndex = new Map<string, string | null>();
  const resolveDoodadEffectTexture = (name: string, modelPath: string): string | null => {
    if (!name) return null;
    const dir = modelPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    const baseName = name.split(/[\\/]/).pop() ?? name;
    const candidates = [
      name,
      normPath(name),
      `${dir}/${baseName}`.replace(/\//g, '\\'),
      `Textures\\${baseName}`,
    ];
    const found = candidates.find((c) => [texture, models, terrain, interfaceMpq, wmoMpq].some((mpq) => mpq.has(c)));
    const keyName = (found ?? name).toLowerCase();
    if (doodadEffectTexIndex.has(keyName)) return doodadEffectTexIndex.get(keyName)!;
    let ref: string | null = null;
    if (found) {
      for (const mpq of [...patches, texture, models, terrain, interfaceMpq, wmoMpq] as MpqArchive[]) {
        if (!mpq.has(found)) continue;
        try {
          const blp = new Blp().load(mpq.extract(found));
          const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
          const idx = doodadEffectTexIndex.size;
          writeFileSync(`${TILE_DIR}/wmo_doodad_fx_tex/${idx}.png`, encodePng(img.width, img.height, img.data));
          ref = `terrain/tiles/${key}/wmo_doodad_fx_tex/${idx}.png`;
        } catch {
          ref = null;
        }
        break;
      }
    }
    doodadEffectTexIndex.set(keyName, ref);
    return ref;
  };
  const toDoodadEffectAsset = (bytes: Uint8Array, modelPath: string) => {
    const emit = readM2Emitters(bytes);
    const texNames = readM2TextureFilenames(bytes);
    const texRef = (globalIdx: number) => resolveDoodadEffectTexture(texNames[globalIdx] ?? '', modelPath);
    const particles: ParticleDef[] = emit.particles.map((p) => ({
      pos: p.position, bone: p.bone, tex: texRef(p.textureIndex), blend: p.blendType, type: p.emitterType,
      rows: p.rows, cols: p.cols, flags: p.flags,
      speed: p.emissionSpeed, speedVar: p.speedVariation, vRange: p.verticalRange, hRange: p.horizontalRange,
      gravity: p.gravity, life: p.lifespan, rate: p.emissionRate, areaL: p.emissionAreaLength,
      areaW: p.emissionAreaWidth, zSource: p.zSource,
    }));
    const ribbons: RibbonDef[] = emit.ribbons.map((r) => ({
      pos: r.position, bone: r.bone, tex: r.textureIndices.map(texRef),
      color: r.color, alpha: r.alpha, above: r.above, below: r.below,
      edgesPerSec: r.edgesPerSecond, edgeLife: r.edgeLifetime, gravity: r.gravity, rows: r.rows, cols: r.cols,
    }));
    return { particles, ribbons };
  };

  const doodadMeshIndex = new Map<string, number>();
  const doodadMeshes: Mesh[] = [];
  const bakeDoodadMesh = (rawName: string): number => {
    const name = normM2Name(rawName);
    let mi = doodadMeshIndex.get(name);
    if (mi !== undefined) return mi;
    mi = -1;
    if (modelSet.has(name)) {
      try {
        const bytes = modelSet.extract(name);
        const effects = toDoodadEffectAsset(bytes, name);
        let m: ReturnType<typeof readVanillaM2> | null = null;
        try { m = readVanillaM2(bytes); } catch { m = null; }
        if (!m && !effects.particles.length && !effects.ribbons.length) throw new Error('no geometry or emitters');
        const positions = m ? Array.from(m.positions) : [];
        const normals = m ? Array.from(m.normals) : [];
        const uvs = m ? Array.from(m.uvs) : [];
        const parts: Part[] = [];
        if (m) {
          const subs = m.submeshes.length
            ? m.submeshes
            : [{ triangleStart: 0, triangleCount: m.indices.length, textureIndex: 0, textureTransform: -1, blendMode: 0, renderFlags: 0 }];
          for (const sub of subs) {
            const end = sub.triangleStart + sub.triangleCount;
            if (sub.triangleCount <= 0 || end > m.indices.length) continue;
            const texName = m.textures[sub.textureIndex]?.filename || m.textures.find((t) => t.filename)?.filename || '';
            parts.push({
              indices: Array.from(m.indices.subarray(sub.triangleStart, end)),
              tex: resolveDoodadTexture(texName),
              blendMode: sub.blendMode ?? 0,
              renderFlags: sub.renderFlags ?? 0,
              xf: sub.textureTransform ?? -1,
            });
          }
        }
        doodadMeshes.push({
          source: name,
          positions,
          normals,
          uvs,
          parts,
          ...(m?.textureTransforms.length ? { texXf: bakeM2TextureTransforms(m.textureTransforms), gs: Array.from(m.globalSequences) } : {}),
          ...(m?.collisionIndices.length ? {
            collision: {
              positions: Array.from(m.collisionPositions),
              indices: Array.from(m.collisionIndices),
            },
          } : {}),
          ...(effects.particles.length ? { particles: effects.particles } : {}),
          ...(effects.ribbons.length ? { ribbons: effects.ribbons } : {}),
        });
        mi = doodadMeshes.length - 1;
      } catch {
        mi = -1;
      }
    }
    doodadMeshIndex.set(name, mi);
    return mi;
  };

  const modelCache = new Map<string, number>();
  const bakedModels: WmoModelJson[] = [];
  const wmoDoodadsByModel = new Map<number, WmoDoodadData>();
  // Per baked model: the root-MODD indices whose owning group is EXTERIOR. Kept beside the doodad
  // data rather than folded into it so parseWmoDoodads stays a pure root-chunk read — the
  // classification only exists once every group file has been walked for its MODR.
  const doodadLightClassByModel = new Map<number, Map<number, number>>();
  const doodadLightSampleByModel = new Map<number, Map<number, WmoDoodadLightSample>>();
  const instances: { m: number; id: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }[] = [];
  const wmoDoodadInstances: {
    m: number; x: number; y: number; z: number;
    qx: number; qy: number; qz: number; qw: number;
    s: number; c: [number, number, number, number];
    /** Parent MODF unique id + root MODD index: stable raw-byte identity for corpus verification. */
    w: number; r: number;
    e?: number;
  }[] = [];
  let missingModels = 0;
  let missingGroups = 0;
  let missingWmoDoodads = 0;
  let collisionFaces = 0;

  for (const d of objectDefs) {
    const rawPath = normPath(d.name);
    let mi = modelCache.get(rawPath);
    
    if (mi === undefined) {
      mi = -1;
      if (wmoSet.has(rawPath)) {
        try {
          console.log(`Processing WMO: "${rawPath}"`);
          const rootBytes = wmoSet.extract(rawPath);
          const w = new MapObj().load(rootBytes);
          const rootMaterials = rawMaterials(rootBytes);
          const rootDoodads = parseWmoDoodads(rootBytes);
          const rootLighting = parseWmoLighting(rootBytes);
          const rootPortals = parseWmoPortals(rootBytes);
          
          // Resolve WMO root materials textures
          const wmoTexIndices = w.materials.map((m: any) => ({
            primary: resolveTexture(m.textures[0] || ''),
            secondary: resolveTexture(m.textures[1] || ''),
          }));

          const groups: WmoGroupGeometry[] = [];
          // Root-MODD index -> lighting class of the group that owns it, accumulated across every
          // group's MODR:
          //
          //   1 OUTDOOR       active constant ambient + directional SH, following time of day.
          //   0 LIT_INTERIOR  ray-sampled group MOCV, with raw MODD as the miss fallback.
          //
          // The discriminator is shared with the renderer's `wmoGroupUsesOutdoorLighting`, not a

          // 0x08 and 0x40 and does not inspect 0x2000. Stormwind combines 0x40 with 0x2000 on 115
          // groups; those surfaces already take the outdoor light, so a doodad standing on them
          // that keeps a static MODD term stays bright while the street around it darkens. Measured
          // on Stormwind.wmo
          // (tools/probe-wmo-group-flag-populations.ts): 1 group is 0x8-only and 115 are 0x40-only
          // (all also 0x2000, none shipping MOCV), against 190 genuinely interior lightmapped groups.
          const DOODAD_LIT_INTERIOR = 0, DOODAD_OUTDOOR = 1;
          const doodadLightClass = new Map<number, number>();
          const doodadLightSamples = new Map<number, WmoDoodadLightSample>();
          const baseName = rawPath.replace(/\.wmo$/i, '');

          // A group's array position IS its WMO group number: root portalRelations (MOPR) and each
          // group's portalStart/BSP refs address groups by index. Dropping a group on a missing file
          // or parse error would slide every later group one slot forward, filing its liquid/geometry
          // under a neighbour's group number (this is exactly the Undercity group-144 corruption).
          // Push an inert placeholder instead: it renders nothing, declares no portals, and keeps the
          // index aligned so downstream references still resolve to the correct group.
          const emptyWmoGroup = (): WmoGroupGeometry => ({
            positions: [], normals: [], uvs: [], colors: [], rawMocv: [], mopyFlags: [], indices: [],
            collisionIndices: [], collisionGroups: [], batches: [],
            flags: 0, lightRefs: [], portalStart: 0, portalCount: 0,
            bspNodes: [], bspFaces: [], bbox: [[0, 0, 0], [0, 0, 0]], liquid: null,
            placeholder: true,
          });

          for (let gi = 0; gi < w.groupInfo.length; gi++) {
            const groupPath = `${baseName}_${String(gi).padStart(3, '0')}.wmo`;
            if (!wmoSet.has(groupPath)) {
              missingGroups++;
              groups.push(emptyWmoGroup());
              continue;
            }

            try {
              const groupBytes = wmoSet.extract(groupPath);
              let g: MapObjGroup;
              try {
                g = new MapObjGroup(w.flags).load(groupBytes);
              } catch (e: any) {
                if (!String(e?.message).includes("reading 'lastVertex'")) throw e;
                // @wowserhq/format's legacy color fixer indexes one batch past the end for
                // several valid Vanilla groups. Preserve the raw authored colors so geometry
                // is not dropped; exact WMO color correction belongs in the renderer later.
                g = new MapObjGroup(w.flags | 0x08).load(groupBytes);
              }
              
              // Extract geometry arrays as standard JS arrays for JSON output
              const positions = Array.from(g.vertices);
              const normals = Array.from(g.normals);
              const uvs = Array.from(g.textureCoords);
              
              // Bake authored MOCV into display vertex lighting (verified fix_vertex_colors), then
              // repack BGRA -> RGBA. MOCV is parsed raw from the group bytes (parseGroupLighting), NOT
              // taken from @wowserhq (BAKE_SOURCE_OF_TRUTH rule #1). It is MOVT-ordered and verified to
              // match the MOVT vertex count, so it aligns 1:1 with g.vertices/g.positions.
              const groupLight = parseGroupLighting(groupBytes);
              const liquid = readVanillaWmoLiquid(groupBytes, rootLighting.wmoFlags);
              const isExterior = (groupLight.flags & (0x08 | 0x40)) !== 0;
              // Doodad lighting class — the SAME rule the renderer already applies to this group's
              // own surfaces (`usesOutdoorLighting`, world-tile-loader.ts:981). A doodad must be lit
              // like the room it stands in, so the two must not diverge.
              const usesOutdoorLighting = (groupLight.flags & (0x0008 | 0x0040)) !== 0;
              const groupDoodadClass = usesOutdoorLighting ? DOODAD_OUTDOOR : DOODAD_LIT_INTERIOR;
              // A doodad can be referenced by more than one group; take the strongest claim so a
              // prop in a doorway is never dimmer than the brighter room it also belongs to.
              for (const ref of groupLight.doodadRefs) {
                doodadLightClass.set(ref, Math.max(doodadLightClass.get(ref) ?? 0, groupDoodadClass));
              }
              const colors: number[] = [];
              if (groupLight.mocv.length > 0) {
                const fixed = fixVertexColors(
                  groupLight.mocv, rootLighting.ambBgr[0], rootLighting.ambBgr[1], rootLighting.ambBgr[2],
                  groupLight.beginSecond, isExterior, rootLighting.wmoFlags,
                );
                for (let i = 0; i < fixed.length; i += 4) colors.push(fixed[i + 2], fixed[i + 1], fixed[i], fixed[i + 3]);
              }

              const indices = Array.from(g.indices);
              const mopy = rawMopy(groupBytes);
              const mopyFlags = mopy.flags;
              if (!usesOutdoorLighting && groupLight.mocv.length === positions.length / 3 * 4) {
                for (const ref of groupLight.doodadRefs) {
                  const point = rootDoodads.doodadPlacements[ref]?.pos;
                  if (!point) continue;
                  const sample = sampleDoodadMocv(point, positions, indices, groupLight.mocv, mopyFlags);
                  const prior = doodadLightSamples.get(ref);
                  if (sample && (!prior || sample.z > prior.z)) doodadLightSamples.set(ref, sample);
                }
              }
              const faceCount = Math.floor(indices.length / 3);
              const collisionIndices: number[] = [];
              const collisionByTerrain = new Map<number, number[]>();
              if (mopyFlags.length !== faceCount) {
                console.warn(`  ${groupPath}: MOPY faces=${mopyFlags.length}, geometry faces=${faceCount}; collision omitted`);
              } else {
                for (let face = 0; face < faceCount; face++) {
                  if (!isCollidableMopy(mopyFlags[face])) continue;
                  const triangle = [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]];
                  collisionIndices.push(...triangle);
                  const materialIndex = mopy.materials[face];
                  const textureName = w.materials[materialIndex]?.textures?.[0] ?? '';
                  const terrainType = terrainTypeForTexture(textureName);
                  const bucket = collisionByTerrain.get(terrainType) ?? [];
                  bucket.push(...triangle);
                  collisionByTerrain.set(terrainType, bucket);
                }
                collisionFaces += collisionIndices.length / 3;
              }
              
              // Process batches
              const batches: WmoBatch[] = g.batches.map((b: any) => {
                // MOBA flag 0x02 moves the real material ID into the final bbox field.
                const materialIndex = (b.flags & 0x02) !== 0 ? b.boundingBox[5] : b.materialIndex;
                return {
                  indexStart: b.indexStart,
                  indexCount: b.indexCount,
                  tex: wmoTexIndices[materialIndex]?.primary ?? -1,
                  tex2: wmoTexIndices[materialIndex]?.secondary ?? -1,
                  // MOMT.shader is retained even though the shipped Vanilla corpus only uses 0/1.
                  // The 4/6 mapping proposed in NEXT_AGENT_BRIEF is absent from all 748 parsed roots.
                  shader: rootMaterials[materialIndex]?.shader ?? 0,
                  blendMode: rootMaterials[materialIndex]?.blend ?? 0,
                  flags: w.materials[materialIndex]?.flags ?? 0
                };
              });

              groups.push({
                positions,
                normals,
                uvs,
                colors,
                rawMocv: groupLight.mocv,
                mopyFlags: Array.from(mopyFlags),
                indices,
                collisionIndices,
                collisionGroups: [...collisionByTerrain].map(([terrainType, groupedIndices]) => ({ terrainType, indices: groupedIndices })),
                batches,
                flags: groupLight.flags,
                lightRefs: groupLight.lightRefs,
                portalStart: groupLight.portalStart,
                portalCount: groupLight.portalCount,
                bspNodes: groupLight.bspNodes,
                bspFaces: groupLight.bspFaces,
                bbox: groupLight.bbox,
                liquid,
              });
            } catch (e: any) {
              console.error(`  Error reading group ${groupPath}:`, e.message);
              missingGroups++;
              groups.push(emptyWmoGroup());
            }
          }

          // Skip huge WMOs (e.g. Stormwind City ~835k verts) that overlap a starting-zone tile but
          // aren't part of it — serialized as JSON floats they balloon a tile to 150 MB+ and can't be
          // streamed. Cap keeps zone buildings like Northshire Abbey (~26k) while dropping cities.
          const MAX_WMO_VERTS = Number(process.env.MAX_WMO_VERTS ?? 1000000);
          const modelVerts = groups.reduce((a, g) => a + g.positions.length / 3, 0);
          if (modelVerts > MAX_WMO_VERTS) {
            console.warn(`  SKIP oversized WMO ${rawPath}: ${Math.round(modelVerts)} verts > cap ${MAX_WMO_VERTS}`);
            mi = -1;
          } else {
            const bakedIndex = bakedModels.length;
            bakedModels.push({
              name: rawPath,
              groups,
              ambient: rootLighting.ambient,
              lights: rootLighting.lights,
              portalVertices: rootPortals.portalVertices,
              portals: rootPortals.portals,
              portalRelations: rootPortals.portalRelations,
            });
            mi = bakedIndex;
            if (rootDoodads.doodadPlacements.length) {
              wmoDoodadsByModel.set(mi, rootDoodads);
          doodadLightClassByModel.set(mi, doodadLightClass);
          doodadLightSampleByModel.set(mi, doodadLightSamples);
            }
          }
        } catch (e: any) {
          console.error(`Error reading WMO root ${rawPath}:`, e.message);
          missingModels++;
        }
      } else {
        console.warn(`WMO file not found in MPQ: "${rawPath}"`);
        missingModels++;
      }
      modelCache.set(rawPath, mi);
    }

    if (mi >= 0) {
      // Vanilla-correct quaternion from raw MODF degrees (see vanillaQuat), not @wowserhq WotLK normalization.
      const [qx, qy, qz, qw] = vanillaQuat(rawRotById.get(d.id), d.rotation);
      const instance = {
        m: mi,
        id: d.id,
        x: d.position[0] - centerX,
        y: d.position[1] - centerY,
        z: d.position[2],
        qx, qy, qz, qw,
      };
      instances.push(instance);

      const rootDoodads = wmoDoodadsByModel.get(mi);
      const lightClasses = doodadLightClassByModel.get(mi);
      const lightSamples = doodadLightSampleByModel.get(mi);
      if (rootDoodads?.doodadPlacements.length) {
        const selectedSetIndex = rawDoodadSetById.get(d.id) ?? 0;
        const selectedSet = rootDoodads.doodadSets[selectedSetIndex] ?? rootDoodads.doodadSets[0];
        const start = selectedSet ? selectedSet.startIndex : 0;
        const count = selectedSet ? selectedSet.count : rootDoodads.doodadPlacements.length;
        // Match the runtime WMO transform in main.ts: parent placement quaternion multiplied
        // directly by the local MODD quaternion, with no local axis/sign swizzle.
        const wmoQ = quatNormalize([qx, qy, qz, qw]);
        for (let i = start; i < Math.min(start + count, rootDoodads.doodadPlacements.length); i++) {
          const placement = rootDoodads.doodadPlacements[i];
          const m = bakeDoodadMesh(placement.name);
          if (m < 0) {
            missingWmoDoodads++;
            continue;
          }
          const local = quatApply(wmoQ, placement.pos);
          const localQ = quatNormalize(placement.rot);
          const finalQ = quatNormalize(quatMul(wmoQ, localQ));
          wmoDoodadInstances.push({
            m,
            x: instance.x + local[0],
            y: instance.y + local[1],
            z: instance.z + local[2],
            qx: finalQ[0],
            qy: finalQ[1],
            qz: finalQ[2],
            qw: finalQ[3],
            s: placement.scale || 1,
            // Retain the raw identity that produced this instance. `w` selects the parent MODF/WMO
            // placement and `r` selects its root MODD record, so the verifier can compare the baked
            // class and model path to raw Build-5875 MODR/MODN bytes instead of checking our own
            // source strings. Runtime rendering ignores both fields.
            w: d.id,
            r: i,
            // Interior CMapDoodadDef instances normally replace raw MODD RGB with the nearest

            // that ray misses; outdoor instances ignore both RGB sources and take live world light.
            c: [
              ...(lightClasses?.get(i)
                ? [placement.color[2], placement.color[1], placement.color[0]]
                : (lightSamples?.get(i)?.rgb ?? [placement.color[2], placement.color[1], placement.color[0]])),
              placement.color[3],
            ],
            // Lighting class of the group that owns this doodad (root MODD index `i`, via MODR).
            // 1 = outdoors (live world light); omitted = enclosed sampled/static path.
            ...(lightClasses?.get(i) ? { e: lightClasses.get(i) } : {}),
          });
        }
      }
    }
  }

  console.log(`WMO stats: uniqueModels=${bakedModels.length} textures=${textureUrls.length} instances=${instances.length} collisionFaces=${collisionFaces} missingModels=${missingModels} missingGroups=${missingGroups}`);
  console.log(`WMO doodads: uniqueMeshes=${doodadMeshes.length} textures=${doodadTextureUrls.length} instances=${wmoDoodadInstances.length} missing=${missingWmoDoodads}`);

  // Preserve the faithful full MODF payload at this stage. A large placement can be authored in
  // more than one overlapping ADT, and its world-space origin is not required to fall inside any
  // of those source ADTs (Monastery cemetery is the Build 5875 counterexample). The corpus-wide
  // canonicalize-wmo-owners pass deduplicates by map + MODF uniqueId after every source tile has
  // been baked; reducing to proxies here can erase every full copy before that pass can elect one.
  const encoded = encodeWmoBinary({ models: bakedModels, textures: textureUrls, instances });
  validateWmoBinaryMeta(encoded.meta, encoded.binary.byteLength);
  const metadata = JSON.stringify(encoded.meta);
  writeFileSync(`${TILE_DIR}/wmos.meta.json`, metadata);
  writeFileSync(`${TILE_DIR}/wmos.bin`, encoded.binary);
  console.log(`wrote wmos.bin (${(encoded.binary.byteLength / 1048576).toFixed(2)} MB) + metadata (${(metadata.length / 1048576).toFixed(2)} MB) + ${textureUrls.length} WMO textures`);

  const canonicalDoodads = canonicalizeWmoDoodads({ meshes: doodadMeshes, textures: doodadTextureUrls, instances: wmoDoodadInstances }, key, meta, tileIndex);
  const doodadJson = JSON.stringify(canonicalDoodads);
  writeFileSync(`${TILE_DIR}/wmo_doodads.json`, doodadJson);
  console.log(`wrote wmo_doodads.json (${(doodadJson.length / 1048576).toFixed(2)} MB) + ${doodadTextureUrls.length} WMO doodad textures`);

  wmoMpq.close();
  terrain.close();
  models.close();
  texture.close();
  interfaceMpq.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
