import type { ActionButton } from '../world';

/** FrameXML ActionButton_GetPagedID, expressed as zero-based SMSG_ACTION_BUTTONS offsets. */
export function resolveVanillaActionBarOffset(
  allActions: readonly ActionButton[],
  classId: number,
  auraSpellIds: readonly number[] = [],
  bonusActionBarForSpell?: (spellId: number) => number,
): number {
  const auras = new Set(auraSpellIds.filter(Boolean));
  if (bonusActionBarForSpell) {
    for (const spellId of auras) {
      const bonusPage = bonusActionBarForSpell(spellId);
      // GetBonusBarOffset 1..4 selects action pages 7..10; packet storage is zero-based.
      if (bonusPage > 0 && bonusPage <= 4) return (5 + bonusPage) * 12;
    }
  }
  if (classId === 1) {
    if (auras.has(71)) return 84; // Defensive Stance: bonus page 2.
    if (auras.has(2458)) return 96; // Berserker Stance: bonus page 3.
    return 72; // Battle Stance: bonus page 1, including its startup-aura race.
  }
  if (classId === 4 && auras.has(1784)) return 72; // Rogue Stealth.
  if (classId === 11) {
    if (auras.has(768) || auras.has(24858)) return 72; // Cat / Moonkin.
    if (auras.has(5487) || auras.has(9634)) return 96; // Bear / Dire Bear.
  }

  // The action packet can precede the form aura. Adopt an unambiguous populated bonus page only
  // when the normal page is empty; later aura updates select the exact page above.
  if (!allActions.slice(0, 12).some(Boolean)) {
    const occupied = [72, 84, 96, 108].filter((offset) => allActions.slice(offset, offset + 12).some(Boolean));
    if (occupied.length === 1) return occupied[0];
  }
  return 0;
}
