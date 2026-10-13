export const WMO_BVH_FORMAT = 'vanillagl-wmo-bvh-v2' as const;
export const WMO_BVH_SERIALIZATION_VERSION = 1 as const;
export const WMO_BVH_LIBRARY_VERSION = '0.9.13' as const;
export const WMO_BVH_OPTIONS = { targetLeafSize: 10 } as const;

export type WmoBvhBinaryRef = { offset: number; byteLength: number };
export type WmoBvhIndexRef = WmoBvhBinaryRef & { component: 'u16' | 'u32'; count: number };
export type WmoBvhSurfaceMeta = {
  model: number;
  group: number;
  surface: number;
  positionCount: number;
  sourceIndexCount: number;
  roots: WmoBvhBinaryRef[];
  index: WmoBvhIndexRef;
  indirect?: WmoBvhIndexRef;
  triangles: number;
};

export type WmoBvhMeta = {
  format: typeof WMO_BVH_FORMAT;
  generatedAt: string;
  meshBvhVersion: typeof WMO_BVH_LIBRARY_VERSION;
  serializationVersion: typeof WMO_BVH_SERIALIZATION_VERSION;
  options: typeof WMO_BVH_OPTIONS;
  sourceBinarySha256: string;
  bvhBinarySha256: string;
  contractSha256: string;
  surfaces: WmoBvhSurfaceMeta[];
};

/** Stable payload covered by contractSha256; generatedAt is intentionally informational. */
export function wmoBvhContractJson(meta: Omit<WmoBvhMeta, 'contractSha256' | 'generatedAt'>): string {
  return JSON.stringify({
    format: meta.format,
    meshBvhVersion: meta.meshBvhVersion,
    serializationVersion: meta.serializationVersion,
    options: meta.options,
    sourceBinarySha256: meta.sourceBinarySha256,
    bvhBinarySha256: meta.bvhBinarySha256,
    surfaces: meta.surfaces,
  });
}
