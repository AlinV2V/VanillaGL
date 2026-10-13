import type { BufferAttribute } from 'three';

/** The caller rewrites the complete live prefix; unused capacity is outside the draw range. */
export function updateDynamicAttributePrefix(attribute: BufferAttribute, vertices: number): void {
  if (vertices <= 0) return;
  // A culled emitter may tick many times before WebGLAttributes consumes its ranges. Replace
  // the pending range instead of appending one per tick; the latest prefix is authoritative.
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, vertices * attribute.itemSize);
  attribute.needsUpdate = true;
}
