import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const DATA = join(PUBLIC, 'data');
const OUTPUT = join(DATA, 'content-hashes.json');
const SHARDED_CATALOGS = join(DATA, 'catalogs');

type HashEntry = { hash: string; bytes: number };

function argValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function walk(dir: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // These are derived from this manifest and must not recursively become hash inputs.
      if (full !== SHARDED_CATALOGS) walk(full, out);
      continue;
    }
    if (full === OUTPUT || entry.name.endsWith('.br')) continue;
    out.push(full);
  }
}

const requestedPrefix = argValue('--path-prefix');
const sourceRoot = requestedPrefix
  ? resolve(PUBLIC, requestedPrefix.replace(/^[/\\]+/, ''))
  : PUBLIC;
if (sourceRoot !== PUBLIC && !sourceRoot.startsWith(`${PUBLIC}${sep}`)) {
  throw new Error(`--path-prefix must resolve inside ${PUBLIC}`);
}

const files: string[] = [];
walk(sourceRoot, files);
let assets: Record<string, HashEntry> = {};
if (requestedPrefix && existsSync(OUTPUT)) {
  try {
    const prior = JSON.parse(readFileSync(OUTPUT, 'utf8')) as { assets?: Record<string, HashEntry> };
    assets = { ...(prior.assets ?? {}) };
  } catch {
    // A malformed prior catalog is safer to replace than partially preserve.
  }
  const logicalPrefix = `/${relative(PUBLIC, sourceRoot).replaceAll('\\', '/')}`.replace(/\/$/, '');
  for (const logical of Object.keys(assets)) {
    if (logical === logicalPrefix || logical.startsWith(`${logicalPrefix}/`)) delete assets[logical];
  }
}
for (let index = 0; index < files.length; index++) {
  const file = files[index];
  const stat = statSync(file);
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  const logical = `/${relative(PUBLIC, file).replaceAll('\\', '/')}`;
  assets[logical] = { hash, bytes: stat.size };
  if ((index + 1) % 5000 === 0 || index + 1 === files.length) console.log(`[hashes] ${index + 1}/${files.length}`);
}
const entries = Object.values(assets);
const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
mkdirSync(DATA, { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify({
  version: 1,
  algorithm: 'sha256',
  generatedAt: new Date().toISOString(),
  files: entries.length,
  bytes,
  assets,
})}\n`);
console.log(`[hashes] ${entries.length} immutable asset identities written to data/content-hashes.json${requestedPrefix ? ` (updated ${files.length} under ${requestedPrefix})` : ''}.`);
