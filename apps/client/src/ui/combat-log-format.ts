/** Asset conversion utility. */
/* eslint-disable @typescript-eslint/no-unused-vars */

/** GlobalStrings.lua:3550-3564. Index is the SpellSchools ordinal. */
const SPELL_SCHOOL_NAME = ['physical', 'holy', 'fire', 'nature', 'frost', 'shadow', 'arcane'] as const;
export const schoolName = (school: number): string => SPELL_SCHOOL_NAME[school] ?? SPELL_SCHOOL_NAME[0];

/** GlobalStrings.lua:1180,1646,1759,2249,2727. Index is the Powers ordinal. */
const POWER_NAME = ['Mana', 'Rage', 'Focus', 'Energy', 'Happiness'] as const;
export const powerName = (powerType: number): string => POWER_NAME[powerType] ?? POWER_NAME[0];

/** GlobalStrings.lua, verbatim. Names are the client's own, so the mapping stays auditable. */
const S = {
  ABSORB_TRAILER: ' (%d absorbed)',
  // melee damage — :609-617
  COMBATHITCRITOTHEROTHER: '%s crits %s for %d.',
  COMBATHITCRITOTHERSELF: '%s crits you for %d.',
  COMBATHITCRITSCHOOLOTHEROTHER: '%s crits %s for %d %s damage.',
  COMBATHITCRITSCHOOLOTHERSELF: '%s crits you for %d %s damage.',
  COMBATHITCRITSCHOOLSELFOTHER: 'You crit %s for %d %s damage.',
  COMBATHITCRITSELFOTHER: 'You crit %s for %d.',
  COMBATHITOTHEROTHER: '%s hits %s for %d.',
  COMBATHITOTHERSELF: '%s hits you for %d.',
  COMBATHITSCHOOLOTHEROTHER: '%s hits %s for %d %s damage.',
  COMBATHITSCHOOLOTHERSELF: '%s hits you for %d %s damage.',
  COMBATHITSCHOOLSELFOTHER: 'You hit %s for %d %s damage.',
  COMBATHITSELFOTHER: 'You hit %s for %d.',
  // melee misses — :2278-2280
  MISSEDOTHEROTHER: '%s misses %s.',
  MISSEDOTHERSELF: '%s misses you.',
  MISSEDSELFOTHER: 'You miss %s.',
  // melee defensive outcomes — :4801-4833
  VSABSORBOTHEROTHER: '%s attacks. %s absorbs all the damage.',
  VSABSORBOTHERSELF: '%s attacks. You absorb all the damage.',
  VSABSORBSELFOTHER: 'You attack. %s absorbs all the damage.',
  VSBLOCKOTHEROTHER: '%s attacks. %s blocks.',
  VSBLOCKOTHERSELF: '%s attacks. You block.',
  VSBLOCKSELFOTHER: 'You attack. %s blocks.',
  VSDEFLECTOTHEROTHER: '%s attacks. %s deflects.',
  VSDEFLECTOTHERSELF: '%s attacks. You deflect.',
  VSDEFLECTSELFOTHER: 'You attack. %s deflects.',
  VSDODGEOTHEROTHER: '%s attacks. %s dodges.',
  VSDODGEOTHERSELF: '%s attacks. You dodge.',
  VSDODGESELFOTHER: 'You attack. %s dodges.',
  VSEVADEOTHEROTHER: '%s attacks. %s evades.',
  VSEVADEOTHERSELF: '%s attacks. You evade.',
  VSEVADESELFOTHER: 'You attack. %s evades.',
  VSIMMUNEOTHEROTHER: '%s attacks but %s is immune.',
  VSIMMUNEOTHERSELF: '%s attacks but you are immune.',
  VSIMMUNESELFOTHER: 'You attack but %s is immune.',
  VSPARRYOTHEROTHER: '%s attacks. %s parries.',
  VSPARRYOTHERSELF: '%s attacks. You parry.',
  VSPARRYSELFOTHER: 'You attack. %s parries.',
  // spell damage — :3233-3244
  SPELLLOGCRITOTHEROTHER: "%s's %s crits %s for %d.",
  SPELLLOGCRITOTHERSELF: "%s's %s crits you for %d.",
  SPELLLOGCRITSCHOOLOTHEROTHER: "%s's %s crits %s for %d %s damage.",
  SPELLLOGCRITSCHOOLOTHERSELF: "%s's %s crits you for %d %s damage.",
  SPELLLOGCRITSCHOOLSELFOTHER: 'Your %s crits %s for %d %s damage.',
  SPELLLOGCRITSCHOOLSELFSELF: 'Your %s crits you for %d %s damage.',
  SPELLLOGCRITSELFOTHER: 'Your %s crits %s for %d.',
  SPELLLOGCRITSELFSELF: 'Your %s crits you for %d.',
  SPELLLOGOTHEROTHER: "%s's %s hits %s for %d.",
  SPELLLOGOTHERSELF: "%s's %s hits you for %d.",
  SPELLLOGSCHOOLOTHEROTHER: "%s's %s hits %s for %d %s damage.",
  SPELLLOGSCHOOLOTHERSELF: "%s's %s hits you for %d %s damage.",
  SPELLLOGSCHOOLSELFOTHER: 'Your %s hits %s for %d %s damage.',
  SPELLLOGSCHOOLSELFSELF: 'Your %s hits you for %d %s damage.',
  SPELLLOGSELFOTHER: 'Your %s hits %s for %d.',
  SPELLLOGSELFSELF: 'Your %s hits you for %d.',
  // spell misses — :3187-3275
  SPELLBLOCKEDOTHEROTHER: "%s's %s was blocked by %s.",
  SPELLBLOCKEDOTHERSELF: "%s's %s was blocked.",
  SPELLBLOCKEDSELFOTHER: 'Your %s was blocked by %s.',
  SPELLDEFLECTEDOTHEROTHER: "%s's %s was deflected by %s.",
  SPELLDEFLECTEDOTHERSELF: "%s's %s was deflected.",
  SPELLDEFLECTEDSELFOTHER: 'Your %s was deflected by %s.',
  SPELLDODGEDOTHEROTHER: "%s's %s was dodged by %s.",
  SPELLDODGEDOTHERSELF: "%s's %s was dodged.",
  SPELLDODGEDSELFOTHER: 'Your %s was dodged by %s.',
  SPELLEVADEDOTHEROTHER: "%s's %s was evaded by %s.",
  SPELLEVADEDOTHERSELF: "%s's %s was evaded.",
  SPELLEVADEDSELFOTHER: 'Your %s was evaded by %s.',
  SPELLIMMUNEOTHEROTHER: "%s's %s fails. %s is immune.",
  SPELLIMMUNEOTHERSELF: "%s's %s failed. You are immune.",
  SPELLIMMUNESELFOTHER: 'Your %s failed. %s is immune.',
  SPELLMISSOTHEROTHER: "%s's %s missed %s.",
  SPELLMISSOTHERSELF: "%s's %s misses you.",
  SPELLMISSSELFOTHER: 'Your %s missed %s.',
  SPELLPARRIEDOTHEROTHER: "%s's %s was parried by %s.",
  SPELLPARRIEDOTHERSELF: "%s's %s was parried.",
  SPELLPARRIEDSELFOTHER: 'Your %s is parried by %s.',
  SPELLRESISTOTHEROTHER: "%s's %s was resisted by %s.",
  SPELLRESISTOTHERSELF: "%s's %s was resisted.",
  SPELLRESISTSELFOTHER: 'Your %s was resisted by %s.',
  SPELLLOGABSORBOTHEROTHER: "%s's %s is absorbed by %s.",
  SPELLLOGABSORBOTHERSELF: "You absorb %s's %s.",
  SPELLLOGABSORBSELFOTHER: 'Your %s is absorbed by %s.',
  SPELLLOGABSORBSELFSELF: 'You absorb your %s.',
  // heals — :1768-1775
  HEALEDCRITOTHEROTHER: "%s's %s critically heals %s for %d.",
  HEALEDCRITOTHERSELF: "%s's %s critically heals you for %d.",
  HEALEDCRITSELFOTHER: 'Your %s critically heals %s for %d.',
  HEALEDCRITSELFSELF: 'Your %s critically heals you for %d.',
  HEALEDOTHEROTHER: "%s's %s heals %s for %d.",
  HEALEDOTHERSELF: "%s's %s heals you for %d.",
  HEALEDSELFOTHER: 'Your %s heals %s for %d.',
  HEALEDSELFSELF: 'Your %s heals you for %d.',
  // periodic auras — :2482-2492
  PERIODICAURADAMAGEOTHEROTHER: "%s suffers %d %s damage from %s's %s.",
  PERIODICAURADAMAGEOTHERSELF: "You suffer %d %s damage from %s's %s.",
  PERIODICAURADAMAGESELFOTHER: '%s suffers %d %s damage from your %s.',
  PERIODICAURADAMAGESELFSELF: 'You suffer %d %s damage from your %s.',
  PERIODICAURAHEALOTHEROTHER: "%s gains %d health from %s's %s.",
  PERIODICAURAHEALOTHERSELF: "You gain %d health from %s's %s.",
  PERIODICAURAHEALSELFOTHER: '%s gains %d health from your %s.',
  PERIODICAURAHEALSELFSELF: 'You gain %d health from %s.',
  // power gain — :2585-2586
  POWERGAINOTHEROTHER: "%s gains %d %s from %s's %s.",
  POWERGAINOTHERSELF: "You gain %d %s from %s's %s.",
  POWERGAINSELFOTHER: '%s gains %d %s from %s.',
  POWERGAINSELFSELF: 'You gain %d %s from %s.',
  // deaths — :3841-3843
  UNITDESTROYEDOTHER: '%s is destroyed.',
  UNITDIESOTHER: '%s dies.',
  UNITDIESSELF: 'You die.',
  // experience — :788-804
  COMBATLOG_XPGAIN_EXHAUSTION1: '%s dies, you gain %d experience. (%s exp %s bonus)',
  COMBATLOG_XPGAIN_FIRSTPERSON: '%s dies, you gain %d experience.',
  COMBATLOG_XPGAIN_FIRSTPERSON_UNNAMED: 'You gain %d experience.',
} as const;

