type TileCoreBuffers = {
  heights: ArrayBuffer;
  holes: ArrayBuffer | null;
  innerHeights: ArrayBuffer | null;
  normals: ArrayBuffer | null;
};

const requireBytes = (label: string, buffer: ArrayBuffer | null, expected: number) => {
  if (buffer && buffer.byteLength !== expected) {
    throw new Error(`${label} malformed: ${buffer.byteLength}/${expected} bytes`);
  }
};

/** Reject present-but-corrupt optional terrain sidecars instead of treating them as absence. */
export function validateTileCoreBuffers(n: number, core: TileCoreBuffers): void {
  if (!Number.isInteger(n) || n < 2) throw new Error(`terrain grid dimension malformed: ${n}`);
  const outer = n * n, inner = (n - 1) * (n - 1);
  requireBytes('heights.f32', core.heights, outer * Float32Array.BYTES_PER_ELEMENT);
  requireBytes('holes.bin', core.holes, 256 * Uint16Array.BYTES_PER_ELEMENT);
  requireBytes('heights_inner.f32', core.innerHeights, inner * Float32Array.BYTES_PER_ELEMENT);
  requireBytes('normals.f32', core.normals, (outer + inner) * 3 * Float32Array.BYTES_PER_ELEMENT);
}
