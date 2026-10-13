/** Asset conversion utility. */
export type CombatAnimKind = 'melee' | 'cast' | 'reaction';

export const ANIM = {
  ATTACK_UNARMED: 0x10,
  COMBAT_WOUND: 0x09,
  COMBAT_CRITICAL: 0x0a,
  SPELL_PRECAST_DIRECTED: 0x33,
  SPELL_CAST_DIRECTED: 0x35,
  CHANNEL_DIRECTED: 0x7c,
} as const;

// vmangos UnitDefines.h:252-268 (the SUPPORTED_CLIENT_BUILD > 1.9.4 block, which is the one
// Build 5875 compiles).
export const HITINFO = {
  AFFECTS_VICTIM: 0x00000002,
  /** HITINFO_LEFTSWING — the server tags every OFF_ATTACK with it (Unit.cpp:1311, 2169). */
  LEFTSWING: 0x00000004,
  MISS: 0x00000010,
  ABSORB: 0x00000020,
  RESIST: 0x00000040,
  CRITICAL: 0x00000080,
  GLANCING: 0x00004000,
  CRUSHING: 0x00008000,
  /** HITINFO_NOACTION — the victim plays no hit reaction for this swing. */
  NOACTION: 0x00010000,
} as const;

/** SMSG_ATTACKERSTATEUPDATE victimState — vmangos UnitDefines.h VictimState. */
export const VICTIM_STATE_TEXT: Record<number, string> = {
  0: 'Miss',
  2: 'Dodge',
  3: 'Parry',
  4: 'Interrupt',
  5: 'Block',
  6: 'Evade',
  7: 'Immune',
  8: 'Deflect',
};

/** SMSG_PET_TAME_FAILURE reasons (vmangos PetDefines.h PetTameFailureReason). */
export const PET_TAME_FAILURE_TEXT: Record<number, string> = {
  1: 'Creature not found',
  2: 'You have too many pets already',
  3: 'Creature is already controlled',
  4: 'Creature not tameable',
  5: 'You have an active summon already',
  6: 'You cannot tame creatures',
  7: 'You do not have a pet to summon',
  8: 'Internal pet error',
  9: 'Creature is too high level for you to tame',
  10: 'Your pet is dead',
  11: 'Your pet is not dead',
  12: 'Unknown taming error',
};

/** Vanilla's own refusal strings for a swing that cannot start. */
export const SWING_ERROR_TEXT: Record<string, string> = {
  notInRange: 'You are too far away!',
  badFacing: 'You are facing the wrong way!',
  notStanding: 'You must be standing to attack.',
  deadTarget: 'Your target is dead.',
  cantAttack: 'You cannot attack that target.',
};

/**
 * Which defensive pose a victim state calls for. The concrete AnimationData id is resolved by the
 * host (`getDefenseAnim`), because parry is weapon-specific — ParryUnarmed/Parry1H/Parry2H/Parry2HL.
 * VictimState values are vmangos UnitDefines.h:238-247.
 */
export const victimDefenseKind = (targetState: number): 'dodge' | 'parry' | 'block' | undefined =>
  targetState === 2 ? 'dodge' : targetState === 3 ? 'parry' : targetState === 5 ? 'block' : undefined;

/** SMSG_SPELLLOGMISS / SPELL_MISS_INFO. */
export const SPELL_MISS_TEXT: Record<number, string> = {
  1: 'Miss',
  2: 'Resist',
  3: 'Dodge',
  4: 'Parry',
  5: 'Block',
  6: 'Evade',
  7: 'Immune',
  8: 'Immune',
  9: 'Deflect',
  10: 'Absorb',
  11: 'Reflect',
};

/**
 * Attack-flavored kit anims (AnimationData.dbc: AttackUnarmed/1H/2H/2HL, BattleRoar, ReadyAbility,
 * Special1H/2H). Vanilla doesn't cancel these on movement, unlike spell casts.
 */
export const MELEE_ONESHOT_ANIMS = new Set([
  0x10, 0x11, 0x12, 0x13, 0x37, 0x38, 0x39, 0x3a,
  0x55, 0x56, 0x57, 0x58, 0x75, // AttackAnimKits pierce/off-hand variants
  0x2e, 0x31, 0x6b,             // AttackBow / AttackRifle / AttackThrown
]);

/** Attack2H / Attack2HL / Attack2HLoosePierce — the swings that pair with Special2H (0x3a). */
export const TWO_HANDED_SWING_ANIMS = new Set([0x12, 0x13, 0x56]);

export const oneShotKind = (animId: number): CombatAnimKind =>
  (MELEE_ONESHOT_ANIMS.has(animId) ? 'melee' : 'cast');

export const woundReactionAnim = (hitInfo: number) => {
  // HITINFO_NOACTION explicitly suppresses the victim's flinch, and HITINFO_AFFECTS_VICTIM is what
  // enables it ("no being hit animation on victim without it" — vmangos UnitDefines.h:255).
  if ((hitInfo & HITINFO.NOACTION) !== 0) return undefined;
  if ((hitInfo & HITINFO.CRITICAL) !== 0) return ANIM.COMBAT_CRITICAL;
  if ((hitInfo & HITINFO.AFFECTS_VICTIM) !== 0) return ANIM.COMBAT_WOUND;
  return undefined;
};