export type CombatLogStringKey = keyof typeof S;
export const COMBAT_LOG_STRINGS = S;

/**
 * Fill a vanilla format string. `%d` and `%s` are consumed positionally in order, exactly like
 * Lua's `format`, so the argument order below can be read straight off the GlobalStrings text.
 */
export function fmt(template: string, ...args: (string | number)[]): string {
  let i = 0;
  return template.replace(/%[ds]/g, () => String(args[i++] ?? ''));
}

/** vMaNGOS Objects/UnitDefines.h:252-268 — the SUPPORTED_CLIENT_BUILD > 1.9.4 block. */
const HITINFO_MISS = 0x00000010;
const HITINFO_CRITICAL = 0x00000080;

/** vMaNGOS Objects/UnitDefines.h:236-247. */
const VICTIMSTATE = { UNAFFECTED: 0, NORMAL: 1, DODGE: 2, PARRY: 3, INTERRUPT: 4, BLOCKS: 5, EVADES: 6, IS_IMMUNE: 7, DEFLECTS: 8 } as const;

/** vMaNGOS Spells/SpellDefines.h:160-175. */
const SPELL_MISS = { NONE: 0, MISS: 1, RESIST: 2, DODGE: 3, PARRY: 4, BLOCK: 5, EVADE: 6, IMMUNE: 7, IMMUNE2: 8, DEFLECT: 9, ABSORB: 10, REFLECT: 11 } as const;

