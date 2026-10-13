/** Split large runtime catalogs into compact top-level-path shards plus a small index. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DATA = join(ROOT, 'apps', 'client', 'public', 'data');
const OUTPUT_ROOT = join(DATA, 'catalogs');

type Catalog = {
  version?: number;
  assets?: Record<string, unknown>;
};

type ShardDescriptor = {
  url: string;
  entries: number;
  bytes: number;
};

function scopeFor(logicalPath: string): string {
  const relative = logicalPath.replace(/^\/+/, '');
  const first = relative.includes('/') ? relative.split('/', 1)[0]!.toLowerCase() : 'root';
  if (!/^[a-z0-9_-]+$/.test(first)) throw new Error(`unsafe catalog scope ${JSON.stringify(first)}`);
  return first;
}

function writeJson(path: string, value: unknown): number {
  const encoded = `${JSON.stringify(value)}\n`;
  writeFileSync(path, encoded);
  return Buffer.byteLength(encoded);
}

function shardCatalog(sourceName: string, catalogName: string) {
  const sourcePath = join(DATA, sourceName);
  if (!existsSync(sourcePath)) throw new Error(`${sourceName} is missing; run its producer first`);
  const sourceBytes = readFileSync(sourcePath);
  const parsed = JSON.parse(sourceBytes.toString('utf8')) as Catalog;
  const assets = parsed.assets ?? {};
  const groups = new Map<string, Record<string, unknown>>();

  for (const logicalPath of Object.keys(assets).sort()) {
    const scope = scopeFor(logicalPath);
    let group = groups.get(scope);
    if (!group) groups.set(scope, group = {});
    group[logicalPath] = assets[logicalPath];
  }

  const outputDir = join(OUTPUT_ROOT, catalogName);
  mkdirSync(outputDir, { recursive: true });
  const shards: Record<string, ShardDescriptor> = {};
  let shardBytes = 0;
  for (const scope of [...groups.keys()].sort()) {
    const shardAssets = groups.get(scope)!;
    const fileName = `${scope}.json`;
    const bytes = writeJson(join(outputDir, fileName), {
      version: 1,
      scope,
      assets: shardAssets,
    });
    shardBytes += bytes;
    shards[scope] = {
      url: `/data/catalogs/${catalogName}/${fileName}`,
      entries: Object.keys(shardAssets).length,
      bytes,
    };
  }

  const indexBytes = writeJson(join(outputDir, 'index.json'), {
    version: 1,
    catalog: catalogName,
    source: basename(sourcePath),
    sourceVersion: parsed.version ?? null,
    entries: Object.keys(assets).length,
    sourceBytes: sourceBytes.byteLength,
    shardBytes,
    shards,
  });
  return { catalogName, entries: Object.keys(assets).length, sourceBytes: sourceBytes.byteLength, shardBytes, indexBytes, shards: groups.size };
}

mkdirSync(OUTPUT_ROOT, { recursive: true });
const results = [
  shardCatalog('content-hashes.json', 'content-hashes'),
  shardCatalog('texture-assets.json', 'texture-assets'),
];

for (const result of results) {
  console.log(`[catalogs] ${result.catalogName}: ${result.entries} entries -> ${result.shards} shards; index=${result.indexBytes} bytes, shards=${result.shardBytes} bytes (legacy=${result.sourceBytes} bytes)`);
}
