import { loadRuntimeData } from '../runtime-data';
type Data = { version?: number; emoteAnims: Record<number, [number, number]>; textEmotes: Record<string, number> };
const data = await loadRuntimeData<Data>('emotes', { emoteAnims: {}, textEmotes: {} });
export const EMOTE_ANIMS = data.emoteAnims;
export const TEXT_EMOTES = data.textEmotes;