/**
 * Which CHAT_MSG_COMBAT_* group a line belongs to. ChatFrame.lua:37-67 registers a ChatTypeInfo
 * entry for each of these, and CombatLog's ChatFrame2 subscribes to the whole set.
 */
export type CombatLogChannel =
  | 'COMBAT_SELF_HITS'
  | 'COMBAT_SELF_MISSES'
  | 'COMBAT_CREATURE_VS_SELF_HITS'
  | 'COMBAT_CREATURE_VS_SELF_MISSES'
  | 'COMBAT_CREATURE_VS_CREATURE_HITS'
  | 'COMBAT_CREATURE_VS_CREATURE_MISSES'
  | 'COMBAT_FRIENDLY_DEATH'
  | 'COMBAT_HOSTILE_DEATH'
  | 'COMBAT_MISC_INFO'
  | 'COMBAT_XP_GAIN';

export interface CombatLogLine {
  text: string;
  channel: CombatLogChannel;
  /** The GlobalStrings key used, so a gate can prove the right one was picked. */
  stringKey: CombatLogStringKey;
}

/** SELF/OTHER pairing, the axis the whole string table is built on. */
type Affiliation = 'SELFOTHER' | 'OTHERSELF' | 'OTHEROTHER' | 'SELFSELF';
const affiliation = (sourceIsPlayer: boolean, targetIsPlayer: boolean): Affiliation =>
  sourceIsPlayer ? (targetIsPlayer ? 'SELFSELF' : 'SELFOTHER') : targetIsPlayer ? 'OTHERSELF' : 'OTHEROTHER';

