/** Fetch the official vMaNGOS db_latest SQLite release used by the alpha audit. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CACHE = join(ROOT, '.client-cache', 'alpha-readiness');
const RELEASE_API = 'https://api.github.com/repos/vmangos/core/releases/tags/db_latest';

const response = await fetch(RELEASE_API, { headers: {
  Accept: 'application/vnd.github+json', 'User-Agent': 'VanillaGL-alpha-readiness-audit',
  'X-GitHub-Api-Version': '2022-11-28',
} });
if (!response.ok) throw new Error(`GitHub release request failed: ${response.status} ${response.statusText}`);
const release = await response.json();
const asset = release.assets?.find((item) => /^db-sqlite-[0-9a-f]+\.zip$/i.test(item.name));
if (!asset) throw new Error('Official db_latest release has no db-sqlite-<revision>.zip asset.');

const stem = asset.name.replace(/\.zip$/i, '');
const directory = join(CACHE, stem);
const archive = join(directory, asset.name);
const database = join(directory, 'sqlite-dump', 'mangos.sqlite');
mkdirSync(directory, { recursive: true });

if (!existsSync(database)) {
  console.log(`Downloading ${asset.name} (${asset.size} bytes) from the official vMaNGOS release...`);
  const download = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'VanillaGL-alpha-readiness-audit' } });
  if (!download.ok) throw new Error(`Database download failed: ${download.status} ${download.statusText}`);
  const payload = Buffer.from(await download.arrayBuffer());
  if (payload.length !== asset.size) throw new Error(`Truncated database archive: expected ${asset.size}, received ${payload.length}`);
  writeFileSync(archive, payload);
  execFileSync('tar', ['-xf', archive, '-C', directory], { stdio: 'inherit' });
}

if (!existsSync(database)) throw new Error(`Extraction did not produce ${database}`);
console.log(`Alpha readiness source ready: ${database}`);
