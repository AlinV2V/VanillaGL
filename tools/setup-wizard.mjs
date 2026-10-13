#!/usr/bin/env node
/**
 * One-step VanillaGL installer. Launched by Setup.bat / setup.sh (or `npm run wizard`).
 * Uses only Node built-ins: it runs before `npm install` has fetched any dependency.
 *
 * Asks every question up front (client folder, world size, realm), then installs
 * dependencies and runs the full asset bake unattended, and finally offers to start the game.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE = join(ROOT, '.client-cache');
const PROFILE = join(CACHE, 'setup-profile.json');
const REALM_CONFIG = join(CACHE, 'realm.json');
const IS_WINDOWS = process.platform === 'win32';
const GB = 1024 ** 3;

const REQUIRED_MPQS = ['base', 'dbc', 'fonts', 'interface', 'misc', 'model', 'sound', 'speech', 'terrain', 'texture', 'wmo']
  .map((name) => `${name}.mpq`);

const TIERS = [
  { id: 'starter', label: 'Starter', detail: 'the six starting regions and the capital cities (smallest, fastest)' },
  { id: 'level40', label: 'Level 1-40', detail: 'every zone for levels 1-40 plus capitals (about 20 GB, about 1 hour)', recommended: true },
  { id: 'full', label: 'Full world', detail: 'every Azeroth and Kalimdor tile (much larger and slower than Level 1-40)' },
];

let rl = createInterface({ input, output });
const ask = async (question, fallback = '') => (await rl.question(question)).trim() || fallback;
const yes = async (question, fallback) => {
  const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return answer ? answer.startsWith('y') : fallback;
};

function heading(text) {
  console.log(`\n${'='.repeat(64)}\n  ${text}\n${'='.repeat(64)}`);
}

function fail(message) {
  console.error(`\n${message}\n`);
  rl.close();
  process.exit(1);
}

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
  if (!supported) {
    fail(`VanillaGL needs Node.js 20.19+ or 22.12+ (you have ${process.versions.node}).\n`
      + 'Install the current LTS from https://nodejs.org and run Setup again.');
  }
}

/** Accepts pasted or drag-and-dropped paths: quotes, PowerShell `& '...'`, file:// and trailing slashes. */
function cleanPath(raw) {
  let value = raw.trim().replace(/^&\s*/, '');
  value = value.replace(/^["']|["']$/g, '').trim();
  if (value.startsWith('file://')) value = fileURLToPath(value);
  if (!IS_WINDOWS) value = value.replace(/\\ /g, ' ');
  return value.replace(/[\\/]+$/, '') || value;
}

function findDataFolder(clientPath) {
  for (const candidate of [clientPath, join(clientPath, 'Data'), join(clientPath, 'data')]) {
    if (!existsSync(candidate)) continue;
    let names;
    try { names = readdirSync(candidate).map((name) => name.toLowerCase()); } catch { continue; }
    if (!names.some((name) => name.endsWith('.mpq'))) continue;
    return { folder: candidate, missing: REQUIRED_MPQS.filter((mpq) => !names.includes(mpq)) };
  }
  return null;
}

async function askClientPath() {
  console.log('\nWhere is your World of Warcraft 1.12.1 client?');
  console.log('Paste the folder path, or drag the folder into this window, then press Enter.');
  for (;;) {
    const raw = await ask('\nClient folder: ');
    if (!raw) continue;
    const clientPath = cleanPath(raw);
    const found = findDataFolder(clientPath);
    if (!found) {
      console.log(`  No .MPQ archives found in "${clientPath}" or its Data folder. Pick the folder that contains WoW.exe.`);
      continue;
    }
    if (found.missing.length) {
      console.log(`  Found ${found.folder}, but it is missing: ${found.missing.join(', ')}.`);
      console.log('  VanillaGL needs a complete 1.12.1 (Build 5875) client.');
      continue;
    }
    console.log(`  OK: found the client archives in ${found.folder}`);
    return clientPath;
  }
}

async function askTier() {
  console.log('\nHow much of the world do you want to prepare?');
  TIERS.forEach((tier, index) => {
    console.log(`  ${index + 1}) ${tier.label}${tier.recommended ? ' (recommended)' : ''}: ${tier.detail}`);
  });
  const fallback = TIERS.findIndex((tier) => tier.recommended) + 1;
  for (;;) {
    const choice = Number(await ask(`Choose 1-${TIERS.length} [${fallback}]: `, String(fallback)));
    if (TIERS[choice - 1]) return TIERS[choice - 1].id;
  }
}

async function askRealm() {
  const saved = existsSync(REALM_CONFIG) ? JSON.parse(readFileSync(REALM_CONFIG, 'utf8')) : {};
  console.log('\nWhich vMaNGOS realm will you play on? Press Enter for one running on this computer.');
  const host = await ask(`Realm address [${saved.host ?? '127.0.0.1'}]: `, saved.host ?? '127.0.0.1');
  const authPort = Number(await ask(`Login (realmd) port [${saved.authPort ?? 3724}]: `, String(saved.authPort ?? 3724)));
  const worldPort = Number(await ask(`World (mangosd) port [${saved.worldPort ?? 8085}]: `, String(saved.worldPort ?? 8085)));
  if (!Number.isInteger(authPort) || !Number.isInteger(worldPort)) fail('Ports must be whole numbers.');
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(REALM_CONFIG, `${JSON.stringify({ host, authPort, worldPort }, null, 2)}\n`);
  console.log(`  Saved. You can change it later by running Setup again.`);
}

function freeSpaceGb() {
  try {
    const stats = statfsSync(ROOT);
    return (stats.bavail * stats.bsize) / GB;
  } catch {
    return null;
  }
}

function warnAboutDisk(tier) {
  const free = freeSpaceGb();
  if (free === null) return true;
  console.log(`\nFree disk space here: ${free.toFixed(1)} GB`);
  if (tier === 'level40' && free < 25) {
    console.log('  Warning: Level 1-40 needs about 20 GB plus working space. Setup may run out of room.');
    return false;
  }
  if (tier === 'full' && free < 60) {
    console.log('  Warning: the full world is much larger than Level 1-40. Make sure you have plenty of room.');
    return false;
  }
  return true;
}

function run(command, args, label) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS && command === 'npm' });
  return result.status === 0;
}