/** Melee lines have no SELFSELF form — you cannot swing at yourself. Fall back to SELFOTHER. */
const meleeAffiliation = (source: boolean, target: boolean): Exclude<Affiliation, 'SELFSELF'> => {
  const a = affiliation(source, target);
  return a === 'SELFSELF' ? 'SELFOTHER' : a;
};

const hitChannel = (sourceIsPlayer: boolean, targetIsPlayer: boolean, miss: boolean): CombatLogChannel => {
  if (sourceIsPlayer) return miss ? 'COMBAT_SELF_MISSES' : 'COMBAT_SELF_HITS';
  if (targetIsPlayer) return miss ? 'COMBAT_CREATURE_VS_SELF_MISSES' : 'COMBAT_CREATURE_VS_SELF_HITS';
  return miss ? 'COMBAT_CREATURE_VS_CREATURE_MISSES' : 'COMBAT_CREATURE_VS_CREATURE_HITS';
};

export interface MeleeDamageLine {
  sourceName: string;
  targetName: string;
  sourceIsPlayer: boolean;
  targetIsPlayer: boolean;
  hitInfo: number;
  totalDamage: number;
  school: number;
  absorb: number;
  targetState: number;
}

/** SMSG_ATTACKERSTATEUPDATE -> one line. */
export function formatMeleeDamage(e: MeleeDamageLine): CombatLogLine {
  const a = meleeAffiliation(e.sourceIsPlayer, e.targetIsPlayer);
  // The victim's defensive state outranks the damage numbers: a dodged swing is a VS* line, never a
  // "hits for 0" line.
  const vsKey: Partial<Record<number, string>> = {
    [VICTIMSTATE.DODGE]: 'VSDODGE',
    [VICTIMSTATE.PARRY]: 'VSPARRY',
    [VICTIMSTATE.BLOCKS]: 'VSBLOCK',
    [VICTIMSTATE.EVADES]: 'VSEVADE',
    [VICTIMSTATE.IS_IMMUNE]: 'VSIMMUNE',
    [VICTIMSTATE.DEFLECTS]: 'VSDEFLECT',
  };
  const vs = vsKey[e.targetState];
  if (vs) {
    const key = `${vs}${a}` as CombatLogStringKey;
    // Every VS* form takes the OTHER party's name, once, except the SELFOTHER/OTHERSELF variants
    // that address "you" and therefore only carry one name.
    const args = a === 'OTHEROTHER' ? [e.sourceName, e.targetName] : a === 'SELFOTHER' ? [e.targetName] : [e.sourceName];
    return { text: fmt(S[key], ...args), channel: hitChannel(e.sourceIsPlayer, e.targetIsPlayer, true), stringKey: key };
  }
  if ((e.hitInfo & HITINFO_MISS) !== 0 || e.targetState === VICTIMSTATE.UNAFFECTED) {
    const key = `MISSED${a}` as CombatLogStringKey;
    const args = a === 'OTHEROTHER' ? [e.sourceName, e.targetName] : a === 'SELFOTHER' ? [e.targetName] : [e.sourceName];
    return { text: fmt(S[key], ...args), channel: hitChannel(e.sourceIsPlayer, e.targetIsPlayer, true), stringKey: key };
  }
  if (e.absorb > 0 && e.totalDamage === 0) {
    const key = `VSABSORB${a}` as CombatLogStringKey;
    const args = a === 'OTHEROTHER' ? [e.sourceName, e.targetName] : a === 'SELFOTHER' ? [e.targetName] : [e.sourceName];
    return { text: fmt(S[key], ...args), channel: hitChannel(e.sourceIsPlayer, e.targetIsPlayer, true), stringKey: key };
  }
  const crit = (e.hitInfo & HITINFO_CRITICAL) !== 0;
  const school = e.school !== 0;
  const key = `COMBATHIT${crit ? 'CRIT' : ''}${school ? 'SCHOOL' : ''}${a}` as CombatLogStringKey;
  const args =
    a === 'OTHEROTHER'
      ? [e.sourceName, e.targetName, e.totalDamage]
      : a === 'SELFOTHER'
        ? [e.targetName, e.totalDamage]
        : [e.sourceName, e.totalDamage];
  if (school) args.push(schoolName(e.school));
  const text = fmt(S[key], ...args) + (e.absorb > 0 ? fmt(S.ABSORB_TRAILER, e.absorb) : '');
  return { text, channel: hitChannel(e.sourceIsPlayer, e.targetIsPlayer, false), stringKey: key };
}

