/** Asset conversion utility. */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const TILES = join(ROOT, 'apps/client/public/terrain/tiles');

const keys = readdirSync(TILES)
  .filter((key) => existsSync(join(TILES, key, 'wmos.meta.json')))
  .sort();

let undercityPlaceholders = 0;
for (let index = 0; index < keys.length; index++) {
  const key = keys[index];
  const result = spawnSync(process.execPath, [join(ROOT, 'tools/bakers/bake-wmos.ts'), key], {
    cwd: ROOT,
    env: {
      ...process.env,
      GLOBAL_WMO: key.startsWith('WailingCaverns_') ? '1' : '0',
      MAX_WMO_VERTS: '1000000',
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  undercityPlaceholders += (combined.match(/UnderCity_[0-9]{3}\.wmo: Invalid typed array length/g) ?? []).length;
  if (result.status !== 0) {
    process.stderr.write(combined);
    process.exit(result.status ?? 1);
  }
  if ((index + 1) % 25 === 0 || index + 1 === keys.length) {
    console.log(`[${index + 1}/${keys.length}] WMO tiles rebuilt`);
  }
}

const canonicalize = spawnSync(process.execPath, [join(ROOT, 'tools/bakers/canonicalize-wmo-owners.ts')], {
  cwd: ROOT,
  env: process.env,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(canonicalize.stdout ?? '');
process.stderr.write(canonicalize.stderr ?? '');
if (canonicalize.status !== 0) process.exit(canonicalize.status ?? 1);

console.log(
  `WMO doodad-lighting migration complete: ${keys.length} tiles; `
  + `${undercityPlaceholders} retained UnderCity parse placeholders.`,
);
