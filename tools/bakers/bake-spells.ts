/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet, DbcFile, openClientArchive, openClientArchives } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/spells', import.meta.url));

async function main() {
  mkdirSync(`${OUT}/icons`, { recursive: true });
  const dbc = await openClientArchive(CACHE, 'dbc.MPQ');
  const interfaceMpq = await openClientArchive(CACHE, 'interface.MPQ');
  // Patch archives shadow the base ones; patch-2 alone replaces 30 DBCs. See @vanillagl/assets.
  const patches = await openClientArchives(CACHE, []);
  // DBCs deliberately stay on the BASE archive. patch-2.MPQ overrides Spell.dbc with a DIFFERENT
  // field layout, and this tool's column indices were derived against the base copy — reading the
  // patch copy makes the layout self-check below fail outright (name/rank/icon all empty, gcd 0).
  // Switching DBC sources is a separate job: re-derive every index first, then flip. Asset (BLP)
  // reads below DO go patch-first, which is safe because those are content, not schema.
  const ifaceSet = new ClientArchiveSet([...patches, interfaceMpq]);

  // Icon id -> BLP path
  const iconDbc = new DbcFile(dbc.extract('DBFilesClient\\SpellIcon.dbc'));
  const iconPath = new Map<number, string>();
  for (let i = 0; i < iconDbc.recordCount; i++) {
    iconPath.set(iconDbc.getUint(i, 0), iconDbc.getString(i, 1));
  }

  // Sanity check the field layout on a known spell before trusting it for the whole bake.
  const spellDbc = new DbcFile(dbc.extract('DBFilesClient\\Spell.dbc'));
  const shapeshiftDbc = new DbcFile(dbc.extract('DBFilesClient\\SpellShapeshiftForm.dbc'));
  const rangeDbc = new DbcFile(dbc.extract('DBFilesClient\\SpellRange.dbc'));
  const radiusDbc = new DbcFile(dbc.extract('DBFilesClient\\SpellRadius.dbc'));
  const durationDbc = new DbcFile(dbc.extract('DBFilesClient\\SpellDuration.dbc'));
  const destinationImplicitTargets = new Set([8, 16, 28, 29, 31, 34, 52]);
  const spellRanges = new Map<number, { min: number; max: number }>();
  const spellRadii = new Map<number, number>();
  const spellDurations = new Map<number, number>();
  for (let i = 0; i < rangeDbc.recordCount; i++) {
    spellRanges.set(rangeDbc.getUint(i, 0), { min: rangeDbc.getFloat(i, 1), max: rangeDbc.getFloat(i, 2) });
  }
  for (let i = 0; i < radiusDbc.recordCount; i++) {
    spellRadii.set(radiusDbc.getUint(i, 0), radiusDbc.getFloat(i, 1));
  }
  for (let i = 0; i < durationDbc.recordCount; i++) {
    const raw = durationDbc.getInt(i, 1);
    spellDurations.set(durationDbc.getUint(i, 0), raw < 0 ? -1 : Math.abs(raw));
  }
  let verified = false;
  for (let i = 0; i < spellDbc.recordCount && !verified; i++) {
    if (spellDbc.getUint(i, 0) !== 133) continue; // Fireball Rank 1
    const icon = iconPath.get(spellDbc.getUint(i, 109)) ?? '';
    const gcd = spellDbc.getUint(i, 150);
    console.log(`layout check — Fireball: name="${spellDbc.getString(i, 112)}" rank="${spellDbc.getString(i, 121)}" icon="${icon}" gcd=${gcd}`);
    // gcd=1500 anchors the StartRecoveryTime column (field 150) for the cooldown bake.
    if (spellDbc.getString(i, 112) !== 'Fireball' || !/firebolt|flamebolt/i.test(icon) || gcd !== 1500) {
      throw new Error('Spell.dbc layout check FAILED — do not trust this bake, verify field indices');
    }
    verified = true;
  }
  if (!verified) throw new Error('Fireball (133) not found in Spell.dbc');

  // Anchor the EffectImplicitTargetA/B columns (A=74-76, B=77-79; effects live at 56-58) before
  // trusting them: Frost Armor (168) must be TARGET_SELF=1, Fireball (133) TARGET_UNIT_ENEMY=6,
  // and Frost Nova (122) uses caster location A=22 plus enemy source-area B=15.
  // Probed empirically across PW:Shield=21 (single friend), Battle Shout=20 (party around caster),
  // Arcane Explosion=22 (all around caster), Arcane Missiles=[1,6,6] — field 74 is the only match.
  for (let i = 0; i < spellDbc.recordCount; i++) {
    const id = spellDbc.getUint(i, 0);
    if (id !== 168 && id !== 133 && id !== 122) continue;
    const targetA = spellDbc.getUint(i, 74);
    const targetB = spellDbc.getUint(i, 77);
    if ((id === 168 && targetA !== 1) || (id === 133 && targetA !== 6) || (id === 122 && (targetA !== 22 || targetB !== 15))) {
      throw new Error(`Spell.dbc implicit-target column check FAILED — spell ${id} A=${targetA} B=${targetB}`);
    }
  }

  // Ground-target anchors from raw Build 5875 bytes:
  // Blizzard (10) has rangeIndex field 32 -> SpellRange 4 -> 30 yd,
  // EffectImplicitTargetA field 74 -> 28 (enemy AoE at dynamic-object destination),
  // and EffectRadiusIndex field 80 -> SpellRadius 14 -> 8 yd.
  let blizzardTargetingVerified = false;
  for (let i = 0; i < spellDbc.recordCount; i++) {
    if (spellDbc.getUint(i, 0) !== 10) continue;
    const target = spellDbc.getUint(i, 74);
    const range = spellRanges.get(spellDbc.getUint(i, 32))?.max ?? 0;
    const radius = spellRadii.get(spellDbc.getUint(i, 80)) ?? 0;
    if (target !== 28 || range !== 30 || radius !== 8) {
      throw new Error(`Spell.dbc ground-target columns FAILED — Blizzard target=${target} range=${range} radius=${radius}`);
    }
    blizzardTargetingVerified = true;
    break;
  }
  if (!blizzardTargetingVerified) throw new Error('Spell.dbc ground-target columns FAILED — Blizzard (10) missing');

  // Anchor the RecoveryTime column (field 16) on Blink (15s cooldown) before trusting it whole-table.
  let blinkVerified = false;
  for (let i = 0; i < spellDbc.recordCount; i++) {
    if (spellDbc.getUint(i, 0) !== 1953) continue; // Blink
    const recovery = Math.max(spellDbc.getUint(i, 15), spellDbc.getUint(i, 16));
    if (recovery !== 15000) throw new Error(`Spell.dbc cooldown column check FAILED — Blink recovery=${recovery}ms, expected 15000`);
    blinkVerified = true;
    break;
  }
  if (!blinkVerified) throw new Error('Spell.dbc cooldown column check FAILED — Blink (spell 1953) missing');

  // Attributes column (field 5) — verified vs known passive/active spells: 0x40 = SPELL_ATTR_PASSIVE
  // (One-Handed Axes/Dual Wield/Language all set it; Fireball/Heroic Strike/Attack/Charge clear it),
  // 0x80 = SPELL_ATTR_DO_NOT_DISPLAY. Lets the action bar seed only active, displayable abilities.
  const SPELL_ATTR_EX2_ENABLE_AFTER_PARRY = 0x00008000;
  const SPELLFAMILY_HUNTER = 9;
  const effectiveCasterAuraState = (row: number) => {
    // vMaNGOS SpellMgr.cpp migrates this pre-1.8 AttributesEx2 bit into the same aura-state gate
    // used by newer DBC rows: Hunter Counterattack uses HUNTER_PARRY (7), other parry reactions use
    // DEFENSE (1). Raw Build 5875 fields: AttributesEx2=7, CasterAuraState=12, family=152.
    if ((spellDbc.getUint(row, 7) & SPELL_ATTR_EX2_ENABLE_AFTER_PARRY) !== 0) {
      return spellDbc.getUint(row, 152) === SPELLFAMILY_HUNTER ? 7 : 1;
    }
    return spellDbc.getUint(row, 12);
  };
  // Cost and prevention columns, probed against raw Build 5875 bytes (tools/probe-spell-cost-columns.ts):
  //   field 27 = PowerType   — 0 mana / 1 rage / 2 focus / 3 energy / -2 health; 5 distinct values
  //                            table-wide. Fireball 0, Heroic Strike 1, Sinister Strike 3.
  //   field 28 = ManaCost    — in the SAME raw units the server publishes in UNIT_FIELD_POWER*, i.e.
  //                            rage in tenths: Fireball 30, Frost Armor 60, Sinister Strike 45,
  //                            Eviscerate 35, Heroic Strike 150 (= 15 rage).
  //   field 156 = PreventionType — 0 none / 1 silence-prevented / 2 pacify-prevented, the exact
  //                            discriminator Spell::CheckCast uses for UNIT_FLAG_SILENCED and
  //                            UNIT_FLAG_PACIFIED (Spell.cpp:6664-6668). Fireball 1, Heroic
  //                            Strike 2, Sinister Strike 2, Auto Shot 2.
  // Field 32 (rangeIndex) is already trusted above and neighbours these, which independently
  // corroborates the canonical 1.12 ordering: ...powerType, manaCost, manaCostPerLevel,
  // manaPerSecond, manaPerSecondPerLevel, rangeIndex...
  const SPELL_FIELD_POWER_TYPE = 27;
  const SPELL_FIELD_MANA_COST = 28;
  const SPELL_FIELD_MANA_COST_PERCENTAGE = 148;
  const SPELL_FIELD_PREVENTION_TYPE = 156;
  const SPELL_FIELD_TOTEM = 36;
  const SPELL_FIELD_REAGENT = 38;
  const SPELL_FIELD_REAGENT_COUNT = 46;
  const SPELL_FIELD_EQUIPPED_ITEM_CLASS = 54;
  const SPELL_FIELD_EQUIPPED_ITEM_SUBCLASS_MASK = 55;
  const SPELL_FIELD_EQUIPPED_ITEM_INVENTORY_TYPE_MASK = 56;
  const SPELL_FIELD_EFFECT_APPLY_AURA = 83;
  const SPELL_FIELD_EFFECT_MISC_VALUE = 98;
  // Raw Build-5875 Spell.dbc StanceBarOrder. CGPlayer_C's learned-form comparator
  // sorts this ascending and sends -1 entries to the end of the ten-slot bar.
  const SPELL_FIELD_STANCE_BAR_ORDER = 157;
  const SPELL_AURA_MOD_SHAPESHIFT = 36;
  const shapeshiftForms = new Map<number, { bonusActionBar: number; attackIconId: number }>();
  for (let row = 0; row < shapeshiftDbc.recordCount; row++) {
    shapeshiftForms.set(shapeshiftDbc.getUint(row, 0), {
      bonusActionBar: shapeshiftDbc.getUint(row, 1),
      attackIconId: shapeshiftDbc.getUint(row, 13),
    });
  }
  for (const [id, name, powerType, cost, costPercentage, prevention] of [
    [133, 'Fireball', 0, 30, 0, 1],
    [78, 'Heroic Strike', 1, 150, 0, 2],
    [1752, 'Sinister Strike', 3, 45, 0, 2],
    [75, 'Auto Shot', 0, 0, 0, 2],
    [1953, 'Blink', 0, 0, 35, 1],
  ] as const) {
    const row = [...Array(spellDbc.recordCount).keys()].find((i) => spellDbc.getUint(i, 0) === id);
    if (row === undefined) throw new Error(`Spell.dbc cost column check FAILED — ${id} ${name} missing`);
    const actual = [
      spellDbc.getUint(row, SPELL_FIELD_POWER_TYPE) | 0,
      spellDbc.getUint(row, SPELL_FIELD_MANA_COST),
      spellDbc.getUint(row, SPELL_FIELD_MANA_COST_PERCENTAGE),
      spellDbc.getUint(row, SPELL_FIELD_PREVENTION_TYPE),
    ];
    if (actual[0] !== powerType || actual[1] !== cost || actual[2] !== costPercentage || actual[3] !== prevention) {
      throw new Error(
        `Spell.dbc cost column check FAILED — ${id} ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify([powerType, cost, costPercentage, prevention])}`,
      );
    }
  }

  for (const [id, reagent, count, totem, equippedClass] of [
    [1856, 5140, 1, 0, -1], // Vanish / Flash Powder
    [2094, 5530, 1, 0, -1], // Blind / Blinding Powder
    [8227, 0, 0, 5176, -1], // Flametongue Totem / Fire Totem
    [78, 0, 0, 0, 2],       // Heroic Strike / weapon
  ] as const) {
    const row = [...Array(spellDbc.recordCount).keys()].find((i) => spellDbc.getUint(i, 0) === id);
    if (row === undefined) throw new Error(`Spell.dbc item-requirement check FAILED — spell ${id} missing`);
    const actual = [
      spellDbc.getUint(row, SPELL_FIELD_REAGENT),
      spellDbc.getUint(row, SPELL_FIELD_REAGENT_COUNT),
      spellDbc.getUint(row, SPELL_FIELD_TOTEM),
      spellDbc.getUint(row, SPELL_FIELD_EQUIPPED_ITEM_CLASS) | 0,
    ];
    if (actual[0] !== reagent || actual[1] !== count || actual[2] !== totem || actual[3] !== equippedClass) {
      throw new Error(`Spell.dbc item-requirement columns FAILED — spell ${id}: ${JSON.stringify(actual)}`);
    }
  }

  const spells: Record<number, [
    string, string, number, number, number, number, number[], number, number, number,
    number, number, number, number, number, number, number, number, number, number,
    Array<[number, number]>, number[], number, number, number, number, number, number, number,
  ]> = {};
  const usedIcons = new Set<number>();
  for (let i = 0; i < spellDbc.recordCount; i++) {
    const id = spellDbc.getUint(i, 0);
    const name = spellDbc.getString(i, 112);
    if (!id || !name) continue;
    const iconId = spellDbc.getUint(i, 109);
    // Effective cooldown = max(CategoryRecoveryTime, RecoveryTime); GCD = StartRecoveryTime (0 = off-GCD).
    const recoveryMs = Math.max(spellDbc.getUint(i, 15), spellDbc.getUint(i, 16));
    const gcdMs = spellDbc.getUint(i, 150);
    const attributes = spellDbc.getUint(i, 5);
    const shapeshiftEffect = [0, 1, 2].find((effect) =>
      spellDbc.getUint(i, SPELL_FIELD_EFFECT_APPLY_AURA + effect) === SPELL_AURA_MOD_SHAPESHIFT);
    const shapeshiftFormId = shapeshiftEffect === undefined
      ? 0
      : spellDbc.getUint(i, SPELL_FIELD_EFFECT_MISC_VALUE + shapeshiftEffect);
    const shapeshiftForm = shapeshiftForms.get(shapeshiftFormId);
    // Both implicit target arrays participate in the client/server target mask. Omitting B
    // loses 775 spells in this data set, including Frost Nova/War Stomp area targeting.
    const implicitTargets = [74, 75, 76, 77, 78, 79].map((field) => spellDbc.getUint(i, field)).filter((t) => t > 0);
    const maxRange = spellRanges.get(spellDbc.getUint(i, 32))?.max ?? 0;
    // Reticle radius is tied to the effects that actually consume a destination.
    // A spell can also carry an unrelated self/unit effect with a different radius,
    // so taking the maximum of all three effects would silently inflate its ground UI.
    const destinationRadii = [0, 1, 2]
      .filter((effect) => (
        destinationImplicitTargets.has(spellDbc.getUint(i, 74 + effect))
        || destinationImplicitTargets.has(spellDbc.getUint(i, 77 + effect))
      ))
      .map((effect) => spellRadii.get(spellDbc.getUint(i, 80 + effect)) ?? 0);
    const radius = destinationRadii.length ? Math.max(...destinationRadii) : 0;
    const reagents: Array<[number, number]> = [];
    for (let reagent = 0; reagent < 8; reagent++) {
      const entry = spellDbc.getUint(i, SPELL_FIELD_REAGENT + reagent);
      if (entry) reagents.push([entry, spellDbc.getUint(i, SPELL_FIELD_REAGENT_COUNT + reagent)]);
    }
    const totems = [0, 1]
      .map((totem) => spellDbc.getUint(i, SPELL_FIELD_TOTEM + totem))
      .filter((entry) => entry > 0);
    spells[id] = [
      name,
      spellDbc.getString(i, 121),
      iconId,
      recoveryMs,
      gcdMs,
      attributes,
      [...new Set(implicitTargets)],
      maxRange,
      radius,
      effectiveCasterAuraState(i),
      spellDbc.getUint(i, 13),
      spellDbc.getFloat(i, 33),
      spellDbc.getUint(i, 7),
      // Raw Build-5875 Spell.dbc `Targets` column. Anchors: Blizzard=0x0040 DEST,
      // Disenchant=0x0010 ITEM, Disarm Trap=0x4000 LOCKED.
      spellDbc.getUint(i, 9),
      // Raw 64-bit SpellFamilyFlags. SMSG_SET_*_SPELL_MODIFIER addresses these exact bit indices.
      spellDbc.getUint(i, 153),
      spellDbc.getUint(i, 154),
      // 16-19: flat/percentage power cost and the silence/pacify discriminator.
      spellDbc.getUint(i, SPELL_FIELD_POWER_TYPE) | 0,
      spellDbc.getUint(i, SPELL_FIELD_MANA_COST),
      spellDbc.getUint(i, SPELL_FIELD_PREVENTION_TYPE),
      spellDbc.getUint(i, SPELL_FIELD_MANA_COST_PERCENTAGE),
      reagents,
      totems,
      spellDbc.getUint(i, SPELL_FIELD_EQUIPPED_ITEM_CLASS) | 0,
      spellDbc.getUint(i, SPELL_FIELD_EQUIPPED_ITEM_SUBCLASS_MASK),
      spellDbc.getUint(i, SPELL_FIELD_EQUIPPED_ITEM_INVENTORY_TYPE_MASK),
      // Native CGPlayer_C learned-spell processing discovers the stance/form bar from
      // SPELL_AURA_MOD_SHAPESHIFT effects, then SpellShapeshiftForm.dbc supplies its bonus page
      // and contextual Attack icon. Keeping these raw relationships makes `.learn all` and
      // cross-class GM characters behave like Build 5875 without a spell-id allowlist.
      shapeshiftFormId,
      spellDbc.getInt(i, SPELL_FIELD_STANCE_BAR_ORDER),
      shapeshiftForm?.bonusActionBar ?? 0,
      shapeshiftForm?.attackIconId ?? 0,
      // Spell.DurationIndex is field 26 in the verified Build-5875 base DBC layout;
      // SpellDuration.dbc field 1 is the server/client base duration in milliseconds.
      spellDurations.get(spellDbc.getUint(i, 26)) ?? 0,
    ];
    if (iconId) usedIcons.add(iconId);
    if (shapeshiftForm?.attackIconId) usedIcons.add(shapeshiftForm.attackIconId);
  }
  if (spells[116]?.[29] !== 5000 || spells[122]?.[29] !== 8000 || spells[168]?.[29] !== 1800000) {
    throw new Error(`Spell duration metadata FAILED — ${JSON.stringify([spells[116]?.[29], spells[122]?.[29], spells[168]?.[29]])}`);
  }
  for (const [id, formId, stanceBarOrder, bonusActionBar, attackIconId] of [
    [768, 1, 2, 1, 1534], // Cat Form
    [783, 3, 3, 0, 0],    // Travel Form intentionally has no bonus action page.
    [5487, 5, 0, 3, 496], // Bear Form
    [2457, 17, 0, 1, 0],  // Battle Stance
  ] as const) {
    const baked = spells[id];
    if (!baked || baked[25] !== formId || baked[26] !== stanceBarOrder
      || baked[27] !== bonusActionBar || baked[28] !== attackIconId) {
      throw new Error(`Spell shapeshift metadata FAILED — spell ${id}: ${JSON.stringify(baked?.slice(25, 29))}`);
    }
  }
  // Pin the one-based state values against representative Build-5875/vMaNGOS reaction gates.
  // Overpower is deliberately zero: vMaNGOS drives it through the warrior reactive/combo-target
  // path, not UNIT_FIELD_AURASTATE.
  for (const [id, casterState, targetState, name] of [
    [6572, 1, 0, 'Revenge'],
    [5308, 0, 2, 'Execute'],
    [20271, 5, 0, 'Judgement'],
    [19306, 7, 0, 'Counterattack'],
    [7384, 0, 0, 'Overpower'],
  ] as const) {
    const baked = spells[id];
    if (!baked || baked[0] !== name || baked[9] !== casterState || baked[10] !== targetState) {
      throw new Error(
        `Spell.dbc aura-state check FAILED — ${id} ${name}: got ${baked ? JSON.stringify([baked[0], baked[9], baked[10]]) : 'missing'}`,
      );
    }
  }
  // vMaNGOS SpellEntry::IsAutoRepeatRangedSpell requires BOTH the ordinary ranged-slot bit and
  // AttributesEx2 AUTO_REPEAT. Preserve the second word so the action bar can toggle the same
  // spells and reconcile SMSG_CANCEL_AUTO_REPEAT without hard-coded spell ids.
  const SPELL_ATTR_USES_RANGED_SLOT = 0x00000002;
  const SPELL_ATTR_EX2_AUTO_REPEAT = 0x00000020;
  for (const [id, name, expected] of [
    [75, 'Auto Shot', true],
    // Build 5875's player wand Shoot row does NOT carry AttributesEx2 AUTO_REPEAT. Do not force it
    // into the Auto Shot path merely because vMaNGOS has nearby "Auto Shot & Shoot" comments.
    [5019, 'Shoot', false],
    [2764, 'Throw', false],
  ] as const) {
    const baked = spells[id];
    const actual = !!baked
      && (baked[5] & SPELL_ATTR_USES_RANGED_SLOT) !== 0
      && (baked[12] & SPELL_ATTR_EX2_AUTO_REPEAT) !== 0;
    if (!baked || baked[0] !== name || actual !== expected) {
      throw new Error(
        `Spell.dbc auto-repeat check FAILED — ${id} ${name}: got ${baked ? JSON.stringify([baked[0], baked[5], baked[12]]) : 'missing'}`,
      );
    }
  }
  writeFileSync(`${OUT}/spells.json`, JSON.stringify(spells));
  console.log(`spells.json: ${Object.keys(spells).length} spells`);

  // Weapon-enchant visuals are a three-DBC relationship in Build 5875:
  // SpellItemEnchantment.itemVisual -> ItemVisuals' five ItemVisualEffect IDs -> model paths.
  // Keep this in the metadata-only path because runtime rendering must never infer a glow from an
  // enchant spell name or ID.
  const enchantDbc = new DbcFile(dbc.extract('DBFilesClient\\SpellItemEnchantment.dbc'));
  const itemVisualsDbc = new DbcFile(dbc.extract('DBFilesClient\\ItemVisuals.dbc'));
  const itemVisualEffectsDbc = new DbcFile(dbc.extract('DBFilesClient\\ItemVisualEffects.dbc'));
  const visualEffects = new Map<number, string>();
  for (let row = 0; row < itemVisualEffectsDbc.recordCount; row++) {
    const id = itemVisualEffectsDbc.getUint(row, 0);
    const model = itemVisualEffectsDbc.getString(row, 1)
      .replace(/\\/g, '/')
      .replace(/\.mdx$/i, '.m2');
    if (id && model) visualEffects.set(id, model);
  }
  const itemVisuals = new Map<number, string[]>();
  for (let row = 0; row < itemVisualsDbc.recordCount; row++) {
    const id = itemVisualsDbc.getUint(row, 0);
    const models = [1, 2, 3, 4, 5]
      .map((field) => visualEffects.get(itemVisualsDbc.getUint(row, field)))
      .filter((model): model is string => !!model);
    if (id && models.length) itemVisuals.set(id, [...new Set(models)]);
  }
  const weaponEnchants: Record<number, string[]> = {};
  const itemEnchantNames: Record<number, string> = {};
  for (let row = 0; row < enchantDbc.recordCount; row++) {
    const enchantId = enchantDbc.getUint(row, 0);
    const name = enchantDbc.getString(row, 13);
    const itemVisualId = enchantDbc.getUint(row, 22);
    const models = itemVisuals.get(itemVisualId);
    if (enchantId && models?.length) weaponEnchants[enchantId] = models;
    if (enchantId && name) itemEnchantNames[enchantId] = name;
  }
  if (itemEnchantNames[1] !== 'Rockbiter 3' || itemEnchantNames[7] !== 'Deadly Poison') {
    throw new Error('SpellItemEnchantment.dbc name-column check failed');
  }
  writeFileSync(`${OUT}/weapon-enchants.json`, JSON.stringify(weaponEnchants));
  writeFileSync(`${OUT}/item-enchants.json`, JSON.stringify(itemEnchantNames));
  console.log(`weapon-enchants.json: ${Object.keys(weaponEnchants).length} enchantments`);
  console.log(`item-enchants.json: ${Object.keys(itemEnchantNames).length} named enchantments`);

  if (process.argv.includes('--metadata-only')) {
    dbc.close();
    interfaceMpq.close();
    return;
  }

  // Vanilla spellbook tabs are driven by SkillLineAbility.dbc, not guessed from
  // spell names. Preserve every association because racial/general abilities may
  // share a spell with a class skill line and are filtered by race/class masks at runtime.
  const skillLineDbc = new DbcFile(dbc.extract('DBFilesClient\\SkillLine.dbc'));
  const skillLines: Record<number, [string, number]> = {};
  for (let i = 0; i < skillLineDbc.recordCount; i++) {
    const id = skillLineDbc.getUint(i, 0);
    const name = skillLineDbc.getString(i, 3);
    if (id && name) skillLines[id] = [name, skillLineDbc.getUint(i, 21)];
  }
  const abilityDbc = new DbcFile(dbc.extract('DBFilesClient\\SkillLineAbility.dbc'));
  const abilities: Record<number, Array<[number, number, number]>> = {};
  for (let i = 0; i < abilityDbc.recordCount; i++) {
    const skillId = abilityDbc.getUint(i, 1);
    const spellId = abilityDbc.getUint(i, 2);
    if (!spells[spellId] || !skillLines[skillId]) continue;
    (abilities[spellId] ??= []).push([skillId, abilityDbc.getUint(i, 3), abilityDbc.getUint(i, 4)]);
  }
  writeFileSync(`${OUT}/spellbook.json`, JSON.stringify({ skillLines, abilities }));
  console.log(`spellbook.json: ${Object.keys(skillLines).length} skill lines, ${Object.keys(abilities).length} spells`);

  // TradeSkillFrame/CraftFrame are entirely client-driven in 1.12: profession
  // openers are SPELL_EFFECT_TRADE_SKILL (47), while recipes are learned spells
  // whose create/enchant effects and reagents live in Spell.dbc. There is no
  // server "trade skill list" packet to invent here.
  const abilityDetails = new Map<number, Array<{ skillId: number; min: number; high: number; low: number; skillUps: number }>>();
  for (let i = 0; i < abilityDbc.recordCount; i++) {
    const spellId = abilityDbc.getUint(i, 2);
    const skillId = abilityDbc.getUint(i, 1);
    if (!spells[spellId] || !skillLines[skillId]) continue;
    const list = abilityDetails.get(spellId) ?? [];
    list.push({
      skillId,
      min: abilityDbc.getUint(i, 7),
      high: abilityDbc.getUint(i, 10),
      low: abilityDbc.getUint(i, 11),
      skillUps: abilityDbc.getUint(i, 12),
    });
    abilityDetails.set(spellId, list);
  }
  const openers: Record<number, number> = {};
  const recipes: Record<number, {
    skillId: number; min: number; high: number; low: number; skillUps: number;
    createItem?: number; enchantItem?: boolean; reagents: Array<[number, number]>;
  }> = {};
  for (let i = 0; i < spellDbc.recordCount; i++) {
    const spellId = spellDbc.getUint(i, 0);
    const details = abilityDetails.get(spellId);
    if (!details?.length) continue;
    const effects = [56, 57, 58].map((field) => spellDbc.getUint(i, field));
    const skillId = details[0].skillId;
    if (effects.includes(47)) openers[spellId] = skillId;
    const createEffect = effects.findIndex((effect) => effect === 24);
    const enchantEffect = effects.findIndex((effect) => effect === 53);
    if (createEffect < 0 && enchantEffect < 0) continue;
    const reagents: Array<[number, number]> = [];
    for (let reagent = 0; reagent < 8; reagent++) {
      const itemId = spellDbc.getUint(i, 37 + reagent);
      const count = spellDbc.getUint(i, 45 + reagent);
      if (itemId && count) reagents.push([itemId, count]);
    }
    const detail = details[0];
    recipes[spellId] = {
      skillId,
      min: detail.min,
      high: detail.high,
      low: detail.low,
      skillUps: detail.skillUps,
      ...(createEffect >= 0 ? { createItem: spellDbc.getUint(i, 95 + createEffect) } : {}),
      ...(enchantEffect >= 0 ? { enchantItem: true } : {}),
      reagents,
    };
  }
  writeFileSync(`${OUT}/recipes.json`, JSON.stringify({ skillLines, openers, recipes }));
  console.log(`recipes.json: ${Object.keys(openers).length} profession openers, ${Object.keys(recipes).length} recipes`);

  let baked = 0;
  let missing = 0;
  for (const iconId of usedIcons) {
    const rel = iconPath.get(iconId);
    if (!rel) { missing++; continue; }
    const blpPath = `${rel}.blp`;
    if (!ifaceSet.has(blpPath)) { missing++; continue; }
    try {
      const blp = new Blp().load(ifaceSet.extract(blpPath));
      const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
      writeFileSync(`${OUT}/icons/${iconId}.png`, encodePng(img.width, img.height, img.data));
      baked++;
    } catch {
      missing++;
    }
  }
  console.log(`icons: ${baked} baked, ${missing} missing/undecodable (of ${usedIcons.size} referenced)`);

  dbc.close();
  interfaceMpq.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