export interface SpellDamageLine {
  sourceName: string;
  targetName: string;
  sourceIsPlayer: boolean;
  targetIsPlayer: boolean;
  spellName: string;
  damage: number;
  school: number;
  absorb: number;
  critical: boolean;
}

/** SMSG_SPELLNONMELEEDAMAGELOG -> one line. */
export function formatSpellDamage(e: SpellDamageLine): CombatLogLine {
  const a = affiliation(e.sourceIsPlayer, e.targetIsPlayer);
  const school = e.school !== 0;
  const key = `SPELLLOG${e.critical ? 'CRIT' : ''}${school ? 'SCHOOL' : ''}${a}` as CombatLogStringKey;
  // "%s's %s hits %s for %d" -> caster, spell, target, damage; the SELF* forms drop the caster and
  // the *SELF forms drop the target, which is why the argument list is assembled per-affiliation.
  const head = a.startsWith('SELF') ? [e.spellName] : [e.sourceName, e.spellName];
  const tail = a.endsWith('SELF') ? [] : [e.targetName];
  const args = [...head, ...tail, e.damage, ...(school ? [schoolName(e.school)] : [])];
  const text = fmt(S[key], ...args) + (e.absorb > 0 ? fmt(S.ABSORB_TRAILER, e.absorb) : '');
  return { text, channel: hitChannel(e.sourceIsPlayer, e.targetIsPlayer, false), stringKey: key };
}

export interface SpellMissLine {
  sourceName: string;
  targetName: string;
  sourceIsPlayer: boolean;
  targetIsPlayer: boolean;
  spellName: string;
  missInfo: number;
}

