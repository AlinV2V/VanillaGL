import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBakeJobCount, runPool } from '../utils/parallel-bake.ts';
import { resolveAssetTool } from '../utils/asset-tools.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const SOUNDS = join(PUBLIC, 'sounds');
const DATA = join(PUBLIC, 'data');
const MANIFEST = join(SOUNDS, 'sound-manifest.json');
const OUT_MANIFEST = join(DATA, 'audio-assets.json');
const THEME_SOURCE = join(PUBLIC, 'audio', 'theme.mp3');
const THEME_OPUS = join(PUBLIC, 'audio', 'theme.opus.ogg');
const ffmpeg = resolveAssetTool('FFMPEG', { required: process.env.REQUIRE_ASSET_TOOLS === '1' })?.path ?? process.env.FFMPEG ?? 'ffmpeg';
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.oga', '.flac']);

const probe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error('[opus] ffmpeg not found. Set FFMPEG or install the portable prerequisite.');
  process.exit(process.env.REQUIRE_ASSET_TOOLS === '1' ? 1 : 0);
}
const ffmpegVersion = String(probe.stdout).split(/\r?\n/, 1)[0]?.trim() || 'unknown';

function walk(dir: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    const ext = extname(entry.name).toLowerCase();
    if (!AUDIO_EXT.has(ext) || /\.opus\.ogg$/i.test(entry.name)) continue;
    out.push(full);
  }
}

function normalizedRelative(file: string) {
  if (resolve(file) === resolve(THEME_SOURCE)) return '../audio/theme.mp3';
  return relative(SOUNDS, file).replaceAll('\\', '/');
}

function outputFor(file: string) {
  if (resolve(file) === resolve(THEME_SOURCE)) return THEME_OPUS;
  return file.replace(/\.[^.]+$/i, '.opus.ogg');
}

function isLongForm(file: string) {
  return /(?:^|\/)(?:music|ambience|ambient|zone|cinematic)(?:\/|[-_.])/i.test(normalizedRelative(file));
}

function encode(input: string, output: string): Promise<void> {
  const bitrate = isLongForm(input) ? '128k' : '96k';
  mkdirSync(dirname(output), { recursive: true });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-vn', '-ar', '48000', '-c:a', 'libopus', '-b:a', bitrate, '-vbr', 'on',
      '-compression_level', '10', '-application', 'audio', output,
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(stderr.trim() || `ffmpeg exited ${code ?? 'unknown'}`)));
  });
}

const inputs: string[] = [];
walk(SOUNDS, inputs);
if (existsSync(THEME_SOURCE)) inputs.push(THEME_SOURCE);
const jobs = Math.max(1, getBakeJobCount());
const mapping = new Map<string, string>();
let sourceBytes = 0;
let outputBytes = 0;
let encoded = 0;
let current = 0;
let skipped = 0;
let failed = 0;

await runPool(inputs, async (input) => {
  const output = outputFor(input);
  const sourceStat = statSync(input);
  sourceBytes += sourceStat.size;
  if (!existsSync(output) || statSync(output).mtimeMs < sourceStat.mtimeMs) {
    try {
      await encode(input, output);
      encoded++;
    } catch (error) {
      failed++;
      console.warn(`[opus] failed ${normalizedRelative(input)}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  } else {
    current++;
  }
  if (!existsSync(output)) return;
  outputBytes += statSync(output).size;
  mapping.set(normalizedRelative(input).toLowerCase(), normalizedRelative(output));
}, {
  jobs,
  onComplete: (done, total) => { if (done === total || done % 100 === 0) console.log(`[opus] ${done}/${total}`); },
});

let manifestUpdates = 0;
if (existsSync(MANIFEST) && mapping.size) {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      entries?: Record<string, { files?: string[] }>;
      audioVariants?: Record<string, { source: string; opus: string }>;
      world?: { weather?: Record<string, string> };
    };
    manifest.audioVariants = {};
    const addVariant = (file: string) => {
      const normalized = file.replaceAll('\\', '/').replace(/^\/?sounds\//i, '');
      const mapped = mapping.get(normalized.toLowerCase());
      if (!mapped) return;
      manifestUpdates++;
      manifest.audioVariants![normalized.toLowerCase()] = { source: normalized, opus: mapped };
    };
    for (const entry of Object.values(manifest.entries ?? {})) {
      if (!Array.isArray(entry.files)) continue;
      for (const file of entry.files) addVariant(file);
    }
    // WeatherSoundIds are a separate Build 5875 id space, so their files are not necessarily
    // referenced by SoundEntries. Route them through the same Opus/source fallback table explicitly.
    for (const file of Object.values(manifest.world?.weather ?? {})) addVariant(file);
    writeFileSync(MANIFEST, JSON.stringify(manifest));
  } catch (error) {
    console.warn(`[opus] sound manifest rewrite skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

mkdirSync(DATA, { recursive: true });
writeFileSync(OUT_MANIFEST, JSON.stringify({
  version: 1,
  generatedAt: new Date().toISOString(),
  codec: 'Ogg Opus',
  sampleRateHz: 48000,
  tool: { command: ffmpeg, version: ffmpegVersion },
  jobs,
  encoded,
  current,
  skipped,
  failed,
  manifestUpdates,
  sourceBytes,
  outputBytes,
  assets: Object.fromEntries(mapping),
}, null, 2));
const reduction = sourceBytes ? (1 - outputBytes / sourceBytes) * 100 : 0;
console.log(`[opus] ${encoded} encoded, ${current} current, ${failed} failed, ${manifestUpdates} manifest paths routed (${reduction.toFixed(1)}% smaller for converted corpus).`);
if (failed) process.exitCode = 1;
