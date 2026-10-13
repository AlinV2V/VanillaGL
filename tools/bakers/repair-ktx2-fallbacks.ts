/** Derive browser-image fallbacks from existing KTX2 payloads when their source image is absent. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBakeJobCount, runPool } from '../utils/parallel-bake.ts';
import { resolveAssetTool } from '../utils/asset-tools.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const REGISTRY = join(PUBLIC, 'data', 'texture-assets.json');
type Entry = { variants?: { ktx2?: string; webp?: string; source?: string } };
type Registry = { assets?: Record<string, Entry>; [key: string]: unknown };
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as Registry;
const assets = registry.assets ?? {};
const toktx = resolveAssetTool('TOKTX', { required: true })!;
const cwebp = resolveAssetTool('CWEBP', { required: true })!;
const extractor = join(dirname(toktx.path), process.platform === 'win32' ? 'ktx.exe' : 'ktx');
if (!existsSync(extractor)) throw new Error(`TOKTX package is missing checksum-verified ktx extraction companion: ${extractor}`);
const physical = (url: string | undefined) => url ? join(PUBLIC, ...url.replace(/^\//, '').split('/')) : '';
const pending = Object.entries(assets).filter(([, entry]) => {
  const variants = entry.variants;
  if (!variants?.ktx2 || !existsSync(physical(variants.ktx2))) return false;
  return ![variants.webp, variants.source].some((url) => url && existsSync(physical(url)));
});
const temporary = mkdtempSync(join(tmpdir(), 'vanillagl-ktx2-fallback-'));
const run = (command: string, args: string[], label: string) => new Promise<void>((resolveRun, rejectRun) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', rejectRun);
  child.once('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${label} failed (${code}): ${stderr.trim()}`)));
});
let repaired = 0;
try {
  await runPool(pending, async ([logical, entry], index) => {
    const input = physical(entry.variants!.ktx2);
    const webpUrl = `${logical.replace(/\.[^.\/]+$/, '')}.fallback.webp`;
    const output = physical(webpUrl);
    const png = join(temporary, `${index}.png`);
    mkdirSync(dirname(output), { recursive: true });
    await run(extractor, ['extract', '--transcode', 'rgba8', input, png], `${logical} KTX2 extraction`);
    await run(cwebp.path, ['-quiet', '-q', '92', '-alpha_q', '100', png, '-o', output], `${logical} WebP fallback`);
    if (!existsSync(output) || statSync(output).size === 0) throw new Error(`${logical}: empty fallback output`);
    entry.variants!.webp = webpUrl;
    repaired++;
  }, {
    jobs: getBakeJobCount(),
    onComplete: (done, total) => { if (done === total || done % 250 === 0) console.log(`[ktx2-fallback] ${done}/${total}`); },
  });
  writeFileSync(REGISTRY, `${JSON.stringify(registry)}\n`);
} finally {
  const absolute = resolve(temporary);
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error(`refusing to remove non-temporary path ${absolute}`);
  rmSync(absolute, { recursive: true, force: true });
}
console.log(`[ktx2-fallback] ${repaired} repaired, ${Object.values(assets).filter((entry) => entry.variants?.ktx2).length - pending.length} already had browser fallback`);
