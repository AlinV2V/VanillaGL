/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet, DbcFile } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/spells', import.meta.url));
const PATHS = {
  spell: 'DBFilesClient\\Spell.dbc',
  ability: 'DBFilesClient\\SkillLineAbility.dbc',
  family: 'DBFilesClient\\CreatureFamily.dbc',
  icon: 'DBFilesClient\\SpellIcon.dbc',
};
const SPELL = {
  requiredLevel: 29, effect: 61, targetA: 82, payload: 109,
  icon: 117, name: 120, rank: 129,
};

type Recipe = {
  learnedSpell: number;
  name: string;
  rank: string;
  iconId: number;
  requiredLevel: number;
  trainingPoints: number;
  skillIds: number[];
  chain: number;
  rankOrder: number;
};

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(`Beast Training bake: ${message}`);
};

async function main() {
  const archives = await ClientArchiveSet.open(CACHE, ['dbc.MPQ', 'interface.MPQ']);
  try {
    for (const path of Object.values(PATHS)) assert(archives.has(path), `missing ${path}`);
    const spells = new DbcFile(archives.extract(PATHS.spell));
    const abilities = new DbcFile(archives.extract(PATHS.ability));
    const familiesDbc = new DbcFile(archives.extract(PATHS.family));
    const icons = new DbcFile(archives.extract(PATHS.icon));
    assert(spells.recordCount === 22_357 && spells.fieldCount === 173,
      `expected patched Spell.dbc 22357x173, got ${spells.recordCount}x${spells.fieldCount}`);
    assert(abilities.recordCount === 5_072 && abilities.fieldCount === 15,
      `expected SkillLineAbility.dbc 5072x15, got ${abilities.recordCount}x${abilities.fieldCount}`);
    assert(familiesDbc.recordCount === 23 && familiesDbc.fieldCount === 18,
      `expected CreatureFamily.dbc 23x18, got ${familiesDbc.recordCount}x${familiesDbc.fieldCount}`);

    const spellRows = new Map<number, number>();
    for (let row = 0; row < spells.recordCount; row++) spellRows.set(spells.getUint(row, 0), row);
    const spellRow = (id: number) => {
      const row = spellRows.get(id);
      assert(row !== undefined, `missing anchor spell ${id}`);
      return row;
    };
    const opener = spellRow(5149);
    const bite = spellRow(17254);
    assert(spells.getUint(opener, SPELL.effect) === 47, 'spell 5149 is not the Beast Training opener');
    assert(spells.getString(bite, SPELL.name) === 'Bite' && spells.getString(bite, SPELL.rank) === 'Rank 1',
      'patched spell name/rank columns moved');
    assert(spells.getUint(bite, SPELL.effect) === 36 && spells.getUint(bite, SPELL.targetA) === 5
      && spells.getUint(bite, SPELL.payload) === 17253 && spells.getUint(bite, SPELL.requiredLevel) === 1,
    'Bite teaching effect/target/payload/level columns moved');
    assert(spells.getUint(spellRow(14926), SPELL.requiredLevel) === 50,
      'Growl rank 6 pet-level column moved');

    const abilityRows = new Map<number, number[]>();
    const previous = new Map<number, number>();
    for (let row = 0; row < abilities.recordCount; row++) {
      const id = abilities.getUint(row, 2);
      abilityRows.set(id, [...(abilityRows.get(id) ?? []), row]);
      const forward = abilities.getUint(row, 8);
      if (forward) {
        const existing = previous.get(forward);
        assert(existing === undefined || existing === id,
          `conflicting predecessors ${existing}/${id} for spell ${forward}`);
        previous.set(forward, id);
      }
    }
    const chainRoot = (spellId: number) => {
      const seen = new Set<number>();
      let current = spellId;
      while (previous.has(current)) {
        assert(!seen.has(current), `rank cycle at spell ${current}`);
        seen.add(current); current = previous.get(current)!;
      }
      return current;
    };
    const rankOrder = (spellId: number) => {
      const seen = new Set<number>();
      let current = spellId; let order = 0;
      while (previous.has(current)) {
        assert(!seen.has(current), `rank cycle at spell ${current}`);
        seen.add(current); current = previous.get(current)!; order++;
      }
      return order;
    };

    const recipes: Record<number, Recipe> = {};
    const targetRanks: Record<number, [chain: number, cumulativeTrainingPoints: number, rankOrder: number]> = {};
    const order: number[] = [];
    let candidates = 0;
    for (let row = 0; row < abilities.recordCount; row++) {
      if (abilities.getUint(row, 1) !== 261) continue;
      const teachingSpell = abilities.getUint(row, 2);
      if (recipes[teachingSpell]) continue;
      const teachingRow = spellRows.get(teachingSpell);
      if (teachingRow === undefined) continue;
      const effectIndex = [0, 1, 2].find((index) =>
        spells.getUint(teachingRow, SPELL.effect + index) === 36
        && spells.getUint(teachingRow, SPELL.targetA + index) === 5);
      if (effectIndex === undefined) continue;
      candidates++;
      const learnedSpell = spells.getUint(teachingRow, SPELL.payload + effectIndex);
      const targets = abilityRows.get(learnedSpell) ?? [];
      // vMaNGOS Pet::CanLearnPetSpell requires the learned spell to belong to family skillLine[0]
      // or generic hunter-pet skill 270. Orphaned Harass rows cannot pass that gate.
      if (!targets.length) continue;
      const costs = [...new Set(targets.map((target) => abilities.getUint(target, 14)))];
      assert(costs.length === 1, `spell ${learnedSpell} has ambiguous cumulative TP ${costs.join('/')}`);
      const skillIds = [...new Set(targets.map((target) => abilities.getUint(target, 1)))].sort((a, b) => a - b);
      const recipe: Recipe = {
        learnedSpell,
        name: spells.getString(teachingRow, SPELL.name),
        rank: spells.getString(teachingRow, SPELL.rank),
        iconId: spells.getUint(teachingRow, SPELL.icon),
        requiredLevel: spells.getUint(teachingRow, SPELL.requiredLevel),
        trainingPoints: costs[0],
        skillIds,
        chain: chainRoot(learnedSpell),
        rankOrder: rankOrder(learnedSpell),
      };
      recipes[teachingSpell] = recipe;
      targetRanks[learnedSpell] = [recipe.chain, recipe.trainingPoints, recipe.rankOrder];
      order.push(teachingSpell);
    }
    assert(candidates === 110, `expected 110 pet-target teachings, got ${candidates}`);
    assert(order.length === 107, `expected 107 server-learnable teachings, got ${order.length}`);

    const familyEntries: Record<number, [name: string, primarySkillId: number]> = {};
    for (let row = 0; row < familiesDbc.recordCount; row++) {
      const id = familiesDbc.getUint(row, 0);
      if (id) familyEntries[id] = [familiesDbc.getString(row, 8), familiesDbc.getUint(row, 5)];
    }
    assert(familyEntries[2]?.[0] === 'Cat' && familyEntries[2]?.[1] === 209,
      'CreatureFamily name/skill columns moved');

    mkdirSync(`${OUT}/icons`, { recursive: true });
    const iconPaths = new Map<number, string>();
    for (let row = 0; row < icons.recordCount; row++) iconPaths.set(icons.getUint(row, 0), icons.getString(row, 1));
    const usedIcons = new Set(order.map((id) => recipes[id].iconId));
    let bakedIcons = 0;
    for (const iconId of usedIcons) {
      const path = iconPaths.get(iconId);
      assert(path, `missing SpellIcon row ${iconId}`);
      const blpPath = `${path}.blp`;
      assert(archives.has(blpPath), `missing ${blpPath}`);
      const image = new Blp().load(archives.extract(blpPath)).getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
      writeFileSync(`${OUT}/icons/${iconId}.png`, encodePng(image.width, image.height, image.data));
      bakedIcons++;
    }
    writeFileSync(`${OUT}/beast-training.json`, JSON.stringify({ opener: 5149, families: familyEntries, order, recipes, targetRanks }));
    console.log(`beast-training.json: ${candidates} candidates, ${order.length} usable teachings, ${Object.keys(familyEntries).length} families, ${bakedIcons} icons`);
  } finally {
    for (const archive of archives.all) archive.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
