/** Asset conversion utility. */
/** `time` is Light.dbc half-minutes over a 2880 day: 0 = midnight, 1440 = noon. */
export function dayFactor(time: number): number {
  if (!Number.isFinite(time)) return 1;
  const hour = ((time % 2880) + 2880) % 2880 / 120;
  if (hour >= 8 && hour <= 17) return 1;                 // full day
  if (hour > 17 && hour < 21) return 1 - (hour - 17) / 4; // dusk 17:00-21:00
  if (hour > 5 && hour < 8) return (hour - 5) / 3;        // dawn 05:00-08:00
  return 0;                                              // night 21:00-05:00
}

/** 0 in full daylight, 1 in full dark. Drives SIDN/WINDOW self-illumination. */
export function nightFactor(time: number): number {
  return 1 - dayFactor(time);
}
