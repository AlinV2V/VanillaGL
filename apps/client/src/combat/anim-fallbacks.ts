// Vanilla AnimationData.dbc ids, verified from wow-client-reversed-extracted/dbcs/AnimationData.json.
// When a baked model lacks the exact id, walk to a present alternative before falling back to Stand.
export const ANIM_FALLBACKS: Record<number, number[]> = {
  0x09: [0x08, 0x0a, 0x00],
  0x0a: [0x09, 0x08, 0x00],
  0x10: [0x11, 0x12, 0x13, 0x75, 0x76], // AttackUnarmed
  0x11: [0x12, 0x13, 0x10, 0x75],       // Attack1H -> 2H / 2HL / unarmed (don't fall through to Stand)
  0x12: [0x13, 0x11, 0x10, 0x75],       // Attack2H -> 2HL / 1H / unarmed
  0x13: [0x12, 0x11, 0x10, 0x75],       // Attack2HL (staff/polearm) -> 2H / 1H / unarmed
  0x14: [0x15, 0x16, 0x17, 0x18, 0x24],
  // Weapon-specific parries walk back to ParryUnarmed, then ShieldBlock, then Stand.
  0x15: [0x14, 0x16, 0x17, 0x18, 0x00],
  0x16: [0x17, 0x15, 0x14, 0x18, 0x00],
  0x17: [0x16, 0x15, 0x14, 0x18, 0x00],
  // ShieldBlock is the sequence 1.12 player models actually ship; Block (0x24) is present in
  // AnimationData but in none of the 16 baked player models, so it is the fallback, not the target.
  0x18: [0x24, 0x14, 0x00],
  // Combat-ready idle (in-combat stand): ReadyUnarmed 25 / Ready1H 26 / Ready2H 27 / Ready2HL 28 /
  // ReadyBow 29 — walk down to a present variant, else plain Stand.
  0x19: [0x1a, 0x00],
  0x1a: [0x1b, 0x1c, 0x19, 0x00],
  0x1b: [0x1c, 0x1a, 0x19, 0x00],
  0x1c: [0x1b, 0x1a, 0x19, 0x00],
  0x1d: [0x19, 0x00],
  0x1e: [0x00],
  // Ranged: AttackBow/AttackRifle/AttackThrown and the ReadyRifle/ReadyThrown stances. All are
  // present on every 1.12 player model, so these only matter for creatures.
  0x2e: [0x31, 0x6b, 0x10, 0x00],       // AttackBow -> AttackRifle / AttackThrown / unarmed
  0x30: [0x1d, 0x19, 0x00],             // ReadyRifle -> ReadyBow / ReadyUnarmed
  0x31: [0x2e, 0x6b, 0x10, 0x00],       // AttackRifle -> AttackBow / AttackThrown / unarmed
  0x6b: [0x2e, 0x31, 0x10, 0x00],       // AttackThrown -> AttackBow / AttackRifle / unarmed
  0x6c: [0x1d, 0x19, 0x00],             // ReadyThrown -> ReadyBow / ReadyUnarmed
  0x24: [0x14, 0x18, 0x00],
  0x33: [0x34, 0x1f, 0x02, 0x00],
  0x35: [0x36, 0x20, 0x02, 0x00],
  // Kit-driven ids from SpellVisualKit (bake-spell-visuals.ts): omni casts, ability specials, roar.
  0x34: [0x33, 0x1f, 0x02, 0x00],       // ReadySpellOmni -> ReadySpellDirected
  0x36: [0x35, 0x20, 0x02, 0x00],       // SpellCastOmni -> SpellCastDirected
  0x37: [0x10, 0x00],                   // BattleRoar -> unarmed swing beats standing still
  0x38: [0x39, 0x11, 0x10, 0x00],       // ReadyAbility -> Special1H / Attack1H / unarmed
  0x39: [0x11, 0x12, 0x10, 0x00],       // Special1H -> Attack1H / 2H / unarmed
  0x3a: [0x12, 0x13, 0x11, 0x10, 0x00], // Special2H -> Attack2H / 2HL / 1H / unarmed
  // AttackAnimKits swing variants (see combat/attack-anims.ts). Attack2HLoosePierce (0x56) ships
  // on zero baked player models, so the polearm/staff pierce kit always resolves to Attack2HL.
  0x55: [0x11, 0x12, 0x10, 0x00],       // Attack1HPierce -> Attack1H / 2H / unarmed
  0x56: [0x13, 0x12, 0x11, 0x10, 0x00], // Attack2HLoosePierce -> Attack2HL / 2H / 1H / unarmed
  0x57: [0x11, 0x12, 0x10, 0x00],       // AttackOff -> Attack1H / 2H / unarmed
  0x58: [0x57, 0x55, 0x11, 0x10, 0x00], // AttackOffPierce -> AttackOff / Attack1HPierce / 1H
  0x75: [0x57, 0x10, 0x11, 0x00],       // AttackUnarmedOff -> AttackOff / unarmed
  0x7c: [0x7d, 0x33, 0x34, 0x02],
};

export function resolveAnimId(wanted: number, available: readonly number[]): number {
  if (!available.length || available.includes(wanted)) return wanted;
  return ANIM_FALLBACKS[wanted]?.find((candidate) => available.includes(candidate)) ?? 0;
}
