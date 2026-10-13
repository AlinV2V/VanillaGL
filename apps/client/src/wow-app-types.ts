import type * as THREE from 'three';
import type { TileEntry } from './tile-utils';
import type { IndoorMaskVolume } from './rendering/wmo-interiors';
import type { WmoLiquidInstance } from './rendering/wmo-liquid-surface';

export type StarterZoneCamera = {
  slug: string;
  index: number;
  zone: string;
  name: string;
  position: [number, number, number];
  yaw: number;
  pitch: number;
  targetVisible?: string[];
};

export type StarterZoneEntry = {
  slug: string;
  name: string;
  mapId: number;
  mapDir: string;
  zoneId: number;
  previewRequiredTiles: string[];
  completeZoneRequiredTiles: string[];
  validationCameras?: StarterZoneCamera[];
};

export type StarterZoneManifest = {
  generatedFrom?: string[];
  zones: StarterZoneEntry[];
};

export type StarterZoneSpawn = {
  guid: number;
  entry: number;
  name: string;
  subname?: string;
  displayId: number;
  faction?: number;
  npcFlags?: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
  movementType?: number;
  wanderRadius?: number;
  spawnTime?: number;
  equipment?: number[];
};

export type StarterZoneSpawnManifest = Record<string, Record<string, Record<string, StarterZoneSpawn[]>>>;

export type AreaTriggerRecord = {
  id: number;
  mapId: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  boxX: number;
  boxY: number;
  boxZ: number;
  boxOrientation: number;
};

export type AreaTriggerManifest = {
  count?: number;
  opcode?: number;
  triggers: AreaTriggerRecord[];
};

export type LoadedTile = {
  key: string;
  entry: TileEntry;
  meta: { minHeight: number; maxHeight: number; originX?: number; originY?: number; n: number; shader?: { surfaceResolution?: number; surfaceTextures?: Array<{ name: string; terrainType: number }> } };
  centerX: number;
  centerY: number;
  n: number;
  step: number;
  heights: Float32Array;
  innerHeights: Float32Array | null;
  holes: Uint16Array | null;
  indoorMasks: IndoorMaskVolume[];
  group: THREE.Group;
  collisionMeshes: THREE.Mesh[];
  wmoLiquids: WmoLiquidInstance[];
  terrainMaterial: THREE.ShaderMaterial | null;
  /** The ADT ground mesh + liquid mesh — hidden while the camera is fully enclosed in a WMO interior (GFX-37). */
  exteriorMeshes: THREE.Object3D[];
  /** Dominant TerrainType.dbc ID at each streamed terrain cell. */
  surfaceMap: { grid: Uint8Array; resolution: number } | null;
  // ADT liquid surface (tools/bake-water.ts): 129x129 grid of liquid heights (NaN = dry) for
  // swim-depth queries; type 1=river/water, 2=ocean, 3=magma, 4=slime.
  water: { grid: Float32Array; type: number } | null;
};
