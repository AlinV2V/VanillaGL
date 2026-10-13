/** Asset conversion utility. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DbcFile, openClientArchive } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/spells/talents.json', import.meta.url));

const CLASS_BY_MASK: Record<number, number> = {
  1: 1, 2: 2, 4: 3, 8: 4, 16: 5, 64: 7, 128: 8, 256: 9, 1024: 11,
};

const archive = await openClientArchive(CACHE, 'dbc.MPQ');
const talentDbc = new DbcFile(archive.extract('DBFilesClient\\Talent.dbc'));
const tabDbc = new DbcFile(archive.extract('DBFilesClient\\TalentTab.dbc'));
console.log(`Talent.dbc rows=${talentDbc.recordCount} fields=${talentDbc.fieldCount}`);
console.log(`TalentTab.dbc rows=${tabDbc.recordCount} fields=${tabDbc.fieldCount}`);

// TalentTab: 0 id, 1 name, (2-9 loc + mask), 10 icon, 11 raceMask, 12 classMask, 13 order, 14 background
type Tab = { id: number; name: string; icon: number; classId: number; order: number; background: string };
const tabs = new Map<number, Tab>();
for (let index = 0; index < tabDbc.recordCount; index++) {
  const id = tabDbc.getUint(index, 0);
  const classMask = tabDbc.getUint(index, 12);
  const classId = CLASS_BY_MASK[classMask];
  if (!classId) continue;
  tabs.set(id, {
    id,
    name: tabDbc.getString(index, 1),
    icon: tabDbc.getUint(index, 10),
    classId,
    order: tabDbc.getUint(index, 13),
    background: tabDbc.getString(index, 14),
  });
}
console.log(`class tabs: ${tabs.size} (expect 27 = 9 classes x 3)`);

// Talent: 0 id, 1 tab, 2 row, 3 col, 4..8 rank spells, 9..11 prereq talent, 12..14 prereq rank
type Talent = { id: number; row: number; col: number; ranks: number[]; prereqTalent: number; prereqRank: number };
const byTab = new Map<number, Talent[]>();
let sample = '';
for (let index = 0; index < talentDbc.recordCount; index++) {
  const tabId = talentDbc.getUint(index, 1);
  if (!tabs.has(tabId)) continue;
  const ranks: number[] = [];
  for (let r = 0; r < 5; r++) {
    const spell = talentDbc.getUint(index, 4 + r);
    if (spell) ranks.push(spell);
  }
  if (!ranks.length) continue;
  const talent: Talent = {
    id: talentDbc.getUint(index, 0),
    row: talentDbc.getUint(index, 2),
    col: talentDbc.getUint(index, 3),
    ranks,
    prereqTalent: talentDbc.getUint(index, 9),
    prereqRank: talentDbc.getUint(index, 12),
  };
  (byTab.get(tabId) ?? byTab.set(tabId, []).get(tabId)!).push(talent);
  if (ranks[0] === 12282) sample = `probe: Improved Heroic Strike -> tab "${tabs.get(tabId)?.name}" row ${talent.row} col ${talent.col}`;
}
console.log(sample || 'probe FAILED: spell 12282 not found at fields 4..8 — schema offsets need adjusting');

const output = {
  tabs: [...tabs.values()]
    .sort((a, b) => a.classId - b.classId || a.order - b.order)
    .map((tab) => ({ ...tab, talents: (byTab.get(tab.id) ?? []).sort((a, b) => a.row - b.row || a.col - b.col) })),
};
writeFileSync(OUT, JSON.stringify(output));
const total = output.tabs.reduce((n, t) => n + t.talents.length, 0);
console.log(`wrote ${OUT}: ${output.tabs.length} tabs, ${total} talents`);
archive.close();
