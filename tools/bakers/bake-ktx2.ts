import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getBakeJobCount, runPool } from '../utils/parallel-bake.ts';
import { resolveAssetTool } from '../utils/asset-tools.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const DATA = join(PUBLIC, 'data');
const REGISTRY = join(DATA, 'texture-assets.json');
const KTX2_MANIFEST = join(DATA, 'ktx2-manifest.json');
const BASIS_SOURCE = join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const BASIS_DEST = join(PUBLIC, 'basis');
const encoder = resolveAssetTool('TOKTX', { required: process.env.REQUIRE_ASSET_TOOLS === '1' })?.path ?? process.env.TOKTX ?? 'toktx';
const MIN_BYTES = Number(process.env.KTX2_MIN_BYTES || 64 * 1024);
const uiTopLevel = new Set(['ui', 'items', 'fonts', 'minimap']);
const excludedTopLevel = new Set([...uiTopLevel, 'sound', 'audio', 'data', 'fixtures', 'basis']);
const dataNamePattern = /(?:^|[-_.])(chunk[_-]?map|splat|surface|lookup|control|weight|weights|id[_-]?map|index[_-]?map|mask)(?:[-_.]|$)/i;
const rawPixelDataNamePattern = /^tex_array\.png$/i;

type TextureUsage = 'color' | 'normal' | 'alpha' | 'ui' | 'data';
type TextureAsset = {
  usage: TextureUsage;
  colorSpace: 'srgb' | 'linear';
  variants: { ktx2?: string; webp?: string; source?: string };
};
type TextureRegistry = {
  version?: number;
  generatedAt?: string;
  encoder?: string;
  assets?: Record<string, TextureAsset>;
};
type KtxProfile = 'dev' | 'fidelity' | 'compact';

function argValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedProfile = (argValue('--profile') ?? process.env.KTX2_PROFILE ?? 'fidelity').toLowerCase();
const profile: KtxProfile = requestedProfile === 'dev' || requestedProfile === 'compact' ? requestedProfile : 'fidelity';
const requestedPathPrefix = argValue('--path-prefix')?.replaceAll('\\', '/').replace(/^\/*/, '/');
if (requestedPathPrefix?.includes('..')) throw new Error(`Unsafe --path-prefix ${requestedPathPrefix}`);

const probe = spawnSync(encoder, ['--version'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error('[ktx2] toktx not found. Set TOKTX or install the portable prerequisite.');
  process.exit(process.env.REQUIRE_ASSET_TOOLS === '1' ? 1 : 0);
}
const encoderVersion = String(probe.stdout || probe.stderr).split(/\r?\n/, 1)[0]?.trim() || 'unknown';

const helpProbe = spawnSync(encoder, ['--help'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
});
const encoderHelp = `${helpProbe.stdout ?? ''}\n${helpProbe.stderr ?? ''}`;
const hasOption = (name: string) => encoderHelp.includes(name);

if (existsSync(BASIS_SOURCE)) {
  mkdirSync(BASIS_DEST, { recursive: true });
  cpSync(BASIS_SOURCE, BASIS_DEST, { recursive: true, force: true });
} else {
  console.warn('[ktx2] Three.js Basis transcoder files were not found in node_modules; runtime will fall back to source images.');
}

function logicalUrl(file: string): string {
  return `/${relative(PUBLIC, file).replaceAll('\\', '/')}`;
}

function classify(file: string): { usage: TextureUsage; colorSpace: 'srgb' | 'linear'; eligibleForKtx2: boolean } {
  const logical = logicalUrl(file);
  const parts = logical.slice(1).split('/');
  const top = parts[0]?.toLowerCase() ?? '';
  const name = parts.at(-1) ?? '';

  if (excludedTopLevel.has(top)) {
    return { usage: uiTopLevel.has(top) ? 'ui' : 'data', colorSpace: 'srgb', eligibleForKtx2: false };
  }
  // Terrain tex_array.png is decoded through DOM Image + canvas to construct a
  // DataTexture2DArray, so it must remain a browser-decodable raw pixel source.
  if (top === 'terrain' && rawPixelDataNamePattern.test(name)) {
    return { usage: 'data', colorSpace: 'linear', eligibleForKtx2: false };
  }
  if (dataNamePattern.test(name)) return { usage: 'data', colorSpace: 'linear', eligibleForKtx2: false };
  if (/(?:^|[-_.])(normal|normals|nrm)(?:[-_.]|$)/i.test(name)) return { usage: 'normal', colorSpace: 'linear', eligibleForKtx2: true };
  if (/(?:^|[-_.])(alpha|cutout)(?:[-_.]|$)/i.test(name)) return { usage: 'alpha', colorSpace: 'srgb', eligibleForKtx2: true };
  return { usage: 'color', colorSpace: 'srgb', eligibleForKtx2: true };
}

let registry: TextureRegistry = { version: 1, assets: {} };
if (existsSync(REGISTRY)) {
  try { registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as TextureRegistry; } catch { /* rebuild from discovered sources */ }
}
const assets: Record<string, TextureAsset> = registry.assets ?? {};

