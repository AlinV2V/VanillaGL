import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { ClientArchiveSet, DbcFile } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/terrain/lighting.json', import.meta.url));
const MAP_CENTER = 17066.666666666668;
const UNITS_PER_YARD = 36;
const NOON = 1440;
const DAY = 2880;

const archives = await ClientArchiveSet.open(CACHE, ['dbc.MPQ']);
const load = (name: string) => new DbcFile(archives.extract(`DBFilesClient\\${name}.dbc`));
const f32 = (raw: number) => {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, raw >>> 0, true);
  return new DataView(buffer).getFloat32(0, true);
};

try {
  const light = load('Light');
  const lightParams = load('LightParams');
  const lightSkybox = load('LightSkybox');
  const intBand = load('LightIntBand');
  const floatBand = load('LightFloatBand');

  const lightParamRecordById = new Map<number, number>();
  for (let i = 0; i < lightParams.recordCount; i++) lightParamRecordById.set(lightParams.getUint(i, 0), i);

  const rowIndexById = (dbc: DbcFile) => {
    const index = new Map<number, number>();
    for (let i = 0; i < dbc.recordCount; i++) index.set(dbc.getUint(i, 0), i);
    return index;
  };
  const intBandRowById = rowIndexById(intBand);
  const floatBandRowById = rowIndexById(floatBand);

  const skyboxPaths = new Map<number, string>();
  for (let i = 0; i < lightSkybox.recordCount; i++) {
    skyboxPaths.set(lightSkybox.getUint(i, 0), lightSkybox.getString(i, 1).replace(/\.mdx$/i, '.m2'));
  }
  const skyboxForParam = new Map<number, string>();
  for (let i = 0; i < lightParams.recordCount; i++) {
    const path = skyboxPaths.get(lightParams.getUint(i, 2));
    if (path) skyboxForParam.set(lightParams.getUint(i, 0), path);
  }

  type ColorBand = { t: number[]; v: [number, number, number][] };
  type FloatBand = { t: number[]; v: number[] };

  const intKeys = (param: number, type: number): ColorBand => {
    const record = intBandRowById.get((param - 1) * 18 + type + 1);
    if (param <= 0 || record === undefined) return { t: [0], v: [[0, 0, 0]] };
    const count = Math.max(1, Math.min(16, intBand.getUint(record, 1)));
    const t: number[] = [];
    const v: [number, number, number][] = [];
    for (let k = 0; k < count; k++) {
      t.push(intBand.getUint(record, 2 + k));
      const value = intBand.getUint(record, 18 + k);
      v.push([((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]);
    }
    return { t, v };
  };

  const floatKeys = (param: number, type: number, scale = 1): FloatBand => {
    const record = floatBandRowById.get((param - 1) * 6 + type + 1);
    if (param <= 0 || record === undefined) return { t: [0], v: [0] };
    const count = Math.max(1, Math.min(16, floatBand.getUint(record, 1)));
    const t: number[] = [];
    const v: number[] = [];
    for (let k = 0; k < count; k++) {
      t.push(floatBand.getUint(record, 2 + k));
      v.push(f32(floatBand.getUint(record, 18 + k)) * scale);
    }
    return { t, v };
  };

  const profile = (param: number) => {
    const paramRecord = lightParamRecordById.get(param);
    return {
      param,
      skybox: skyboxForParam.get(param) ?? null,
      glowIntensity: paramRecord === undefined ? 0.5 : f32(lightParams.getUint(paramRecord, 4)),
      bands: {
        sun: intKeys(param, 0),
        ambient: intKeys(param, 1),
        skyTop: intKeys(param, 2),
        groundAmbient: intKeys(param, 3),
        skyMid: intKeys(param, 4),
        skyHorizon: intKeys(param, 6),
        fog: intKeys(param, 7),
      },
      floats: {
        fogEnd: floatKeys(param, 0, 1 / UNITS_PER_YARD),
        fogStartScale: floatKeys(param, 1),
      },
    };
  };

  const records = Array.from({ length: light.recordCount }, (_, index) => {
    const gameY = f32(light.getUint(index, 2));
    const gameZ = f32(light.getUint(index, 3));
    const gameX = f32(light.getUint(index, 4));
    const params = [7, 8, 9, 10, 11].map((field) => light.getUint(index, field));
    const param = params[0] || params.find((candidate) => candidate > 0) || 1;
    return {
      id: light.getUint(index, 0),
      map: light.getUint(index, 1),
      x: MAP_CENTER - gameX / UNITS_PER_YARD,
      y: MAP_CENTER - gameY / UNITS_PER_YARD,
      z: gameZ / UNITS_PER_YARD,
      falloffStart: f32(light.getUint(index, 5)) / UNITS_PER_YARD,
      falloffEnd: f32(light.getUint(index, 6)) / UNITS_PER_YARD,
      params,
      profile: profile(param),
      profiles: params.map((candidate) => profile(candidate || param)),
    };
  });

  const maps: Record<number, { global: (typeof records)[number]; zones: typeof records }> = {};
  for (const map of [...new Set(records.map((record) => record.map))].sort((a, b) => a - b)) {
    const mapRecords = records.filter((record) => record.map === map);
    const global = mapRecords.find((record) => record.x === MAP_CENTER && record.y === MAP_CENTER && record.z === 0)
      ?? mapRecords.reduce((highest, record) => (record.id > highest.id ? record : highest));
    const zones = mapRecords.filter((record) => record !== global && record.falloffEnd > 0);
    maps[map] = { global, zones };
    console.log(`map ${map}: global light #${global.id} param=${global.profile.param}, ${zones.length} zone lights`);
  }

  writeFileSync(
    OUT,
    JSON.stringify({
      version: 5,
      dayLength: DAY,
      defaultTime: NOON,
      mapCenter: MAP_CENTER,
      unitsPerYard: UNITS_PER_YARD,
      skyboxes: Object.fromEntries(skyboxPaths),
      maps,
    }, null, 2),
  );
  console.log('wrote', OUT);
} finally {
  archives.close();
}
