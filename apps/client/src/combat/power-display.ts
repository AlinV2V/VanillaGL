/** Asset conversion utility. */
const POWER_DISPLAY_DIVISORS = [1, 10, 1, 1, 1000] as const;

export function displayPowerValue(powerType: number, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const divisor = POWER_DISPLAY_DIVISORS[powerType] ?? 1;
  return Math.trunc(value / divisor);
}

