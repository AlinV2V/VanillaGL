/** Asset conversion utility. */
import { getInterfaceCvars } from './interface-runtime';
import type { InterfaceCvars } from './interface-cvars';

export type FctCategory =
  | 'targetDamage'
  | 'periodicDamage'
  | 'petDamage'
  | 'incomingDamage'
  | 'dodgeParryMiss'
  | 'damageReduction'
  | 'energyGains'
  | 'comboPoints'
  | 'honorGained'
  | 'reputation'
  | 'auras'
  | 'fadingAuras'
  | 'lowManaHealth'
  | 'combatState'
  | 'friendlyHealers'
  | 'reactives';

/**
 * Category → cvar key. `incomingDamage` deliberately has no key: damage landing on
 * you is not one of the panel's toggles (there is no "hide my own damage taken"
 * checkbox), so it rides on the master switch alone.
 */
const CATEGORY_CVAR: Record<FctCategory, keyof InterfaceCvars | null> = {
  targetDamage: 'fctTargetDamage',
  periodicDamage: 'fctPeriodicDamage',
  petDamage: 'fctPetDamage',
  incomingDamage: null,
  dodgeParryMiss: 'fctDodgeParryMiss',
  damageReduction: 'fctDamageReduction',
  energyGains: 'fctEnergyGains',
  comboPoints: 'fctComboPoints',
  honorGained: 'fctHonorGained',
  reputation: 'fctReputation',
  auras: 'fctAuras',
  fadingAuras: 'fctFadingAuras',
  lowManaHealth: 'fctLowManaHealth',
  combatState: 'fctCombatState',
  friendlyHealers: 'fctFriendlyHealers',
  reactives: 'fctReactives',
};

/** Categories the panel nests under "Show Target Damage" (indented + grayed with it). */
const REQUIRES_TARGET_DAMAGE = new Set<FctCategory>(['periodicDamage', 'petDamage']);

export function fctAllows(category: FctCategory): boolean {
  const cvars = getInterfaceCvars();
  if (Number(cvars.enableFCT) !== 1) return false;
  if (REQUIRES_TARGET_DAMAGE.has(category) && Number(cvars.fctTargetDamage) !== 1) return false;
  const key = CATEGORY_CVAR[category];
  return key === null || Number(cvars[key]) === 1;
}

/**
 * Vertical travel for a spawned label, as a CSS `translate` Y term.
 *
 * "Scroll Up" is the vanilla default (text rises away from the unit and fades).
 * "Scroll Down" mirrors it. The start term keeps the label anchored on the unit's
 * head before the transition runs, so only the end term changes between modes.
 */
export function fctFloatTravel(critical: boolean): { from: string; to: string } {
  const scrollDown = String(getInterfaceCvars().fctFloatMode) === 'Scroll Down';
  if (scrollDown) return { from: '-100%', to: critical ? '85%' : '40%' };
  return { from: '-100%', to: critical ? '-285%' : '-240%' };
}
