/** Bake portable UASTC KTX2 terrain arrays for ASTC/ETC2/BC transcode; incremental and content-addressed. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodePng, decodeRgbaPng } from '../utils/png.ts';
import { resolveAssetTool } from '../utils/asset-tools.ts';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const publicRoot = join(root, 'apps/client/public'), outputRoot = join(publicRoot, 'terrain/arrays');
const encoder = resolveAssetTool('TOKTX', { required: true })!;
const selected = process.argv.find((value) => value.startsWith('--tile='))?.slice(7);
const entries = (JSON.parse(readFileSync(join(publicRoot, 'terrain/index.json'), 'utf8')) as { key: string }[])
  .filter((entry) => !selected || entry.key === selected);
if (selected && !entries.length) throw new Error(`Unknown terrain tile: ${selected}`);
mkdirSync(outputRoot, { recursive: true });
let cursor = 0, encoded = 0, current = 0, skipped = 0, completed = 0;
const pending = new Map<string, Promise<void>>();
async function encode(source: Buffer, destination: string, count: number, size: number) {
  const pixels = decodeRgbaPng(source);
  if (pixels.width !== size || pixels.height !== size * count) throw new Error('Terrain strip dimensions mismatch');
  const scratch = await mkdtemp(join(tmpdir(), 'vanillagl-terrain-array-'));
  try {
    const files = [];
    for (let layer = 0; layer < count; layer++) {
      const path = join(scratch, `${layer}.png`), start = layer * size * size * 4;
      writeFileSync(path, encodePng(size, size, pixels.data.subarray(start, start + size * size * 4))); files.push(path);
    }
    const temporary = join(scratch, 'array.ktx2');
    const args = ['--t2', '--encode', 'uastc', '--uastc_quality', '1', '--zcmp', '5', '--threads', '1',
      '--assign_oetf', 'linear', '--assign_primaries', 'none', '--upper_left_maps_to_s0t0', '--target_type', 'RGB',
      '--layers', String(count), '--genmipmap', temporary, ...files];
    await new Promise<void>((accept, reject) => {
      const child = spawn(encoder.path, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
      child.on('error', reject); child.on('exit', (code) => code === 0 ? accept() : reject(new Error(stderr || `toktx exit ${code}`)));
    });
    const bytes = readFileSync(temporary);
    if (bytes.readUInt32LE(20) !== size || bytes.readUInt32LE(24) !== size || bytes.readUInt32LE(32) !== count
      || bytes.readUInt32LE(40) !== Math.floor(Math.log2(size)) + 1) throw new Error('Encoded KTX2 layout mismatch');
    writeFileSync(`${destination}.tmp`, bytes); renameSync(`${destination}.tmp`, destination);
    encoded++;
  } finally {
    if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !scratch.includes('vanillagl-terrain-array-')) throw new Error('Unsafe scratch cleanup');
    await rm(scratch, { recursive: true, force: true });
  }
}
async function worker() {
  while (cursor < entries.length) {
    const entry = entries[cursor++];
    if (!/^[A-Za-z0-9_-]+$/.test(entry.key)) throw new Error('Unsafe terrain key');
    const base = join(publicRoot, 'terrain/tiles', entry.key), metaPath = join(base, 'meta.json');
    if (!existsSync(metaPath)) { skipped++; continue; }
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')), shader = meta.shader;
    if (!shader || !existsSync(join(base, 'tex_array.png'))) { skipped++; continue; }
    const source = readFileSync(join(base, 'tex_array.png'));
    const hash = createHash('sha256').update(`terrain-array-v1-uastc1-linear-${encoder.version}:${shader.texSize}:${shader.texCount}:`).update(source).digest('hex');
    const destination = join(outputRoot, `${hash}.ktx2`);
    if (!existsSync(destination)) {
      let task = pending.get(hash);
      if (!task) { task = encode(source, destination, shader.texCount, shader.texSize); pending.set(hash, task); }
      await task;
    } else current++;
    const url = `/terrain/arrays/${hash}.ktx2`;
    if (shader.compressedArrayUrl !== url) {
      // Re-read before changing only our field, preserving any intervening metadata writes.
      const latest = JSON.parse(readFileSync(metaPath, 'utf8')); latest.shader.compressedArrayUrl = url;
      writeFileSync(`${metaPath}.array-tmp`, JSON.stringify(latest)); renameSync(`${metaPath}.array-tmp`, metaPath);
    }
    // Production may serve a precompressed sibling; it must expose the same new array URL.
    const metadata = readFileSync(metaPath), sibling = `${metaPath}.br`;
    if (existsSync(sibling) && !brotliDecompressSync(readFileSync(sibling)).equals(metadata)) {
      writeFileSync(`${sibling}.array-tmp`, brotliCompressSync(metadata, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }));
      renameSync(`${sibling}.array-tmp`, sibling);
    }
    completed++;
    if (completed % 100 === 0) console.log(`[terrain-arrays] ${completed}/${entries.length} tiles, ${encoded} encoded`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log(JSON.stringify({ terrainArrays: true, tiles: completed, encoded, current, skipped, format: 'UASTC linear RGB, full mip chain' }));
