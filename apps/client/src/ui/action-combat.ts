import type { ActionButton, CombatEvent, InventorySlot, InventorySnapshot, ItemInfo, RealmWorldClient, WorldEntity } from '../world';
import { QA_GLOBALS_ENABLED, qaGlobals } from '../qa-globals.ts';
import type { WorldEntityRenderer } from '../world-entity-renderer';
import { CooldownStore } from '../combat/cooldowns';
import { spellAuraReadiness } from '../combat/aura-state';
import { spellUsability, type ActionUsability, type UsabilityInventoryItem } from '../combat/action-usability';
import {
  applySpellModifier,
  SPELL_MOD_OP,
  uniformSpellModifier,
  type SpellModifierKind,
} from '../combat/spell-modifiers';
import { showUiError, spellCastErrorText } from '../combat/spell-errors';
import {
  spellTargetWorkflow,
  TARGET_FLAG_CORPSE_ALLY,
  TARGET_FLAG_CORPSE_ENEMY,
  TARGET_FLAG_DEST_LOCATION,
  TARGET_FLAG_GAMEOBJECT,
  TARGET_FLAG_ITEM,
  TARGET_FLAG_LOCKED,
  TARGET_FLAG_SOURCE_LOCATION,
  TARGET_FLAG_STRING,
  TARGET_FLAG_TRADE_ITEM,
  TARGET_FLAG_UNIT,
  TARGET_FLAG_UNIT_DEAD,
  type SpellCastTargets,
  type SpellDestination,
  type SpellTargetWorkflow,
} from '../combat/spell-targeting';
import { factionIdForTemplate, getUnitReaction } from '../faction-reaction';
import { withDuelReaction } from './duel-reaction';
import { ownsFloatingCombatText } from './combat-text-ownership';
import type { CursorSlotRef, InventoryCursorController } from './inventory-cursor';
import { resolveVanillaActionBarOffset } from './action-bar-pages';
import { fctAllows } from './floating-combat-text';
import { areActionBarsLocked, multiBarVisibility } from './action-bar-visibility';
import { getInterfaceCvars } from './interface-runtime'; import { isBuiltInAddonEnabled } from './builtin-addons';
import type { MainMenuActionView, MainMenuMultiBarView } from './main-menu-bar-canvas';
import { actionButtonView, multiBarActionViews, type ActionViewDeps } from './action-button-views';
import { AQUATIC_FORM_ID, ShapeshiftActionState, SHAPESHIFT_META } from './shapeshift-action-state';
import {
  ANIM, HITINFO, oneShotKind, PET_TAME_FAILURE_TEXT, SPELL_MISS_TEXT, SWING_ERROR_TEXT,
  TWO_HANDED_SWING_ANIMS, VICTIM_STATE_TEXT, victimDefenseKind, woundReactionAnim,
  type CombatAnimKind,
} from '../combat/combat-anim-tables';
import { multiBarActionOffset, nextViewableActionPage, type MultiBarId } from './multi-action-bars';
import { itemButtonTooltip, spellButtonTooltip } from './action-tooltip';
import { loadSpellTooltips } from './spell-tooltip-text';
import { getGameTooltip, type TooltipLine } from './game-tooltip';
export const ACTION_BUTTON_TYPE_SPELL = 0x00;
export const ACTION_BUTTON_TYPE_MACRO = 0x40;
export const ACTION_BUTTON_TYPE_ITEM = 0x80;
export const ACTION_BAR_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
export const ATTACK_SPELL_ID = 6603; // "Attack" toggles auto-attack instead of casting.
export const ATTACK_ICON_ID = 26; // Ability_MeleeDamage (crossed swords) — 6603's own icon is "Temp".
// Stances/forms are toggle states vanilla does not pre-place on a new character's bar.
/** `"Rank 3"` -> `3`. Returns 0 for subtext that is not a rank (e.g. "Summon Warhorse"). */
const rankNumber = (rankText: string | undefined): number => {
  const match = rankText?.match(/^\s*rank\s+(\d+)\s*$/i);
  return match ? Number(match[1]) : 0;
};

const SEED_EXCLUDED_SPELLS = new Set([2457, 71, 2458, 5487, 768, 783, 1066, 24858, 33891]);
// Stock 1.12 level-one class buttons. Racial abilities and passives belong in the
// General spellbook tab, not on a newly-created character's primary bar.
const STARTER_CLASS_BAR: Record<number, number[]> = {
  1: [78],             // Warrior: Heroic Strike
  2: [21084, 635],     // Paladin: Seal of Righteousness, Holy Light
  3: [2973],           // Hunter: Raptor Strike
  4: [1752, 2098],     // Rogue: Sinister Strike, Eviscerate
  5: [585, 2050],      // Priest: Smite, Lesser Heal
  7: [403, 331],       // Shaman: Lightning Bolt, Healing Wave
  8: [133, 168],       // Mage: Fireball, Frost Armor
  9: [686, 687],       // Warlock: Shadow Bolt, Demon Skin
  11: [5176, 5185],    // Druid: Wrath, Healing Touch
};
export const DEFAULT_GCD_MS = 1500;
export const BASE_MELEE_RANGE_OFFSET = 1.333333373069763;
export const MIN_MELEE_RANGE = 5.0;
export const MIN_COMBAT_REACH = 1.5;
export const MELEE_FRONT_HALF_ARC = Math.PI / 3; // vMaNGOS HasInArc(2*pi/3): +/-60 degrees.
// [0 name, 1 rank, 2 iconId, 3 recoveryMs?, 4 gcdMs?, 5 attributes?, 6 implicitTargets?,
//  7 maxRange?, 8 radius?, 9 casterAuraState?, 10 targetAuraState?, 11 projectileSpeed?,
//  12 attributesEx2?, 13 explicitTargetMask?, 14 familyFlagsLow?, 15 familyFlagsHigh?,
//  16 powerType?, 17 powerCost?, 18 preventionType?, 19 powerCostPercentage?,
//  20 reagents?, 21 totems?, 22 equipped class?, 23 subclass mask?, 24 inventory-type mask?, 25 shapeshift form id?, 26 stance-bar order?, 27 bonus-action page?, 28 form Attack icon?, 29 base aura duration ms?]
// — attributes field 5:
// 0x40 = PASSIVE, 0x80 = DO_NOT_DISPLAY (used to seed only active, displayable abilities onto an
// empty action bar). implicitTargets = nonzero Spell.dbc EffectImplicitTargetA/B values (fields 74-79).
// 16-19 come from Spell.dbc fields 27/28/156/148 and drive the three-state usable render.
type SpellMeta = Record<number, [
  string, string, number, number?, number?, number?, number[]?, number?, number?, number?,
  number?, number?, number?, number?, number?, number?, number?, number?, number?, number?,
  Array<[number, number]>?, number[]?, number?, number?, number?, number?, number?, number?, number?, number?,
]>;
// Spell.dbc implicit targets that take the SELECTED UNIT in CMSG_CAST_SPELL. Destination areas are
// intercepted by spellNeedsDestination before this resolver; the remaining implicit families
// (self 1, party-around-caster 20, all-around-caster 22, cone 24...) cast with mask 0 and let the
// server fill targets. Sending the hostile selection for a self-buff like Frost Armor came back
// SPELL_FAILED_BAD_TARGETS ("the spell doesn't work").
const ENEMY_UNIT_TARGETS = new Set([6, 25]); // TARGET_CHAIN_DAMAGE, TARGET_DUELVSPLAYER
const FRIEND_UNIT_TARGETS = new Set([21, 35, 45, 57]); // single friend / party member / chain heal
const SPELL_ATTR_ON_NEXT_SWING = 0x00000004;
// SPELL_ATTR_USES_RANGED_SLOT (vmangos SpellDefines.h:793) — "All ranged abilites have this flag".
// Auto Shot (75), Shoot (5019) and Throw (2764) all carry it, and all three have SpellVisual 0 in
// Build 5875's Spell.dbc, so their caster pose has to come from the equipped ranged weapon instead.
const SPELL_ATTR_USES_RANGED_SLOT = 0x00000002;
const SPELL_ATTR_EX2_AUTO_REPEAT = 0x00000020;
const PET_ACTION_FEEDBACK_TEXT: Record<number, string> = {
  1: 'Your pet is dead.',
  2: 'There is nothing to attack.',
  3: 'You cannot attack that target.',
  4: 'No path available',
};
type LocalPosition = { x: number; y: number; z: number };
type FloatingTextOptions = { critical?: boolean; small?: boolean };
/** SMSG_SPELLLOGMISS / SpellMissInfo: 3 DODGE, 4 PARRY, 5 BLOCK (vmangos SharedDefines.h). */
const spellMissDefenseKind = (missInfo: number): 'dodge' | 'parry' | 'block' | undefined =>
  missInfo === 3 ? 'dodge' : missInfo === 4 ? 'parry' : missInfo === 5 ? 'block' : undefined;
