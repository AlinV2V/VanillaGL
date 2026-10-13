type HeightPoint = readonly [number, number, number];

const triangleHeight = (
  x: number,
  y: number,
  a: HeightPoint,
  b: HeightPoint,
  c: HeightPoint,
): number | null => {
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  const wa = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator;
  const wb = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator;
  const wc = 1 - wa - wb;
  return wa >= -1e-6 && wb >= -1e-6 && wc >= -1e-6 ? wa * a[2] + wb * b[2] + wc * c[2] : null;
};

/** Sample the ADT outer/inner height fan exactly as the shipped world loader does. */
export const sampleTerrainHeightGrid = (
  heights: ArrayLike<number>,
  innerHeights: ArrayLike<number> | null,
  n: number,
  row: number,
  col: number,
): number => {
  const rowF = Math.max(0, Math.min(n - 1, row));
  const colF = Math.max(0, Math.min(n - 1, col));
  const r0 = Math.max(0, Math.min(n - 2, Math.floor(rowF)));
  const c0 = Math.max(0, Math.min(n - 2, Math.floor(colF)));
  const r1 = Math.min(n - 1, r0 + 1);
  const c1 = Math.min(n - 1, c0 + 1);
  const fr = rowF - r0;
  const fc = colF - c0;

  if (innerHeights) {
    const a: HeightPoint = [0, 0, heights[r0 * n + c0]];
    const b: HeightPoint = [1, 0, heights[r1 * n + c0]];
    const c: HeightPoint = [1, 1, heights[r1 * n + c1]];
    const d: HeightPoint = [0, 1, heights[r0 * n + c1]];
    const middle: HeightPoint = [0.5, 0.5, innerHeights[r0 * (n - 1) + c0]];
    return (
      triangleHeight(fr, fc, a, b, middle) ??
      triangleHeight(fr, fc, b, c, middle) ??
      triangleHeight(fr, fc, c, d, middle) ??
      triangleHeight(fr, fc, d, a, middle) ??
      middle[2]
    );
  }

  const h0 = heights[r0 * n + c0] + (heights[r1 * n + c0] - heights[r0 * n + c0]) * fr;
  const h1 = heights[r0 * n + c1] + (heights[r1 * n + c1] - heights[r0 * n + c1]) * fr;
  return h0 + (h1 - h0) * fc;
};
