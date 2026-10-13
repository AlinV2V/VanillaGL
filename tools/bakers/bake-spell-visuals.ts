/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { DbcFile, openClientArchive, openClientArchives } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/spells', import.meta.url));

// Spell.dbc columns (verified vs known spells: Fireball speed=24/school=Fire/visual=67)
const COL_SPEED = 33; // Fireball=24, Frostbolt=28, ShadowBolt=20 (spec's "37" was wrong)
const COL_SCHOOL = 1;
const COL_VISUAL = 107;
const COL_EFFECT_FIRST = 56;
const SPELL_EFFECT_PERSISTENT_AREA_AURA = 27;

/**
 * EffectImplicitTargetA/B, Spell.dbc fields 74-79. The column mapping is already asserted in
 * tools/bake-spells.ts against three known spells (168 Frost Armor A=1, 133 Fireball A=6,
 * 122 Frost Nova A=22 B=15) and re-asserted below.
 *
 * Values are vMaNGOS `enum SpellTarget` (Spells/SpellDefines.h:23). This decides WHERE the impact
 * kit is anchored, which nothing consumed before:
 *   TARGET_UNIT_CASTER (1)                  -> the caster, whatever the UI has selected
 *   TARGET_LOCATION_* / TARGET_ENUM_UNITS_*_AOE_* -> ONE effect at the source/destination
 *   everything else (TARGET_UNIT_ENEMY 6, TARGET_UNIT_FRIEND 21, chain heal 45, ...)
 *                                           -> one effect per unit actually hit
 * Of the spells that carry an impact kit this splits 218 self / 81 area / 856 per-unit, so the
 * previous "always per hit target" behaviour was wrong for roughly a quarter of them: Arcane
 * Explosion (22,15) drew one explosion per victim instead of one at the caster, and Ice Armor (1)
 * drew its ice burst on whatever mob happened to be selected.
 */
const COL_IMPLICIT_TARGET = [74, 75, 76, 77, 78, 79];
const TARGET_UNIT_CASTER = 1;
/** vMaNGOS SpellTarget values that denote a LOCATION or an area sweep rather than a picked unit. */
const AREA_OR_LOCATION_TARGETS = new Set([
  7, 8, 9, 10, 15, 16, 17, 18, 22, 24, 28, 29, 30, 31, 33, 34, 36,
  39, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
]);

type ImpactAnchor = 'caster' | 'source' | 'target';

function impactAnchorOf(spell: DbcFile, row: number): ImpactAnchor {
  const targets = COL_IMPLICIT_TARGET.map((f) => spell.getUint(row, f)).filter((t) => t > 0);
  if (!targets.length) return 'target';
  if (targets.some((t) => AREA_OR_LOCATION_TARGETS.has(t))) return 'source';
  if (targets.every((t) => t === TARGET_UNIT_CASTER)) return 'caster';
  return 'target';
}