export class ActionCombatController {
  private spellMeta: SpellMeta | null = null;
  private barActions: ActionButton[] = [];
  private activeBarOffset = 0;
  private manualActionPage = 0;
  private seededDefaultBar = false;
  private activeCast: { spellId: number; startTime: number; durationMs: number; isChannel: boolean } | null = null;
  private readonly cooldowns = new CooldownStore();
  private queuedMeleeSpellId = 0;
  private autoRepeatSpellId = 0;
  /**
   * Who the active auto-repeat is firing at, as confirmed by SMSG_SPELL_GO. Auto-repeat targets are
   * captured at cast time server-side and never follow the selection, so this is what tells a
   * "stop shooting" press apart from a "shoot that one instead" press.
   */
  private autoRepeatTargetGuid?: string;
  private pendingTarget?: {
    spellId: number;
    workflow: SpellTargetWorkflow;
    explicitMask: number;
    itemUse?: { bag: number; slot: number; spellSlot: number };
  };
  private readonly specialMeleeSwingUntil = new Map<string, number>();
  private usabilityInventoryCache?: { snapshot: InventorySnapshot | undefined; allItems: UsabilityInventoryItem[] | undefined; equippedItems: UsabilityInventoryItem[] | undefined };
  readonly shapeshift = new ShapeshiftActionState({ knownSpellIds: () => this.deps.getWorld()?.getKnownSpells() ?? [], auraSpellIds: () => this.deps.getPlayerEntity()?.auraSpellIds ?? [], meta: (spellId) => this.spellMeta?.[spellId], usability: (spellId) => this.getSpellUsability(spellId), cooldown: (spellId, now) => this.cooldowns.get(spellId, now), cast: (spellId) => this.useSpell(spellId) });
  constructor(private readonly deps: {
    elements: {
      actionBar: HTMLElement;
      buffsEl: HTMLElement;
      castBar: HTMLElement;
      castSpellName: HTMLElement;
      castFill: HTMLElement;
    };
    cursor: InventoryCursorController;
    getWorld: () => RealmWorldClient | undefined;
    getPlayerGuid: () => string | undefined;
    getSelectedTargetGuid: () => string | undefined;
    getPlayerEntity: () => WorldEntity | undefined;
    getPlayerClassId: () => number | undefined;
    getPlayerLevel: () => number | undefined;
    getInventory: () => InventorySnapshot | undefined;
    getProficiencyMask: (itemClass: number) => number | undefined;
    getSelectedTargetEntity: () => WorldEntity | undefined;
    getSelectedTargetPosition: () => LocalPosition | null | undefined;
    getPlayerLocalPosition: () => LocalPosition;
    worldToLocalPosition: (position: SpellDestination) => LocalPosition;
    getPlayerFacing: () => number;
    isSwimming: () => boolean;
    getEntityRenderer: () => WorldEntityRenderer | null | undefined;
    getAutoAttacking: () => boolean;
    setAutoAttacking: (value: boolean) => void;
    updateAttackIndicator: () => void;
    updateAttackBlocked: (blocked: boolean) => void;
    stopAttack: () => void;
    attackTarget: (guid: string) => void;
    log: (message: string) => void;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    findInventorySlot: (ref: CursorSlotRef) => InventorySlot | undefined;
    findFirstItemByEntry: (entry: number) => InventorySlot | undefined;
    activateInventorySlot: (slot: InventorySlot) => void;
    isBagContainerItem: (item?: NonNullable<InventorySlot['item']>, info?: ItemInfo, ref?: CursorSlotRef) => boolean;
    canPlaceItemOnActionButton: (item?: NonNullable<InventorySlot['item']>, info?: ItemInfo, ref?: CursorSlotRef, forcedBag?: boolean) => boolean;
    playEntityOrPlayer: (guid: string, animationId: number, durationMs?: number, kind?: CombatAnimKind) => void;
    /** AttackAnimKits swing for the named hand; `offHand` comes from HITINFO_LEFTSWING. */
    getMeleeAttackAnim: (attackerGuid: string, offHand?: boolean) => number;
    /** AttackBow/AttackRifle/AttackThrown for the equipped ranged weapon; undefined when unknown. */
    getRangedAttackAnim: (attackerGuid: string) => number | undefined;
    /** Weapon-aware Dodge / Parry* / ShieldBlock pose for a unit. */
    getDefenseAnim: (guid: string, kind: 'dodge' | 'parry' | 'block') => number;
    clearPlayerCombatAnim: () => void;
    spawnDamageText: (guid: string, text: string, color: string, opts?: FloatingTextOptions) => void;
    /** Owner check for the FCT "Pet Damage" category; undefined when the player has no pet. */
    getPetGuid: () => string | undefined;
    castSpellVisual: (
      spellId: number,
      casterGuid: string,
      targetGuid: string | undefined,
      stage: 'start' | 'go' | 'channel',
      durationMs: number,
      destination?: LocalPosition,
      /** Every GUID in the SMSG_SPELL_GO hit list, so multi-target spells impact on all of them. */
      hitGuids?: string[],
      ammo?: { displayId: number; inventoryType: number; speed: number },
      /** Every target missed: drop the target-anchored impact, keep the caster/source ones. */
      suppressTargetImpact?: boolean,
    ) => void;
    beginGroundTargeting: (request: {
      spellId: number;
      name: string;
      maxRange: number;
      radius: number;
      confirm?: (destination: SpellDestination) => void;
    }) => void;
    requestTextInput: (message: string, onAccept: (value: string) => void) => void;
    /** Baked SpellVisualKit anim for a stage: id to play, null = play nothing (vanilla), undefined = spell not baked. */
    getSpellCastAnim: (spellId: number, stage: 'start' | 'go' | 'channel') => number | null | undefined;
    refreshTargetFrame: () => void;
    renderInventory: () => void;
    rerenderNpcInteractions: () => void;
    executeMacro?: (index: number) => void;
    openTradeSkill?: (spellId: number) => boolean;
  }) {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.pendingTarget) return;
      this.cancelPendingTarget();
      event.preventDefault();
      event.stopImmediatePropagation();
    });
  }

  async loadSpellMeta(): Promise<SpellMeta> {
    if (this.spellMeta) return this.spellMeta as SpellMeta;
    try {
      this.spellMeta = await (await fetch('/spells/spells.json')).json();
      return this.spellMeta as SpellMeta;
    } catch {
      // Never cache the failure. A transient boot-time miss on spells.json must not permanently
      // disable implicit-target routing, next-swing queueing and GCD/recovery timing for the whole
      // session — leaving spellMeta unset lets the next call (casts/aura render/panel open) retry.
      return {};
    }
  }

  getSpellName(spellId: number) {
    return this.spellMeta?.[spellId]?.[0] ?? `Spell #${spellId}`;
  }

  /** Raw spells.json tuple for QA tooling: [name, rank, iconId, recoveryMs, gcdMs, attributes]. */
  getSpellMetaEntry(spellId: number) {
    return this.spellMeta?.[spellId];
  }

  /** Current 12-slot bar (QA tooling; do not mutate). */
  getBarActions(): readonly ActionButton[] {
    return this.barActions;
  }

  getActionPage() { return this.manualActionPage + 1; }

  /**
   * ActionBar_PageUp / ActionBar_PageDown (ActionButton.lua:63-101): skip any page a VISIBLE
   * multibar already draws, and wrap. The old clamp dead-ended at pages 1 and 6.
   */
  changeActionPage(direction: 'up' | 'down') {
    const next = nextViewableActionPage(this.manualActionPage + 1, direction, multiBarVisibility());
    this.manualActionPage = next - 1;
    return this.renderActionBar();
  }

  /** Warm the Spell.dbc description corpus so the first action-button hover already has its text. */
  preloadSpellTooltips() { return loadSpellTooltips(); }

  /** Everything `action-button-views.ts` needs to render a slot the way this controller would. */
  private actionViewDeps(): ActionViewDeps {
    const world = this.deps.getWorld();
    return {
      spellIconId: (id) => this.spellMeta?.[id]?.[2],
      readiness: (id) => this.getSpellUsability(id),
      cooldown: (id, now) => {
        const active = this.cooldowns.get(id, now);
        return active
          ? { remainingMs: Math.max(0, active.start + active.durationMs - now), durationMs: active.durationMs }
          : undefined;
      },
      itemInfo: (entry) => world?.getItemInfo(entry),
      itemIconUrl: (displayInfoId, entry) => this.deps.itemIconUrl(displayInfoId, entry),
      itemCount: (entry) => this.deps.findFirstItemByEntry(entry)?.item?.count,
      // Only the main bar carries the 1..= hotkeys; vanilla binds the multibars separately.
      hotkey: (slot, bar) => (bar ? undefined : ACTION_BAR_KEYS[slot]),
      queuedMeleeSpellId: this.queuedMeleeSpellId,
      autoAttacking: this.deps.getAutoAttacking(),
      attackSpellId: ATTACK_SPELL_ID,
      attackIconId: this.shapeshift.attackIconId(ATTACK_ICON_ID),
      spellActionType: ACTION_BUTTON_TYPE_SPELL,
      itemActionType: ACTION_BUTTON_TYPE_ITEM,
    };
  }

  /** Canvas-ready view of the authoritative action state. */
  getCanvasActionViews(now = performance.now()): MainMenuActionView[] {
    const deps = this.actionViewDeps();
    const cell = (slot: number) => this.deps.elements.actionBar.children[slot] as HTMLElement | undefined;
    return Array.from({ length: 12 }, (_, slot) => actionButtonView(this.barActions[slot], slot, deps, now, cell(slot)));
  }

  /** Canvas-ready views for MultiBarBottomLeft / MultiBarBottomRight. */
  getCanvasMultiBarViews(now = performance.now()): MainMenuMultiBarView {
    const all = this.deps.getWorld()?.getActionButtons() ?? [];
    return multiBarActionViews(all, multiBarVisibility(), this.actionViewDeps(), now);
  }

  /**
   * GameTooltip lines for an action-bar button, or undefined when the slot is empty.
   *
   * Spells get the full vanilla body — cost, cast time, requirements and the Spell.dbc description
   * with its `$s1` tokens resolved. Items fall through to the item tooltip builder.
   */
  actionTooltipLines(slot: number, bar?: MultiBarId): TooltipLine[] | undefined {
    const button = bar ? this.multiBarAction(bar, slot) : this.barActions[slot];
    if (!button) return undefined;
    if (button.type === ACTION_BUTTON_TYPE_ITEM) {
      return itemButtonTooltip(button.action, this.deps.getWorld()?.getItemInfo(button.action),
        this.deps.findFirstItemByEntry(button.action)?.item?.count);
    }
    if (button.type !== ACTION_BUTTON_TYPE_SPELL) return undefined;
    return spellButtonTooltip(button.action, this.spellMeta?.[button.action], this.getSpellName(button.action));
  }

  /** The action a multibar slot points at, straight out of the flat array at its fixed page. */
  private multiBarAction(bar: MultiBarId, slot: number): ActionButton | null {
    return this.deps.getWorld()?.getActionButtons()?.[multiBarActionOffset(bar) + slot] ?? null;
  }

  async pickupSpellbookSpell(spellId: number) {
    const meta = (await this.loadSpellMeta())[spellId];
    if (!meta) return;
    this.deps.cursor.setHeldCursor({
      kind: 'action',
      sourceSlot: -1,
      action: spellId,
      type: ACTION_BUTTON_TYPE_SPELL,
      name: meta[1] ? `${meta[0]} (${meta[1]})` : meta[0],
      iconUrl: `/spells/icons/${spellId === ATTACK_SPELL_ID ? ATTACK_ICON_ID : meta[2]}.png`,
    });
  }

  /**
   * FrameXML ActionButton_GetPagedID maps the main 12 buttons onto bonus pages 7-10 while a
   * stance/form is active. Packet storage is zero-based, hence Battle Stance begins at slot 72.
   */
  private resolveActiveBarOffset(allActions: readonly ActionButton[]) {
    const player = this.deps.getPlayerEntity();
    const classId = this.deps.getPlayerClassId() ?? 0;
    const bonusOffset = resolveVanillaActionBarOffset(allActions, classId, player?.auraSpellIds, (spellId) => this.shapeshift.bonusActionBar(spellId));
    return bonusOffset || this.manualActionPage * 12;
  }

  private packetActionSlot(visibleSlot: number, bar?: MultiBarId) {
    return (bar ? multiBarActionOffset(bar) : this.activeBarOffset) + visibleSlot;
  }

  spellRecoveryMs(spellId: number) {
    return this.modifiedSpellValue(spellId, this.spellMeta?.[spellId]?.[3] ?? 0, SPELL_MOD_OP.COOLDOWN);
  }

  spellGcdMs(spellId: number) {
    return this.modifiedSpellValue(
      spellId,
      this.spellMeta?.[spellId]?.[4] ?? DEFAULT_GCD_MS,
      SPELL_MOD_OP.GLOBAL_COOLDOWN,
    );
  }

  spellRange(spellId: number) {
    return this.modifiedSpellValue(spellId, this.spellMeta?.[spellId]?.[7] ?? 0, SPELL_MOD_OP.RANGE);
  }

  private spellModifier(spellId: number, kind: SpellModifierKind, modOp: number) {
    const meta = this.spellMeta?.[spellId];
    const world = this.deps.getWorld();
    if (!meta || !world) return 0;
    return uniformSpellModifier(
      world.getSpellModifierValues(kind, modOp, meta[14] ?? 0, meta[15] ?? 0),
    );
  }

  private modifiedSpellValue(spellId: number, base: number, modOp: number) {
    return applySpellModifier(
      base,
      this.spellModifier(spellId, 'flat', modOp),
      this.spellModifier(spellId, 'pct', modOp),
    );
  }

  private getSpellAuraReadiness(spellId: number) {
    const meta = this.spellMeta?.[spellId];
    return spellAuraReadiness(
      this.deps.getPlayerEntity()?.auraState,
      this.deps.getSelectedTargetEntity()?.auraState,
      meta?.[9],
      meta?.[10],
    );
  }

  private usabilityInventory(inventory: InventorySnapshot | undefined): NonNullable<typeof this.usabilityInventoryCache> {
    if (this.usabilityInventoryCache && this.usabilityInventoryCache.snapshot === inventory) return this.usabilityInventoryCache;
    if (!inventory) {
      return (this.usabilityInventoryCache = { snapshot: inventory, allItems: undefined, equippedItems: undefined });
    }
    const allItems: UsabilityInventoryItem[] = [];
    const equippedItems: UsabilityInventoryItem[] = [];
    const add = (slot: InventorySlot, equipped: boolean) => {
      const item = slot.item;
      if (!item) return;
      const value = {
        entry: item.entry, count: item.count, classId: item.info?.classId,
        subclass: item.info?.subclass, inventoryType: item.info?.inventoryType,
        durability: item.durability, maxDurability: item.maxDurability,
      };
      allItems.push(value);
      if (equipped) equippedItems.push(value);
    };
    for (const slot of inventory.equipment) add(slot, true);
    for (const bag of [...inventory.bags, inventory.keyring]) for (const slot of bag.slots) add(slot, false);
    return (this.usabilityInventoryCache = { snapshot: inventory, allItems, equippedItems });
  }

  /**
   * Vanilla's three-state IsUsableAction (ActionButton.lua:205-219): aura state, power cost,
   * silence/pacify, reagents/totems, equipped-item masks and the server-published proficiency mask.
   * The button stays clickable so SPELL_FAILED_* remains authoritative if local state races the
   * server.
   */
  private getSpellUsability(spellId: number): ActionUsability {
    const meta = this.spellMeta?.[spellId];
    const player = this.deps.getPlayerEntity();
    const inventory = this.deps.getInventory();
    const { allItems, equippedItems } = this.usabilityInventory(inventory);
    const requiredClass = meta?.[22];
    const proficiencyMask = requiredClass !== undefined && requiredClass >= 0
      ? this.deps.getProficiencyMask(requiredClass)
      : undefined;
    const readiness = spellUsability(
      {
        powerType: meta?.[16],
        powerCost: meta?.[17],
        powerCostPercentage: meta?.[19],
        preventionType: meta?.[18],
        casterAuraState: meta?.[9],
        targetAuraState: meta?.[10],
        explicitTargetMask: meta?.[13],
        reagents: meta?.[20],
        totems: meta?.[21],
        equippedItemClass: requiredClass,
        equippedItemSubclassMask: meta?.[23],
        equippedItemInventoryTypeMask: meta?.[24],
      },
      {
        powers: player?.powers,
        maxPowers: player?.maxPowers,
        health: player?.health,
        baseMana: player?.baseMana,
        baseHealth: player?.baseHealth,
        powerType: player?.powerType,
        auraState: player?.auraState,
        targetAuraState: this.deps.getSelectedTargetEntity()?.auraState,
        silenced: player?.silenced,
        pacified: player?.pacified,
        inventoryItems: allItems,
        equippedItems,
        proficiencyMasks: requiredClass !== undefined && requiredClass >= 0 && proficiencyMask !== undefined
          ? { [requiredClass]: proficiencyMask }
          : undefined,
      },
    );
    // Build 5875 exposes SPELL_FAILED_ONLY_UNDERWATER as "Can only use while swimming".
    if (meta?.[SHAPESHIFT_META.formId] === AQUATIC_FORM_ID && !this.deps.isSwimming()) readiness.usable = false;
    return readiness;
  }
  pickupActionButton(slot: number, bar?: MultiBarId) {
    const button = bar ? this.multiBarAction(bar, slot) : this.barActions[slot];
    const world = this.deps.getWorld();
    if (!button) return;
    // Interface Options → "Lock ActionBars": a locked bar refuses to give its buttons up.
    if (areActionBarsLocked()) {
      this.deps.log('action bar: locked (Interface Options → Lock ActionBars)');
      return;
    }
    const meta = this.spellMeta?.[button.action];
    const item = button.type === ACTION_BUTTON_TYPE_ITEM ? world?.getItemInfo(button.action) : undefined;
    const iconUrl = button.type === ACTION_BUTTON_TYPE_SPELL && meta?.[2]
      ? `/spells/icons/${meta[2]}.png`
      : button.type === ACTION_BUTTON_TYPE_ITEM
        ? this.deps.itemIconUrl(item?.displayInfoId, button.action)
        : '';
    const name = button.type === ACTION_BUTTON_TYPE_SPELL
      ? (meta ? (meta[1] ? `${meta[0]} (${meta[1]})` : meta[0]) : `Spell ${button.action}`)
      : button.type === ACTION_BUTTON_TYPE_ITEM
        ? item?.name ?? `Item #${button.action}`
        : `Macro ${button.action}`;
    world?.setActionButton(this.packetActionSlot(slot, bar), 0, 0);
    if (!bar) this.barActions[slot] = null;
    void this.renderActionBar(bar ? undefined : this.barActions);
    this.deps.cursor.setHeldCursor({ kind: 'action', sourceSlot: slot, sourceBar: bar, action: button.action, type: button.type, name, iconUrl });
  }

  placeHeldOnActionButton(slot: number, bar?: MultiBarId) {
    const heldCursor = this.deps.cursor.heldCursor;
    const world = this.deps.getWorld();
    if (!heldCursor || !world) return false;
    if (heldCursor.kind === 'item') {
      const sourceSlot = this.deps.findInventorySlot(heldCursor.source);
      const info = sourceSlot?.item?.info ?? world.getItemInfo(heldCursor.entry);
      if (!this.deps.canPlaceItemOnActionButton(sourceSlot?.item, info, heldCursor.source, heldCursor.isBag)) {
        this.deps.log(info ? `action bar: ${info.name} cannot be placed on an action button` : `action bar: item ${heldCursor.entry} is still loading`);
        return false;
      }
      world.setActionButton(this.packetActionSlot(slot, bar), heldCursor.entry, ACTION_BUTTON_TYPE_ITEM);
      if (!bar) this.barActions[slot] = { action: heldCursor.entry, type: ACTION_BUTTON_TYPE_ITEM };
    } else {
      world.setActionButton(this.packetActionSlot(slot, bar), heldCursor.action, heldCursor.type);
      if (!bar) this.barActions[slot] = { action: heldCursor.action, type: heldCursor.type };
    }
    this.deps.cursor.clearHeldCursor();
    void this.renderActionBar(bar ? undefined : this.barActions);
    return true;
  }

  useItemAction(entry: number) {
    const slot = this.deps.findFirstItemByEntry(entry);
    if (!slot) {
      this.deps.log(`action bar: item ${entry} is not in your bags`);
      return;
    }
    if (this.useInventoryItem(slot)) return;
    this.deps.activateInventorySlot(slot);
  }

  toggleAttack() {
    if (this.deps.getAutoAttacking()) {
      this.deps.stopAttack();
      return;
    }
    const guid = this.deps.getSelectedTargetGuid();
    if (guid) this.deps.attackTarget(guid);
    else this.deps.log('combat: no target selected');
  }

  useAction(slot: number, bar?: MultiBarId) {
    if (this.deps.cursor.heldCursor) {
      this.placeHeldOnActionButton(slot, bar);
      return;
    }
    const button = bar ? this.multiBarAction(bar, slot) : this.barActions[slot];
    if (!button) return;
    if (button.type === ACTION_BUTTON_TYPE_ITEM) {
      this.useItemAction(button.action);
      return;
    }
    if (button.type === ACTION_BUTTON_TYPE_MACRO) {
      this.deps.executeMacro?.(Math.max(0, button.action - 1));
      return;
    }
    if (button.type !== ACTION_BUTTON_TYPE_SPELL) {
      this.deps.log(`action bar: slot ${slot + 1} contains an unsupported action type 0x${button.type.toString(16)}`);
      return;
    }
    this.useSpell(button.action);
  }

  useSpell(spellId: number) {
    const world = this.deps.getWorld();
    if (!world) return;
    if (this.deps.openTradeSkill?.(spellId)) return;
    if (spellId === ATTACK_SPELL_ID) {
      this.toggleAttack();
      return;
    }
    const meta = this.spellMeta?.[spellId];
    if (meta?.[SHAPESHIFT_META.formId] === AQUATIC_FORM_ID && !this.deps.isSwimming()) return showUiError('Can only use while swimming');
    const explicitMask = meta?.[13] ?? 0;
    const workflow = spellTargetWorkflow(explicitMask, meta?.[6]);
    if (workflow === 'destination') {
      this.deps.beginGroundTargeting({
        spellId,
        name: meta?.[0] ?? `Spell #${spellId}`,
        maxRange: this.spellRange(spellId) || 30,
        radius: meta?.[8] ?? 3,
        confirm: (destination) => world.castSpellTargets(spellId, {
          targetMask: explicitMask | TARGET_FLAG_DEST_LOCATION,
          destination,
        }),
      });
      return;
    }
    if (workflow === 'source') {
      const player = this.deps.getPlayerEntity();
      if (player?.x === undefined || player.y === undefined || player.z === undefined) {
        showUiError('Invalid target.');
        return;
      }
      world.castSpellTargets(spellId, {
        targetMask: explicitMask | TARGET_FLAG_SOURCE_LOCATION,
        source: { x: player.x, y: player.y, z: player.z },
      });
      return;
    }
    if (workflow === 'string') {
      this.deps.requestTextInput(`Target for ${meta?.[0] ?? `Spell #${spellId}`}`, (stringTarget) => {
        world.castSpellTargets(spellId, { targetMask: explicitMask | TARGET_FLAG_STRING, stringTarget });
      });
      return;
    }
    if (workflow === 'tradeItem') {
      world.castSpellTargets(spellId, {
        targetMask: explicitMask | TARGET_FLAG_TRADE_ITEM,
        // SpellCastTargets::setTradeItemTarget uses the non-traded slot index as a GUID value.
        itemGuid: '0000000000000006',
      });
      return;
    }
    if (
      workflow === 'item'
      || workflow === 'locked'
      || workflow === 'gameObject'
      || workflow === 'corpse'
    ) {
      this.beginPendingTarget({ spellId, workflow, explicitMask });
      return;
    }
    const targetGuid = this.resolveCastTarget(spellId);
    // Pressing an active auto-repeat toggles it OFF only when it would repeat at the same target.
    // Against a NEW target the press is a retarget, and the server supports it directly:
    // SpellCaster::SetCurrentCastedSpell interrupts the current CURRENT_AUTOREPEAT_SPELL and
    // installs the new one with its new targets (SpellCaster.cpp:1661/1725), while
    // Unit::_UpdateAutoRepeatSpell replays the targets captured at cast time (Unit.cpp:3001) and so
    // never follows a selection change on its own. Cancelling unconditionally meant a hunter whose
    // mob died had to press Auto Shot twice to fire at the next one.
    const sameTarget = (targetGuid ?? '') === (this.autoRepeatTargetGuid ?? '');
    if (this.isAutoRepeatSpell(spellId) && this.autoRepeatSpellId === spellId && sameTarget) {
      world.cancelAutoRepeatSpell();
      this.clearAutoRepeatSpell();
      return;
    }
    if (this.isOnNextSwingSpell(spellId)) {
      if (!targetGuid) {
        showUiError('You have no target.');
        return;
      }
      // Heroic Strike, Maul and Raptor Strike are queued for the next weapon swing. Vanilla also
      // starts auto-attack when one is pressed against a valid target; without this, the server
      // holds the queued spell forever and repeated key presses appear to do nothing.
      if (!this.deps.getAutoAttacking()) this.deps.attackTarget(targetGuid);
      this.setQueuedMeleeSpell(spellId);
    }
    world.castSpellTargets(spellId, targetGuid
      ? { targetMask: explicitMask | TARGET_FLAG_UNIT, unitGuid: targetGuid }
      : { targetMask: explicitMask });
  }

  private beginPendingTarget(request: NonNullable<ActionCombatController['pendingTarget']>) {
    this.pendingTarget = request;
    const name = this.spellMeta?.[request.spellId]?.[0] ?? `Spell #${request.spellId}`;
    this.deps.log(
      `spell targeting: ${name} waiting for ${request.workflow} target; Escape cancels`,
    );
  }

  cancelPendingTarget() {
    if (!this.pendingTarget) return false;
    this.deps.log(`spell targeting: cancelled ${this.spellMeta?.[this.pendingTarget.spellId]?.[0] ?? this.pendingTarget.spellId}`);
    this.pendingTarget = undefined;
    return true;
  }

  /** One authoritative cleanup path for death, transfer, disconnect and character/world changes. */
  teardownCombatState(options: { clearCooldowns?: boolean } = {}) {
    this.pendingTarget = undefined;
    this.activeCast = null;
    this.clearQueuedMeleeSpell();
    this.clearAutoRepeatSpell();
    this.specialMeleeSwingUntil.clear();
    if (options.clearCooldowns !== false) this.cooldowns.clearAll();
    this.hideCastBar();
    this.renderAttackActiveState();
  }

  private sendPendingTargets(targets: SpellCastTargets) {
    const pending = this.pendingTarget;
    const world = this.deps.getWorld();
    if (!pending || !world) return false;
    if (pending.itemUse) {
      world.useItem(
        pending.itemUse.bag,
        pending.itemUse.slot,
        pending.itemUse.spellSlot,
        targets,
      );
    } else {
      world.castSpellTargets(pending.spellId, targets);
    }
    this.pendingTarget = undefined;
    return true;
  }

  /** Consume a world click while SpellIsTargeting is active. */
  targetPendingWorldEntity(entity: WorldEntity) {
    const pending = this.pendingTarget;
    if (!pending) return false;
    if ((entity.unitFlags ?? 0) & 0x02000000) {
      showUiError('Invalid target.');
      return true;
    }
    if (pending.workflow === 'gameObject' || pending.workflow === 'locked') {
      if (entity.typeName !== 'gameobject') {
        if (pending.workflow === 'locked') {
          showUiError('Requires a lockable item or object.');
        } else {
          showUiError('Invalid target.');
        }
        return true;
      }
      return this.sendPendingTargets({
        targetMask: pending.explicitMask | TARGET_FLAG_GAMEOBJECT,
        gameObjectGuid: entity.guid,
      });
    }
    if (pending.workflow === 'corpse') {
      const isCorpseObject = entity.typeName === 'corpse';
      const isDeadUnit = (entity.health ?? 1) <= 0;
      if (!isCorpseObject && !isDeadUnit) {
        showUiError('Target must be dead.');
        return true;
      }
      if (isCorpseObject) {
        const corpseFlag = pending.explicitMask & (TARGET_FLAG_CORPSE_ALLY | TARGET_FLAG_CORPSE_ENEMY);
        return this.sendPendingTargets({
          targetMask: pending.explicitMask | (corpseFlag || TARGET_FLAG_CORPSE_ALLY),
          corpseGuid: entity.guid,
        });
      }
      return this.sendPendingTargets({
        targetMask: pending.explicitMask | TARGET_FLAG_UNIT | TARGET_FLAG_UNIT_DEAD,
        unitGuid: entity.guid,
      });
    }
    showUiError('Select an inventory item.');
    return true;
  }

  /** Consume an inventory click for enchant, disenchant, lock, or item-origin targeting. */
  targetPendingInventoryItem(slot: InventorySlot) {
    const pending = this.pendingTarget;
    if (!pending) return false;
    if (pending.workflow !== 'item' && pending.workflow !== 'locked') return false;
    if (!slot.itemGuid) {
      showUiError('Invalid target.');
      return true;
    }
    return this.sendPendingTargets({
      targetMask: pending.explicitMask
        | TARGET_FLAG_ITEM
        | (pending.workflow === 'locked' ? TARGET_FLAG_LOCKED : 0),
      itemGuid: slot.itemGuid,
    });
  }

  /** Right-click/action-button use with the on-use spell's real target body. */
  useInventoryItem(slot: InventorySlot) {
    const info = slot.item?.info;
    const spellSlot = info?.onUseSpellSlot;
    if (!info || spellSlot === undefined) return false;
    const spellId = info.spells[spellSlot]?.spellId ?? 0;
    const world = this.deps.getWorld();
    if (!world) return true;
    if (!this.spellMeta) {
      void this.loadSpellMeta().then(() => this.useInventoryItem(slot));
      return true;
    }
    const meta = this.spellMeta[spellId];
    const explicitMask = meta?.[13] ?? 0;
    const workflow = spellTargetWorkflow(explicitMask, meta?.[6]);
    const itemUse = {
      bag: slot.protocolBag,
      slot: slot.protocolSlot,
      spellSlot,
    };
    if (workflow === 'destination') {
      this.deps.beginGroundTargeting({
        spellId,
        name: meta?.[0] ?? info.name,
        maxRange: this.spellRange(spellId) || 30,
        radius: meta?.[8] ?? 3,
        confirm: (destination) => world.useItem(
          itemUse.bag,
          itemUse.slot,
          itemUse.spellSlot,
          { targetMask: explicitMask | TARGET_FLAG_DEST_LOCATION, destination },
        ),
      });
      return true;
    }
    if (
      workflow === 'item'
      || workflow === 'locked'
      || workflow === 'gameObject'
      || workflow === 'corpse'
    ) {
      this.beginPendingTarget({ spellId, workflow, explicitMask, itemUse });
      return true;
    }
    if (workflow === 'tradeItem') {
      world.useItem(itemUse.bag, itemUse.slot, itemUse.spellSlot, {
        targetMask: explicitMask | TARGET_FLAG_TRADE_ITEM,
        itemGuid: '0000000000000006',
      });
      return true;
    }
    if (workflow === 'string') {
      this.deps.requestTextInput(`Target for ${meta?.[0] ?? info.name}`, (stringTarget) => {
        world.useItem(itemUse.bag, itemUse.slot, itemUse.spellSlot, {
          targetMask: explicitMask | TARGET_FLAG_STRING,
          stringTarget,
        });
      });
      return true;
    }
    if (workflow === 'source') {
      const player = this.deps.getPlayerEntity();
      if (player?.x === undefined || player.y === undefined || player.z === undefined) {
        showUiError('Invalid target.');
        return true;
      }
      world.useItem(itemUse.bag, itemUse.slot, itemUse.spellSlot, {
        targetMask: explicitMask | TARGET_FLAG_SOURCE_LOCATION,
        source: { x: player.x, y: player.y, z: player.z },
      });
      return true;
    }
    const targetGuid = workflow === 'unit' ? this.resolveCastTarget(spellId) : undefined;
    world.useItem(itemUse.bag, itemUse.slot, itemUse.spellSlot, targetGuid
      ? { targetMask: explicitMask | TARGET_FLAG_UNIT, unitGuid: targetGuid }
      : { targetMask: explicitMask });
    return true;
  }

  async castSpellByName(name: string) {
    // Vanilla macro syntax carries an optional explicit rank in the same argument:
    // `/cast Fireball(Rank 3)`. The rank has to be split off before matching — comparing the whole
    // string against the base name in SpellMeta[0] never matched, so every downranked macro failed
    // with "You do not know Fireball(Rank 3)". SpellMeta[1] holds the rank text ("Rank 3").
    const raw = name.trim();
    const ranked = raw.match(/^(.*?)\s*\(\s*rank\s+(\d+)\s*\)$/i);
    const wanted = (ranked ? ranked[1] : raw).trim().toLowerCase();
    const wantedRank = ranked ? Number(ranked[2]) : 0;

    const meta = await this.loadSpellMeta();
    const known = this.deps.getWorld()?.getKnownSpells() ?? [];
    let matches = known.filter((spellId) => meta[spellId]?.[0]?.toLowerCase() === wanted);
    if (wantedRank) {
      matches = matches.filter((spellId) => rankNumber(meta[spellId]?.[1]) === wantedRank);
    }
    if (!matches.length) {
      showUiError(`You do not know ${raw}.`);
      return false;
    }
    // Without an explicit rank vanilla casts the highest known rank; the known-spell list is
    // ascending, so the last match is that rank.
    this.useSpell(matches[matches.length - 1]);
    return true;
  }

  assignMacro(index: number) {
    const world = this.deps.getWorld();
    if (!world) return false;
    const slot = this.barActions.findIndex((button) => !button);
    if (slot < 0) {
      showUiError('Your action bar is full.');
      return false;
    }
    const action = index + 1;
    world.setActionButton(this.packetActionSlot(slot), action, ACTION_BUTTON_TYPE_MACRO);
    this.barActions[slot] = { action, type: ACTION_BUTTON_TYPE_MACRO };
    void this.renderActionBar(this.barActions);
    return true;
  }

  private isOnNextSwingSpell(spellId: number) {
    return ((this.spellMeta?.[spellId]?.[5] ?? 0) & SPELL_ATTR_ON_NEXT_SWING) !== 0;
  }

  private isRangedSpell(spellId: number) {
    return ((this.spellMeta?.[spellId]?.[5] ?? 0) & SPELL_ATTR_USES_RANGED_SLOT) !== 0;
  }

  private isAutoRepeatSpell(spellId: number) {
    const meta = this.spellMeta?.[spellId];
    return ((meta?.[5] ?? 0) & SPELL_ATTR_USES_RANGED_SLOT) !== 0
      && ((meta?.[12] ?? 0) & SPELL_ATTR_EX2_AUTO_REPEAT) !== 0;
  }

  private setQueuedMeleeSpell(spellId: number) {
    this.queuedMeleeSpellId = spellId;
    for (let i = 0; i < this.barActions.length; i++) {
      const action = this.barActions[i];
      const cell = this.deps.elements.actionBar.children[i] as HTMLElement | undefined;
      cell?.classList.toggle('is-queued', action?.type === ACTION_BUTTON_TYPE_SPELL && action.action === spellId);
    }
  }

  private clearQueuedMeleeSpell(spellId?: number) {
    if (spellId && this.queuedMeleeSpellId !== spellId) return;
    this.queuedMeleeSpellId = 0;
    for (const cell of this.deps.elements.actionBar.children) cell.classList.remove('is-queued');
  }

  private setAutoRepeatSpell(spellId: number, targetGuid?: string) {
    this.autoRepeatSpellId = spellId;
    this.autoRepeatTargetGuid = targetGuid;
    this.renderAttackActiveState();
  }

  private clearAutoRepeatSpell() {
    this.autoRepeatSpellId = 0;
    this.autoRepeatTargetGuid = undefined;
    this.renderAttackActiveState();
  }

  private renderAttackActiveState() {
    for (let i = 0; i < this.barActions.length; i++) {
      const action = this.barActions[i];
      const cell = this.deps.elements.actionBar.children[i] as HTMLElement | undefined;
      cell?.classList.toggle(
        'is-active-attack',
        action?.type === ACTION_BUTTON_TYPE_SPELL
          && (
            (this.deps.getAutoAttacking() && action.action === ATTACK_SPELL_ID)
            || (this.autoRepeatSpellId !== 0 && action.action === this.autoRepeatSpellId)
          ),
      );
    }
  }

  /**
   * Who to put in CMSG_CAST_SPELL for this spell, mirroring the 1.12 client's use of
   * Spell.dbc EffectImplicitTargetA/B:
   *  - any enemy-unit effect (Fireball, Heroic Strike, Arcane Missiles' trigger) -> the selection;
   *  - friend-unit effects (heals, single-target buffs) -> the selection only when it is
   *    actually friendly, else mask 0 so the server self-casts;
   *  - pure self/party/area spells (Frost Armor, Battle Shout, Frost Nova) -> always mask 0.
   * Spells missing from the bake keep the old pass-the-selection behavior.
   */
  private resolveCastTarget(spellId: number): string | undefined {
    const implicitTargets = this.spellMeta?.[spellId]?.[6];
    const selected = this.deps.getSelectedTargetGuid();
    if (!implicitTargets?.length) return selected;
    if (implicitTargets.some((target) => ENEMY_UNIT_TARGETS.has(target))) return selected;
    if (implicitTargets.some((target) => FRIEND_UNIT_TARGETS.has(target))) {
      if (!selected) return undefined;
      const player = this.deps.getPlayerEntity();
      const target = this.deps.getSelectedTargetEntity();
      const forced = this.deps.getWorld()?.getForcedReaction(factionIdForTemplate(target?.faction) ?? 0);
      const reaction = withDuelReaction(
        player,
        target,
        getUnitReaction(player?.faction, target?.faction, forced),
      );
      if (reaction === 'friendly') return selected;
      // Interface Options → "Auto Self Cast": with it on, a friendly spell cast while a
      // non-friendly unit is selected falls back to yourself (mask 0). With it off the
      // selection is sent through unchanged, so the server answers with the usual
      // invalid-target error instead of silently healing you.
      return Number(getInterfaceCvars().autoSelfCast) === 1 ? undefined : selected;
    }
    return undefined;
  }

  /**
   * Some servers ship an empty default action bar (no `playercreateinfo_action` rows), leaving the
   * player with no visible skills and — without a spellbook UI — no way to place them. When the
   * server gives us nothing, seed the bar from the player's known ACTIVE abilities (passives and
   * non-displayed spells filtered out via the Attributes column) so warriors etc. see their skills.
   * Persisted once via CMSG_SET_ACTION_BUTTON so the layout sticks server-side for next login.
   */
  private buildDefaultBar(meta: SpellMeta): ActionButton[] {
    const world = this.deps.getWorld();
    if (!world) return [];
    const known = new Set(world.getKnownSpells());
    const isActive = (id: number) => {
      if (id !== ATTACK_SPELL_ID && SEED_EXCLUDED_SPELLS.has(id)) return false; // stances/forms
      const m = meta[id];
      if (!m || !m[2]) return false;          // unknown to our metadata, or no icon to show
      const attrs = m[5] ?? 0;
      return (attrs & 0x40) === 0 && (attrs & 0x80) === 0; // not PASSIVE, not DO_NOT_DISPLAY
    };
    // Attack (auto-attack toggle) leads the bar in vanilla, then learned abilities in learn order.
    const classId = this.deps.getPlayerClassId() ?? 0;
    const ordered = [ATTACK_SPELL_ID, ...(STARTER_CLASS_BAR[classId] ?? [])]
      .filter((id, index, all) => all.indexOf(id) === index)
      .filter((id) => id === ATTACK_SPELL_ID || known.has(id))
      .filter(isActive);
    return ordered.slice(0, 12).map((id) => ({ action: id, type: ACTION_BUTTON_TYPE_SPELL }));
  }

  async renderActionBar(override?: readonly ActionButton[]) {
    const world = this.deps.getWorld();
    const meta = await this.loadSpellMeta();
    const allActions = world?.getActionButtons() ?? [];
    this.activeBarOffset = this.resolveActiveBarOffset(allActions);
    let source = override ?? allActions.slice(this.activeBarOffset, this.activeBarOffset + 12);
    // Repair the old "put every known active spell on the bar" seed once for fresh
    // level-one characters. Afterwards the player's own layout is never overwritten.
    if (!override && world && (this.deps.getPlayerLevel() ?? 0) === 1 && world.getKnownSpells().length > 0) {
      const guid = this.deps.getPlayerGuid();
      // Never share a repair marker between characters. During the login burst playerGuid used to
      // be undefined, creating a permanent `:unknown` marker that suppressed every later character.
      const marker = guid ? `wow-starter-bar-v4:${guid}` : '';
      if (marker && !localStorage.getItem(marker)) {
        const expected = this.buildDefaultBar(meta);
        const live = source.filter(Boolean) as ActionButton[];
        const exact = live.length === expected.length && expected.every((button, index) =>
          button?.action === live[index]?.action && button?.type === live[index]?.type);
        if (expected.length > 1) {
          if (!exact) {
            source = expected;
            for (let i = 0; i < 12; i++) {
              const button = expected[i];
              world.setActionButton(this.packetActionSlot(i), button?.action ?? 0, button?.type ?? 0);
            }
            this.seededDefaultBar = true;
          }
          localStorage.setItem(marker, '1');
        }
      }
    }
    if (!override && world) {
      // Only the first 12 slots belong to the visible primary bar. Buttons on stance/additional
      // pages must not prevent a blank primary page from being repaired.
      const live = source.filter(Boolean) as ActionButton[];
      const onlyAttack = live.length === 1 && live[0]?.action === ATTACK_SPELL_ID;
      if ((!this.seededDefaultBar && (live.length === 0 || onlyAttack)) || (this.seededDefaultBar && live.length === 0)) {
        const seeded = this.buildDefaultBar(meta);
        // Only seed once we actually have abilities to place (Attack + >=1 skill). This gates out
        // the premature enter-world render that fires BEFORE SMSG_INITIAL_SPELLS arrives — which
        // used to persist a lone Attack and then block the real bar (Heroic Strike etc.) from ever
        // seeding. `onlyAttack` also recovers a bar already stuck at just Attack from that old bug.
        if (seeded.length > 1) {
          source = seeded;
          this.seededDefaultBar = true;
          seeded.forEach((b, i) => b && world.setActionButton(this.packetActionSlot(i), b.action, b.type));
        }
      }
    }
    this.barActions = source.slice(0, 12).map((b) => (b ? { ...b } : null));
    this.deps.elements.actionBar.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      let button = this.barActions[i];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'wow-action-button';
      cell.dataset.actionSlot = String(i);
      const normal = document.createElement('span');
      normal.className = 'wow-action-normal';
      const key = document.createElement('span');
      key.textContent = ACTION_BAR_KEYS[i];
      key.className = 'wow-action-hotkey';
      const cooldown = document.createElement('span');
      cooldown.className = 'wow-action-cooldown is-hidden';
      const cooldownText = document.createElement('span');
      cooldownText.className = 'wow-action-cd-text is-hidden';
      if (button && button.type === ACTION_BUTTON_TYPE_SPELL) {
        const m = meta[button.action];
        cell.title = m ? (m[1] ? `${m[0]} (${m[1]})` : m[0]) : `Spell ${button.action}`;
        // Auto-attack (spell 6603) carries SpellIconID 1 = the "Temp" placeholder (reads as a vague
        // figure, not a weapon). Vanilla shows a melee/weapon icon for it — use Ability_MeleeDamage.
        const iconId = button.action === ATTACK_SPELL_ID ? this.shapeshift.attackIconId(ATTACK_ICON_ID) : m?.[2];
        if (iconId) {
          const icon = document.createElement('span');
          icon.className = 'wow-action-icon';
          icon.style.backgroundImage = `url(/spells/icons/${iconId}.png)`;
          cell.appendChild(icon);
        }
      } else if (button && button.type === ACTION_BUTTON_TYPE_ITEM) {
        const info = world?.getItemInfo(button.action);
        if (info && this.deps.isBagContainerItem(undefined, info)) {
          world?.setActionButton(this.packetActionSlot(i), 0, 0);
          this.barActions[i] = null;
          button = null;
        }
        if (button) {
          const iconUrl = this.deps.itemIconUrl(info?.displayInfoId, button.action);
          cell.title = info?.name ?? `Item ${button.action}`;
          if (iconUrl) {
            const icon = document.createElement('span');
            icon.className = 'wow-action-icon';
            icon.style.backgroundImage = `url('${iconUrl}')`;
            cell.appendChild(icon);
          }
        }
      } else if (button) {
        cell.title = button.type === ACTION_BUTTON_TYPE_MACRO ? `Macro ${button.action}` : `Action ${button.action}`;
      }
      cell.appendChild(normal);
      cell.appendChild(cooldown);
      cell.appendChild(cooldownText);
      cell.appendChild(key);
      if (button?.type === ACTION_BUTTON_TYPE_SPELL && button.action === this.queuedMeleeSpellId) cell.classList.add('is-queued');
      const slot = i;
      cell.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        if (event.button === 0 && this.deps.cursor.heldCursor) {
          this.placeHeldOnActionButton(slot);
          return;
        }
        if (event.button === 0 && event.shiftKey) {
          this.pickupActionButton(slot);
          return;
        }
        if (event.button === 0 || event.button === 2) this.useAction(slot);
      });
      cell.addEventListener('pointerup', (event) => {
        if (event.button !== 0 || !this.deps.cursor.heldCursor) return;
        event.preventDefault();
        this.placeHeldOnActionButton(slot);
      });
      cell.addEventListener('contextmenu', (event) => event.preventDefault());
      this.deps.elements.actionBar.appendChild(cell);
    }
    this.deps.cursor.refreshHeldSourceMarks();
    this.renderAttackActiveState();
  }

  async renderBuffs(guid = this.deps.getPlayerGuid()) {
    if (!guid) {
      this.deps.elements.buffsEl.classList.add('is-hidden');
      this.deps.elements.buffsEl.innerHTML = '';
      return;
    }
    const meta = await this.loadSpellMeta();
    const world = this.deps.getWorld();
    const rawAuras = world?.getAuras(guid) ?? [];
    const helpful = rawAuras.filter((aura) => aura.slot < 32).slice(0, 16);
    const harmful = rawAuras.filter((aura) => aura.slot >= 32).slice(0, 7);
    const auras = [...helpful, ...harmful];
    this.deps.elements.buffsEl.innerHTML = '';
    for (const aura of auras) {
      if (!aura.spellId) continue;
      const m = meta[aura.spellId];
      const icon = document.createElement('button');
      icon.type = 'button';
      const harmfulAura = aura.slot >= 32;
      const cancelable = (aura.flags & 0x01) !== 0;
      icon.className = `wow-buff-icon${harmfulAura ? ' is-harmful' : ''}${cancelable ? ' is-cancelable' : ''}`;
      if (m?.[2]) icon.style.backgroundImage = `url(/spells/icons/${m[2]}.png)`;
      if (aura.charges > 1) {
        const count = document.createElement('span');
        count.className = 'wow-buff-count';
        count.textContent = String(aura.charges);
        icon.appendChild(count);
      }
      if ((aura.timeRemainingMs ?? 0) > 0 && Number(getInterfaceCvars().buffDurations) === 1) {
        const duration = document.createElement('span');
        duration.className = 'wow-buff-duration';
        duration.dataset.expiresAt = String(Date.now() + (aura.timeRemainingMs ?? 0));
        duration.textContent = formatAuraDuration(aura.timeRemainingMs ?? 0);
        icon.appendChild(duration);
      }
      icon.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (cancelable) world?.cancelAura(aura.slot);
      });
      icon.addEventListener('pointermove', (event) => {
        const lines = spellButtonTooltip(aura.spellId, m, m?.[0] ?? `Spell ${aura.spellId}`);
        if (cancelable) lines.push({ text: 'Right-click to cancel', color: '#20ff20' });
        getGameTooltip().show(lines, event.clientX, event.clientY);
      });
      icon.addEventListener('pointerleave', () => getGameTooltip().hide());
      this.deps.elements.buffsEl.appendChild(icon);
    }
    this.deps.elements.buffsEl.classList.toggle('is-hidden', this.deps.elements.buffsEl.children.length === 0);
  }
  updateAuraTimers() {
    const now = Date.now();
    for (const label of this.deps.elements.buffsEl.querySelectorAll<HTMLElement>('.wow-buff-duration')) {
      const remaining = Math.max(0, Number(label.dataset.expiresAt ?? now) - now);
      const text = formatAuraDuration(remaining);
      if (label.textContent !== text) label.textContent = text;
      if (remaining <= 0) label.closest('.wow-buff-icon')?.remove();
    }
    this.deps.elements.buffsEl.classList.toggle('is-hidden', this.deps.elements.buffsEl.children.length === 0);
  }

  hideCastBar() {
    this.activeCast = null;
    this.deps.elements.castBar.classList.add('is-hidden');
    this.deps.elements.castFill.style.width = '0%';
  }

  /** True while the local player has a pending timed cast or an active channel (cast bar shown). */
  isCasting(): boolean {
    return this.activeCast !== null;
  }

  /** Whether the pending player cast is a channel (interrupted with CMSG_CANCEL_CHANNELLING). */
  isChannelling(): boolean {
    return this.activeCast?.isChannel === true;
  }

  updateCastBar() {
    if (!this.activeCast) return;
    const elapsed = performance.now() - this.activeCast.startTime;
    const duration = Math.max(1, this.activeCast.durationMs);
    const remaining = Math.max(0, duration - elapsed);
    const ratio = this.activeCast.isChannel ? remaining / duration : Math.min(1, elapsed / duration);
    this.deps.elements.castFill.style.width = `${Math.round(ratio * 100)}%`;
    if (this.activeCast.isChannel && remaining <= 0) this.hideCastBar();
  }

  triggerGlobalCooldown(castSpellId?: number) {
    const gcd = castSpellId !== undefined ? this.spellGcdMs(castSpellId) : DEFAULT_GCD_MS;
    if (gcd <= 0) return;
    const now = performance.now();
    for (const action of this.barActions) {
      if (!action || action.type !== ACTION_BUTTON_TYPE_SPELL || action.action === ATTACK_SPELL_ID) continue;
      if (this.spellGcdMs(action.action) <= 0) continue;
      this.cooldowns.start(action.action, gcd, now);
    }
  }

  updateCooldowns() {
    const now = performance.now();
    for (let i = 0; i < 12; i++) {
      const cell = this.deps.elements.actionBar.children[i] as HTMLElement | undefined;
      const overlay = cell?.querySelector<HTMLElement>('.wow-action-cooldown');
      const label = cell?.querySelector<HTMLElement>('.wow-action-cd-text');
      const action = this.barActions[i];
      const spellId = action?.type === ACTION_BUTTON_TYPE_SPELL ? action.action : 0;
      const cooldown = spellId ? this.cooldowns.get(spellId, now) : undefined;
      if (!overlay || !label || !cooldown) {
        overlay?.classList.add('is-hidden');
        label?.classList.add('is-hidden');
        if (label) label.textContent = '';
        continue;
      }
      const remaining = Math.max(0, cooldown.start + cooldown.durationMs - now);
      const remainingRatio = Math.max(0, Math.min(1, remaining / Math.max(1, cooldown.durationMs)));
      overlay.style.setProperty('--cd-angle', `${Math.round(remainingRatio * 360)}deg`);
      overlay.classList.remove('is-hidden');
      if (remaining > 0 && isBuiltInAddonEnabled('cooldownNumbers')) {
        label.textContent = remaining < 3000 ? (remaining / 1000).toFixed(1) : String(Math.ceil(remaining / 1000));
        label.classList.remove('is-hidden');
      } else {
        label.textContent = '';
        label.classList.add('is-hidden');
      }
    }
  }

  updateActionStates() {
    const target = this.deps.getSelectedTargetEntity();
    const targetDead = !!target && (target.health ?? 1) <= 0 && !!target.maxHealth;
    let outOfMeleeRange = false;
    let badFacing = false;
    if (target && !targetDead) {
      const p = this.deps.getSelectedTargetPosition();
      if (p) {
        const self = this.deps.getPlayerLocalPosition();
        const dx = p.x - self.x;
        const dy = p.y - self.y;
        const dist = Math.hypot(dx, dy);
        const player = this.deps.getPlayerEntity();
        const selfReach = Math.max(player?.combatReach ?? MIN_COMBAT_REACH, MIN_COMBAT_REACH);
        const targetReach = Math.max(target.combatReach ?? MIN_COMBAT_REACH, MIN_COMBAT_REACH);
        const reach = Math.max(selfReach + targetReach + BASE_MELEE_RANGE_OFFSET, MIN_MELEE_RANGE);
        outOfMeleeRange = dist > reach;
        const toTarget = Math.atan2(dy, dx);
        const delta = Math.abs(((toTarget - this.deps.getPlayerFacing() + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        badFacing = dist > 1.4 && delta > MELEE_FRONT_HALF_ARC;
      }
    }
    const meleeBlocked = !!target && !targetDead && (outOfMeleeRange || badFacing);
    const player = this.deps.getPlayerEntity();
    // UNIT_FLAG_DISARMED only ever covers the main hand — CanUseEquippedWeapon returns true for
    // OFF_ATTACK and RANGED_ATTACK unconditionally (vMaNGOS Unit.h:991-1004) — but the main hand is
    // what the Attack button drives.
    const weaponBlocked = !!player?.disarmed || !!player?.pacified;
    for (let i = 0; i < 12; i++) {
      const cell = this.deps.elements.actionBar.children[i] as HTMLElement | undefined;
      if (!cell) continue;
      const action = this.barActions[i];
      const isAttack = action?.type === ACTION_BUTTON_TYPE_SPELL && action.action === ATTACK_SPELL_ID;
      cell.classList.toggle('is-out-of-range', isAttack && meleeBlocked);
      const usability: ActionUsability = action?.type === ACTION_BUTTON_TYPE_SPELL
        ? this.getSpellUsability(action.action)
        : { usable: true, notEnoughPower: false, reactive: false };
      const blocked = !usability.usable && !usability.notEnoughPower;
      // Advisory only: keep the button clickable so the realm can return authoritative
      // SPELL_FAILED_* feedback if update-field state is stale or a second requirement fails.
      cell.classList.toggle('is-aura-unusable', blocked || (isAttack && weaponBlocked));
      // Vanilla's third state: enough of everything except the resource (ActionButton.lua:212).
      cell.classList.toggle('is-not-enough-power', usability.notEnoughPower);
      cell.classList.toggle('is-aura-reactive', usability.reactive);
    }
    this.deps.updateAttackBlocked(meleeBlocked);
  }

  handleCombatEvent(ev: CombatEvent) {
    switch (ev.kind) {
      case 'attackStart':
        if (ev.attackerGuid === this.deps.getPlayerGuid()) {
          this.deps.setAutoAttacking(true);
          this.deps.updateAttackIndicator();
          this.renderAttackActiveState();
        }
        break;
      case 'attackStop':
        if (ev.attackerGuid === this.deps.getPlayerGuid()) {
          this.deps.setAutoAttacking(false);
          this.deps.updateAttackIndicator();
          this.renderAttackActiveState();
          this.clearQueuedMeleeSpell();
        }
        break;
      case 'combatCancelled':
        this.deps.setAutoAttacking(false);
        this.deps.updateAttackIndicator();
        this.renderAttackActiveState();
        this.clearQueuedMeleeSpell();
        this.deps.clearPlayerCombatAnim();
        break;
      case 'autoRepeatCancelled':
        this.clearAutoRepeatSpell();
        this.deps.clearPlayerCombatAnim();
        break;
      case 'swingError': {
        const text = SWING_ERROR_TEXT[ev.reason] ?? ev.reason;
        showUiError(text);
        this.deps.log(`combat: ${text}`);
        break;
      }
      case 'creatureQueryResponse':
      case 'playerNameResponse':
        if (this.deps.getSelectedTargetGuid()) this.deps.refreshTargetFrame();
        break;
      case 'itemQueryResponse':
        this.deps.renderInventory();
        this.deps.rerenderNpcInteractions();
        break;
      case 'spellStart': {
        // Anim from the spell's own SpellVisualKit when baked; generic precast pose only for unbaked
        // spells. A baked spell whose precast kit has no anim plays nothing (kit anim 0 = Stand).
        const startAnim = this.deps.getSpellCastAnim(ev.spellId, 'start');
        if (startAnim !== null) {
          const anim = startAnim ?? ANIM.SPELL_PRECAST_DIRECTED;
          this.deps.playEntityOrPlayer(ev.casterGuid, anim, Math.max(650, ev.castTimeMs || 0), oneShotKind(anim));
        }
        this.deps.castSpellVisual(
          ev.spellId,
          ev.casterGuid,
          ev.targetGuid,
          'start',
          // The true cast time, not a 600ms stand-in: the controller needs to tell an instant cast
          // (no bar, one authored play) from a timed one (glow loops for exactly the bar).
          ev.castTimeMs || 0,
          ev.destination ? this.deps.worldToLocalPosition(ev.destination) : undefined,
          undefined,
          ev.ammoDisplayId
            ? {
                displayId: ev.ammoDisplayId,
                inventoryType: ev.ammoInventoryType ?? 0,
                speed: this.spellMeta?.[ev.spellId]?.[11] || 40,
              }
            : undefined,
        );
        if (ev.casterGuid === this.deps.getPlayerGuid() && ev.castTimeMs > 0) {
          this.activeCast = { spellId: ev.spellId, startTime: performance.now(), durationMs: ev.castTimeMs, isChannel: false };
          void this.showCastBar();
        }
        if (ev.casterGuid === this.deps.getPlayerGuid()) this.triggerGlobalCooldown(ev.spellId);
        break;
      }
      case 'spellGo': {
        const allMiss = ev.hitGuids.length === 0 && ev.misses.length > 0;
        // Melee abilities (Heroic Strike etc.) have no cast kit — their swing anim comes from
        // SMSG_ATTACKERSTATEUPDATE. Only unbaked spells fall back to the generic throw pose.
        const onNextSwing = this.isOnNextSwingSpell(ev.spellId);
        const goAnim = this.deps.getSpellCastAnim(ev.spellId, 'go');
        if (onNextSwing) {
          // Successful CURRENT_MELEE_SPELL casts send SPELL_GO but deliberately return before the
          // ordinary attacker-state packet in vMaNGOS. This is therefore the sole authoritative
          // Heroic/Maul/Raptor swing animation path. Do not depend on the visual manifest having
          // finished its asynchronous load; fall back to Special1H/2H, never a spell-cast pose.
          const attackAnim = this.deps.getMeleeAttackAnim(ev.casterGuid);
          const anim = typeof goAnim === 'number' ? goAnim : TWO_HANDED_SWING_ANIMS.has(attackAnim) ? 0x3a : 0x39;
          this.deps.playEntityOrPlayer(ev.casterGuid, anim, 700, oneShotKind(anim));
          this.specialMeleeSwingUntil.set(ev.casterGuid, performance.now() + 1600);
        } else if (this.isRangedSpell(ev.spellId)) {
          // Ranged abilities and auto-shot: Spell.dbc gives them no SpellVisual in 1.12, so the
          // caster pose is AttackBow / AttackRifle / AttackThrown off the equipped ranged weapon.
          // A baked kit anim still wins when one exists (Aimed Shot etc.).
          const anim = (typeof goAnim === 'number' ? goAnim : undefined) ?? this.deps.getRangedAttackAnim(ev.casterGuid);
          if (anim !== undefined) this.deps.playEntityOrPlayer(ev.casterGuid, anim, 700, 'melee');
        } else if (goAnim !== null) {
          const anim = goAnim ?? ANIM.SPELL_CAST_DIRECTED;
          this.deps.playEntityOrPlayer(ev.casterGuid, anim, 700, oneShotKind(anim));
        }


        // no miss-reason array; the miss branch emits miss feedback and skips those kits. The
        // caster's cast kit still happened, so suppress only the target-anchored impact here.
        this.deps.castSpellVisual(
          ev.spellId,
          ev.casterGuid,
          ev.targetGuid,
          'go',
          0,
          ev.destination ? this.deps.worldToLocalPosition(ev.destination) : undefined,
          ev.hitGuids,
          ev.ammoDisplayId
            ? {
                displayId: ev.ammoDisplayId,
                inventoryType: ev.ammoInventoryType ?? 0,
                speed: this.spellMeta?.[ev.spellId]?.[11] || 40,
              }
            : undefined,
          allMiss,
        );
        for (const miss of ev.misses) {
          if (!this.shouldShowCombatText(ev.casterGuid, miss.guid)) continue;
          if (fctAllows('dodgeParryMiss')) {
            this.deps.spawnDamageText(
              miss.guid,
              SPELL_MISS_TEXT[miss.reason] ?? 'Miss',
              miss.guid === this.deps.getPlayerGuid() ? '#ffb0a8' : '#d8d8d8',
            );
          }
          const defense = spellMissDefenseKind(miss.reason);
          if (defense) {
            this.deps.playEntityOrPlayer(miss.guid, this.deps.getDefenseAnim(miss.guid, defense), 600, 'reaction');
          }
        }
        if (ev.casterGuid === this.deps.getPlayerGuid()) {
          if (this.isAutoRepeatSpell(ev.spellId)) this.setAutoRepeatSpell(ev.spellId, ev.targetGuid);
          this.clearQueuedMeleeSpell(ev.spellId);
          // A non-instant spell already began its global sweep at SPELL_START. Restarting it at
          // SPELL_GO made Fireball and heals appear to have an extra cooldown after completion.
          if (this.activeCast?.spellId !== ev.spellId) this.triggerGlobalCooldown(ev.spellId);
          const recovery = this.spellRecoveryMs(ev.spellId);
          if (recovery > 0) this.cooldowns.start(ev.spellId, recovery);
          this.hideCastBar();
        }
        break;
      }
      case 'spellFailure':
        if (ev.casterGuid === this.deps.getPlayerGuid()) {
          this.clearQueuedMeleeSpell(ev.spellId);
          // A rejected on-next-swing ability (usually not enough rage) must not erase the normal
          // weapon swing that it just auto-started. Cast/channel failures still clear their pose.
          if (!this.isOnNextSwingSpell(ev.spellId)) this.deps.clearPlayerCombatAnim();
          this.hideCastBar();
          this.deps.log(`combat: spell ${ev.spellId} failed (reason 0x${ev.reason.toString(16)})`);
        }
        break;
      case 'petCastFailed': {
        const text = spellCastErrorText(ev.reason);
        if (text) showUiError(text);
        this.deps.log(`combat: pet spell ${ev.spellId} failed (status ${ev.status}, reason 0x${ev.reason.toString(16)}${text ? ` — ${text}` : ''})`);
        break;
      }
      case 'petActionFeedback': {
        const text = PET_ACTION_FEEDBACK_TEXT[ev.message] ?? `Pet action failed (${ev.message}).`;
        showUiError(text);
        this.deps.log(`combat: ${text}`);
        break;
      }
      case 'petTameFailure': {
        const text = PET_TAME_FAILURE_TEXT[ev.reason] ?? 'Unknown taming error';
        showUiError(text);
        this.deps.log(`combat: ${text}`);
        break;
      }
      case 'petBroken':
        showUiError('Your pet has run away');
        this.deps.log('combat: Your pet has run away');
        break;
      case 'feignDeathResisted':
        showUiError('Feign Death was resisted.');
        this.deps.log('combat: Feign Death was resisted');
        break;
      case 'spellDelayed':
        if (this.activeCast && ev.casterGuid === this.deps.getPlayerGuid()) {
          this.activeCast.durationMs = Math.max(1, this.activeCast.durationMs + ev.delayMs);
        }
        break;
      case 'channelStart': {
        const channelAnim = this.deps.getSpellCastAnim(ev.spellId, 'channel');
        if (channelAnim !== null) {
          this.deps.playEntityOrPlayer(ev.casterGuid, channelAnim ?? ANIM.CHANNEL_DIRECTED, Math.max(800, ev.durationMs), 'cast');
        }
        this.deps.castSpellVisual(ev.spellId, ev.casterGuid, undefined, 'channel', ev.durationMs);
        if (ev.casterGuid === this.deps.getPlayerGuid() && ev.durationMs > 0) {
          this.activeCast = { spellId: ev.spellId, startTime: performance.now(), durationMs: ev.durationMs, isChannel: true };
          void this.showCastBar();
        }
        break;
      }
      case 'channelUpdate':
        if (this.activeCast && ev.casterGuid === this.deps.getPlayerGuid()) {
          this.activeCast.durationMs = Math.max(1, ev.timeRemainingMs);
          this.activeCast.startTime = performance.now();
          if (ev.timeRemainingMs <= 0) this.hideCastBar();
        }
        break;
      case 'castResult': {
        if (!ev.success) {
          this.clearQueuedMeleeSpell(ev.spellId);
          if (!this.isOnNextSwingSpell(ev.spellId)) this.deps.clearPlayerCombatAnim();
          this.hideCastBar();
          // Vanilla shows cast failures as red UIErrorsFrame text ("Out of range", "Not enough
          // mana"...). Console-only logging read as "the ability silently doesn't work".
          const text = spellCastErrorText(ev.reason);
          if (text) showUiError(text);
          this.deps.log(`combat: spell ${ev.spellId} failed (reason 0x${(ev.reason ?? 0).toString(16)}${text ? ` — ${text}` : ''})`);
        } else {
          this.triggerGlobalCooldown(ev.spellId);
        }
        break;
      }
      case 'spellCooldown':
        this.cooldowns.start(ev.spellId, ev.cooldownMs);
        break;
      case 'cooldownEvent': {
        const recovery = this.spellRecoveryMs(ev.spellId);
        this.cooldowns.start(ev.spellId, recovery > 0 ? recovery : DEFAULT_GCD_MS);
        this.triggerGlobalCooldown(ev.spellId);
        break;
      }
      case 'clearCooldown':
        this.cooldowns.clear(ev.spellId);
        break;
      case 'spellModifier':
      case 'proficiency':
      case 'forcedReactions':
        // These tables feed predictive cooldown/range/equipment usability. The server remains
        // authoritative, but the visible action state must update in the same packet turn.
        this.updateActionStates();
        break;
      case 'pvpCredit':
        if (ev.honor > 0 && fctAllows('honorGained')) {
          this.deps.spawnDamageText(
            this.deps.getPlayerGuid() ?? ev.victimGuid,
            `+${ev.honor} Honor`,
            '#ffcf5a',
            { small: true },
          );
        }
        this.deps.log(`combat: +${ev.honor} honor from ${ev.victimGuid} (rank ${ev.victimRank})`);
        break;
      case 'gameObjectAnimation':
        if (ev.phase === 'custom' && ev.animationId !== undefined) {
          this.deps.getEntityRenderer()?.playAuthoredOneShot(ev.guid, ev.animationId, 'emoteState');
        } else if (ev.phase === 'reset') {
          this.deps.getEntityRenderer()?.clearOneShot(ev.guid);
        }
        this.deps.log(`combat: game object ${ev.guid} ${ev.phase}${ev.animationId === undefined ? '' : ` animation ${ev.animationId}`}`);
        break;
      case 'mountSpecial':
        this.deps.getEntityRenderer()?.playMountSpecial(ev.guid);
        break;
      case 'textEmote':
        // The separate SMSG_EMOTE packet owns the animation. This packet is the localized text
        // presentation/target-name half and must not replay the gesture.
        this.deps.log(`emote: ${ev.sourceGuid} text ${ev.textEmoteId} (${ev.emoteNumber})${ev.targetName ? ` -> ${ev.targetName}` : ''}`);
        break;
      case 'meleeDamage':
        this.handleMeleeDamage(ev);
        break;
      case 'spellDamage':
        this.handleSpellDamage(ev);
        break;
      case 'damageShield':
        // Thorns and friends: the shield wearer reflects onto whoever hit them, and the reflected
        // damage lands on ev.victimGuid. Vanilla shows it as ordinary incoming damage plus a flinch.
        if (this.shouldShowCombatText(ev.shieldGuid, ev.victimGuid)) {
          if (fctAllows(this.damageCategory(ev.shieldGuid, ev.victimGuid))) {
            const onMe = ev.victimGuid === this.deps.getPlayerGuid();
            this.deps.spawnDamageText(ev.victimGuid, String(ev.damage), onMe ? '#ff5544' : '#fff6b3', { small: true });
          }
          this.deps.playEntityOrPlayer(ev.victimGuid, ANIM.COMBAT_WOUND, 600, 'reaction');
        }
        break;
      case 'spellHeal':
        if (this.shouldShowCombatText(ev.healerGuid, ev.targetGuid) && fctAllows('incomingDamage')) {
          this.deps.spawnDamageText(ev.targetGuid, `+${ev.amount}`, ev.targetGuid === this.deps.getPlayerGuid() ? '#35ff70' : '#72ff9a', { critical: ev.critical });
          // "Show Friendly Healer Names" credits an incoming heal to whoever cast it.
          if (ev.targetGuid === this.deps.getPlayerGuid() && ev.healerGuid !== ev.targetGuid && fctAllows('friendlyHealers')) {
            const healer = this.deps.getWorld()?.getPlayerName(ev.healerGuid)?.name;
            if (healer) this.deps.spawnDamageText(ev.targetGuid, healer, '#8fe6a8', { small: true });
          }
        }
        break;
      case 'spellEnergize':
        if (this.shouldShowCombatText(ev.casterGuid, ev.targetGuid) && fctAllows('energyGains')) {
          this.deps.spawnDamageText(ev.targetGuid, `+${ev.amount}`, '#68b7ff', { small: ev.targetGuid !== this.deps.getPlayerGuid() });
        }
        break;
      case 'environmentalDamage':
        if (ev.victimGuid === this.deps.getPlayerGuid()) {
          if (fctAllows('incomingDamage')) this.deps.spawnDamageText(ev.victimGuid, String(ev.damage), '#ff5544');
          this.spawnMitigation(ev.victimGuid, 0, ev.absorb, ev.resist);
          if (ev.damage > 0) this.deps.playEntityOrPlayer(ev.victimGuid, ANIM.COMBAT_WOUND, 600, 'reaction');
        }
        break;
      case 'spellMiss': {
        if (!this.shouldShowCombatText(ev.casterGuid, ev.targetGuid)) break;
        if (fctAllows('dodgeParryMiss')) {
          this.deps.spawnDamageText(ev.targetGuid, SPELL_MISS_TEXT[ev.missInfo] ?? 'Miss', ev.targetGuid === this.deps.getPlayerGuid() ? '#ffb0a8' : '#d8d8d8');
        }
        const defense = spellMissDefenseKind(ev.missInfo);
        if (defense) this.deps.playEntityOrPlayer(ev.targetGuid, this.deps.getDefenseAnim(ev.targetGuid, defense), 600, 'reaction');
        break;
      }
      case 'spellDispel':
        this.deps.log(`combat: ${ev.success ? 'dispelled' : 'failed to dispel'} spells [${ev.spellIds.join(', ')}] on ${ev.targetGuid}`);
        break;
      case 'partyKill':
        this.deps.log(`combat: ${ev.killerGuid} killed ${ev.victimGuid}`);
        break;
      case 'spellExecute':
        this.deps.log(`combat: spell ${ev.spellId} executed ${ev.effects.map((effect) => `${effect.effectId}x${effect.count}`).join(', ')}`);
        break;
      case 'spellInstaKill':
        this.deps.log(`combat: spell ${ev.spellId} instantly killed ${ev.victimGuid}`);
        break;
      case 'spellChainTargets': {
        // vMaNGOS sends MSG_CHANNEL_START only to the casting player. Observers receive this
        // packet instead, so it is also their authoritative remote channel-pose trigger.
        const anim = this.deps.getSpellCastAnim(ev.spellId, 'channel');
        if (anim !== null) {
          this.deps.playEntityOrPlayer(ev.casterGuid, anim ?? ANIM.CHANNEL_DIRECTED, 1500, 'cast');
        }
        break;
      }
      case 'aiReaction':
        // Consumed by the world-audio controller.
        break;
      case 'periodicAura':
        this.handlePeriodicAura(ev);
        break;
    }
  }

  installDebugHooks() {
    if (!QA_GLOBALS_ENABLED) return;
    qaGlobals.__wowActionBar = { render: (actions?: readonly ActionButton[]) => this.renderActionBar(actions) };
    qaGlobals.__wowCombat = { fire: (event: CombatEvent) => this.handleCombatEvent(event) };
    qaGlobals.__wowCooldown = {
      start: (spellId: number, durationMs: number) => this.cooldowns.start(spellId, durationMs),
      clear: (spellId: number) => this.cooldowns.clear(spellId),
      global: (castSpellId?: number) => this.triggerGlobalCooldown(castSpellId),
    };
  }

  private async showCastBar() {
    if (!this.activeCast) return;
    const meta = await this.loadSpellMeta();
    const m = meta[this.activeCast.spellId];
    this.deps.elements.castSpellName.textContent = m?.[0] ?? `Spell ${this.activeCast.spellId}`;
    this.deps.elements.castBar.classList.remove('is-hidden');
    this.updateCastBar();
  }

  private shouldShowCombatText(sourceGuid: string, targetGuid: string) {
    return ownsFloatingCombatText(this.deps.getPlayerGuid(), this.deps.getPetGuid(), sourceGuid, targetGuid);
  }

  /**
   * Which Floating Combat Text checkbox governs a damage/heal line.
   *
   * Damage landing on you is feedback the panel has no toggle for, so it rides the
   * master switch (`incomingDamage`). Everything else is damage you or your pet put
   * on a unit, which is what "Show Target Damage" / "Pet Damage" mean.
   */
  private damageCategory(sourceGuid: string, targetGuid: string): 'incomingDamage' | 'petDamage' | 'targetDamage' {
    if (targetGuid === this.deps.getPlayerGuid()) return 'incomingDamage';
    const petGuid = this.deps.getPetGuid();
    if (petGuid && sourceGuid === petGuid) return 'petDamage';
    return 'targetDamage';
  }

  /** Block/Absorb/Resist riders share one checkbox ("Show Damage Reduction"). */
  private spawnMitigation(targetGuid: string, blocked = 0, absorb = 0, resist = 0) {
    if (!fctAllows('damageReduction')) return;
    if (blocked > 0) this.deps.spawnDamageText(targetGuid, `-${blocked} Block`, '#b8c8ff', { small: true });
    if (absorb > 0) this.deps.spawnDamageText(targetGuid, `-${absorb} Absorb`, '#cdbdff', { small: true });
    if (resist > 0) this.deps.spawnDamageText(targetGuid, `-${resist} Resist`, '#9fd7ff', { small: true });
  }

  private handleMeleeDamage(ev: Extract<CombatEvent, { kind: 'meleeDamage' }>) {
    const playerGuid = this.deps.getPlayerGuid();
    const selectedGuid = this.deps.getSelectedTargetGuid();
    const mine = ev.attackerGuid === playerGuid;
    const onMe = ev.victimGuid === playerGuid;
    const critical = (ev.hitInfo & HITINFO.CRITICAL) !== 0;
    const showText = this.shouldShowCombatText(ev.attackerGuid, ev.victimGuid);
    const outcomeText = VICTIM_STATE_TEXT[ev.targetState] ?? ((ev.hitInfo & HITINFO.MISS) !== 0 ? 'Miss' : '');
    const color = onMe ? '#ff5544' : mine ? (critical ? '#ffe680' : '#ffffff') : '#c7c7c7';
    if (showText && ev.totalDamage > 0) {
      const suffix = (ev.hitInfo & HITINFO.GLANCING) !== 0 ? ' Glancing' : (ev.hitInfo & HITINFO.CRUSHING) !== 0 ? ' Crushing' : '';
      if (fctAllows(this.damageCategory(ev.attackerGuid, ev.victimGuid))) {
        this.deps.spawnDamageText(ev.victimGuid, `${ev.totalDamage}${suffix}`, color, { critical });
      }
    } else if (showText && fctAllows('dodgeParryMiss')) {
      // A zero-damage swing is exactly a dodge/parry/block/miss line.
      this.deps.spawnDamageText(ev.victimGuid, outcomeText || 'Miss', onMe ? '#ffb0a8' : '#d8d8d8');
    }
    if (showText) this.spawnMitigation(ev.victimGuid, ev.blocked, ev.absorb, ev.resist);
    const offHandSwing = (ev.hitInfo & HITINFO.LEFTSWING) !== 0;
    const preserveSpecial = (this.specialMeleeSwingUntil.get(ev.attackerGuid) ?? 0) > performance.now();
    if (!preserveSpecial) {
      this.deps.playEntityOrPlayer(ev.attackerGuid, this.deps.getMeleeAttackAnim(ev.attackerGuid, offHandSwing), 700, 'melee');
    } else if (offHandSwing) {
      // A queued on-next-swing ability only consumes the MAIN hand (vmangos only arms
      // CURRENT_MELEE_SPELL for BASE_ATTACK, Unit.cpp:2176). The off-hand blow that lands in the
      // same window is a real, separate swing and must still animate.
      this.deps.playEntityOrPlayer(ev.attackerGuid, this.deps.getMeleeAttackAnim(ev.attackerGuid, true), 700, 'melee');
    } else {
      this.specialMeleeSwingUntil.delete(ev.attackerGuid);
    }
    const defense = victimDefenseKind(ev.targetState);
    const victimAnim = defense
      ? this.deps.getDefenseAnim(ev.victimGuid, defense)
      : woundReactionAnim(ev.hitInfo);
    if (victimAnim !== undefined) this.deps.playEntityOrPlayer(ev.victimGuid, victimAnim, 600, 'reaction');
    if (ev.victimGuid === selectedGuid || ev.attackerGuid === selectedGuid) this.deps.refreshTargetFrame();
  }

  private handleSpellDamage(ev: Extract<CombatEvent, { kind: 'spellDamage' }>) {
    const showText = this.shouldShowCombatText(ev.attackerGuid, ev.targetGuid);
    const playerGuid = this.deps.getPlayerGuid();
    const selectedGuid = this.deps.getSelectedTargetGuid();
    const onMe = ev.targetGuid === playerGuid;
    const mine = ev.attackerGuid === playerGuid;
    const critical = (ev.hitInfo & 0x02) !== 0;
    if (showText && fctAllows(this.damageCategory(ev.attackerGuid, ev.targetGuid))) {
      this.deps.spawnDamageText(ev.targetGuid, String(ev.damage), onMe ? '#ff5544' : mine ? (critical ? '#ffd85a' : '#fff6b3') : '#d8d8d8', { critical });
    }
    if (showText) this.spawnMitigation(ev.targetGuid, ev.blocked, ev.absorb, ev.resist);
    this.deps.playEntityOrPlayer(ev.targetGuid, critical ? ANIM.COMBAT_CRITICAL : ANIM.COMBAT_WOUND, 600, 'reaction');
    if (ev.targetGuid === selectedGuid || ev.attackerGuid === selectedGuid) this.deps.refreshTargetFrame();
  }

  private handlePeriodicAura(ev: Extract<CombatEvent, { kind: 'periodicAura' }>) {
    if (!this.shouldShowCombatText(ev.casterGuid, ev.targetGuid)) return;
    const playerGuid = this.deps.getPlayerGuid();
    if (ev.auraType === 3 || ev.auraType === 89) {
      // A DoT tick on someone else is "Periodic Damage"; a tick on you is damage taken.
      const category = ev.targetGuid === playerGuid ? 'incomingDamage' : 'periodicDamage';
      if (fctAllows(category)) {
        this.deps.spawnDamageText(ev.targetGuid, String(ev.amount), ev.targetGuid === playerGuid ? '#ff5544' : '#fff6b3', { small: true });
      }
      this.spawnMitigation(ev.targetGuid, 0, ev.absorb ?? 0, ev.resist ?? 0);
    } else if (ev.auraType === 8 || ev.auraType === 20) {
      if (fctAllows('incomingDamage')) this.deps.spawnDamageText(ev.targetGuid, `+${ev.amount}`, '#72ff9a', { small: true });
    } else if (ev.auraType === 24 || ev.auraType === 64) {
      if (fctAllows('energyGains')) this.deps.spawnDamageText(ev.targetGuid, `+${ev.amount}`, '#68b7ff', { small: true });
    }
  }
}

const formatAuraDuration = (milliseconds: number) => {
  const seconds = Math.max(0, milliseconds / 1000);
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
  if (seconds >= 10) return String(Math.ceil(seconds));
  return seconds > 0 ? seconds.toFixed(1) : '';
};
