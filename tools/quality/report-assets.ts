import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const CACHE = join(ROOT, '.client-cache');
const OUT = join(CACHE, 'asset-report.json');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ktx2']);
const GPU_VISUAL_ROOTS = new Set(['terrain', 'creatures', 'equipment', 'gameobjects', 'spells', 'login', 'sky']);
const UI_ROOTS = new Set(['ui', 'items', 'fonts']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav']);
const BINARY_EXTS = new Set(['.bin', '.f32', '.wasm']);

function bucketFor(path: string, ext: string): string {
  const top = path.split(/[\\/]/)[0]?.toLowerCase() ?? 'root';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ext === '.json') return 'json';
  if (BINARY_EXTS.has(ext)) return 'binary';
  if (IMAGE_EXTS.has(ext)) {
    if (UI_ROOTS.has(top)) return 'ui-images';
    if (GPU_VISUAL_ROOTS.has(top)) return 'gpu-images';
    return 'other-images';
  }
  return top || 'other';
}

type Stats = { files: number; bytes: number };
const byBucket = new Map<string, Stats>();
const byExtension = new Map<string, Stats>();
const byTopLevel = new Map<string, Stats>();
const LARGEST_LIMIT = 100;
const largest: Array<{ path: string; bytes: number }> = [];
const textureInventory = {
  png: 0,
  jpeg: 0,
  webp: 0,
  ktx2: 0,
  sourceBytes: 0,
  ktx2Bytes: 0,
};
let totalFiles = 0;
let totalBytes = 0;

function add(map: Map<string, Stats>, key: string, bytes: number) {
  const stat = map.get(key) ?? { files: 0, bytes: 0 };
  stat.files++;
  stat.bytes += bytes;
  map.set(key, stat);
}

function recordLargest(path: string, bytes: number) {
  if (largest.length === LARGEST_LIMIT && bytes <= largest[largest.length - 1].bytes) return;
  let low = 0;
  let high = largest.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (largest[mid].bytes >= bytes) low = mid + 1;
    else high = mid;
  }
  largest.splice(low, 0, { path, bytes });
  if (largest.length > LARGEST_LIMIT) largest.pop();
}

function walk(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;

    const bytes = statSync(full).size;
    const path = relative(PUBLIC, full).split(sep).join('/');
    const ext = extname(entry.name).toLowerCase() || '<none>';
    const top = path.split('/')[0] || '<root>';
    totalFiles++;
    totalBytes += bytes;
    add(byBucket, bucketFor(path, ext), bytes);
    add(byExtension, ext, bytes);
    add(byTopLevel, top, bytes);
    recordLargest(path, bytes);

    if (ext === '.png') {
      textureInventory.png++;
      textureInventory.sourceBytes += bytes;
    } else if (ext === '.jpg' || ext === '.jpeg') {
      textureInventory.jpeg++;
      textureInventory.sourceBytes += bytes;
    } else if (ext === '.webp') {
      textureInventory.webp++;
    } else if (ext === '.ktx2') {
      textureInventory.ktx2++;
      textureInventory.ktx2Bytes += bytes;
    }
  }
}

walk(PUBLIC);

const toObject = (map: Map<string, Stats>) => Object.fromEntries(
  [...map.entries()].sort((a, b) => b[1].bytes - a[1].bytes),
);
const report = {
  generatedAt: new Date().toISOString(),
  publicRoot: relative(ROOT, PUBLIC).split(sep).join('/'),
  total: { files: totalFiles, bytes: totalBytes },
  buckets: toObject(byBucket),
  topLevel: toObject(byTopLevel),
  extensions: toObject(byExtension),
  textures: textureInventory,
  largestFiles: largest,
};

mkdirSync(CACHE, { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
console.log(`Asset corpus: ${totalFiles} files, ${mib(totalBytes)}`);
for (const [name, stats] of [...byBucket.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${name.padEnd(16)} ${String(stats.files).padStart(6)} files  ${mib(stats.bytes).padStart(10)}`);
}
console.log(`Texture inventory: PNG=${textureInventory.png}, JPEG=${textureInventory.jpeg}, WebP=${textureInventory.webp}, KTX2=${textureInventory.ktx2}`);
console.log(`Wrote ${relative(ROOT, OUT).split(sep).join('/')}`);
