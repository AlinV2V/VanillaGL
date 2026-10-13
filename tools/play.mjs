#!/usr/bin/env node
/**
 * Starts the realm bridge (WebSocket-to-TCP proxy) and the game client together, then opens
 * the browser. Launched by Play.bat / play.sh (or `npm run play`). Ctrl+C stops both.
 * Pass --no-open to skip opening the browser.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIENT = join(ROOT, 'apps', 'client');
const PROFILE = join(ROOT, '.client-cache', 'setup-profile.json');
const REALM_CONFIG = join(ROOT, '.client-cache', 'realm.json');
const SETUP_HINT = process.platform === 'win32' ? 'Setup.bat' : './setup.sh';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

if (!existsSync(join(ROOT, 'node_modules', 'vite'))) {
  console.error(`\nDependencies are not installed yet. Run ${SETUP_HINT} first.\n`);
  process.exit(1);
}
if (readJson(PROFILE)?.status !== 'complete') {
  console.error(`\nThe game files have not been baked yet. Run ${SETUP_HINT} first.\n`);
  process.exit(1);
}

const realm = { host: '127.0.0.1', authPort: 3724, worldPort: 8085, ...readJson(REALM_CONFIG) };
// Vite moves to the next free port when 5173 is taken; allow the browser origins it may use.
const origins = [];
for (let port = 5173; port <= 5183; port++) origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);

function viteBin() {
  try {
    const pkg = createRequire(join(CLIENT, 'package.json')).resolve('vite/package.json');
    return join(dirname(pkg), 'bin', 'vite.js');
  } catch {
    return join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  }
}

const children = [];
let stopping = false;

function start(label, args, options) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', ...options });
  children.push(child);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`\n${label} stopped${code ? ` (exit code ${code})` : ''}. Shutting down.`);
    stop(code ?? 1);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log('\nStarting VanillaGL');
console.log(`  Realm:  ${realm.host} (login ${realm.authPort}, world ${realm.worldPort})`);
console.log('  Game:   http://localhost:5173 (or the next free port shown below)');
console.log('  Stop:   press Ctrl+C in this window\n');

start('Realm bridge', [join(ROOT, 'server', 'proxy', 'proxy.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    REALM_HOST: realm.host,
    AUTH_PORT: String(realm.authPort),
    WORLD_PORT: String(realm.worldPort),
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? origins.join(','),
  },
});

const viteArgs = [viteBin()];
if (!process.argv.includes('--no-open')) viteArgs.push('--open');
start('Game client', viteArgs, { cwd: CLIENT });
