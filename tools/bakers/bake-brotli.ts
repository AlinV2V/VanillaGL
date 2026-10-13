import { constants as zlibConstants, brotliCompress } from 'node:zlib';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBakeJobCount, runPool } from '../utils/parallel-bake.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const DATA = join(PUBLIC, 'data');
const MANIFEST = join(DATA, 'compression-assets.json');
const compress = promisify(brotliCompress);
const MIN_BYTES = Number(process.env.BROTLI_MIN_BYTES || 1024);
const ELIGIBLE = new Set(['.json', '.bin', '.f32', '.txt', '.csv', '.xml', '.js', '.css', '.wasm', '.svg']);
const ALREADY_COMPRESSED = new Set(['.br', '.gz', '.ktx2', '.webp', '.png', '.jpg', '.jpeg', '.gif', '.ogg', '.oga', '.opus', '.mp3', '.mp4', '.webm', '.zip']);

type Entry = { sourceBytes: number; brotliBytes: number; saving: number };

function walk(dir: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    const ext = extname(entry.name).toLowerCase();
    if (ALREADY_COMPRESSED.has(ext)) continue;
    if (!ELIGIBLE.has(ext)) continue;
    const stat = statSync(full);
    if (stat.size >= MIN_BYTES) out.push(full);
  }
}

function logical(file: string) {
  return `/${relative(PUBLIC, file).replaceAll('\\', '/')}`;
}

function brotliMode(file: string) {
  const ext = extname(file).toLowerCase();
  return ['.json', '.txt', '.csv', '.xml', '.js', '.css', '.svg'].includes(ext)
    ? zlibConstants.BROTLI_MODE_TEXT
    : zlibConstants.BROTLI_MODE_GENERIC;
}

const files: string[] = [];
walk(PUBLIC, files);
const jobs = Math.max(1, getBakeJobCount());
const entries: Record<string, Entry> = {};
let current = 0;
let compressedCount = 0;
let rejected = 0;

await runPool(files, async (file) => {
  const sourceStat = statSync(file);
  const output = `${file}.br`;
  if (existsSync(output) && statSync(output).mtimeMs >= sourceStat.mtimeMs) {
    const brotliBytes = statSync(output).size;
    if (brotliBytes < sourceStat.size) {
      entries[logical(file)] = { sourceBytes: sourceStat.size, brotliBytes, saving: 1 - brotliBytes / sourceStat.size };
      current++;
      return;
    }
  }

  const source = readFileSync(file);
  const result = await compress(source, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: brotliMode(file),
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
    },
  });
  if (result.byteLength >= source.byteLength * 0.98) {
    rejected++;
    return;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result);
  entries[logical(file)] = {
    sourceBytes: source.byteLength,
    brotliBytes: result.byteLength,
    saving: 1 - result.byteLength / source.byteLength,
  };
  compressedCount++;
}, {
  jobs,
  onComplete: (done, total) => { if (done === total || done % 500 === 0) console.log(`[brotli] ${done}/${total}`); },
});

mkdirSync(DATA, { recursive: true });
const sourceBytes = Object.values(entries).reduce((sum, entry) => sum + entry.sourceBytes, 0);
const brotliBytes = Object.values(entries).reduce((sum, entry) => sum + entry.brotliBytes, 0);
writeFileSync(MANIFEST, JSON.stringify({
  version: 1,
  generatedAt: new Date().toISOString(),
  encoding: 'br',
  quality: 11,
  jobs,
  compressed: compressedCount,
  current,
  rejected,
  sourceBytes,
  brotliBytes,
  saving: sourceBytes ? 1 - brotliBytes / sourceBytes : 0,
  assets: entries,
}, null, 2));
console.log(`[brotli] ${Object.keys(entries).length} assets have .br sidecars; ${(sourceBytes ? (1 - brotliBytes / sourceBytes) * 100 : 0).toFixed(1)}% aggregate transfer saving.`);
