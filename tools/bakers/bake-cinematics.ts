/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openClientArchive } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const DBC_DIR = process.env.DBC_SOURCE_DIR || join(process.cwd(), 'data', 'dbcs');
const OUT = fileURLToPath(new URL('../../apps/client/public/data/cinematics.json', import.meta.url));

const CAMERA_ARRAY_HEADER = 0x124;
const CAMERA_STRIDE = 0x7c;
/** M2SplineKey<C3Vector>: value, inTan, outTan. */
const SPLINE_KEY_VEC3 = 36;
/** M2SplineKey<float>. */
const SPLINE_KEY_F32 = 12;

interface Dbc {
  records: number;
  fields: number;
  rowSize: number;
  row(i: number): DataView;
  str(offset: number): string;
}

function readDbc(name: string, expectFields: number, expectRowSize: number): Dbc {
  const bytes = readFileSync(join(DBC_DIR, `${name}.dbc`));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0x43424457) throw new Error(`${name}.dbc: not WDBC`);
  const records = v.getUint32(4, true);
  const fields = v.getUint32(8, true);
  const rowSize = v.getUint32(12, true);
  const stringSize = v.getUint32(16, true);
  if (fields !== expectFields) throw new Error(`${name}.dbc has ${fields} columns, expected ${expectFields}`);
  if (rowSize !== expectRowSize) throw new Error(`${name}.dbc row size ${rowSize}, expected ${expectRowSize}`);
  const base = 20;
  const stringBase = base + records * rowSize;
  const strings = bytes.subarray(stringBase, stringBase + stringSize);
  return {
    records,
    fields,
    rowSize,
    row: (i) => new DataView(bytes.buffer, bytes.byteOffset + base + i * rowSize, rowSize),
    str: (offset) => {
      let end = offset;
      while (end < strings.length && strings[end] !== 0) end++;
      return Buffer.from(strings.subarray(offset, end)).toString('latin1');
    },
  };
}

type Vec3 = [number, number, number];
/** Slot 0 of the on-disk key. Slots 1/2 are deliberately not carried. */
interface SplineKeyVec3 { t: number; v: Vec3 }
interface SplineKeyF32 { t: number; v: number }

const r4 = (n: number) => +n.toFixed(4);

function readCameraBlock(bytes: Uint8Array, sourcePath: string) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== 'MD20') throw new Error(`${sourcePath}: magic ${magic}, expected MD20`);
  const version = v.getUint32(4, true);
  if (version !== 256) throw new Error(`${sourcePath}: M2 version ${version}, expected 256 (Build 5875)`);

  const count = v.getUint32(CAMERA_ARRAY_HEADER, true);
  const offset = v.getUint32(CAMERA_ARRAY_HEADER + 4, true);
  if (count !== 1) throw new Error(`${sourcePath}: ${count} cameras, expected exactly 1`);

  const vec = (p: number): Vec3 => [v.getFloat32(p, true), v.getFloat32(p + 4, true), v.getFloat32(p + 8, true)];

  const trackHeader = (o: number) => ({
    interpolation: v.getUint16(o, true),
    globalSequence: v.getInt16(o + 2, true),
    tsCount: v.getUint32(o + 0x0c, true),
    tsOffset: v.getUint32(o + 0x10, true),
    valCount: v.getUint32(o + 0x14, true),
    valOffset: v.getUint32(o + 0x18, true),
  });

  const readVec3Spline = (o: number, label: string): SplineKeyVec3[] => {
    const h = trackHeader(o);
    if (h.globalSequence >= 0) throw new Error(`${sourcePath}: ${label} track is on a global sequence`);
    if (h.valCount !== h.tsCount) {
      throw new Error(`${sourcePath}: ${label} valCount ${h.valCount} != tsCount ${h.tsCount}`);
    }
    const stride = h.interpolation >= 2 ? SPLINE_KEY_VEC3 : 12;
    const end = h.valOffset + h.tsCount * stride;
    if (end > bytes.length) throw new Error(`${sourcePath}: ${label} spline overruns file (${end} > ${bytes.length})`);
    const keys: SplineKeyVec3[] = [];
    for (let i = 0; i < h.tsCount; i++) {
      keys.push({ t: v.getUint32(h.tsOffset + i * 4, true), v: vec(h.valOffset + i * stride).map(r4) as Vec3 });
    }
    return keys;
  };

  const readF32Spline = (o: number, label: string): SplineKeyF32[] => {
    const h = trackHeader(o);
    if (h.valCount !== h.tsCount) {
      throw new Error(`${sourcePath}: ${label} valCount ${h.valCount} != tsCount ${h.tsCount}`);
    }
    const stride = h.interpolation >= 2 ? SPLINE_KEY_F32 : 4;
    const keys: SplineKeyF32[] = [];
    for (let i = 0; i < h.tsCount; i++) {
      keys.push({ t: v.getUint32(h.tsOffset + i * 4, true), v: r4(v.getFloat32(h.valOffset + i * stride, true)) });
    }
    return keys;
  };

  const o = offset;
  const positionTrack = o + 0x10;
  const targetTrack = o + 0x38;
  const rollTrack = o + 0x60;

  return {
    fov: r4(v.getFloat32(o + 0x04, true)),
    farClip: r4(v.getFloat32(o + 0x08, true)),
    nearClip: r4(v.getFloat32(o + 0x0c, true)),
    positionInterp: trackHeader(positionTrack).interpolation,
    position: readVec3Spline(positionTrack, 'position'),
    positionBase: vec(o + 0x2c).map(r4) as Vec3,
    target: readVec3Spline(targetTrack, 'target'),
    targetBase: vec(o + 0x54).map(r4) as Vec3,
    roll: readF32Spline(rollTrack, 'roll'),
  };
}

