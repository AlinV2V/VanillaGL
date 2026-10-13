/** Asset conversion utility. */
export type ConColor = 'red' | 'orange' | 'yellow' | 'green' | 'gray';

/** Level at/below which a unit gives no XP and cons gray. vMaNGOS GetGrayLevel. */
export function getGrayLevel(playerLevel: number): number {
  if (playerLevel <= 5) return 0;
  if (playerLevel <= 39) return playerLevel - 5 - Math.floor(playerLevel / 10);
  return playerLevel - 1 - Math.floor(playerLevel / 5);
}

/** Reaction-independent difficulty color of `unitLevel` relative to `playerLevel`. */
export function levelDifficultyColor(playerLevel: number, unitLevel: number): ConColor {
  if (unitLevel >= playerLevel + 5) return 'red';
  if (unitLevel >= playerLevel + 3) return 'orange';
  if (unitLevel >= playerLevel - 2) return 'yellow';
  if (unitLevel > getGrayLevel(playerLevel)) return 'green';
  return 'gray';
}
