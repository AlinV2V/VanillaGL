export type CorpseSettlementPoint = { x: number; y: number; z: number };

/** Chosen cache tolerance: one centimetre is below visible/server movement but absorbs float noise. */
export const CORPSE_SETTLE_MOVE_EPSILON = 0.01;

/** A later dead-unit packet moved far enough that its one-shot ground result is no longer valid. */
export const corpseSettlementSourceMoved = (
  source: CorpseSettlementPoint | undefined,
  target: CorpseSettlementPoint,
): boolean => {
  if (!source) return true;
  const dx = source.x - target.x;
  const dy = source.y - target.y;
  const dz = source.z - target.z;
  return dx * dx + dy * dy + dz * dz > CORPSE_SETTLE_MOVE_EPSILON ** 2;
};
