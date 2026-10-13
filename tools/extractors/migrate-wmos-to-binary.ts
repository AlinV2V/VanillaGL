import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeWmoDoodads, canonicalizeWmoTile, encodeWmoBinary, validateWmoBinaryMeta } from '../utils/wmo-binary.ts';

const TERRAIN = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));
const TILES = join(TERRAIN, 'tiles');
const index = JSON.parse(readFileSync(join(TERRAIN, 'index.json'), 'utf8')) as Array<{
  key: string; map: number; originX: number; originY: number;
}>;
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const keys = requested.length ? requested : readdirSync(TILES).filter((key) => existsSync(join(TILES, key, 'wmos.json')));

let legacyBytes = 0;
let binaryBytes = 0;
let metadataBytes = 0;
let doodadBefore = 0;
let doodadAfter = 0;

for (let tileIndex = 0; tileIndex < keys.length; tileIndex++) {
  const key = keys[tileIndex];
  const dir = join(TILES, key);
  const sourcePath = join(dir, 'wmos.json');
  if (!existsSync(sourcePath)) throw new Error(`${key}: missing legacy wmos.json`);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const canonical = canonicalizeWmoTile(source, key, meta, index);
  const encoded = encodeWmoBinary(canonical);
  validateWmoBinaryMeta(encoded.meta, encoded.binary.byteLength);
  const metaText = JSON.stringify(encoded.meta);
  writeFileSync(join(dir, 'wmos.meta.json'), metaText);
  writeFileSync(join(dir, 'wmos.bin'), encoded.binary);

  legacyBytes += statSync(sourcePath).size;
  binaryBytes += encoded.binary.byteLength;
  metadataBytes += Buffer.byteLength(metaText);

  const doodadPath = join(dir, 'wmo_doodads.json');
  if (existsSync(doodadPath)) {
    const before = statSync(doodadPath).size;
    const doodads = JSON.parse(readFileSync(doodadPath, 'utf8'));
    const canonicalDoodads = canonicalizeWmoDoodads(doodads, key, meta, index);
    const text = JSON.stringify(canonicalDoodads);
    writeFileSync(doodadPath, text);
    doodadBefore += before;
    doodadAfter += Buffer.byteLength(text);
  }

  if ((tileIndex + 1) % 25 === 0 || tileIndex + 1 === keys.length) {
    console.log(`migrated ${tileIndex + 1}/${keys.length} tiles`);
  }
}

const mb = (value: number) => (value / 1048576).toFixed(1);
console.log(`WMO binary migration OK: JSON ${mb(legacyBytes)} MB -> binary ${mb(binaryBytes)} MB + metadata ${mb(metadataBytes)} MB`);
console.log(`WMO doodad ownership: ${mb(doodadBefore)} MB -> ${mb(doodadAfter)} MB`);