// SpellVisual.dbc columns (hypothesis from spec; asserted on Fireball below)
const SV = {
  precast: 1, cast: 2, impact: 3, state: 4, channel: 5,
  hasMissile: 6, missileModel: 7, missilePathType: 8, missileDestAttach: 9, missileSound: 10,
  hasArea: 11, areaModel: 12, areaKit: 13,
};
/**
 * SpellVisualKit.dbc columns — RECOVERED FROM RAW BUILD 5875 BYTES, not from a spec.
 * 1366 records x 35 fields. tools/probe-svk-schema.ts + tools/probe-svk-slots.ts:
 *   0        id
 *   1        startAnimId   values 0..5 only, 100% resolve as AnimationData ids
 *   2        animId        702 rows = -1, max 202, 100% of positives resolve as AnimationData
 *   3..12    ten SpellVisualEffectName slots — EVERY positive value in all ten columns
 *            resolves against SpellVisualEffectName.dbc (100%, no exceptions)
 *   13       soundId       97% resolve as SoundEntries, max 7594 = SoundEntries id max
 *   14       shakeId       42 positives, 100% resolve as SpellEffectCameraShakes (id max 26)
 *   15..18   charProc[4]   small enum, -1..15
 *   19..34   charParam[4][4]  float block (bit patterns are IEEE floats, not ids)
 *
 * The slot ORDER was recovered statistically rather than assumed: of the SpellVisualEffectName
 * names carrying exactly one body-part token, 93% of "Head" land in col 3, 70% of "Chest" in
 * col 4, 91% of "Base" in col 5, and 89% of "Hand" split near-evenly across cols 6 and 7
 * (219 vs 226) — the signature of a LeftHand/RightHand pair. Cols 9..12 are too sparse to
 * name from data (6/2/0/13 uses); they are carried through by index and treated as generic.
 *
 * The names are artist labels and are NOT authoritative — a model called "...Impact Base" does
 * sit in the Head column in 6 kits. The COLUMN is the client's attachment decision, so the
 * runtime binds by slot index, never by parsing the name.
 */
const SVK = { startAnim: 1, animId: 2, effectFirst: 3, effectCount: 10, soundId: 13, shakeId: 14 };
const SVK_SLOT_NAMES = [
  'head', 'chest', 'base', 'leftHand', 'rightHand', 'breath', 'slot6', 'slot7', 'slot8', 'world',
] as const;

// Known-good chain anchors. These MUST all be present in the full visual set and resolve.
const VERIFY_ANCHORS: Record<number, string> = {
  133: 'Fireball', 116: 'Frostbolt', 686: 'Shadow Bolt', 403: 'Lightning Bolt', 585: 'Smite',
  2054: 'Heal', 2050: 'Lesser Heal', 331: 'Healing Wave', 17: 'Power Word: Shield', 172: 'Corruption',
  348: 'Immolate', 139: 'Renew', 8921: 'Moonfire', 78: 'Heroic Strike', 100: 'Charge',
  5143: 'Arcane Missiles', 10: 'Blizzard', 5740: 'Rain of Fire', 20116: 'Consecration',
};

// Spell.dbc name column (verified in tools/bake-spells.ts: field 112 = SpellName enUS).
const COL_NAME = 112;

/**
 * SpellVisual is a client rendering table, not a player-spellbook table. Restricting this bake to
 * SkillLineAbility silently removed every creature, boss, pet, trap, quest and item visual even
 * though SMSG_SPELL_START/GO use the same Spell.dbc ids for all of them. The real client can resolve
 * any named Spell.dbc row with an authored SpellVisual, so the browser client must do the same.
 *
 * Persistent-area spells are included even when SpellVisual is zero: vMaNGOS creates a type-6
 * DynamicObject for SPELL_EFFECT_PERSISTENT_AREA_AURA and the client still needs the spell metadata
 * to attach and retire that server-authored area lifecycle.
 */
function deriveVisualSpellSet(spell: DbcFile): Set<number> {
  const spells = new Set<number>();
  for (let row = 0; row < spell.recordCount; row++) {
    const id = spell.getUint(row, 0);
    const name = spell.getString(row, COL_NAME);
    if (!id || !name) continue;
    const persistentArea = [0, 1, 2]
      .some((effect) => spell.getUint(row, COL_EFFECT_FIRST + effect) === SPELL_EFFECT_PERSISTENT_AREA_AURA);
    if (spell.getUint(row, COL_VISUAL) > 0 || persistentArea) spells.add(id);
  }
  for (const [idStr, name] of Object.entries(VERIFY_ANCHORS)) {
    if (!spells.has(Number(idStr))) throw new Error(`full visual spell set is missing anchor ${idStr} (${name})`);
  }
  return spells;
}
const SCHOOLS = ['Physical', 'Holy', 'Fire', 'Nature', 'Frost', 'Shadow', 'Arcane'];

