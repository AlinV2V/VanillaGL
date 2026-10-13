/** Asset conversion utility. */
export const BUILD_5875_WORLD_DETAIL = [
  { frillDensity: 16, smallCull: 0.07 },
  { frillDensity: 32, smallCull: 0.04 },
  { frillDensity: 48, smallCull: 0.01 },
] as const;

export const BUILD_5875_GROUND_EFFECT_SENTINEL = 0xffff;
export const BUILD_5875_GROUND_EFFECT_CELL_SIDE = 8;
export const BUILD_5875_GROUND_EFFECT_MODEL_SLOTS = 4;
export const BUILD_5875_GROUND_EFFECT_DEFAULT_DENSITY = 8;
export const BUILD_5875_GROUND_EFFECT_CELL_WIDTH = 4.1666665;
export const BUILD_5875_GROUND_EFFECT_HALF_CELL_WIDTH = 2.0833333;

/** Clean, deterministic seeded PRNG for procedural ground foliage placement. */
export class Build5875GroundEffectRandom {
  private state: number;

  constructor(indexX: number, indexY: number) {
    this.state = (((((indexY & 0xffff) << 16) | (indexX & 0xffff)) ^ 0x6d2b79f5) >>> 0);
  }

  nextUint32(): number {
    let t = this.state = (this.state + 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  nextSignedUnit(): number {
    return (this.nextUint32() / 0xffffffff) * 2 - 1;
  }
}

export function build5875GroundEffectCellPasses(
  random: Build5875GroundEffectRandom,
  count: number,
): Array<{ column: number; row: number }> {
  return Array.from({ length: count }, () => ({
    column: random.nextUint32() & 7,
    row: random.nextUint32() & 7,
  }));
}

export function build5875PredTexLayer(predTex: readonly number[], column: number, row: number): number {
  return ((predTex[row] ?? 0) >>> (column * 2)) & 3;
}

export function build5875CellSuppressesDoodads(
  noEffectDoodad: ArrayLike<number>,
  column: number,
  row: number,
): boolean {
  return (((noEffectDoodad[row] ?? 0) >>> column) & 1) !== 0;
}

export function build5875CellIsHole(holes: number, column: number, row: number): boolean {
  return (holes & (1 << ((row >> 1) * 4 + (column >> 1)))) !== 0;
}

export function clampBuild5875WorldDetail(value: number | undefined): 0 | 1 | 2 {
  const level = Math.max(0, Math.min(2, Math.round(value ?? 2)));
  return level as 0 | 1 | 2;
}

export function groundEffectDetailTierForPass(pass: number): 0 | 1 | 2 {
  if (pass < BUILD_5875_WORLD_DETAIL[0].frillDensity) return 0;
  if (pass < BUILD_5875_WORLD_DETAIL[1].frillDensity) return 1;
  return 2;
}

export function groundEffectInstanceVisibleAtDetail(
  instance: { d?: number },
  worldDetail: number | undefined,
): boolean {
  return instance.d === undefined || instance.d <= clampBuild5875WorldDetail(worldDetail);
}
