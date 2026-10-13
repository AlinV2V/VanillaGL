/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openClientArchive, PATCH_ARCHIVES } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data'));
const dec = new TextDecoder('utf-8');

const archives: { name: string; ar: Awaited<ReturnType<typeof openClientArchive>> }[] = [];
for (const name of [...PATCH_ARCHIVES, 'interface.MPQ']) {
  try {
    archives.push({ name, ar: await openClientArchive(CACHE, name) });
  } catch {
    // A stock 1.12.1 client has no patch-3.MPQ.
  }
}

const owner = (path: string) => archives.find((a) => a.ar.has(path)) ?? null;
const base = archives.find((a) => a.name === 'interface.MPQ')!;

// The toc lists the .xml files; each .xml pulls .lua siblings that the toc does not name, so take the
// union of the toc entries and every FrameXML path in the archive listings.
const tocOwner = owner('Interface\\FrameXML\\FrameXML.toc')!;
const toc = dec.decode(tocOwner.ar.extract('Interface\\FrameXML\\FrameXML.toc'));
const wanted = new Set<string>(['Interface\\FrameXML\\FrameXML.toc']);
for (const line of toc.split(/\r?\n/)) {
  const f = line.trim();
  if (/\.(xml|lua|ttf|tga|blp)$/i.test(f)) wanted.add(`Interface\\FrameXML\\${f}`);
}
for (const { ar } of archives) {
  for (const entry of ar.list()) {
    if (/^Interface\\FrameXML\\[^\\]+\.(xml|lua)$/i.test(entry)) wanted.add(entry);
    // 1.12 moved AuctionFrame/MacroFrame/InspectFrame/KeyBindingFrame/ClassTrainerFrame/CraftFrame/
    // TalentFrame out of FrameXML into load-on-demand Blizzard addons; patch.MPQ blanks the FrameXML
    // copies to 0 bytes. Without these the 1.12 layout for those panels is simply not on disk.
    if (/^Interface\\AddOns\\Blizzard_[^\\]+\\[^\\]+\.(xml|lua|toc)$/i.test(entry)) wanted.add(entry);
  }
}

let written = 0;
let patched = 0;
let baseOnly = 0;
const changed: string[] = [];
const added: string[] = [];

for (const path of [...wanted].sort()) {
  const own = owner(path);
  if (!own) continue;
  const bytes = own.ar.extract(path);
  const rel = path.replace(/^Interface\\/i, '');
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  written++;

  if (own.name === 'interface.MPQ') {
    baseOnly++;
    continue;
  }
  patched++;
  if (!base.ar.has(path)) added.push(`${rel}  (+${bytes.length}B, only in ${own.name})`);
  else {
    const b = base.ar.extract(path);
    const same = b.length === bytes.length && Buffer.from(b).equals(Buffer.from(bytes));
    if (!same) changed.push(`${rel.padEnd(34)} base ${String(b.length).padStart(7)}B -> ${own.name} ${String(bytes.length).padStart(7)}B`);
  }
}

console.log(`wrote ${written} files to ${OUT}`);
console.log(`  ${patched} came from a patch archive, ${baseOnly} only exist in interface.MPQ`);
console.log(`\n=== ${added.length} files that exist ONLY in a patch (never extracted before) ===`);
console.log(added.join('\n'));
console.log(`\n=== ${changed.length} files the patch REPLACED (the extracted copy was stale) ===`);
console.log(changed.join('\n'));

for (const { ar } of archives) ar.close();
