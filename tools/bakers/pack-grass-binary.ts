/** Convert existing grass.json instance arrays to the versioned grass.bin runtime contract. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRASS_BINARY_CELL_SIZE,
  GRASS_BINARY_FALLBACK_FILE,
  GRASS_BINARY_FILE,
  GRASS_BINARY_FORMAT,
  decodeGrassBinary,
  encodeGrassBinary,
  type GrassBinarySourceInstance,
} from '../../apps/client/src/rendering/grass-binary-format.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TILES = join(ROOT, 'apps', 'client', 'public', 'terrain', 'tiles');

type GrassManifest = {
  schemaVersion?: number;
  instances?: GrassBinarySourceInstance[];
  packedInstances?: { format?: string };
  [key: string]: unknown;
};

function selectedKeys(args: string[]): string[] {
  if (args.includes('--all')) {
    return readdirSync(TILES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(TILES, entry.name, 'grass.json')))
      .map((entry) => entry.name)
      .sort();
  }
  const keys = args.filter((arg) => !arg.startsWith('--'));
  if (!keys.length) throw new Error('Pass one or more tile keys, or --all');
  return keys;
}

let converted = 0;
let sourceBytes = 0;
let packedBytes = 0;
const keepFallback = process.argv.includes('--fallback');
for (const key of selectedKeys(process.argv.slice(2))) {
  const dir = join(TILES, key);
  const jsonPath = join(dir, 'grass.json');
  if (!existsSync(jsonPath)) {
    console.warn(`${key}: grass.json missing`);
    continue;
  }
  const originalBytes = statSync(jsonPath).size;
  const originalJson = readFileSync(jsonPath, 'utf8');
  const manifest = JSON.parse(originalJson) as GrassManifest;
  if (!Array.isArray(manifest.instances)) {
    if (manifest.packedInstances?.format === GRASS_BINARY_FORMAT && existsSync(join(dir, GRASS_BINARY_FILE))) {
      console.log(`${key}: already packed`);
      continue;
    }
    console.warn(`${key}: no legacy instances to pack`);
    continue;
  }
  const packed = encodeGrassBinary(manifest.instances, GRASS_BINARY_CELL_SIZE);
  const binary = Buffer.from(packed.buffer);
  decodeGrassBinary(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength), {
    byteLength: binary.byteLength,
    instanceCount: manifest.instances.length,
    cellCount: packed.cells.length,
  });
  writeFileSync(join(dir, GRASS_BINARY_FILE), binary);
  if (keepFallback) writeFileSync(join(dir, GRASS_BINARY_FALLBACK_FILE), originalJson);
  else if (existsSync(join(dir, GRASS_BINARY_FALLBACK_FILE))) unlinkSync(join(dir, GRASS_BINARY_FALLBACK_FILE));
  const compact: GrassManifest = {
    ...manifest,
    schemaVersion: 4,
    packedInstances: {
      format: GRASS_BINARY_FORMAT,
      url: GRASS_BINARY_FILE,
      byteLength: binary.byteLength,
      sha256: createHash('sha256').update(binary).digest('hex'),
      instanceCount: manifest.instances.length,
      cellCount: packed.cells.length,
      cellSize: GRASS_BINARY_CELL_SIZE,
      ...(keepFallback ? { fallbackUrl: GRASS_BINARY_FALLBACK_FILE } : {}),
    },
  };
  delete compact.instances;
  writeFileSync(jsonPath, JSON.stringify(compact));
  // A precompression sidecar for the former 15 MB JSON would serve stale bytes in production.
  // The canonical Brotli baker will recreate sidecars after the selected route is validated.
  for (const stale of [`${jsonPath}.br`, `${join(dir, GRASS_BINARY_FILE)}.br`, `${join(dir, GRASS_BINARY_FALLBACK_FILE)}.br`]) {
    if (existsSync(stale)) unlinkSync(stale);
  }
  converted++;
  sourceBytes += originalBytes;
  packedBytes += binary.byteLength + statSync(jsonPath).size;
  console.log(`${key}: ${manifest.instances.length} instances, ${packed.cells.length} cells, ${(originalBytes / 1e6).toFixed(2)} MB -> ${(packedBytes / converted / 1e6).toFixed(2)} MB average packed`);
}

console.log(`Packed grass: ${converted} tile(s), ${(sourceBytes / 1e6).toFixed(2)} MB JSON -> ${(packedBytes / 1e6).toFixed(2)} MB binary+metadata`);
