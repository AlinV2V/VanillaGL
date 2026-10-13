/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { DbcFile, openClientArchive } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/terrain/area_names.json', import.meta.url));
const PARENTS_OUT = fileURLToPath(new URL('../../apps/client/public/terrain/area_parents.json', import.meta.url));

async function main() {
  const dbc = await openClientArchive(CACHE, 'dbc.MPQ');
  const area = new DbcFile(dbc.extract('DBFilesClient\\AreaTable.dbc'));

  // Anchor the name column (field 11) on Northshire Valley (id 9) before trusting it whole-table.
  let checked = false;
  for (let i = 0; i < area.recordCount; i++) {
    if (area.getUint(i, 0) !== 9) continue;
    const name = area.getString(i, 11);
    console.log(`layout check — area 9 name="${name}" (expect "Northshire Valley")`);
    if (name !== 'Northshire Valley') throw new Error(`AreaTable name column check FAILED — area 9 = "${name}"`);
    checked = true;
    break;
  }
  if (!checked) throw new Error('AreaTable area 9 (Northshire Valley) not found');

  const names: Record<number, string> = {};
  const parents: Record<number, number> = {};
  for (let i = 0; i < area.recordCount; i++) {
    const id = area.getUint(i, 0);
    const name = area.getString(i, 11);
    if (id && name) names[id] = name;
    if (id) parents[id] = area.getUint(i, 2);
  }
  writeFileSync(OUT, JSON.stringify(names));
  writeFileSync(PARENTS_OUT, JSON.stringify(parents));
  console.log(`area_names.json + area_parents.json: ${Object.keys(names).length} areas`);
  dbc.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
