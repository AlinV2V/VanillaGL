/** Stretch the complete texture across the currently alive ribbon edges. */
export const ribbonEdgeU = (index: number, activeEdges: number): number =>
  index / Math.max(1, activeEdges - 1);

/** Preserve sub-edge time when one ribbon edge is emitted. */
export const advanceRibbonEmission = (accumulator: number, edgesPerSecond: number, dt: number) => {
  const next = accumulator + Math.max(1, edgesPerSecond) * dt;
  return { emit: next >= 1, accumulator: next >= 1 ? next - 1 : next };
};
