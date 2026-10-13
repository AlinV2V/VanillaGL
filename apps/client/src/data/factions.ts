import { loadRuntimeData } from '../runtime-data';
export type FactionMeta = { id: number; reputationListId: number; parentFactionId: number; name: string; description: string };
type Data = { version?: number; factionsByReputationIndex: Record<number, FactionMeta> };
const data = await loadRuntimeData<Data>('factions', { factionsByReputationIndex: {} });
export const FACTIONS_BY_REPUTATION_INDEX = data.factionsByReputationIndex;
