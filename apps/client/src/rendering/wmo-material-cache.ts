export type WmoInteriorMaterialCacheKeyParts = {
  modelIndex: number;
  tex: number;
  tex2: number;
  shader: number;
  blendMode: number;
  flags: number;
  hasVertexColors: boolean;
  lightRefs: readonly number[];
};
/** Asset conversion utility. */
export function wmoInteriorMaterialCacheKey(parts: WmoInteriorMaterialCacheKeyParts): string {
  return `interior_${parts.modelIndex}_${parts.tex}_${parts.tex2}_${parts.shader}_${parts.blendMode}_${parts.flags}_${parts.hasVertexColors ? 1 : 0}_${parts.lightRefs.join(',')}`;
}
