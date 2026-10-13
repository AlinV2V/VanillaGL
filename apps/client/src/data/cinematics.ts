import { loadRuntimeData } from '../runtime-data';
export interface CinematicSplineKeyVec3 { t: number; v: [number, number, number] }
export interface CinematicSplineKeyF32 { t: number; v: number }
export interface CinematicCameraData { id: number; model: string; soundId: number; origin: [number, number, number]; facing: number; fov: number; farClip: number; nearClip: number; positionInterp: number; position: CinematicSplineKeyVec3[]; positionBase: [number, number, number]; target: CinematicSplineKeyVec3[]; targetBase: [number, number, number]; roll: CinematicSplineKeyF32[] }
export interface CinematicSequenceData { id: number; soundId: number; cameras: number[] }
type Data = { version?: number; cameras: Record<number, CinematicCameraData>; sequences: Record<number, CinematicSequenceData> };
const data = await loadRuntimeData<Data>('cinematics', { cameras: {}, sequences: {} });
export const CINEMATIC_CAMERAS = data.cameras; export const CINEMATIC_SEQUENCES = data.sequences;
