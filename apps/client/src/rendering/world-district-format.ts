import { worldPageSourceChecksum } from './world-page-format';
import type { CellProjection } from './world-cell-proof';

export type DistrictSource = Parameters<typeof worldPageSourceChecksum>[0] & { batches?: unknown[]; flags?: number };
export type DistrictCell = { coordinate: [number, number, number]; hidden: Array<[string, string]> };
export type DistrictModel = {
  model: string; groups: Record<string, string>; origin: [number, number, number];
  size: [number, number, number]; cells: DistrictCell[];
};
export type DistrictCatalog = { format: 'vgl-world-district-v1'; projection: CellProjection; sourceHash: string; models: DistrictModel[] };
const districtMode = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('worlddistrict') : null;
export const districtEnabled = districtMode === 'on' || districtMode === 'visibility' || districtMode === 'materials';
export const districtMaterialsEnabled = districtMode === 'on' || districtMode === 'materials';
export const districtVisibilityEnabled = districtMode === 'on' || districtMode === 'visibility';
export const districtPartId = (group: number, ordinal: number) => `${group}:${ordinal}`;

/** Include material/batch flags: a changed opaque surface must never keep a stale visibility proof. */
export function districtSourceChecksum(source: DistrictSource): string {
  let hash = 2166136261;
  const metadata = JSON.stringify([source.flags, source.batches ?? []]);
  for (let i = 0; i < metadata.length; i++) hash = Math.imul(hash ^ metadata.charCodeAt(i), 16777619);
  return `${worldPageSourceChecksum(source)}:${hash >>> 0}`;
}
