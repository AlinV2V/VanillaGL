/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { ClientArchiveSet, openClientArchives, readVanillaM2 } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const MODELS = fileURLToPath(new URL('../../apps/client/public/creatures/models', import.meta.url));
const DISPLAYS = fileURLToPath(new URL('../../apps/client/public/creatures/display', import.meta.url));

// Creature display metadata can reference models overridden or introduced by patch archives.
// Use the same patch-first resolution policy as the creature asset baker itself.
const archive = new ClientArchiveSet(await openClientArchives(CACHE, ['model.MPQ']));
let models = 0;
let withPortraitCamera = 0;
let missingSources = 0;
const camerasByModel = new Map<string, ReturnType<typeof readVanillaM2>['cameras']>();
for (const entry of readdirSync(MODELS, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(MODELS, entry.name);
  const meta = JSON.parse(gunzipSync(readFileSync(join(dir, 'model.json.gz'))).toString('utf8')) as { source: string };
  if (!archive.has(meta.source)) {
    missingSources++;
    continue;
  }
  const cameras = readVanillaM2(archive.extract(meta.source)).cameras;
  camerasByModel.set(entry.name, cameras);
  models++;
  if (cameras.some((camera) => camera.type === 0)) withPortraitCamera++;
}
let displays = 0;
for (const name of readdirSync(DISPLAYS)) {
  if (!name.endsWith('.json')) continue;
  const path = join(DISPLAYS, name);
  const display = JSON.parse(readFileSync(path, 'utf8')) as { model: string; cameras?: ReturnType<typeof readVanillaM2>['cameras'] };
  const cameras = camerasByModel.get(display.model);
  if (!cameras) continue;
  display.cameras = cameras;
  writeFileSync(path, JSON.stringify(display));
  displays++;
}
archive.close();
console.log(
  `Creature portrait cameras: ${withPortraitCamera}/${models} models, embedded into ${displays} display records` +
  (missingSources ? `, ${missingSources} unresolved source(s) skipped.` : '.'),
);
