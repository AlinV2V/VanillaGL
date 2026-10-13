import { loadRuntimeData } from '../runtime-data';
export type TransportAnimationNode = { time: number; x: number; y: number; z: number };
export type TransportAnimation = { totalTime: number; nodes: TransportAnimationNode[] };
export type TransportAnimationData = { version: 1; elevators: Record<string, TransportAnimation> };
export const TRANSPORT_ANIMATIONS = await loadRuntimeData<TransportAnimationData>('transport-animations', { version: 1, elevators: {} });
