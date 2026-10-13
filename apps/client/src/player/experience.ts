// Vanilla XP required from the current level to the next. vMaNGOS normally mirrors this through
// PLAYER_NEXT_LEVEL_XP, but a client still needs a truthful display when that private startup field
// is omitted. Index 0 is unused; level 60 is the Vanilla cap.
const XP_TO_NEXT_LEVEL = [
  0,
  400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600,
  8800, 10100, 11400, 12900, 14400, 16000, 17700, 19400, 21300, 23200,
  25200, 27300, 29400, 31700, 34000, 36400, 38900, 41400, 44300, 47400,
  50800, 54500, 58600, 62800, 67100, 71600, 76100, 80800, 85700, 90700,
  95800, 101000, 106300, 111800, 117500, 123200, 129100, 135100, 141200, 147500,
  153900, 160400, 167100, 173900, 180800, 187900, 195000, 202300, 209800,
] as const;

export function vanillaXpToNextLevel(level: number | undefined): number {
  if (!level || level < 1 || level >= XP_TO_NEXT_LEVEL.length) return 0;
  return XP_TO_NEXT_LEVEL[level] ?? 0;
}

export function resolveExperienceProgress(input: {
  currentXp?: number;
  nextLevelXp?: number;
  restedXp?: number;
  restState?: number;
  level?: number;
  renderedCurrentXp?: number;
}) {
  const level = input.level && input.level > 0 ? input.level : 1;
  const current = Math.max(0, input.currentXp ?? input.renderedCurrentXp ?? 0);
  const maximum = Math.max(1, input.nextLevelXp || vanillaXpToNextLevel(level) || 1);
  const rested = Math.max(0, input.restedXp ?? 0);
  const isRested = input.restState === 1 && rested > 0;
  return {
    current,
    maximum,
    rested,
    isRested,
    percent: Math.min(100, current / maximum * 100),
    restedPercent: Math.min(100, (current + rested) / maximum * 100),
  };
}
