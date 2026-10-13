/** Horizontal share of a pitched swim velocity vector. */
export const swimHorizontalScale = (pitch: number): number => Math.cos(pitch);

/** Build 5875 / vMaNGOS fall-speed caps in yards per second. */
export const fallTerminalVelocity = (safeFall: boolean): number => safeFall ? 7.0 : 60.148003;
