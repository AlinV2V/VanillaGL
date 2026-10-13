import * as THREE from 'three';

export type DoodadPartRuntimeGeometry = {
  partIndex: number;
  lodIndices: readonly THREE.BufferAttribute[];
  renderNormalAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null;
};

export type DoodadGeometryGroup = { start: number; count: number; materialIndex?: number };

export type DoodadPhysicalLayout = {
  /** Indices into the source model's part runtime array. */
  partSlots: readonly number[];
  /** One combined index buffer per LOD. */
  lodIndices: readonly THREE.BufferAttribute[];
  /** Present only for a grouped multi-material mesh. */
  lodGroups?: readonly (readonly DoodadGeometryGroup[])[];
  renderNormalAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null;
};

export type DoodadPhysicalMode = 'grouped' | 'parts';

export function doodadPhysicalMode(search: string): DoodadPhysicalMode {
  return new URLSearchParams(search).get('doodadphysical') === 'parts' ? 'parts' : 'grouped';
}

function combinedIndex(
  parts: readonly DoodadPartRuntimeGeometry[],
  slots: readonly number[],
  level: number,
): { index: THREE.BufferAttribute; groups: DoodadGeometryGroup[] } {
  const selected = slots.map((slot) => {
    const lods = parts[slot].lodIndices;
    return lods[Math.min(level, lods.length - 1)];
  });
  const count = selected.reduce((sum, index) => sum + index.count, 0);
  let maxIndex = 0;
  for (const index of selected) {
    for (let offset = 0; offset < index.count; offset++) maxIndex = Math.max(maxIndex, index.getX(offset));
  }
  const values = maxIndex <= 65_535 ? new Uint16Array(count) : new Uint32Array(count);
  const groups: DoodadGeometryGroup[] = [];
  let cursor = 0;
  selected.forEach((index, materialIndex) => {
    groups.push({ start: cursor, count: index.count, materialIndex });
    for (let offset = 0; offset < index.count; offset++) values[cursor++] = index.getX(offset);
  });
  return { index: new THREE.BufferAttribute(values, 1), groups };
}

/**
 * Preserve logical culling cells while collapsing a model's exact-material parts into one
 * multi-material InstancedMesh. Different generated normal streams cannot share one geometry, so
 * those uncommon sources retain the legacy one-object-per-part representation.
 */
export function buildDoodadPhysicalLayouts(
  parts: readonly DoodadPartRuntimeGeometry[],
  mode: DoodadPhysicalMode,
): DoodadPhysicalLayout[] {
  const slots = parts.map((_, index) => index);
  const commonNormal = parts[0]?.renderNormalAttr ?? null;
  const groupable = mode === 'grouped' && parts.length > 1
    && parts.every((part) => part.renderNormalAttr === commonNormal);
  if (!groupable) {
    return slots.map((slot) => ({
      partSlots: [slot],
      lodIndices: parts[slot].lodIndices,
      renderNormalAttr: parts[slot].renderNormalAttr,
    }));
  }

  const levelCount = Math.max(...parts.map((part) => part.lodIndices.length));
  const levels = Array.from({ length: levelCount }, (_, level) => combinedIndex(parts, slots, level));
  return [{
    partSlots: slots,
    lodIndices: levels.map((level) => level.index),
    lodGroups: levels.map((level) => level.groups),
    renderNormalAttr: commonNormal,
  }];
}

export function applyDoodadGeometryGroups(
  geometry: THREE.BufferGeometry,
  groups: readonly DoodadGeometryGroup[] | undefined,
): void {
  if (!groups) return;
  geometry.clearGroups();
  for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
}