/** SMSG_SPELLLOGMISS -> one line. Returns null for outcomes vanilla does not log. */
export function formatSpellMiss(e: SpellMissLine): CombatLogLine | null {
  const family: Partial<Record<number, string>> = {
    [SPELL_MISS.MISS]: 'SPELLMISS',
    [SPELL_MISS.RESIST]: 'SPELLRESIST',
    [SPELL_MISS.DODGE]: 'SPELLDODGED',
    [SPELL_MISS.PARRY]: 'SPELLPARRIED',
    [SPELL_MISS.BLOCK]: 'SPELLBLOCKED',
    [SPELL_MISS.EVADE]: 'SPELLEVADED',
    [SPELL_MISS.IMMUNE]: 'SPELLIMMUNE',
    [SPELL_MISS.IMMUNE2]: 'SPELLIMMUNE',
    [SPELL_MISS.DEFLECT]: 'SPELLDEFLECTED',
    [SPELL_MISS.ABSORB]: 'SPELLLOGABSORB',
  };
  const base = family[e.missInfo];
  if (!base) return null; // NONE and REFLECT produce no line of their own.
  const a = affiliation(e.sourceIsPlayer, e.targetIsPlayer);
  // Only the absorb family has a SELFSELF form; the rest collapse it onto SELFOTHER.
  const resolved = a === 'SELFSELF' && base !== 'SPELLLOGABSORB' ? 'SELFOTHER' : a;
  const key = `${base}${resolved}` as CombatLogStringKey;
  const template = S[key];
  if (!template) return null;
  // SPELLLOGABSORBOTHERSELF is the one inverted form in the table: "You absorb %s's %s." names the
  // CASTER, not the target, so its arguments cannot come from the generic assembly below.
  if (key === 'SPELLLOGABSORBOTHERSELF') return { text: fmt(template, e.sourceName, e.spellName), channel: hitChannel(e.sourceIsPlayer, e.targetIsPlayer, true), stringKey: key };
  const head = resolved.startsWith('SELF') ? [e.spellName] : [e.sourceName, e.spellName];
  const tail = resolved.endsWith('SELF') ? [] : [e.targetName];
  return { text: fmt(template, ...head, ...tail), channel: hitChannel(e.sourceIsPlayer, e.targetIsPlayer, true), stringKey: key };
}

export interface SpellHealLine {
  sourceName: string;
  targetName: string;
  sourceIsPlayer: boolean;
  targetIsPlayer: boolean;
  spellName: string;
  amount: number;
  critical: boolean;
}

/** SMSG_SPELLHEALLOG -> one line. */
export function formatSpellHeal(e: SpellHealLine): CombatLogLine {
  const a = affiliation(e.sourceIsPlayer, e.targetIsPlayer);
  const key = `HEALED${e.critical ? 'CRIT' : ''}${a}` as CombatLogStringKey;
  const head = a.startsWith('SELF') ? [e.spellName] : [e.sourceName, e.spellName];
  const tail = a.endsWith('SELF') ? [] : [e.targetName];
  return { text: fmt(S[key], ...head, ...tail, e.amount), channel: 'COMBAT_MISC_INFO', stringKey: key };
}

/** SMSG_SPELLENERGIZELOG / periodic energize -> one Build-5875 POWERGAIN affiliation line. */
export function formatSpellEnergize(e: {
  sourceName: string;
  targetName: string;
  sourceIsPlayer: boolean;
  targetIsPlayer: boolean;
  spellName: string;
  amount: number;
  powerType: number;
}): CombatLogLine {
  const a = affiliation(e.sourceIsPlayer, e.targetIsPlayer);
  const key = `POWERGAIN${a}` as CombatLogStringKey;
  const args = a === 'OTHEROTHER'
    ? [e.targetName, e.amount, powerName(e.powerType), e.sourceName, e.spellName]
    : a === 'OTHERSELF'
      ? [e.amount, powerName(e.powerType), e.sourceName, e.spellName]
      : a === 'SELFOTHER'
        ? [e.targetName, e.amount, powerName(e.powerType), e.spellName]
        : [e.amount, powerName(e.powerType), e.spellName];
  return { text: fmt(S[key], ...args), channel: 'COMBAT_MISC_INFO', stringKey: key };
}

