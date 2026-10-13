import { loadRuntimeData } from '../runtime-data';
export type StarterOutfitItem = { displayInfoId: number; inventoryType: number };
type Data = { version?: number; outfits: Record<string, StarterOutfitItem[]> };
const data = await loadRuntimeData<Data>('char-start-outfits', { outfits: {} });
export const CHAR_START_OUTFITS = data.outfits;
export function starterOutfitFor(race: number | undefined, classId: number | undefined, gender: number | undefined): StarterOutfitItem[] {
  if (race === undefined || classId === undefined || gender === undefined) return [];
  return CHAR_START_OUTFITS[`${race}:${classId}:${gender}`] ?? [];
}
