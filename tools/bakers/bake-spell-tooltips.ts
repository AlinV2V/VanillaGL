/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet, DbcFile } from '@vanillagl/assets';

const OUT = fileURLToPath(new URL('../../apps/client/public/spells', import.meta.url));
const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));

const F_NAME = 120;
const F_RANK = 129;
const F_DESCRIPTION = 138;
const F_TOOLTIP = 147;
const F_DIE_SIDES = 64;
const F_BASE_POINTS = 76;
const F_AMPLITUDE = 94;

// Resolve through the whole set: the patch archive that shadows Spell.dbc does not necessarily
// carry SpellDuration.dbc, so asking that one archive directly fails with StormLib error 44.
const archives = await ClientArchiveSet.open(CACHE, ['dbc.MPQ']);
const spell = new DbcFile(archives.extract('DBFilesClient\\Spell.dbc'));
const durationDbc = new DbcFile(archives.extract('DBFilesClient\\SpellDuration.dbc'));

if (spell.fieldCount !== 173) {
  throw new Error(`expected the patched 173-field Spell.dbc, got ${spell.fieldCount} — indices below are not valid for it`);
}

const durationMs = new Map<number, number>();
for (let i = 0; i < durationDbc.recordCount; i++) durationMs.set(durationDbc.getUint(i, 0), durationDbc.getInt(i, 1));

const rowOf = new Map<number, number>();
for (let i = 0; i < spell.recordCount; i++) rowOf.set(spell.getUint(i, 0), i);

/** Corruption (172) lasts 12 s; that is the anchor for the DurationIndex column. */
const corruption = rowOf.get(172);
let F_DURATION_INDEX = -1;
if (corruption !== undefined) {
  for (let f = 0; f < spell.fieldCount; f++) {
    const v = spell.getInt(corruption, f);
    if (v > 0 && durationMs.get(v) === 12000) { F_DURATION_INDEX = f; break; }
  }
}
if (F_DURATION_INDEX < 0) throw new Error('could not derive DurationIndex — Corruption(172) has no field resolving to 12000 ms');

// Layout self-check on known spells before trusting the whole bake, same discipline as bake-spells.
const assertSpell = (id: number, expect: { name: string; base0: number; sides0: number }) => {
  const r = rowOf.get(id);
  if (r === undefined) throw new Error(`layout check: spell ${id} missing`);
  const name = spell.getString(r, F_NAME);
  const base0 = spell.getInt(r, F_BASE_POINTS);
  const sides0 = spell.getInt(r, F_DIE_SIDES);
  if (name !== expect.name || base0 !== expect.base0 || sides0 !== expect.sides0) {
    throw new Error(`layout check FAILED for ${id}: name=${name} base=${base0} sides=${sides0}`);
  }
};
assertSpell(78, { name: 'Heroic Strike', base0: 10, sides0: 1 });
assertSpell(133, { name: 'Fireball', base0: 13, sides0: 9 });

type Entry = [string, string, number[], number[], number[], number];
const out: Record<number, Entry> = {};
let withText = 0;

for (let i = 0; i < spell.recordCount; i++) {
  const id = spell.getUint(i, 0);
  const description = spell.getString(i, F_DESCRIPTION) || '';
  const tooltip = spell.getString(i, F_TOOLTIP) || '';
  if (!description && !tooltip) continue;
  withText++;
  const triple = (base: number) => [0, 1, 2].map((e) => spell.getInt(i, base + e));
  out[id] = [
    description,
    tooltip,
    triple(F_BASE_POINTS),
    triple(F_DIE_SIDES),
    triple(F_AMPLITUDE),
    durationMs.get(spell.getInt(i, F_DURATION_INDEX)) ?? 0,
  ];
}

mkdirSync(OUT, { recursive: true });
const path = `${OUT}/spell-tooltips.json`;
writeFileSync(path, JSON.stringify(out));
console.log(`bake-spell-tooltips: ${withText} of ${spell.recordCount} spells carry text -> ${path}`);
console.log(`  DurationIndex derived at field ${F_DURATION_INDEX}`);
for (const id of [78, 133, 172, 585]) {
  const e = out[id];
  if (e) console.log(`  ${String(id).padStart(4)} base=${e[2][0]} sides=${e[3][0]} amp=${e[4][0]} dur=${e[5]}  ${JSON.stringify(e[0].slice(0, 70))}`);
}

for (const a of archives.all) a.close();
