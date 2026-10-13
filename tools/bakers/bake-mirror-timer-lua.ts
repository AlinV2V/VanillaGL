/** Extract unmodified Build 5875 mirror-timer sources for the optional Lua UI prototype. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet } from '@vanillagl/assets';

const cache = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const output = fileURLToPath(new URL('../../apps/client/public/ui-lua/mirror-timer', import.meta.url));
const archive = await ClientArchiveSet.open(cache, ['interface.MPQ']);
try {
  mkdirSync(output, { recursive: true });
  const sources: { path: string; sha256: string; bytes: number }[] = [];
  for (const file of ['MirrorTimer.lua', 'MirrorTimer.xml']) {
    const path = `Interface\\FrameXML\\${file}`;
    if (!archive.has(path)) throw new Error(`Missing ${path}`);
    const bytes = archive.extract(path);
    writeFileSync(`${output}/${file}`, bytes);
    sources.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const globals = Buffer.from(archive.extract('Interface\\FrameXML\\GlobalStrings.lua')).toString('utf8');
  const labels: Record<string, string> = {};
  for (const name of ['BREATH_LABEL', 'EXHAUSTION_LABEL']) {
    const match = globals.match(new RegExp(`^${name}\\s*=\\s*"([^"\\r\\n]*)"`, 'm'));
    if (!match) throw new Error(`Missing ${name}`);
    labels[name.replace('_LABEL', '')] = match[1];
  }
  writeFileSync(`${output}/manifest.json`, JSON.stringify({ version: 1, build: 5875, sources, labels }, null, 2));
  console.log(`Mirror timer Lua/XML extracted unchanged to ${output}`);
} finally { archive.close(); }