export interface PeriodicAuraLine {
  sourceName: string;
  targetName: string;
  sourceIsPlayer: boolean;
  targetIsPlayer: boolean;
  spellName: string;
  amount: number;
  school: number;
  absorb: number;
  powerType?: number;
  /** Damage 3/89; heal 8/20; energize 24/64. */
  auraType: number;
}

/** SMSG_PERIODICAURALOG -> one line. */
export function formatPeriodicAura(e: PeriodicAuraLine): CombatLogLine | null {
  const a = affiliation(e.sourceIsPlayer, e.targetIsPlayer);
  if (e.auraType === 8 || e.auraType === 20) {
    const key = `PERIODICAURAHEAL${a}` as CombatLogStringKey;
    const template = S[key];
    if (!template) return null;
    const args = a === 'OTHERSELF'
      ? [e.amount, e.sourceName, e.spellName]
      : a === 'OTHEROTHER'
        ? [e.targetName, e.amount, e.sourceName, e.spellName]
        : a === 'SELFOTHER'
          ? [e.targetName, e.amount, e.spellName]
          : [e.amount, e.spellName];
    return { text: fmt(template, ...args), channel: 'COMBAT_MISC_INFO', stringKey: key };
  }
  if (e.auraType === 24 || e.auraType === 64) return formatSpellEnergize({ ...e, powerType: e.powerType ?? 0 });
  const key = `PERIODICAURADAMAGE${a}` as CombatLogStringKey;
  const template = S[key];
  if (!template) return null;
  // "%s suffers %d %s damage from %s's %s." -> target, amount, school, caster, spell.
  const victim = a.endsWith('SELF') ? [] : [e.targetName];
  const caster = a.startsWith('SELF') ? [e.spellName] : [e.sourceName, e.spellName];
  const args = [...victim, e.amount, schoolName(e.school), ...caster];
  const text = fmt(template, ...args) + (e.absorb > 0 ? fmt(S.ABSORB_TRAILER, e.absorb) : '');
  return { text, channel: hitChannel(e.sourceIsPlayer, e.targetIsPlayer, false), stringKey: key };
}

/** A unit died. GlobalStrings:3841-3843. */
export function formatDeath(e: { name: string; isPlayer: boolean; hostile: boolean; destroyed?: boolean }): CombatLogLine {
  if (e.isPlayer) return { text: S.UNITDIESSELF, channel: 'COMBAT_FRIENDLY_DEATH', stringKey: 'UNITDIESSELF' };
  const key: CombatLogStringKey = e.destroyed ? 'UNITDESTROYEDOTHER' : 'UNITDIESOTHER';
  return { text: fmt(S[key], e.name), channel: e.hostile ? 'COMBAT_HOSTILE_DEATH' : 'COMBAT_FRIENDLY_DEATH', stringKey: key };
}

/** SMSG_LOG_XPGAIN -> CHAT_MSG_COMBAT_XP_GAIN, using Build-5875 GlobalStrings verbatim. */
export function formatXpGain(e: { victimName?: string; totalXp: number; baseXp?: number }): CombatLogLine {
  if (!e.victimName) {
    return {
      text: fmt(S.COMBATLOG_XPGAIN_FIRSTPERSON_UNNAMED, e.totalXp),
      channel: 'COMBAT_XP_GAIN',
      stringKey: 'COMBATLOG_XPGAIN_FIRSTPERSON_UNNAMED',
    };
  }
  const restedBonus = Math.max(0, e.totalXp - (e.baseXp ?? e.totalXp));
  if (restedBonus > 0) {
    return {
      text: fmt(S.COMBATLOG_XPGAIN_EXHAUSTION1, e.victimName, e.totalXp, restedBonus, 'Rested'),
      channel: 'COMBAT_XP_GAIN',
      stringKey: 'COMBATLOG_XPGAIN_EXHAUSTION1',
    };
  }
  return {
    text: fmt(S.COMBATLOG_XPGAIN_FIRSTPERSON, e.victimName, e.totalXp),
    channel: 'COMBAT_XP_GAIN',
    stringKey: 'COMBATLOG_XPGAIN_FIRSTPERSON',
  };
}