function installDependencies() {
  if (existsSync(join(ROOT, 'node_modules', 'esbuild')) && existsSync(join(ROOT, 'node_modules', 'vite'))) return;
  heading('Installing dependencies');
  if (!run('npm', ['install', '--no-audit', '--no-fund'], 'npm install')) {
    fail('npm install failed. Check your internet connection and run Setup again.');
  }
}

function previousSetup() {
  if (!existsSync(PROFILE)) return null;
  try { return JSON.parse(readFileSync(PROFILE, 'utf8')); } catch { return null; }
}

async function main() {
  heading('VanillaGL setup');
  console.log('This converts your own World of Warcraft 1.12.1 client into game files for the browser.');
  console.log('Nothing is downloaded from Blizzard; your client never leaves this computer.');
  checkNode();

  const previous = previousSetup();
  let bake = true;
  if (previous?.status === 'complete') {
    console.log(`\nSetup already finished on ${previous.generatedAt?.slice(0, 10) ?? 'an earlier run'} (world: ${previous.tier}).`);
    bake = await yes('Run the bake again (for example to change the world size)?', false);
  } else if (previous?.status === 'failed') {
    console.log('\nA previous setup did not finish. It will resume and reuse everything already baked.');
  }

  let clientPath = null;
  let tier = null;
  if (bake) {
    clientPath = await askClientPath();
    tier = await askTier();
  }
  await askRealm();

  if (bake) {
    const roomy = warnAboutDisk(tier);
    console.log('\nEverything is answered. The bake runs unattended; the first run takes about an hour.');
    console.log('If it stops for any reason, run Setup again and it continues where it left off.');
    if (!(await yes('Start now?', roomy))) fail('Setup cancelled. Run it again whenever you are ready.');
  }
  rl.close();

  installDependencies();

  if (bake) {
    heading('Baking game files');
    const ok = run(process.execPath, [
      '--import', './tools/utils/sim/register-ts.mjs', 'tools/setup-assets.ts',
      clientPath, '--tier', tier, '--profile', 'release',
    ], `setup --tier ${tier} --profile release`);
    if (!ok) {
      fail('Setup stopped before finishing (see the error above).\n'
        + 'Fix the reported problem, then run Setup again: finished work is kept and it resumes.');
    }
  }

  rl = createInterface({ input, output });
  heading('All done');
  const play = await yes('Start the game now?', true);
  rl.close();
  if (play) run(process.execPath, ['tools/play.mjs'], 'play');
  else console.log(`\nStart it any time with ${IS_WINDOWS ? 'Play.bat' : './play.sh'} (or npm run play).\n`);
}

main().catch((error) => fail(`Setup failed: ${error instanceof Error ? error.message : String(error)}`));
