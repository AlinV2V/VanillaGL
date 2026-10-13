import type * as THREE from 'three';

export type ObjectKind = 'm2' | 'wmo' | 'npc' | 'gameobject' | 'unknown';
export type EnvironmentState = { hour: number; fogNear: number; fogFar: number; fogColor: string; weather: 'clear' | 'rain' | 'snow' };
export type SerializedObject = {
  id?: string;
  model: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: number | [number, number, number];
};
export type LiveTarget = { recordId: string; tileKey: string; kind: ObjectKind; model: string; sourceId?: string | number };
export type MaterialLocator = { slot: number; materialIndex?: number; groupIndex?: number; batchIndex?: number; meshIndex?: number; partIndex?: number; textureIndex?: number };
export type MaterialOverride = {
  id: string; recordId: string; tileKey: string; kind: ObjectKind; model: string; sourceId?: string | number;
  locator: MaterialLocator; scope: 'instance' | 'asset'; color?: string; textureUrl?: string; opacity?: number; emissive?: string;
};
export type LiveProject = {
  mapId: number; tileKey: string;
  objects: Array<{ target: LiveTarget; state: 'added' | 'modified' | 'deleted'; transform?: SerializedObject }>;
  materials: MaterialOverride[]; environment?: EnvironmentState;
};
export type LiveCommand =
  | { type: 'transform.set'; target: LiveTarget; transform: SerializedObject }
  | { type: 'object.spawn'; target: LiveTarget; transform: SerializedObject }
  | { type: 'object.delete'; target: LiveTarget }
  | { type: 'object.restore'; target: LiveTarget }
  | { type: 'material.set'; target: LiveTarget; override: MaterialOverride }
  | { type: 'environment.set'; environment: EnvironmentState }
  | { type: 'project.apply'; project: LiveProject }
  | { type: 'playmode.set'; playing: boolean }
  | { type: 'selection.focus'; target: LiveTarget };
export type Incoming = { type: 'bridge.hello'; cachedProject?: LiveProject } | { type: 'bridge.command'; id: string; command: LiveCommand };
export type RuntimeHooks = typeof globalThis & {
  __wowScene?: THREE.Scene; __wowCamera?: THREE.Camera;
  __wowControls?: { target: THREE.Vector3; update: () => void };
  __wowWeather?: { setWeather: (state: { type: number; grade: number; soundId: number; instant: boolean }) => void };
  __wowFreeCam?: (enabled?: boolean) => unknown;
  wowTune?: (partial?: Record<string, number>) => Record<string, number>;
};