interface EffectModel {
  id: number; name: string; model: string; attachment: number; scale: number;
  /** Index into SVK_SLOT_NAMES — the kit column this model came from. Drives runtime anchoring. */
  slot: number;
}
interface CameraShakeComponent {
  id: number; shakeType: number; direction: number; amplitude: number; frequency: number;
  duration: number; phase: number; coefficient: number;
}
interface Kit {
  id: number; startAnimId: number; animId: number; soundId: number; shakeId: number;
  shake: CameraShakeComponent[];
  effects: EffectModel[];
  
  chainEffect?: { id: number; mode: 'channel' | 'cast' };
  
  characterOpacity?: number;
}

const toM2 = (p: string) => p.replace(/\.(mdx|mdl)$/i, '.m2').replace(/\\/g, '/');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dbc = await openClientArchive(CACHE, 'dbc.MPQ');
  const spell = new DbcFile(dbc.extract('DBFilesClient\\Spell.dbc'));
  const sv = new DbcFile(dbc.extract('DBFilesClient\\SpellVisual.dbc'));
  const svk = new DbcFile(dbc.extract('DBFilesClient\\SpellVisualKit.dbc'));
  const sven = new DbcFile(dbc.extract('DBFilesClient\\SpellVisualEffectName.dbc'));
  const spellEffectCameraShakes = new DbcFile(dbc.extract('DBFilesClient\\SpellEffectCameraShakes.dbc'));
  const cameraShakes = new DbcFile(dbc.extract('DBFilesClient\\CameraShakes.dbc'));
  const chainEffects = new DbcFile(dbc.extract('DBFilesClient\\SpellChainEffects.dbc'));
  const chainEffectIds = new Set<number>();
  for (let row = 0; row < chainEffects.recordCount; row++) {
    chainEffectIds.add(chainEffects.getUint(row, 0));
  }

  // index records by id
  const indexById = (d: DbcFile) => {
    const m = new Map<number, number>();
    for (let i = 0; i < d.recordCount; i++) m.set(d.getUint(i, 0), i);
    return m;
  };
  const svById = indexById(sv);
  const svkById = indexById(svk);
  const svenById = indexById(sven);
  const spellEffectCameraShakesById = indexById(spellEffectCameraShakes);
  const cameraShakesById = indexById(cameraShakes);
  const spellById = indexById(spell);

  const effectModel = (id: number, slot: number): EffectModel | null => {
    const rec = svenById.get(id);
    if (id <= 0 || rec === undefined) return null;
    const model = sven.getString(rec, 2);
    if (!model) return null;
    return {
      id, name: sven.getString(rec, 1), model: toM2(model),
      attachment: sven.getInt(rec, 3), scale: sven.getFloat(rec, 4), slot,
    };
  };

  
  if (
    spellEffectCameraShakes.fieldCount !== 4
    || spellEffectCameraShakes.recordSize !== 16
    || cameraShakes.fieldCount !== 8
    || cameraShakes.recordSize !== 32
  ) {
    throw new Error(
      `camera-shake DBC layout mismatch: groups=${spellEffectCameraShakes.fieldCount}x${spellEffectCameraShakes.recordSize}`
      + ` components=${cameraShakes.fieldCount}x${cameraShakes.recordSize}`,
    );
  }
  const resolveShakeComponent = (id: number): CameraShakeComponent | null => {
    const rec = cameraShakesById.get(id);
    if (id <= 0 || rec === undefined) return null;
    return {
      id,
      shakeType: cameraShakes.getInt(rec, 1),
      direction: cameraShakes.getInt(rec, 2),
      amplitude: cameraShakes.getFloat(rec, 3),
      frequency: cameraShakes.getFloat(rec, 4),
      duration: cameraShakes.getFloat(rec, 5),
      phase: cameraShakes.getFloat(rec, 6),
      coefficient: cameraShakes.getFloat(rec, 7),
    };
  };
  const resolveShake = (id: number): CameraShakeComponent[] => {
    const rec = spellEffectCameraShakesById.get(id);
    if (id <= 0 || rec === undefined) return [];
    const components: CameraShakeComponent[] = [];
    for (let field = 1; field <= 3; field++) {
      const component = resolveShakeComponent(spellEffectCameraShakes.getInt(rec, field));
      if (component) components.push(component);
    }
    return components;
  };

  const resolveKit = (kitId: number): Kit | null => {
    const rec = svkById.get(kitId);
    if (kitId === 0 || rec === undefined) return null;
    const effects: EffectModel[] = [];
    for (let e = 0; e < SVK.effectCount; e++) {
      // The slot INDEX is the client's attachment decision. Columns 14..18 are shakeId and
      // charProc[4]; reading them as per-effect attachment overrides fed camera-shake ids
      // (up to 26) and proc enums into the attachment lookup.
      const em = effectModel(svk.getInt(rec, SVK.effectFirst + e), e);
      if (em) effects.push(em);
    }
    let chainEffect: Kit['chainEffect'];
    let characterOpacity: number | undefined;
    for (let proc = 0; proc < 4; proc++) {
      const kind = svk.getInt(rec, 15 + proc);
      const param0 = svk.getFloat(rec, 19 + proc);
      const id = Math.round(param0);

      // SpellChainEffects store. Other char-proc parameters can be positive
      // numbers too (kit 4889 carries 13, while Build 5875 authors ids 1..12).
      if (!chainEffect && (kind === 0 || kind === 12) && id > 0 && chainEffectIds.has(id)) {
        chainEffect = { id, mode: kind === 0 ? 'channel' : 'cast' };
      }
      // Character-process 14 removes the previous modifier for this visual, then adds param[0]


      if (kind === 14 && param0 >= 0 && param0 < 1) {
        characterOpacity = param0;
      }
    }
    return {
      id: kitId,
      startAnimId: svk.getInt(rec, SVK.startAnim),
      animId: svk.getInt(rec, SVK.animId),
      soundId: svk.getUint(rec, SVK.soundId),
      shakeId: svk.getInt(rec, SVK.shakeId),
      shake: resolveShake(svk.getInt(rec, SVK.shakeId)),
      effects,
      chainEffect,
      characterOpacity,
    };
  };

  // ---- VERIFY field mapping on Fireball before trusting the whole resolve ----
  const fbRec = spellById.get(133)!;
  const fbVisual = spell.getUint(fbRec, COL_VISUAL);
  const fbSvRec = svById.get(fbVisual)!;
  const precast = sv.getUint(fbSvRec, SV.precast);
  const cast = sv.getUint(fbSvRec, SV.cast);
  const impact = sv.getUint(fbSvRec, SV.impact);
  console.log(`VERIFY Fireball: visual=${fbVisual} (exp 67)  precastKit=${precast} (exp 30)  castKit=${cast} (exp 38)  impactKit=${impact} (exp 286)`);
  if (fbVisual !== 67 || precast !== 30 || cast !== 38 || impact !== 286) {
    throw new Error('SpellVisual column mapping FAILED vs Fireball ground truth — do not trust this bake');
  }
  const pkit = resolveKit(precast)!;
  console.log(`VERIFY precastKit 30: anim=${pkit.animId} (exp 51)  sound=${pkit.soundId} (exp 702)  effect0=${pkit.effects[0]?.model}`);
  if (pkit.animId !== 51) throw new Error('SpellVisualKit animId column FAILED vs ground truth');
  // Kit 30 raw row is [30,0,51,-1,-1,-1,287,287,-1,...]: "Fire Precast Hand" occupies BOTH hand
  // columns. If the effect block ever stops landing on slots 3 (leftHand) and 4 (rightHand) with
  // the same model, the column base has shifted and every anchor in the game is wrong.
  const hands = pkit.effects.filter((e) => SVK_SLOT_NAMES[e.slot] === 'leftHand' || SVK_SLOT_NAMES[e.slot] === 'rightHand');
  if (hands.length !== 2 || hands[0].id !== hands[1].id || hands[0].id !== 287) {
    throw new Error(`SpellVisualKit effect-slot base FAILED: kit 30 hands = ${JSON.stringify(hands.map((h) => h.id))}, expected [287,287]`);
  }
  // Kit 286 (Fireball impact) authors exactly one effect, in the chest column.
  const ikit = resolveKit(impact)!;
  if (ikit.effects.length !== 1 || SVK_SLOT_NAMES[ikit.effects[0].slot] !== 'chest' || ikit.effects[0].id !== 321) {
    throw new Error(`SpellVisualKit chest slot FAILED: kit 286 = ${JSON.stringify(ikit.effects.map((e) => [SVK_SLOT_NAMES[e.slot], e.id]))}`);
  }
  const fbSpeed = spell.getFloat(fbRec, COL_SPEED);
  console.log(`VERIFY Fireball speed=${fbSpeed} (exp 24)  school=${spell.getUint(fbRec, COL_SCHOOL)}`);
  const shake6 = resolveShake(6);
  if (
    JSON.stringify(shake6.map((component) => component.id)) !== '[4,5,6]'
    || shake6[0]?.shakeType !== 0
    || shake6[0]?.direction !== 0
    || shake6[0]?.amplitude !== 2
    || shake6[0]?.frequency !== 6
    || shake6[0]?.duration !== 4
    || shake6[0]?.phase !== 0
    || Math.abs((shake6[0]?.coefficient ?? 0) - 0.4) > 1e-6
  ) {
    throw new Error(`camera-shake join/field mapping FAILED for group 6: ${JSON.stringify(shake6)}`);
  }
  const chainLightningKit = resolveKit(321);
  const drainLifeKit = resolveKit(402);
  if (chainLightningKit?.chainEffect?.id !== 1 || chainLightningKit.chainEffect.mode !== 'cast'
    || drainLifeKit?.chainEffect?.id !== 8 || drainLifeKit.chainEffect.mode !== 'channel') {
    throw new Error('SpellVisualKit chain-proc columns FAILED against Chain Lightning / Drain Life');
  }
  const stealthKit = resolveKit(312);
  const invisibilityKit = resolveKit(3450);
  if (Math.abs((stealthKit?.characterOpacity ?? -1) - 0.3) > 1e-6
    || Math.abs((invisibilityKit?.characterOpacity ?? -1) - 0.5) > 1e-6) {
    throw new Error('SpellVisualKit character-opacity columns FAILED against Stealth / Invisibility');
  }


  // floats and two timing words directly from the 0x20-byte record to build AULightningObject.
  if (chainEffects.fieldCount !== 8 || chainEffects.recordSize !== 32) {
    throw new Error(`SpellChainEffects.dbc layout mismatch: ${chainEffects.fieldCount}x${chainEffects.recordSize}`);
  }
  const chainManifest: Record<number, {
    id: number; texture: string; textureLength: number; width: number; noise: number;
    scrollSpeed: number; segmentDurationMs: number; fadeMs: number;
  }> = {};
  const textureArchives = await openClientArchives(CACHE, ['texture.MPQ']);
  mkdirSync(`${OUT}/tex`, { recursive: true });
  for (let row = 0; row < chainEffects.recordCount; row++) {
    const id = chainEffects.getUint(row, 0);
    const source = chainEffects.getString(row, 7).replace(/\//g, '\\');
    const texture = `tex/chain_effect_${id}.png`;
    chainManifest[id] = {
      id,
      texture,
      textureLength: chainEffects.getFloat(row, 1),
      width: chainEffects.getFloat(row, 2),
      noise: chainEffects.getFloat(row, 3),
      scrollSpeed: chainEffects.getFloat(row, 4),
      segmentDurationMs: chainEffects.getUint(row, 5),
      fadeMs: chainEffects.getUint(row, 6),
    };
    const archive = textureArchives.find((candidate) => candidate.has(source));
    if (!archive) throw new Error(`SpellChainEffects texture missing: ${source}`);
    const blp = new Blp().load(archive.extract(source));
    const image = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
    writeFileSync(`${OUT}/${texture}`, encodePng(image.width, image.height, image.data));
  }
  if (chainManifest[1]?.width !== 0.5 || chainManifest[8]?.scrollSpeed !== -0.5) {
    throw new Error('SpellChainEffects.dbc value check FAILED against Lightning / SoulBeam');
  }
  writeFileSync(`${OUT}/spell-chain-effects.json`, JSON.stringify(chainManifest));

  // Implicit-target columns, anchored on the same three spells tools/bake-spells.ts asserts.
  const targetsOf = (id: number) => COL_IMPLICIT_TARGET.map((f) => spell.getUint(spellById.get(id)!, f)).filter((t) => t > 0);
  const anchorOf = (id: number) => impactAnchorOf(spell, spellById.get(id)!);
  console.log(
    `VERIFY implicit targets: FrostArmor=${targetsOf(168)} Fireball=${targetsOf(133)} FrostNova=${targetsOf(122)}`
    + ` ArcaneExplosion=${targetsOf(1449)} IceArmor=${targetsOf(7302)} ChainLightning=${targetsOf(421)}`,
  );
  const expectedAnchors: Record<number, ImpactAnchor> = {
    168: 'caster',  // Frost Armor  — TARGET_UNIT_CASTER only
    7302: 'caster', // Ice Armor    — TARGET_UNIT_CASTER only
    133: 'target',  // Fireball     — TARGET_UNIT_ENEMY
    421: 'target',  // Chain Lightning
    122: 'source',  // Frost Nova   — LOCATION_CASTER_SRC + ENEMY_AOE_AT_SRC
    1449: 'source', // Arcane Explosion — same pair
    2120: 'source', // Flamestrike  — ENEMY_AOE_AT_DEST
  };
  for (const [idStr, expected] of Object.entries(expectedAnchors)) {
    const got = anchorOf(Number(idStr));
    if (got !== expected) {
      throw new Error(`implicit-target anchoring FAILED for spell ${idStr}: got '${got}', expected '${expected}' (targets=${targetsOf(Number(idStr))})`);
    }
  }

  // ---- Resolve every authored visual, regardless of who casts it ----
  const targetIds = [...deriveVisualSpellSet(spell)].sort((a, b) => a - b);
  console.log(`derived ${targetIds.length} named Build-5875 visual/persistent-area spells`);
  const manifest: Record<number, unknown> = {};
  const neededModels = new Set<string>();
  const collect = (k: Kit | null) => k?.effects.forEach((e) => neededModels.add(e.model));
  let withVisual = 0;

  for (const id of targetIds) {
    const rec = spellById.get(id);
    if (rec === undefined) continue;
    const name = spell.getString(rec, COL_NAME);
    if (!name) continue;
    const persistentArea = [0, 1, 2]
      .some((effect) => spell.getUint(rec, COL_EFFECT_FIRST + effect) === SPELL_EFFECT_PERSISTENT_AREA_AURA);
    const visualId = spell.getUint(rec, COL_VISUAL);
    if (visualId) withVisual++;
    const svRec = svById.get(visualId);
    const kits: Record<string, Kit | null> = { precast: null, cast: null, impact: null, state: null, channel: null };
    let missile: unknown = null;
    let area: unknown = null;
    if (svRec !== undefined) {
      kits.precast = resolveKit(sv.getUint(svRec, SV.precast));
      kits.cast = resolveKit(sv.getUint(svRec, SV.cast));
      kits.impact = resolveKit(sv.getUint(svRec, SV.impact));
      kits.state = resolveKit(sv.getUint(svRec, SV.state));
      kits.channel = resolveKit(sv.getUint(svRec, SV.channel));
      Object.values(kits).forEach(collect);
      if (sv.getUint(svRec, SV.hasMissile)) {
        const mm = effectModel(sv.getInt(svRec, SV.missileModel), -1);
        if (mm) {
          neededModels.add(mm.model);
          missile = { model: mm.model, scale: mm.scale, speed: spell.getFloat(rec, COL_SPEED),
            destAttachment: sv.getUint(svRec, SV.missileDestAttach), pathType: sv.getUint(svRec, SV.missilePathType) };
        }
      }
      if (sv.getUint(svRec, SV.hasArea)) {
        const am = effectModel(sv.getInt(svRec, SV.areaModel), -1);
        const ak = resolveKit(sv.getUint(svRec, SV.areaKit));
        collect(ak);
        if (am) { neededModels.add(am.model); area = { model: am.model, scale: am.scale, kit: ak }; }
      }
    }
    manifest[id] = {
      name, visualId, speed: spell.getFloat(rec, COL_SPEED),
      school: SCHOOLS[spell.getUint(rec, COL_SCHOOL)] ?? 'Physical',
      persistentArea,
      impactAnchor: impactAnchorOf(spell, rec),
      kits, missile, area,
    };
  }

  // ---- Standalone kit manifest ----
  // SMSG_PLAY_SPELL_VISUAL (opcode 499) and SMSG_PLAY_SPELL_IMPACT (503) carry a
  // SpellVisualKit.dbc id directly, not a spell id — vMaNGOS Server/Packets/Spell.cpp:54
  // serializes { ObjectGuid, uint32 spellVisualId } and Spell.h:93 documents the field as
  // "SpellVisualKit.dbc index". Channelled spells (Spell.cpp:4219) and eat/drink
  // (Player.cpp:2281, kits 406/438) reach the client ONLY through this path, so the spell-keyed
  // manifest above cannot serve them. Bake every kit that resolves to a model, authored sound, or
  // camera shake. Seventeen Build 5875 shake kits contain no model and were previously lost here.
  const kitManifest: Record<number, Kit> = {};
  for (let rec = 0; rec < svk.recordCount; rec++) {
    const kit = resolveKit(svk.getUint(rec, 0));
    const hasSound = !!kit && kit.soundId > 0 && kit.soundId < 0xffffffff;
    if (!kit || (!kit.effects.length && !kit.shake.length && !hasSound && !kit.chainEffect
      && kit.characterOpacity === undefined)) continue;
    kitManifest[kit.id] = kit;
    kit.effects.forEach((e) => neededModels.add(e.model));
  }
  for (const anchor of [406, 438]) {
    if (!kitManifest[anchor]) {
      console.warn(`  !! vMaNGOS SPELL_VISUAL_KIT ${anchor} (SpellDefines.h:782) resolves to no model`);
    }
  }

  writeFileSync(`${OUT}/spell-visuals.json`, JSON.stringify(manifest));
  writeFileSync(`${OUT}/spell-visual-kits.json`, JSON.stringify(kitManifest));
  writeFileSync(`${OUT}/spell-visual-models.json`, JSON.stringify([...neededModels].sort(), null, 1));
  console.log(`\nWROTE spell-visuals.json (${Object.keys(manifest).length} spells, ${withVisual} with a visual chain)`);
  console.log(`WROTE spell-visual-kits.json (${Object.keys(kitManifest).length} of ${svk.recordCount} kits carry a model, sound, shake, chain, or character opacity)`);
  console.log(`WROTE spell-chain-effects.json (${Object.keys(chainManifest).length} authored beam profiles)`);
  console.log(`  + ${neededModels.size} unique effect models`);
}

await main();
