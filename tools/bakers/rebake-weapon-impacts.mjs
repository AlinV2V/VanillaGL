/** Asset conversion utility. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DBC = process.env.WOW_DBC_DIR
  ?? (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data'));
const MANIFEST = `${ROOT}/apps/client/public/sounds/sound-manifest.json`;

const bytes = readFileSync(`${DBC}/WeaponImpactSounds.dbc`);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (bytes.toString('latin1', 0, 4) !== 'WDBC') throw new Error('not a DBC');
const recordCount = view.getUint32(4, true);
const fieldCount = view.getUint32(8, true);
const recordSize = view.getUint32(12, true);

if (recordSize !== 0x5c || fieldCount !== 23) {
  throw new Error(`WeaponImpactSounds layout changed: ${recordCount} rows, ${fieldCount} fields, ${recordSize} bytes`);
}
const field = (row, index) => view.getUint32(20 + row * recordSize + index * 4, true);
const positive = (value) => (value > 0 && value < 0x80000000 ? value : 0);
const readDbc = (name) => {
  const data = readFileSync(`${DBC}/${name}`);
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.toString('latin1', 0, 4) !== 'WDBC') throw new Error(`${name}: not a DBC`);
  const rows = dataView.getUint32(4, true);
  const fields = dataView.getUint32(8, true);
  const size = dataView.getUint32(12, true);
  return {
    rows,
    fields,
    size,
    field: (row, index) => dataView.getUint32(20 + row * size + index * 4, true),
  };
};

const NORMAL_BASE = 3;
const CRITICAL_BASE = 13;
const COLUMNS = 10;

const impacts = {};
let materialFlagRows = 0;
for (let row = 0; row < recordCount; row++) {
  const subclass = String(field(row, 1));
  const materialFlag = field(row, 2) !== 0;
  if (materialFlag) materialFlagRows++;
  const entry = (impacts[subclass] ??= {});
  entry[materialFlag ? 'material1' : 'material0'] = {
    normal: Array.from({ length: COLUMNS }, (_, i) => positive(field(row, NORMAL_BASE + i))),
    critical: Array.from({ length: COLUMNS }, (_, i) => positive(field(row, CRITICAL_BASE + i))),
  };
  if (!materialFlag || entry.flesh === undefined) {
    entry.flesh = positive(field(row, NORMAL_BASE));
    entry.fleshCritical = positive(field(row, CRITICAL_BASE));
  }
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const materialDbc = readDbc('Material.dbc');
if (materialDbc.size !== 12 || materialDbc.fields !== 3) {
  throw new Error(`Material.dbc layout changed: ${materialDbc.rows} rows, ${materialDbc.fields} fields, ${materialDbc.size} bytes`);
}
const impactMaterialFlags = {};
for (let row = 0; row < materialDbc.rows; row++) {
  impactMaterialFlags[String(materialDbc.field(row, 0))] = materialDbc.field(row, 1);
}
const previous = manifest.world.weaponImpacts ?? {};
for (const [subclass, entry] of Object.entries(previous)) {
  const next = impacts[subclass];
  if (!next) throw new Error(`subclass ${subclass} disappeared from the DBC re-bake`);
  if (next.flesh !== entry.flesh || next.fleshCritical !== entry.fleshCritical) {
    throw new Error(
      `subclass ${subclass} column-0 changed: was ${JSON.stringify(entry)}, now ${JSON.stringify({ flesh: next.flesh, fleshCritical: next.fleshCritical })}`,
    );
  }
}
manifest.world.weaponImpacts = impacts;
manifest.world.impactMaterialFlags = impactMaterialFlags;
writeFileSync(MANIFEST, JSON.stringify(manifest));

const slots = Object.values(impacts)
  .flatMap((entry) => [entry.material0, entry.material1].filter(Boolean))
  .flatMap((variant) => [...variant.normal, ...variant.critical]).length;
console.log(`weaponImpacts: ${Object.keys(impacts).length} subclasses, ${materialFlagRows} material-flag rows, ${slots} sound slots retained (was ${Object.keys(previous).length * 2})`);
