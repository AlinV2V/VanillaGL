/** Build 5875 HelmetGeosetVisData fields are race-indexed HIDE masks. */
export type HelmetFeature = 'hair' | 'beard' | 'ears' | 'horns' | 'extra';

export type HelmetVisibilityInfo = {
  helmetGeosetVis?: Partial<Record<HelmetFeature, number>>;
};

/** A set bit for the character's race means that feature is hidden by the equipped helmet. */
export function helmetGeosetHides(
  itemInfos: readonly HelmetVisibilityInfo[],
  race: number,
  feature: HelmetFeature,
): boolean {
  if (!Number.isInteger(race) || race < 0 || race > 31) return false;
  const raceBit = (1 << race) >>> 0;
  return itemInfos.some((info) => {
    const mask = info.helmetGeosetVis?.[feature];
    return typeof mask === 'number' && (((mask >>> 0) & raceBit) !== 0);
  });
}
