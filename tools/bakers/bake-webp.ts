import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBakeJobCount, runPool } from '../utils/parallel-bake.ts';
import { resolveAssetTool } from '../utils/asset-tools.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const DATA = join(PUBLIC, 'data');
const REGISTRY = join(DATA, 'texture-assets.json');
const MANIFEST = join(DATA, 'webp-manifest.json');
const encoder = resolveAssetTool('CWEBP', { required: process.env.REQUIRE_ASSET_TOOLS === '1' })?.path ?? process.env.CWEBP ?? 'cwebp';
const MIN_BYTES = Math.max(0, Number(process.env.WEBP_MIN_BYTES || 4 * 1024));
const ENCODER_SIGNATURE = 'cwebp/lossless-z9-exact';

// These families are consumed by DOM/CSS/Canvas code. Some (login/spell art)
// can also be sampled by WebGL, so the registry intentionally allows both a
// WebP and KTX2 variant for the same logical PNG source.
const WEBP_ROOTS = [
  ['ui'],
  ['items'],
  ['minimap'],
  ['login'],
  ['spells', 'icons'],
] as const;

const probe = spawnSync(encoder, ['-version'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error('[webp] cwebp not found. Set CWEBP or install the portable prerequisite.');
  process.exit(process.env.REQUIRE_ASSET_TOOLS === '1' ? 1 : 0);
}
const encoderVersion = String(probe.stdout || probe.stderr).split(/\r?\n/, 1)[0]?.trim() || 'unknown';

type TextureAsset = {
  usage?: 'color' | 'normal' | 'alpha' | 'ui' | 'data';
  colorSpace?: 'srgb' | 'linear';
  variants?: { ktx2?: string; webp?: string; source?: string };
};
type TextureRegistry = {
  version?: number;
  generatedAt?: string;
  encoder?: string;
  assets?: Record<string, TextureAsset>;
};

function logicalUrl(file: string): string {
  return `/${relative(PUBLIC, file).replaceAll('\\', '/')}`;
}

const images: string[] = [];
let skipped = 0;
function walk(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (extname(entry.name).toLowerCase() !== '.png') continue;
    if (entry.name.toLowerCase() === 'point.png') { skipped++; continue; } // keep the tiny cursor path stable for CSS/setup invariants
    if (statSync(full).size < MIN_BYTES) { skipped++; continue; }
    images.push(full);
  }
}
for (const parts of WEBP_ROOTS) walk(join(PUBLIC, ...parts));

function encodeAsync(input: string, output: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(encoder, ['-lossless', '-exact', '-z', '9', '-mt', '-quiet', input, '-o', output], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim() || `cwebp exited ${code ?? 'unknown'}`));
    });
  });
}

const jobs = getBakeJobCount();
const manifest: Record<string, string> = {};
let previousEncoder = '';
if (existsSync(MANIFEST)) {
  try {
    previousEncoder = String((JSON.parse(readFileSync(MANIFEST, 'utf8')) as { encoder?: string }).encoder ?? '');
  } catch { /* an invalid manifest forces a clean re-encode */ }
}
const forceExactReencode = previousEncoder !== ENCODER_SIGNATURE;
let encoded = 0;
let current = 0;
let failed = 0;
let staleRemoved = 0;
let sourceBytes = 0;
let outputBytes = 0;

await runPool(images, async (input) => {
  const output = input.replace(/\.png$/i, '.webp');
  const source = logicalUrl(input);
  const mapped = logicalUrl(output);
  const sourceStat = statSync(input);
  sourceBytes += sourceStat.size;

  if (!forceExactReencode && existsSync(output) && statSync(output).mtimeMs >= sourceStat.mtimeMs) {
    current++;
    outputBytes += statSync(output).size;
    manifest[source] = mapped;
    return;
  }

  mkdirSync(dirname(output), { recursive: true });
  try {
    await encodeAsync(input, output);
    encoded++;
    outputBytes += statSync(output).size;
    manifest[source] = mapped;
  } catch (error) {
    failed++;
    console.warn(`[webp] failed: ${relative(PUBLIC, input)}\n${error instanceof Error ? error.message : String(error)}`);
  }
}, {
  jobs,
  onComplete: (done, total) => {
    if (done === total || done % 250 === 0) console.log(`[webp] ${done}/${total} processed`);
  },
});

mkdirSync(DATA, { recursive: true });
writeFileSync(MANIFEST, `${JSON.stringify({
  version: 2,
  encoder: ENCODER_SIGNATURE,
  tool: { command: encoder, version: encoderVersion },
  minSourceBytes: MIN_BYTES,
  jobs,
  stats: { encoded, current, skipped, failed, staleRemoved },
  roots: WEBP_ROOTS.map((parts) => parts.join('/')),
  images: manifest,
})}\n`);

let registry: TextureRegistry = { version: 1, assets: {} };
if (existsSync(REGISTRY)) {
  try { registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as TextureRegistry; } catch { /* rebuild the affected UI entries below */ }
}
registry.assets ??= {};
for (const [source, webp] of Object.entries(manifest)) {
  const asset = registry.assets[source] ?? { usage: 'ui', colorSpace: 'srgb', variants: { source } };
  // Do not erase a GPU classification written by the KTX2 pass. The physical
  // variants, not a single usage flag, decide what each runtime consumer loads.
  asset.usage ??= 'ui';
  asset.colorSpace ??= 'srgb';
  asset.variants ??= {};
  asset.variants.source ??= source;
  asset.variants.webp = webp;
  registry.assets[source] = asset;
}

// A registry variant is a promise the runtime may follow. Remove stale promises instead of
// retaining KTX-only entries that claim an original source image still exists after pruning.
for (const [logical, asset] of Object.entries(registry.assets)) {
  asset.variants ??= {};
  for (const variant of ['source', 'webp', 'ktx2'] as const) {
    const url = asset.variants[variant];
    if (!url) continue;
    const physical = resolve(PUBLIC, url.replace(/^\/+/, ''));
    const withinPublic = relative(PUBLIC, physical);
    if (withinPublic.startsWith('..') || isAbsolute(withinPublic) || !existsSync(physical)) {
      delete asset.variants[variant];
      staleRemoved++;
    }
  }
  if (!asset.variants.source && !asset.variants.webp && !asset.variants.ktx2) delete registry.assets[logical];
}
registry.version = 1;
registry.generatedAt = new Date().toISOString();
writeFileSync(REGISTRY, `${JSON.stringify(registry)}\n`);

const reduction = sourceBytes > 0 ? (1 - outputBytes / sourceBytes) * 100 : 0;
console.log(`[webp] jobs=${jobs}; ${encoded} encoded, ${current} current, ${skipped} skipped, ${failed} failed, ${staleRemoved} stale variants removed, ${Object.keys(manifest).length} mapped.`);
console.log(`[webp] ${Math.round(sourceBytes / 1024)} KiB -> ${Math.round(outputBytes / 1024)} KiB (${reduction.toFixed(1)}% smaller for converted browser-image sources).`);
if (failed > 0) process.exitCode = 1;
