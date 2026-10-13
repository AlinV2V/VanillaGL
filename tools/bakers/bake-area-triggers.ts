import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCE = join(process.env.DBC_SOURCE_DIR ?? join(ROOT, 'data', 'dbcs'), 'AreaTrigger.json');
const OUT = join(ROOT, 'apps', 'client', 'public', 'terrain', 'area_triggers.json');

type RawAreaTrigger = Record<`field_${number}`, number>;

const floatBits = new ArrayBuffer(4);
const floatView = new DataView(floatBits);
function f32bits(value: number): number {
  floatView.setUint32(0, value >>> 0, true);
  return floatView.getFloat32(0, true);
}

const input = JSON.parse(readFileSync(SOURCE, 'utf8')) as { header?: unknown; records?: RawAreaTrigger[] };
const records = input.records ?? [];
const triggers = records
  .map((record) => ({
    id: (record.field_0 ?? 0) >>> 0,
    mapId: (record.field_1 ?? 0) >>> 0,
    x: f32bits(record.field_2 ?? 0),
    y: f32bits(record.field_3 ?? 0),
    z: f32bits(record.field_4 ?? 0),
    radius: f32bits(record.field_5 ?? 0),
    boxX: f32bits(record.field_6 ?? 0),
    boxY: f32bits(record.field_7 ?? 0),
    boxZ: f32bits(record.field_8 ?? 0),
    boxOrientation: f32bits(record.field_9 ?? 0),
  }))
  .filter((trigger) => trigger.id > 0 && Number.isFinite(trigger.x) && Number.isFinite(trigger.y) && Number.isFinite(trigger.z));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generatedFrom: SOURCE,
  opcode: 0x00b4,
  count: triggers.length,
  triggers,
}));
const radius = triggers.filter((trigger) => trigger.radius > 0).length;
console.log(`baked ${triggers.length} AreaTriggers -> ${OUT} (${radius} radius, ${triggers.length - radius} box)`);