const allImages: string[] = [];
function walk(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') allImages.push(full);
  }
}
walk(PUBLIC);

const images = allImages.filter((input) => {
  const logical = logicalUrl(input);
  const info = classify(input);
  const asset = assets[logical] ?? { usage: info.usage, colorSpace: info.colorSpace, variants: {} };
  asset.usage = info.usage;
  asset.colorSpace = info.colorSpace;
  asset.variants ??= {};
  asset.variants.source = logical;
  if (!info.eligibleForKtx2) delete asset.variants.ktx2;
  assets[logical] = asset;
  return (!requestedPathPrefix || logical.startsWith(requestedPathPrefix))
    && info.eligibleForKtx2
    && statSync(input).size >= MIN_BYTES;
});

function encoderArgs(output: string, input: string, usage: TextureUsage): string[] {
  const args = ['--t2'];
  if (profile === 'compact') {
    // KTX-Software versions use either "etc1s" or "basis-lz" terminology. Prefer
    // the legacy toktx spelling when available and fall back to the modern name.
    const codec = encoderHelp.includes('etc1s') ? 'etc1s' : 'basis-lz';
    args.push('--encode', codec);
  } else {
    args.push('--encode', 'uastc');
    if (profile === 'dev') {
      if (hasOption('--uastc_quality')) args.push('--uastc_quality', '0');
      else if (hasOption('--uastc-quality')) args.push('--uastc-quality', '0');
    }
    if (profile === 'fidelity') {
      // Lossless supercompression is safe for fidelity and cuts UASTC transport size.
      if (hasOption('--zcmp')) args.push('--zcmp', '5');
      else if (hasOption('--zstd')) args.push('--zstd', '5');
    }
  }
  if (usage === 'normal') {
    if (hasOption('--normal_mode')) args.push('--normal_mode');
    else if (hasOption('--normal-mode')) args.push('--normal-mode');
  }
  args.push('--genmipmap');
  return [...args, output, input];
}

const jobs = Math.max(1, getBakeJobCount());
const threadsPerEncoder = Math.max(1, Math.floor(availableParallelism() / jobs));

function encodeAsync(input: string, output: string, usage: TextureUsage): Promise<void> {
  const args = encoderArgs(output, input, usage);
  if (hasOption('--threads')) args.splice(args.length - 2, 0, '--threads', String(threadsPerEncoder));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(encoder, args, {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim() || `toktx exited ${code ?? 'unknown'}`));
    });
  });
}

let manifest: Record<string, string> = {};
if (requestedPathPrefix && existsSync(KTX2_MANIFEST)) {
  try {
    manifest = (JSON.parse(readFileSync(KTX2_MANIFEST, 'utf8')) as { textures?: Record<string, string> }).textures ?? {};
  } catch { /* rebuild the selected scope while preserving the texture registry */ }
}
let encoded = 0;
let failed = 0;
let current = 0;

await runPool(images, async (input) => {
  const output = input.replace(/\.(png|jpe?g)$/i, '.ktx2');
  const inputStat = statSync(input);
  const logical = logicalUrl(input);
  const info = classify(input);
  const mapped = logicalUrl(output);

  if (existsSync(output) && statSync(output).mtimeMs >= inputStat.mtimeMs) {
    current++;
    manifest[logical] = mapped;
    assets[logical].variants.ktx2 = mapped;
    return;
  }

  mkdirSync(dirname(output), { recursive: true });
  try {
    await encodeAsync(input, output, info.usage);
    encoded++;
    manifest[logical] = mapped;
    assets[logical].variants.ktx2 = mapped;
  } catch (error) {
    failed++;
    console.warn(`[ktx2] failed: ${relative(PUBLIC, input)}\n${error instanceof Error ? error.message : String(error)}`);
  }
}, {
  jobs,
  onComplete: (done, total) => {
    if (done === total || done % 100 === 0) console.log(`[ktx2] ${done}/${total} processed`);
  },
});

mkdirSync(DATA, { recursive: true });
writeFileSync(KTX2_MANIFEST, `${JSON.stringify({
  version: 2,
  encoder: `toktx/${profile}`,
  tool: { command: encoder, version: encoderVersion },
  minSourceBytes: MIN_BYTES,
  jobs,
  stats: { encoded, current, skipped: allImages.length - images.length, failed },
  textures: manifest,
})}\n`);
writeFileSync(REGISTRY, `${JSON.stringify({
  ...registry,
  version: 1,
  generatedAt: new Date().toISOString(),
  encoder: `toktx/${profile}`,
  assets,
})}\n`);

console.log(`[ktx2] profile=${profile}, jobs=${jobs}, encoderThreads=${threadsPerEncoder}`);
if (requestedPathPrefix) console.log(`[ktx2] targeted path prefix: ${requestedPathPrefix}`);
console.log(`[ktx2] ${encoded} encoded, ${current} current, ${allImages.length - images.length} skipped, ${failed} failed, ${Object.keys(manifest).length} mapped.`);
if (failed) process.exitCode = 1;
if (!failed && (!requestedPathPrefix || requestedPathPrefix.startsWith('/terrain'))) await import('./bake-terrain-arrays.ts');