async function main() {
  const sequencesDbc = readDbc('CinematicSequences', 10, 40);
  const camerasDbc = readDbc('CinematicCamera', 7, 28);
  const model = await openClientArchive(CACHE, 'model.MPQ');

  const cameras: Record<number, unknown> = {};
  let totalKeys = 0;

  for (let i = 0; i < camerasDbc.records; i++) {
    const row = camerasDbc.row(i);
    const id = row.getUint32(0x00, true);
    const modelPath = camerasDbc.str(row.getUint32(0x04, true));
    const soundId = row.getUint32(0x08, true);
    const origin: Vec3 = [
      r4(row.getFloat32(0x0c, true)),
      r4(row.getFloat32(0x10, true)),
      r4(row.getFloat32(0x14, true)),
    ];
    const facing = r4(row.getFloat32(0x18, true));

    const m2Path = modelPath.replace(/\.mdx$/i, '.m2');
    const block = readCameraBlock(model.extract(m2Path), m2Path);
    totalKeys += block.position.length + block.target.length + block.roll.length;

    cameras[id] = { id, model: m2Path, soundId, origin, facing, ...block };
  }

  const sequences: Record<number, unknown> = {};
  for (let i = 0; i < sequencesDbc.records; i++) {
    const row = sequencesDbc.row(i);
    const id = row.getUint32(0, true);
    const soundId = row.getUint32(4, true);
    const cameraIds: number[] = [];
    for (let c = 0; c < 8; c++) {
      const camId = row.getUint32(8 + c * 4, true);
      if (camId === 0) continue;
      if (!(camId in cameras)) throw new Error(`CinematicSequences ${id} references unknown camera ${camId}`);
      cameraIds.push(camId);
    }
    if (cameraIds.length === 0) throw new Error(`CinematicSequences ${id} has no cameras`);
    sequences[id] = { id, soundId, cameras: cameraIds };
  }

  mkdirSync(fileURLToPath(new URL('../../apps/client/public/data/', import.meta.url)), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ version: 1, cameras, sequences }, null, 2), 'utf8');
  console.log(
    `Wrote ${Object.keys(sequences).length} sequences / ${Object.keys(cameras).length} cameras ` +
      `(${totalKeys} spline keys) -> ${OUT}`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
