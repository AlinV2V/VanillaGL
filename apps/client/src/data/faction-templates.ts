import { loadRuntimeData } from '../runtime-data';
export type FactionTemplateTuple = readonly [number, number, number, number, readonly number[], readonly number[]];
type Data = { version?: number; templates: Record<number, FactionTemplateTuple> };
const data = await loadRuntimeData<Data>('faction-templates', { templates: {} });
export const FACTION_TEMPLATES = data.templates;
