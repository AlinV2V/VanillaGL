import * as THREE from 'three';
import { resolveAnimId } from './combat/anim-fallbacks';
import { remoteReadyStanceAnim, resolveWeapons } from './combat/attack-anims';
import { createM2Animator, type M2AnimationData, type M2Animator } from './m2-animator';
import { createM2Material } from './m2-material';
import { createBlobShadow, disposeBlobShadow, updateBlobShadowLod } from './rendering/blob-shadow';
import { gameObjectRestingPose, gameObjectTransitionAnim, type GameObjectPose } from './rendering/gameobject-anim';
import { staggerUnitAnimationAccum, unitAnimationSampleInterval } from './rendering/unit-animation-lod';
import { UnitAnimationVisibility } from './rendering/unit-animation-visibility';
import { isWeaponDrawn } from './combat/virtual-items';
import {
  loadBakedCharacterModel,
  loadBakedCreatureEquipmentAttachments,
  loadBakedNpcCharacterModel,
  type BakedCamera,
  type LoadedEquipmentAttachment,
  type PlayerAnimator,
  type PlayerAnimState,
} from './model-loader';
import { extrapolateGroundMovement } from './player/remote-extrapolation';
import { TypeID } from './world-entities';
import { isServerOnlyMarker } from './rendering/server-only-markers';
import { isConvergingToTarget } from './rendering/locomotion-state';
import { getInterfaceCvars } from './ui/interface-runtime';
import { publishRemoteCharacter } from './ui/inspect-character-refresh';
import { corpseSettlementSourceMoved } from './rendering/corpse-settlement';
import { groundProbeSource, shouldApplyLivingUnitGroundSettle, unitGroundProbeZ } from './rendering/ground-settle';
import { unitAnimationPlan } from './rendering/unit-animation-plan';
import { TransportRuntime } from './rendering/transport-locomotion';
import { assetRequestQueue } from './assets/asset-request-queue';
import { classifyEntityRenderChange } from './rendering/entity-render-change';
import { entityBeyondDrawDistance, entityDistanceSquared } from './rendering/entity-distance-rejection';
import { beginCpuScope, CpuScopeId, endCpuScope, performanceAblations, recordEntityAnimationSample, recordPick } from './rendering/performance-detail-diagnostics';
import type { WorldEntityChange } from './world-entities';
import { abortableDelay } from './platform/abortable-delay';
import { ByteBudgetPromiseCache, estimateDecodedBytes } from './platform/byte-budget-promise-cache';
import { PendingPromiseCache } from './platform/pending-promise-cache';
import { loadOptimizedTexture } from './rendering/optimized-texture-loader';
import { requestCreatureDisplayJson } from './rendering/entity-display-request';
import { SpatialIndex2D } from './platform/spatial-index';
import { advanceUnitSplinePresentation, ownsUnitSpline, retiredUnitSpline, type UnitSplinePresentationState } from './rendering/unit-spline-presentation';
import { centerM2BoundsOnOrigin, createSharedM2GeometryGroup, releaseSharedM2Geometry, SharedM2GeometryPool } from './rendering/shared-m2-geometry-pool';
import { BoundedTextureRegistry } from './rendering/shared-texture-cache';
// UNIT_FIELD_BYTES_1 byte 0 (UnitStandStateType) -> idle AnimationData sequence, matching the local
// player: 97 SitGround, 100 Sleep, 102/103/104 SitChair Low/Med/High, 115 KneelLoop. vMaNGOS sits a
// unit (SIT=1) on any AURA_INTERRUPT_STANDING_CANCELS aura apply — eating/drinking — and on /sit, so
// other players and NPCs sit here the same way the local player does.
const STAND_STATE_ANIM: Record<number, number> = { 1: 97, 2: 97, 3: 100, 4: 102, 5: 103, 6: 104, 8: 115 };
const readyStanceAnimFor = (entity: {
  typeId?: number;
  unitFlags?: number;
  sheathState?: number;
  visibleEquipment?: readonly {
    displayInfoId: number;
    inventoryType: number;
    slot?: number;
    subclass?: number;
  }[];
}) => {
  const sheathState = entity.sheathState ?? 0;
  if (sheathState === 0) return undefined;
  const weapons = resolveWeapons(entity.visibleEquipment);
  return remoteReadyStanceAnim(
    entity.typeId === TypeID.UNIT,
    entity.unitFlags,
    sheathState,
    weapons.mainHand,
    weapons.ranged,
  );
};
import type { WorldEntity, CharacterInfo } from './world';
import type { RenderSnapshotBuffer } from './simulation/render-snapshot';
import { unitSplineClock } from './rendering/unit-spline-state';
import { recordAssetLoadFailure, type AssetLoadFailure, UnbakedCreatureDisplayError, UnbakedGameObjectDisplayError } from './rendering/asset-load-failure';
export { assetLoadRetryDelay as gameObjectAssetRetryDelay } from './rendering/asset-load-failure';

type LocalPoint = { x: number; y: number };
/** Derive the native portrait focus from Vanilla's semantic head key-bone (id 6). */
function setM2PortraitFraming(root: THREE.Object3D, data: M2AnimationData & { cameras?: BakedCamera[] }) {
  const camera = data.cameras?.find((entry) => entry.type === 0);
  if (camera) {
    const positionOffset = camera.positionTrack.values.length >= 3 ? camera.positionTrack.values : [0, 0, 0];
    const targetOffset = camera.targetTrack.values.length >= 3 ? camera.targetTrack.values : [0, 0, 0];
    root.userData.portraitCamera = {
      fov: camera.fov,
      nearClip: camera.nearClip,
      farClip: camera.farClip,
      position: camera.positionBase.map((value, index) => value + positionOffset[index]),
      target: camera.targetBase.map((value, index) => value + targetOffset[index]),
    };
  }
  const headBone = data.bones.findIndex((bone) => bone.keyBoneId === 6);
  if (headBone < 0 || data.positions.length < 3) return;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let xSum = 0, ySum = 0, zSum = 0, count = 0;
  const vertexCount = Math.floor(data.positions.length / 3);
  for (let i = 0; i < vertexCount; i++) {
    let strongestBone = -1;
    let strongestWeight = 0;
    for (let influence = 0; influence < 4; influence++) {
      const weight = data.boneWeights[i * 4 + influence] ?? 0;
      if (weight > strongestWeight) {
        strongestWeight = weight;
        strongestBone = data.boneIndices[i * 4 + influence] ?? -1;
      }
    }
    if (strongestBone !== headBone) continue;
    const x = data.positions[i * 3];
    const y = data.positions[i * 3 + 1];
    const z = data.positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    xSum += x; ySum += y; zSum += z; count++;
  }
  if (count < 3) {
    const pivot = data.bones[headBone]?.pivot;
    if (pivot) root.userData.portraitFraming = { focus: [...pivot], radius: 0.2 };
    return;
  }
  root.userData.portraitFraming = {
    // The influenced-vertex centroid is biased toward the face, unlike the whole-model AABB.
    focus: [xSum / count, ySum / count, zSum / count],
    radius: Math.max(0.06, (maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5),
  };
}

export type WorldEntityRendererOptions = {
  scene: THREE.Scene;
  worldToLocal: (x: number, y: number) => LocalPoint | null;
  canRender?: (entity: WorldEntity) => boolean;
  sampleHeight?: (x: number, y: number) => number;
  /**
   * WMO-aware ground under a point, in LOCAL render coords. `sampleHeight` reads the terrain
   * heightfield only, which is 48 yards below the deck on the Stormwind bridge, 1.25 below the
   * gate road, and similarly wrong on every WMO floor, stair and upper storey. Both the corpse
   * settle and the living-unit settle resolve through it. Optional: without it they fall back to
   * terrain, i.e. the previous behaviour.
   */
  sampleGroundZ?: (x: number, y: number, z: number) => number;
  playerGuid?: string;
  /** Player/camera position in LOCAL render coords — enables distance-based animation LOD. */
  getViewPosition?: () => { x: number; y: number } | null;
  /** Yards beyond which units stop rendering (`unitDrawDist`). */
  getUnitDrawDist?: () => number;
  forceFullRateCreatureAnimations?: () => boolean;
  getTextureAnisotropy?: () => number; updateM2Light?: (owner: THREE.Object3D, point: THREE.Vector3) => void;
};

export type WorldEntityInspection = {
  entity: WorldEntity;
  render: {
    modelLoaded: boolean;
    modelDisplayId?: number;
    loadingDisplayId?: number;
    animated: boolean;
    placeholderVisible: boolean;
    missingAsset: boolean;
    assetState?: 'not-requested' | 'loading' | 'retrying' | 'unbaked' | 'loaded';
    assetRetryAt?: number;
    displayFieldPresent?: boolean;
    serverOnlyMarker?: boolean;
    modelSource?: string;
    modelParts?: number;
    modelTextures?: number;
    modelBones?: number;
    modelAnimations?: number[];
    activeAnimationId?: number;
    activeAnimationName?: string;
    localPosition: [number, number, number];
    /** Sampled terrain height under the entity — compare to localPosition[2] to detect float. */
    groundZ?: number;      // terrain heightfield only
    groundZWmo?: number;   // WMO-aware: the surface the entity actually rests on
  };
};

export type WorldNameplateEntry = {
  guid: string;
  entity: WorldEntity;
  localPosition: { x: number; y: number; z: number };
  height: number;
};

type RenderedEntity = {
  entity: WorldEntity;
  group: THREE.Group;
  placeholder: THREE.Mesh;
  placeholderMaterial: THREE.MeshStandardMaterial;
  blobShadow: THREE.Mesh;
  typeId?: TypeID;
  modelRoot?: THREE.Group;
  modelDisplayId?: number;
  modelScale?: number;
  /** Real measured model height (group-local yards, before group.scale) for overhead-name anchoring,
   *  cached against the modelRoot it was measured from so it recomputes whenever the model swaps. */
  measuredHeight?: number;
  measuredHeightRoot?: THREE.Group;
  loadingDisplayId?: number;
  animator?: M2Animator;
  playerAnimator?: PlayerAnimator; // humanoid NPCs render through the player pipeline (state-based anim)
  playerDispose?: () => void;
  /** Character-pipeline models: move weapons between hands and sheath points. */
  setWeaponsSheathed?: (sheathState: number) => void;
  getEquipmentAttachmentRoot?: (slot: number) => THREE.Group | undefined;
  appliedSheathState?: number;
  modelSource?: string;
  /** Set once a corpse has been settled onto the ground; cleared if the unit is alive again. */
  corpseSettled?: boolean;
  /** Packet-space render target that produced the cached corpse settlement. */
  corpseSettleSource?: THREE.Vector3;
  /**
   * Cached living-unit ground settle: the packet-space position it was sampled from, the surface
   * that came back, and when. `x`/`y`/`z` are the SOURCE, never the settled result — see
   * `groundSettleFor`.
   */
  groundSettle?: { x: number; y: number; z: number; groundZ: number; sampledAt: number };
  modelParts?: number;
  modelTextures?: number;
  modelBones?: number;
  modelAnimations?: number[];
  modelAnimationDurations?: Map<number, number>;
  activeAnimationId?: number;
  playerAppearanceKey?: string;
  loadingPlayerAppearanceKey?: string;
  renderTarget?: THREE.Vector3;
  renderTargetO?: number;
  /** Last WorldEntity.teleportSeq this renderer consumed; a change forces a hard snap. */
  teleportSeq?: number;
  /** Fixed-step snapshot versions consumed by the hot renderer path. */
  snapshotTransformVersion?: number;
  snapshotAppearanceVersion?: number;
  snapshotCombatVersion?: number;
  /** UNIT_VIRTUAL_ITEM_* signature of the humanoid-NPC model currently installed. */
  npcWeaponKey?: string;
  creatureEquipment?: LoadedEquipmentAttachment[];
  creatureEquipmentDispose?: () => void;
  splinePresentation: UnitSplinePresentationState;
  // Accumulated time since the last skinning pass (distance-based animation LOD).
  animAccum?: number; animSampleInterval?: number;
  /** Whether the unit intersected the world-camera frustum on the preceding update. */
  animationInView?: boolean;
  // One-shot animation override (attack swings etc.): play this id until the deadline.
  overrideAnimId?: number;
  overrideUntil?: number;
  overrideKind?: 'melee' | 'cast' | 'reaction' | 'emoteState';
  /** Last GAMEOBJECT_STATE this renderer animated; a change plays the Open/Close transition. */
  appliedGameObjectState?: number;
  // Mount (UNIT_FIELD_MOUNTDISPLAYID): the mount mesh takes the entity's locomotion
  // anims while the rider sits on its attachment 0 (seat) with the Mount pose (91).
  mountRoot?: THREE.Group;
  mountAnimator?: M2Animator;
  mountAnimationDurations?: Map<number, number>;
  mountOverrideAnimId?: number;
  mountOverrideUntil?: number;
  mountModelDisplayId?: number;
  mountLoadingId?: number;
  mountDispose?: () => void;
  mountSeatMatrix?: THREE.Matrix4;
};

function animationDurations(
  sequences: readonly { id: number; duration: number; timeStart: number; timeEnd: number }[],
) {
  const result = new Map<number, number>();
  for (const sequence of sequences) {
    const duration = Math.max(1, sequence.duration || sequence.timeEnd - sequence.timeStart || 1);
    // The animator may choose any authored variation of an animation id. Holding the override for
    // the longest authored variation prevents the next locomotion state from truncating it.
    result.set(sequence.id, Math.max(result.get(sequence.id) ?? 0, duration));
  }
  return result;
}

type CreatureDisplayJson = M2AnimationData & {
  displayId: number;
  source?: string;
  scale: number;
  positions: number[];
  normals?: number[];
  uvs: number[];
  parts: Array<{ indices: number[]; tex: number; blendMode: number; renderFlags: number }>;
  textures: string[];
  cameras?: BakedCamera[];
};

type CreatureDisplayAsset = {
  displayId: number;
  scale: number;
  data: CreatureDisplayJson;
  parts: Array<{ indices: number[]; material: THREE.Material }>;
};

// For humanoid NPCs we skip the creature model entirely and render via the player pipeline.
type HumanoidAsset = { displayId: number; humanoidCharacter: DisplayJson['character']; bakedBodyTextureUrl: string };
type LoadedAsset = CreatureDisplayAsset | HumanoidAsset;
const isHumanoid = (a: LoadedAsset | null): a is HumanoidAsset => !!a && 'humanoidCharacter' in a;
const displayAssetBytes = (asset: LoadedAsset | CreatureDisplayAsset | null) => asset && !isHumanoid(asset)
  ? estimateDecodedBytes([asset.data, asset.parts.map((part) => part.indices)]) : 0;

// Source specification.
//   display/<id>.json  — tiny: which model, scale, skin texture refs, visible submeshes
//   models/<key>/model.json + geo.bin — geometry+bones+anims baked ONCE per unique model
type Submesh = {
  partId: number; textureType: number; type0Tex: string | null;
  blendMode: number; renderFlags: number; indexStart: number; indexCount: number;
};
type ModelMeta = {
  source: string; vertexCount: number; indexCount: number; indexType: 'u16' | 'u32';
  hasNormals: boolean; submeshes: Submesh[];
  sequences: M2AnimationData['sequences']; animLookup: number[]; bones: M2AnimationData['bones'];
  attachments?: M2AnimationData['attachments'];
  cameras?: BakedCamera[];
};
type DecodedModel = {
  meta: ModelMeta;
  positions: Float32Array; normals: Float32Array | null; uvs: Float32Array;
  boneWeights: Uint8Array; boneIndices: Uint8Array; indices: Uint16Array | Uint32Array;
};
type DisplayJson = {
  displayId: number; model: string; scale: number; alpha: number;
  skins: (string | null)[]; bakeSkin: string | null; visible: number[];
  /** Embedded from the model at bake time so portrait metadata never participates in world loading. */
  cameras?: BakedCamera[];
  // Present for humanoid NPCs: render via the player pipeline (composited skin/face/hair + armor).
  character?: Pick<CharacterInfo, 'race' | 'gender' | 'skin' | 'face' | 'hairStyle' | 'hairColor' | 'facialHair' | 'equipment'>;
};

type GameObjectDisplayJson = {
  displayId: number;
  model: string;
  source?: string;
  scale: number;
  textures: string[];
  visible?: number[];
};

export const DEFAULT_UNIT_DRAW_DIST = 300;

const SPLINEFLAG_RUN_MODE = 0x00000100;
const MOVEFLAG_MASK_XZ = 0x0000000f;
const MOVEFLAG_FORWARD = 0x00000001;
const MOVEFLAG_BACKWARD = 0x00000002;
const MOVEFLAG_STRAFE_LEFT = 0x00000004;
const MOVEFLAG_STRAFE_RIGHT = 0x00000008;
const MOVEFLAG_TURN_LEFT = 0x00000010;
const MOVEFLAG_TURN_RIGHT = 0x00000020;
const MOVEFLAG_WALK_MODE = 0x00000100;
const MOVEFLAG_FALLING = 0x00002000;
const MOVEFLAG_FALLING_FAR = 0x00004000;
const MOVEFLAG_SWIMMING = 0x00200000;
/**
 * How long a living unit's ground sample stays good without a packet to invalidate it.
 *
 * `upsert` clears the cache whenever a packet actually moves the unit, which covers every normal
 * case. This timer covers one it cannot: WMO collision that registers AFTER the unit settled, from
 * a DIFFERENT tile. Measured at the Stormwind gate — the guards live on Azeroth_31_48 and _31_49,
 * the road they stand on belongs to `stormwind.wmo`, and that instance is owned by Azeroth_30_48.
 * `reupsertTileEntities` only re-upserts the loading tile's own entities, so nothing else would
 * ever tell those guards their ground had arrived.
 */
const GROUND_SETTLE_REVALIDATE_MS = 500;
const MSG_MOVE_JUMP = 0x00bb;
const DEFAULT_RUN_SPEED = 7.0; // yd/s — vanilla baseline when the server hasn't sent speeds yet
const DEFAULT_WALK_SPEED = 2.5;
const DEFAULT_BACK_SPEED = 4.5;
const DEFAULT_JUMP_VELOCITY = 7.95797334;
const WOW_JUMP_GRAVITY = 19.29110527;
const REMOTE_JUMP_MAX_MS = 1500;
/**
 * How long position may be extrapolated past the last packet. Short on purpose: a runaway position
 * flings a remote player across the zone.
 */
const GROUND_PREDICTION_MAX_MS = 600;
/**
 * How long a STATIONARY turn may be extrapolated. Far longer than the position window, because a
 * spinning-on-the-spot player emits no packets at all to correct against: `sendHeartbeat` requires
 * 0.75 yd of displacement before it will fire, and a spin doesn't displace you, so the mover is
 * silent from START_TURN until the player lets go. Sharing the position window froze remote
 * spinners at pi x 0.6s = 108 degrees for the rest of the hold (measured). vmangos integrates a
 * stationary turn with no cap whatsoever (Unit.cpp:3193-3199); the bound here is its own 10 s
 * extrapolation sanity limit (Unit.cpp:3161). A wrong yaw is cosmetic and self-corrects on the next
 * packet — unlike a wrong position, it cannot put the player anywhere they aren't.
 */
const TURN_IN_PLACE_PREDICTION_MAX_MS = 10000;
const GROUNDED_JUMP_CLEAR_MS = 180;
const REMOTE_GROUNDED_AIRBORNE_EPSILON = 0.45;
const POSITION_SNAP_THRESHOLD = 10.0;
const POSITION_INTERPOLATION_DECAY = 12.0;
const ROTATION_TURN_RATE = 3.141594;
const ROTATION_SNAP_THRESHOLD = 1.5;
const TURN_IN_PLACE_THRESHOLD = 0.1;

function angleDelta(from: number, to: number) {
  let delta = (to - from + Math.PI) % (Math.PI * 2);
  if (delta < 0) delta += Math.PI * 2;
  return delta - Math.PI;
}

export class WorldEntityRenderer {
  private readonly scene: THREE.Scene;
  private readonly worldToLocal: (x: number, y: number) => LocalPoint | null;
  private readonly canRender: (entity: WorldEntity) => boolean;
  private readonly sampleHeight?: (x: number, y: number) => number;
  private readonly sampleGroundZ?: (x: number, y: number, z: number) => number;
  private readonly rendered = new Map<string, RenderedEntity>();
  private readonly spatial = new SpatialIndex2D<RenderedEntity>();
  private readonly spatialCandidates: RenderedEntity[] = [];
  private readonly unitGeometry = new THREE.CapsuleGeometry(0.45, 1.55, 4, 8);
  private readonly playerGeometry = new THREE.CapsuleGeometry(0.5, 1.75, 5, 10);
  private readonly gameObjectGeometry = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly assetCache = new ByteBudgetPromiseCache<number, LoadedAsset | null>(128 * 1024 * 1024, 256, displayAssetBytes);
  private readonly gameObjectAssetCache = new ByteBudgetPromiseCache<number, CreatureDisplayAsset | null>(64 * 1024 * 1024, 128, displayAssetBytes);
  private gameObjectManifestPromise?: Promise<Set<number> | null>;
  private readonly gameObjectLoadFailures = new Map<number, AssetLoadFailure>();
  private readonly creatureLoadFailures = new Map<number, AssetLoadFailure>();
  private readonly sharedM2Geometry = new SharedM2GeometryPool();
  // Deduped-format caches: geometry+anim is shared per MODEL (one fetch serves every display that
  // uses it), and textures are shared in a flat pool keyed by URL. This is what collapses the old
  // Source specification.
  private readonly modelCache = new ByteBudgetPromiseCache<string, DecodedModel | null>(256 * 1024 * 1024, 2048);
  private readonly creatureTexCache = new Map<string, THREE.Texture | null>(); private readonly creatureTexPending = new PendingPromiseCache<string, THREE.Texture | null>();
  private readonly creatureTextureRegistry = new BoundedTextureRegistry<THREE.Texture>(256, (texture) => [texture], (url) => this.evictCreatureTexture(url));
  private readonly materialCache = new Map<string, THREE.Material>();
  private readonly missingDisplayIds = new Set<number>();
  private readonly getViewPosition?: () => { x: number; y: number } | null;
  private readonly getUnitDrawDist?: () => number; private readonly forceFullRateCreatureAnimations?: () => boolean;
  private readonly getTextureAnisotropy: () => number; private readonly updateM2Light?: (owner: THREE.Object3D, point: THREE.Vector3) => void;
  private readonly raycaster = new THREE.Raycaster(); private readonly pointer = new THREE.Vector2();
  private readonly pickCandidates: THREE.Group[] = []; private readonly pickCenter = new THREE.Vector3();
  private readonly transports = new TransportRuntime((x, y) => this.worldToLocal(x, y));
  private readonly animationVisibility = new UnitAnimationVisibility();
  private animationFrame = {
    candidates: 0, sampled: 0, throttled: 0,
    outsideFrustum: 0, beyondDrawDistance: 0, moving: 0, disabled: 0,
  };
  private selectionHelper?: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private selectedGuid?: string;
  private playerGuid?: string;
  private locallyControlledGuid?: string;
  private assetGeneration = 0; private assetAbort = new AbortController();
  private appliedSnapshotRevision = -1;
  private readonly attachmentMatrix = new THREE.Matrix4(); private readonly attachmentPosition = new THREE.Vector3();
  constructor(options: WorldEntityRendererOptions) {
    this.scene = options.scene;
    this.worldToLocal = options.worldToLocal;
    this.canRender = options.canRender ?? (() => true);
    this.sampleHeight = options.sampleHeight;
    this.sampleGroundZ = options.sampleGroundZ;
    this.playerGuid = options.playerGuid;
    this.getViewPosition = options.getViewPosition;
    this.getUnitDrawDist = options.getUnitDrawDist; this.forceFullRateCreatureAnimations = options.forceFullRateCreatureAnimations;
    this.getTextureAnisotropy = options.getTextureAnisotropy ?? (() => 8); this.updateM2Light = options.updateM2Light;
  }

  setPlayerGuid(guid: string | undefined) { this.playerGuid = guid; }
  /**
   * Mark a rendered non-player unit as the local movement subject. Its group becomes the movement
   * controller's position/root while server updates still provide authoritative reconciliation.
   */
  setLocallyControlledMover(guid: string | undefined) { this.locallyControlledGuid = guid && guid !== this.playerGuid ? guid : undefined; }

  controlFrame(guid: string): { position: THREE.Vector3; root: THREE.Object3D } | null {
    const rendered = this.rendered.get(guid); return rendered ? { position: rendered.group.position, root: rendered.group } : null;
  }
  transportFrame = (guid: string) => this.transports.frame(guid);

  /**
   * Consume fixed-step numeric render state. Packet callbacks still deliver cold metadata such as
   * equipment, splines and asset identities; transform/teleport cadence comes from this buffer.
   */
  applyRenderSnapshot(
    snapshot: RenderSnapshotBuffer,
    resolveEntity: (renderId: number) => WorldEntity | undefined,
  ): void {
    if (snapshot.revision === this.appliedSnapshotRevision) return;
    this.appliedSnapshotRevision = snapshot.revision;
    const now = performance.now();
    for (let index = 0; index < snapshot.count; index++) {
      const entity = resolveEntity(snapshot.renderIds[index]);
      if (!entity || entity.guid === this.playerGuid) continue;

      let rendered = this.rendered.get(entity.guid);
      if (!rendered) {
        this.upsert(entity);
        rendered = this.rendered.get(entity.guid);
        if (!rendered) continue;
      }

      const appearanceVersion = snapshot.appearanceVersions[index];
      if (rendered.snapshotAppearanceVersion !== appearanceVersion) {
        rendered.snapshotAppearanceVersion = appearanceVersion;
        this.upsert(entity);
        rendered = this.rendered.get(entity.guid);
        if (!rendered) continue;
      }
      rendered.snapshotCombatVersion = snapshot.combatVersions[index];

      const transformVersion = snapshot.transformVersions[index];
      const teleportSeq = snapshot.teleportSequences[index];
      if (rendered.snapshotTransformVersion === transformVersion && rendered.teleportSeq === teleportSeq) continue;
      rendered.snapshotTransformVersion = transformVersion;
      // Once a completed spline receives a newer authoritative transform, presentation ownership
      // can yield without making the old spline runnable again.
      if (retiredUnitSpline(rendered.splinePresentation, entity.spline)) {
        rendered.splinePresentation.ownedSpline = undefined;
        rendered.splinePresentation.world = undefined;
      }

      // Transport path clocks are a presentation-space overlay over the canonical base transform.
      if (entity.gameObjectType === 11 || entity.gameObjectType === 15) {
        rendered.teleportSeq = teleportSeq;
        continue;
      }

      const p = index * 3;
      const local = this.worldToLocal(snapshot.positions[p], snapshot.positions[p + 1]);
      if (!local) continue;
      const z = snapshot.positions[p + 2];
      const scaleValue = snapshot.scales[index];
      const scale = Math.max(0.05, Math.min(5, Number.isFinite(scaleValue) && scaleValue > 0
        ? scaleValue : entity.scale ?? rendered.modelScale ?? 1));
      const height = this.heightFor(entity) * scale;
      const hasModel = !!rendered.modelRoot && (entity.typeId === TypeID.PLAYER || rendered.modelDisplayId === snapshot.displayIds[index]);
      const targetZ = hasModel ? z : z + height * 0.5;
      const orientation = snapshot.orientations[index];
      const teleported = rendered.teleportSeq !== teleportSeq;
      rendered.teleportSeq = teleportSeq;

      const current = rendered.group.position;
      const finiteCurrent = Number.isFinite(current.x) && Number.isFinite(current.y) && Number.isFinite(current.z);
      const isDeadUnit = entity.typeId === TypeID.UNIT && snapshot.health[index] === 0 && snapshot.maxHealth[index] > 0;
      const splineDriven = unitSplineClock(entity.spline, now).moving
        || ownsUnitSpline(rendered.splinePresentation, entity.spline);
      const interpolate = entity.typeId === TypeID.PLAYER || (!splineDriven && !isDeadUnit && entity.typeId !== TypeID.GAMEOBJECT);
      const previousTarget = rendered.renderTarget;

      if (interpolate) {
        const target = previousTarget ?? new THREE.Vector3();
        target.set(local.x, local.y, targetZ);
        rendered.renderTarget = target;
        rendered.renderTargetO = orientation;
        if (teleported || !previousTarget || !finiteCurrent || current.distanceTo(target) > POSITION_SNAP_THRESHOLD) {
          if (!rendered.corpseSettled) current.copy(target);
          rendered.group.rotation.z = orientation;
        }
      } else {
        rendered.renderTarget = undefined;
        rendered.renderTargetO = undefined;
        if (!rendered.corpseSettled && (teleported || entity.typeId === TypeID.GAMEOBJECT || !finiteCurrent)) {
          current.set(local.x, local.y, targetZ);
          rendered.group.rotation.z = orientation;
        }
      }
    }
  }

  upsert(entity: WorldEntity) {
    if (entity.guid === this.playerGuid || entity.x === undefined || entity.y === undefined) return;
    const positionedEntity = this.transports.positioned(entity, performance.now());
    if (!this.canRender(positionedEntity)) {
      this.remove(entity.guid);
      return;
    }

    // Corpses have no baked body yet; DynamicObjects are spell-visual lifecycle anchors. Neither
    // should fall through to the generic debug placeholder.
    if (entity.typeId === TypeID.CORPSE || entity.typeId === TypeID.DYNAMICOBJECT) {
      this.remove(entity.guid);
      return;
    }

    const local = this.worldToLocal(positionedEntity.x!, positionedEntity.y!);
    if (!local) return;
    if (!this.rendered.has(entity.guid) && entity.guid !== this.locallyControlledGuid && entityBeyondDrawDistance(
      local, this.getViewPosition?.() ?? null, this.getUnitDrawDist?.() ?? DEFAULT_UNIT_DRAW_DIST,
    )) return;

    const rendered = this.getOrCreate(entity);
    rendered.entity = entity;
    const z = positionedEntity.z ?? this.sampleHeight?.(local.x, local.y) ?? 0;
    // Server scale already includes model × display scale; the baked value is fallback-only.
    const scale = Math.max(0.05, Math.min(5, entity.scale ?? rendered.modelScale ?? 1));
    const height = this.heightFor(entity) * scale;
    const hasModel = !!rendered.modelRoot && (entity.typeId === TypeID.PLAYER || rendered.modelDisplayId === entity.displayId);

    const target = new THREE.Vector3(local.x, local.y, hasModel ? z : z + height * 0.5);
    const isDeadUnit = entity.typeId === TypeID.UNIT && (entity.health ?? 1) <= 0 && !!entity.maxHealth;
    if (rendered.corpseSettled && (!isDeadUnit || corpseSettlementSourceMoved(rendered.corpseSettleSource, target))) {
      rendered.corpseSettled = false;
      rendered.corpseSettleSource = undefined;
    }
    if (entity.typeId === TypeID.PLAYER) {
      const previousTarget = rendered.renderTarget;
      rendered.renderTarget = target;
      rendered.renderTargetO = positionedEntity.o ?? rendered.group.rotation.z;
      // A non-finite prior frame or teleport must snap back to authoritative state.
      const cur = rendered.group.position;
      const finite = Number.isFinite(cur.x) && Number.isFinite(cur.y) && Number.isFinite(cur.z);
      const teleported = rendered.teleportSeq !== entity.teleportSeq;
      rendered.teleportSeq = entity.teleportSeq;
      if (teleported || !previousTarget || !finite || cur.distanceTo(target) > POSITION_SNAP_THRESHOLD) {
        rendered.group.position.copy(target);
        rendered.group.rotation.z = rendered.renderTargetO;
      }
    } else {
      // Sparse UNIT packets interpolate unless a spline or corpse owns the exact position.
      const previousTarget = rendered.renderTarget;
      const presentationOwned = ownsUnitSpline(rendered.splinePresentation, rendered.entity.spline);
      const splineDriven = unitSplineClock(rendered.entity.spline, performance.now()).moving || presentationOwned;
      const interpolated = !splineDriven && !isDeadUnit;
      rendered.renderTarget = interpolated ? target : undefined;
      rendered.renderTargetO = interpolated ? positionedEntity.o ?? rendered.group.rotation.z : undefined;
      const cur = rendered.group.position;
      const finite = Number.isFinite(cur.x) && Number.isFinite(cur.y) && Number.isFinite(cur.z);
      // GAMEOBJECTs snap because no UNIT ground-settle pass owns their Z.
      const snap = presentationOwned
        ? !finite
        : !interpolated || !previousTarget || !finite || entity.typeId === TypeID.GAMEOBJECT
          || cur.distanceTo(target) > POSITION_SNAP_THRESHOLD;
      if (!rendered.corpseSettled && snap) rendered.group.position.copy(target);
      if (corpseSettlementSourceMoved(rendered.groundSettle, target)) rendered.groundSettle = undefined;
      // Yaw follows position: snap on a discontinuity, else let the per-frame turn below ease in.
      if (snap) rendered.group.rotation.z = positionedEntity.o ?? 0;
    }
    rendered.group.scale.setScalar(scale);
    this.spatial.update(entity.guid, rendered, rendered.group.position.x, rendered.group.position.y);
    if (entity.typeId === TypeID.PLAYER) {
      // A display differing from native is an authoritative creature-form transform.
      const transformed = !!(
        entity.displayId
        && entity.nativeDisplayId
        && entity.displayId !== entity.nativeDisplayId
      );
      if (transformed) {
        // Prevent an in-flight humanoid composition from winning the async race.
        rendered.loadingPlayerAppearanceKey = undefined;
        this.ensureCreatureModel(entity, rendered);
      } else {
        rendered.loadingDisplayId = undefined;
        this.ensurePlayerModel(entity, rendered);
      }
    }
    if (entity.displayId && entity.typeId === TypeID.UNIT) this.ensureCreatureModel(entity, rendered);
    if (entity.typeId === TypeID.GAMEOBJECT) {
      if (isServerOnlyMarker(entity)) {
        rendered.placeholder.visible = false;
        rendered.blobShadow.visible = false;
      } else if (entity.displayId) {
        this.ensureGameObjectModel(entity, rendered);
      }
    }
    if (entity.typeId === TypeID.PLAYER || entity.typeId === TypeID.UNIT) this.ensureMountModel(entity, rendered);
    // UNIT_FIELD_BYTES_2 selects the authoritative drawn weapon set; zero is only the pre-arrival default.
    if (rendered.setWeaponsSheathed) {
      const sheathState = entity.sheathState ?? 0;
      if (rendered.appliedSheathState !== sheathState) {
        rendered.appliedSheathState = sheathState;
        // Pass the three-state value, not a boolean; ranged and melee are distinct sets.
        rendered.setWeaponsSheathed(sheathState);
      }
    }
    this.updateAppearance(entity, rendered);
  }

  /** Packet-hot path: snapshots own numeric transforms; this only maintains render ownership. */
  updateTransformHot(entity: WorldEntity): boolean {
    if (entity.guid === this.playerGuid || entity.x === undefined || entity.y === undefined) return false;
    if (!this.canRender(this.transports.positioned(entity, performance.now()))) { this.remove(entity.guid); return false; }
    const rendered = this.rendered.get(entity.guid);
    if (!rendered || rendered.typeId !== entity.typeId) { this.upsert(entity); return false; }
    rendered.entity = entity;
    return true;
  }

  updateCombatHot(entity: WorldEntity) {
    const rendered = this.rendered.get(entity.guid);
    if (!rendered) return;
    rendered.entity = entity; this.updateAppearance(entity, rendered);
  }

  updateAppearanceCold(entity: WorldEntity) { this.upsert(entity); }
  updateEquipmentCold(entity: WorldEntity) { this.upsert(entity); }

  applyEntityChange(change: WorldEntityChange) {
    if (change.kind === 'none') return;
    if (change.kind === 'remove') { this.remove(change.guid); return; }
    if (change.kind === 'create') { this.upsert(change.entity); return; }
    const domains = classifyEntityRenderChange(change);
    if (!this.updateTransformHot(change.entity)) return;
    if (domains.equipment) this.updateEquipmentCold(change.entity);
    else if (domains.appearance) this.updateAppearanceCold(change.entity);
    else if (domains.combat) this.updateCombatHot(change.entity);
  }

  /**
   * Ground under a living NPC, cached.
   *
   * The WMO-aware probe must start from authoritative packet/spline Z; probing from our settled Z
   * cannot rediscover a deck above it. Because the probe raycasts collision candidates, moving units
   * reuse the current support for one yard/500 ms instead of re-running cold upsert work each frame.
   */
  private groundSettleFor(rendered: RenderedEntity, now: number, moving = false) {
    const cached = rendered.groundSettle;
    const p = rendered.group.position;
    const dx = cached ? p.x - cached.x : 0, dy = cached ? p.y - cached.y : 0;
    if (cached && now - cached.sampledAt < GROUND_SETTLE_REVALIDATE_MS && (!moving || dx * dx + dy * dy <= 1)) return cached;
    // During a spline, presentation owns an immutable server-sampled transform. Canonical entity.z
    // intentionally remains at its last packet value, so using it here applies a stale vertical
    // offset and makes walkers float/sink until the cache revalidates.
    const presentationOwned = ownsUnitSpline(rendered.splinePresentation, rendered.entity.spline);
    const sourceZ = unitGroundProbeZ(presentationOwned, rendered.splinePresentation.world?.z, rendered.entity?.z);
    const source = groundProbeSource(moving ? undefined : cached, p, sourceZ);
    const groundZ = this.sampleGroundZ
      ? this.sampleGroundZ(source.x, source.y, source.z)
      : this.sampleHeight?.(source.x, source.y);
    if (groundZ === undefined || !Number.isFinite(groundZ)) return null;
    const settle = { x: source.x, y: source.y, z: source.z, groundZ, sampledAt: now };
    rendered.groundSettle = settle;
    return settle;
  }

  update(dt: number, camera?: THREE.Camera) {
    // Distance-based animation LOD ("same trick the client uses"): far-away units sample bone
    // tracks and upload their bone texture at a reduced rate. Passing the
    // accumulated dt keeps animation time correct — far units just update in coarser steps.
    const view = this.getViewPosition?.() ?? null;
    const now = performance.now();
    const hasAnimationFrustum = this.animationVisibility.prepare(camera);
    const animationFrame = this.animationFrame;
    animationFrame.candidates = 0;
    animationFrame.sampled = 0;
    animationFrame.throttled = 0;
    animationFrame.outsideFrustum = 0;
    animationFrame.beyondDrawDistance = 0;
    animationFrame.moving = 0; animationFrame.disabled = 0;
    for (const rendered of this.rendered.values()) {
      this.transports.advance(rendered.entity, rendered.group, now);
      const isDead = (rendered.entity.health ?? 1) <= 0 && !!rendered.entity.maxHealth;
      // A dead unit must NOT keep gliding along its monster-move spline: `dead` only wins for the
      // animation, so without this the corpse moonwalks along a path whose straight-line z floats
      // above terrain (advanceSpline interpolates z between sparse waypoints) and freezes mid-air.
      // Freeze it and settle the body onto sampled ground so it lies where it fell.
      // Player movement in vanilla is driven by MSG_MOVE_* flags, not monster-move splines. Some
      // player update blocks can carry (or retain) spline data, but treating that as authoritative
      // suppresses the flag-driven walk/run state while dead-reckoning still moves the render target:
      // remote players slide or hold a broken stand/turn pose. Only NPCs/creatures should advance
      // through the spline path here.
      const allowSplineMovement = rendered.entity.typeId !== TypeID.PLAYER
        && rendered.entity.guid !== this.locallyControlledGuid;
      const splineMoving = !isDead && allowSplineMovement ? this.advanceSpline(rendered) : false;
      const hasAnimator = !!(rendered.animator || rendered.playerAnimator || rendered.mountAnimator);
      if (hasAnimator) animationFrame.candidates++;
      rendered.animAccum = (rendered.animAccum ?? 0) + dt;
      let distanceSquared = 0;
      if (view) {
        distanceSquared = entityDistanceSquared(rendered.group.position, view);
        const drawLimit = this.getUnitDrawDist?.() ?? DEFAULT_UNIT_DRAW_DIST;
        const beyondDrawDist = distanceSquared > drawLimit * drawLimit;
        if (rendered.group.visible === beyondDrawDist) rendered.group.visible = !beyondDrawDist;
        if (beyondDrawDist) {
          rendered.animationInView = false;
          if (hasAnimator) animationFrame.beyondDrawDistance++;
          this.spatial.update(rendered.entity.guid, rendered, rendered.group.position.x, rendered.group.position.y);
          continue;
        }
      }
      const gameObjectDisplayId = rendered.entity.typeId === TypeID.GAMEOBJECT ? rendered.entity.displayId : undefined;
      const gameObjectFailure = gameObjectDisplayId ? this.gameObjectLoadFailures.get(gameObjectDisplayId) : undefined;
      if (gameObjectDisplayId && gameObjectFailure?.kind === 'transient' && now >= gameObjectFailure.retryAt
        && !rendered.modelRoot && rendered.loadingDisplayId === undefined) this.ensureGameObjectModel(rendered.entity, rendered);
      const creatureDisplayId = rendered.entity.typeId !== TypeID.GAMEOBJECT ? rendered.entity.displayId : undefined;
      const creatureFailure = creatureDisplayId ? this.creatureLoadFailures.get(creatureDisplayId) : undefined;
      if (creatureDisplayId && creatureFailure?.kind === 'transient' && now >= creatureFailure.retryAt
        && !rendered.modelRoot && rendered.loadingDisplayId === undefined) this.ensureCreatureModel(rendered.entity, rendered);
      // Settle a corpse onto the ground it actually fell on. This used to read the terrain-only
      // sampler with no clamp — the one writer in this class that can move a unit an unbounded
      // distance — so a guard dying on the City_01 bridge dropped to the terrain 48 yards below
      // it, through the deck. `sampleGroundZ` is WMO-aware and returns the deck. There is still no
      // clamp, deliberately: spline interpolation between sparse waypoints can leave a body well
      // above the surface, and settling it is the whole point of this branch.
      //
      // Settle ONCE rather than per frame. A corpse does not move, and sampleGroundZ casts a ring of
      // rays where sampleHeight was a heightfield lookup.
      if (isDead && rendered.entity.typeId === TypeID.UNIT) {
        if (!rendered.corpseSettled) {
          const p = rendered.group.position;
          const ground = this.sampleGroundZ
            ? this.sampleGroundZ(p.x, p.y, p.z)
            : this.sampleHeight?.(p.x, p.y);
          if (ground !== undefined && Number.isFinite(ground)) {
            rendered.corpseSettleSource = p.clone();
            rendered.group.position.z = ground;
            rendered.corpseSettled = true;
          }
        }
      } else if (rendered.corpseSettled) {
        rendered.corpseSettled = false;
        rendered.corpseSettleSource = undefined;
      }
      const rawFlags = rendered.entity.flags ?? 0;
      const flags = rendered.entity.typeId === TypeID.UNIT && retiredUnitSpline(rendered.splinePresentation, rendered.entity.spline)
        ? rawFlags & ~MOVEFLAG_MASK_XZ
        : rawFlags;
      const packetAgeMs = this.predictionAgeMs(rendered, now, GROUND_PREDICTION_MAX_MS);
      const jumpAgeMs = (rendered.entity.fallTime ?? 0) + this.predictionAgeMs(rendered, now, REMOTE_JUMP_MAX_MS);
      let airborne = (flags & (MOVEFLAG_FALLING | MOVEFLAG_FALLING_FAR)) !== 0 && jumpAgeMs <= REMOTE_JUMP_MAX_MS;
      if (airborne && rendered.entity.typeId === TypeID.PLAYER && this.sampleHeight) {
        const p = rendered.renderTarget ?? rendered.group.position;
        const ground = this.sampleHeight(p.x, p.y);
        const explicitJump = rendered.entity.movementOpcode === MSG_MOVE_JUMP;
        // Other browser clients can briefly (or incorrectly) keep MOVEFLAG_JUMPING while their
        // feet are still on the ground, especially across terrain/WMO ground disagreement. If we
        // trust that flag blindly, observers see the player "running" in the jump pose: arms out,
        // feet floating, no real run cycle. Keep true jump packets, but ground-close follow-up
        // movement/heartbeat packets should resolve to walk/run like the vanilla client view.
        if (!explicitJump && Number.isFinite(ground) && Math.abs(p.z - ground) <= REMOTE_GROUNDED_AIRBORNE_EPSILON) {
          airborne = false;
        }
      }

      // Settle standing NPCs onto the surface they are actually on. The dead-unit branch above
      // already did this for corpses; living units kept the server's spawn z and hovered by a
      // fraction of a yard wherever the two heightfields disagreed. Skipped while airborne or
      // swimming (their z is meaningful then), and skipped past the bounded living-unit limit.
      if (
        !isDead &&
        !airborne &&
        rendered.entity.typeId === TypeID.UNIT &&
        (flags & MOVEFLAG_SWIMMING) === 0
      ) {
        const settle = this.groundSettleFor(rendered, now, splineMoving);
        // Measure the gap from the SOURCE z, not the rendered one: once we have moved the unit,
        // the rendered z is our own answer and comparing against it always reads zero.
        if (settle && shouldApplyLivingUnitGroundSettle(settle.z, settle.groundZ)) {
          rendered.group.position.z = splineMoving
            ? rendered.group.position.z + settle.groundZ - settle.z
            : settle.groundZ;
        }
      }
      if (rendered.renderTarget) {
        // Vanilla MSG_MOVE is fire-and-forget: a START_* packet carries position+flags once, then
        // the mover only re-reports on STOP/heartbeat. Dead-reckon the target forward between
        // packets so remote players glide (and keep moving through a jump) instead of running in
        // place then snapping. The lerp below smooths the rendered group toward that target.
        //
        // Units reach here too now, but only for the smoothing — dead reckoning stays player-only.
        // Extrapolating a creature forward from a stale flag would walk mobs through walls between
        // packets; the lerp can only move toward a position the server has already published.
        if (rendered.entity.typeId === TypeID.PLAYER) airborne = this.deadReckonPlayer(rendered, flags, airborne, dt, now);
        const distance = rendered.group.position.distanceTo(rendered.renderTarget);
        if (distance > POSITION_SNAP_THRESHOLD) {
          rendered.group.position.copy(rendered.renderTarget);
        } else {
          const alpha = 1 - Math.exp(-POSITION_INTERPOLATION_DECAY * dt);
          // A UNIT's z belongs to the ground settle above, NOT to the packet: lerping all three
          // dragged it back toward the server's z every frame and undid that settle.
          if (rendered.entity.typeId === TypeID.PLAYER) rendered.group.position.lerp(rendered.renderTarget, alpha);
          else {
            rendered.group.position.x += (rendered.renderTarget.x - rendered.group.position.x) * alpha;
            rendered.group.position.y += (rendered.renderTarget.y - rendered.group.position.y) * alpha;
          }
        }
        if (rendered.renderTargetO !== undefined) {
          const delta = angleDelta(rendered.group.rotation.z, rendered.renderTargetO);
          if (Math.abs(delta) > ROTATION_SNAP_THRESHOLD) {
            rendered.group.rotation.z = rendered.renderTargetO;
          } else {
            rendered.group.rotation.z += Math.sign(delta) * Math.min(Math.abs(delta), ROTATION_TURN_RATE * dt);
          }
        }
      }
      // Only active spline motion suppresses flag locomotion and the convergence hold.
      const hasSpline = allowSplineMovement && splineMoving;
      const flagMoving = !airborne && !hasSpline && (flags & MOVEFLAG_MASK_XZ) !== 0;
      // A short tap is over before the interpolation is. The STOP packet clears the movement flags
      // while the rendered body is still most of a step behind renderTarget, so the model used to
      // finish the step in the Stand pose — measured on an 80 ms W tap: 0.42 yd of the 0.56 yd
      // travelled, three quarters of the visible motion, played with the feet planted. That is the
      // "sliding without moving their feet" report. Locomotion has to follow the body, not the
      // flags, so keep it running until the body has actually arrived.
      // Horizontal only, and gated by `isConvergingToTarget` so the rule is testable — see that
      // function for why a 3-D test made every standing NPC and horse walk on the spot.
      const converging = !airborne && !hasSpline
        && isConvergingToTarget(rendered.group.position, rendered.renderTarget);
      this.updateM2Light?.(rendered.group, rendered.group.position);
      const moving = !airborne && (splineMoving || flagMoving || converging);
      const facingDelta = rendered.renderTargetO !== undefined ? angleDelta(rendered.group.rotation.z, rendered.renderTargetO) : 0;
      const flagTurnLeft = (flags & MOVEFLAG_TURN_LEFT) !== 0 && (flags & MOVEFLAG_TURN_RIGHT) === 0;
      const flagTurnRight = (flags & MOVEFLAG_TURN_RIGHT) !== 0 && (flags & MOVEFLAG_TURN_LEFT) === 0;
      const facingTurnLeft = facingDelta > TURN_IN_PLACE_THRESHOLD;
      const facingTurnRight = facingDelta < -TURN_IN_PLACE_THRESHOLD;
      // `!moving` rather than `!flagMoving`: a body still catching up must not drop into the
      // turn-in-place shuffle, which sits above locomotion in the animation chain below.
      const turningLeft = !airborne && !hasSpline && !moving && (flagTurnLeft || facingTurnLeft);
      const turningRight = !airborne && !hasSpline && !moving && (flagTurnRight || facingTurnRight);
      if ((moving || airborne) && rendered.overrideKind === 'emoteState') {
        rendered.overrideAnimId = undefined;
        rendered.overrideUntil = undefined;
        rendered.overrideKind = undefined;
      }
      const backpedaling = flagMoving && !splineMoving && (flags & MOVEFLAG_BACKWARD) !== 0 && (flags & MOVEFLAG_FORWARD) === 0;
      const strafingLeft = flagMoving && !splineMoving && (flags & MOVEFLAG_STRAFE_LEFT) !== 0 && (flags & MOVEFLAG_STRAFE_RIGHT) === 0, strafingRight = flagMoving && !splineMoving && (flags & MOVEFLAG_STRAFE_RIGHT) !== 0 && (flags & MOVEFLAG_STRAFE_LEFT) === 0;
      const running = splineMoving
        ? ((rendered.entity.spline?.flags ?? 0) & SPLINEFLAG_RUN_MODE) !== 0
        : (flags & MOVEFLAG_WALK_MODE) === 0;
      // Combat facing: a stationary creature in melee must keep facing its target. Vanilla
      // continuously turns the unit toward UNIT_FIELD_TARGET, but the server only re-sends a
      // creature's orientation sparsely (fire-and-forget), so the client's last `o` goes stale —
      // the mob ends up swinging at empty air a couple metres off. While it's not moving, steer it
      // toward the live target position (the player via charPos, or another rendered unit).
      if (!isDead && !moving && rendered.entity.typeId === TypeID.UNIT && rendered.entity.targetGuid) {
        const tg = rendered.entity.targetGuid;
        let tx: number | undefined;
        let ty: number | undefined;
        if (tg === this.playerGuid && view) { tx = view.x; ty = view.y; }
        else {
          const targetRendered = this.rendered.get(tg);
          if (targetRendered) { tx = targetRendered.group.position.x; ty = targetRendered.group.position.y; }
        }
        if (tx !== undefined && ty !== undefined) {
          const desired = Math.atan2(ty - rendered.group.position.y, tx - rendered.group.position.x);
          const delta = angleDelta(rendered.group.rotation.z, desired);
          if (Math.abs(delta) > ROTATION_SNAP_THRESHOLD) rendered.group.rotation.z = desired;
          else rendered.group.rotation.z += Math.sign(delta) * Math.min(Math.abs(delta), ROTATION_TURN_RATE * dt);
        }
      }
      // Death (anim 1) wins over everything; a pending one-shot (attack swing) wins over
      // locomotion; otherwise stand/walk/run by spline or live movement flags.
      const dead = isDead;
      if (rendered.overrideUntil !== undefined && now >= rendered.overrideUntil) {
        rendered.overrideAnimId = undefined;
        rendered.overrideUntil = undefined;
      }
      // GameObjects are not units and have no locomotion — a chest is never "moving", so the unit
      // chain below always handed them animation 0. Models that ship no Stand then fell through
      // m2-animator's last-resort `: 0` to sequence *index* 0, which for 29 baked models is a
      // transition (Chest03 `Open` 666ms, GnomereganDoor01 `Open` 3000ms), and it looped forever.
      // Vanilla drives these from GAMEOBJECT_STATE: play the transition once on change, then rest.
      let goPose: GameObjectPose | undefined;
      if (rendered.entity.typeId === TypeID.GAMEOBJECT) {
        const available = rendered.modelAnimations ?? [];
        const state = rendered.entity.gameObjectState;
        goPose = gameObjectRestingPose(state, available);
        if (goPose !== undefined) {
          const transition = gameObjectTransitionAnim(rendered.appliedGameObjectState, state, available);
          const transitionMs = transition !== undefined
            ? rendered.modelAnimationDurations?.get(transition)
            : undefined;
          if (transition !== undefined && transitionMs) {
            rendered.overrideAnimId = transition;
            rendered.overrideUntil = now + transitionMs;
            rendered.overrideKind = 'reaction';
          }
          rendered.appliedGameObjectState = state;
        }
      }
      // A transition used as a resting pose must freeze on its final frame, not wrap. `settle`
      // latches the end of the cycle in flight, which is exactly that.
      const goSettle = goPose?.hold === true && rendered.overrideAnimId === undefined;
      const { locomotionAnimationId, animationId, layeredUpperBody } = unitAnimationPlan({ dead,
        overrideAnimationId: rendered.overrideAnimId, overrideKind: rendered.overrideKind,
        gameObjectAnimationId: goPose?.animId, airborne, turningLeft, turningRight, backpedaling, moving, running });
      const stateChanged = rendered.activeAnimationId !== animationId;
      rendered.activeAnimationId = animationId;
      let interval = 0; // seconds between skinning passes (0 = every frame)
      if (view) {
        let animationInView = true;
        if (hasAnimationFrustum) {
          const scale = Math.max(0.05, Math.abs(rendered.group.scale.z));
          const height = this.heightFor(rendered.entity) * scale;
          const horizontalRadius = Math.max(
            (rendered.entity.boundingRadius ?? 0) * scale,
            (rendered.entity.combatReach ?? 0) * scale,
            height * 0.5,
          );
          animationInView = this.animationVisibility.intersects(
            rendered.group.position,
            height,
            horizontalRadius,
          );
        }
        const reenteredView = rendered.animationInView === false && animationInView;
        rendered.animationInView = animationInView;
        if (!animationInView) {
          interval = Number.POSITIVE_INFINITY;
          if (hasAnimator) animationFrame.outsideFrustum++;
        } else {
          // Root movement stays per-frame; throttle only skeleton sampling and its palette upload.
          interval = unitAnimationSampleInterval(distanceSquared, stateChanged || reenteredView, moving, !!this.forceFullRateCreatureAnimations?.() && rendered.entity.typeId === TypeID.UNIT);
        }
      }
      rendered.animAccum = staggerUnitAnimationAccum(rendered.animAccum, rendered.entity.guid, interval, rendered.animSampleInterval);
      rendered.animSampleInterval = interval;
      if (hasAnimator && moving) animationFrame.moving++;
      if (!performanceAblations.entityAnimationOff && rendered.animAccum >= interval) {
        const animationStarted = performanceAblations.detail && hasAnimator ? performance.now() : -1;
        if (hasAnimator) animationFrame.sampled++;
        const step = rendered.animAccum;
        rendered.animAccum = 0;
        const mounted = !!(rendered.mountRoot && rendered.mountAnimator);
        if (mounted) {
          // The mount carries the locomotion (stand 0 / walk 4 / run 5); one-shot
          // overrides and death still play on the RIDER, which otherwise holds the
          // Mount pose (91) glued to the mount's seat attachment (id 0).
          if (rendered.mountOverrideUntil !== undefined && now >= rendered.mountOverrideUntil) {
            rendered.mountOverrideAnimId = undefined;
            rendered.mountOverrideUntil = undefined;
          }
          const mountAnimId = dead ? 1
            : rendered.mountOverrideAnimId !== undefined ? rendered.mountOverrideAnimId
            : moving ? (running ? 5 : 4) : 0;
          rendered.mountAnimator!.update(step, mountAnimId, camera, rendered.mountRoot!);
          const riderAnimId = dead ? 1
            : rendered.overrideAnimId !== undefined ? rendered.overrideAnimId
            : 91;
          if (rendered.playerAnimator?.updateAnimationId) {
            rendered.playerAnimator.updateAnimationId(step, riderAnimId, camera, rendered.modelRoot);
          } else {
            rendered.animator?.update(step, riderAnimId, camera, rendered.modelRoot);
          }
          const seat = rendered.mountSeatMatrix;
          if (seat && rendered.modelRoot && rendered.mountAnimator!.getAttachmentMatrix?.(0, seat)) {
            rendered.modelRoot.matrixAutoUpdate = false;
            rendered.modelRoot.matrix.copy(seat);
          }
        } else {
          rendered.animator?.update(step, layeredUpperBody ? locomotionAnimationId : animationId, camera, rendered.modelRoot, goSettle, layeredUpperBody ? animationId : undefined);
          if (rendered.playerAnimator) {
            const state: PlayerAnimState = airborne ? 'jump'
              : turningLeft ? 'turnLeft'
              : turningRight ? 'turnRight'
              : strafingLeft ? 'strafeLeft' : strafingRight ? 'strafeRight'
              : backpedaling ? 'walkBack'
              : moving ? (running ? 'run' : 'walk') : 'stand';
            const sitAnim = state === 'stand' ? STAND_STATE_ANIM[rendered.entity.standState ?? 0] : undefined;
            if (dead && rendered.playerAnimator.updateAnimationId) rendered.playerAnimator.updateAnimationId(step, 1, camera, rendered.modelRoot);
            else if (layeredUpperBody && rendered.playerAnimator.updateUpperBody)
              rendered.playerAnimator.updateUpperBody(step, state, animationId, camera, rendered.modelRoot);
            else if (rendered.overrideAnimId !== undefined && rendered.playerAnimator.updateAnimationId) {
              rendered.playerAnimator.updateAnimationId(step, animationId, camera, rendered.modelRoot);
            } else if (sitAnim !== undefined && rendered.playerAnimator.updateAnimationId) {
              // Seated/sleeping/kneeling from the server stand state (eating, /sit) — render the pose
              // instead of Stand while the unit is idle.
              rendered.playerAnimator.updateAnimationId(step, resolveAnimId(sitAnim, rendered.modelAnimations || []), camera, rendered.modelRoot);
            } else {
              // Combat-ready idle follows the prepared weapon, but NPCs additionally require the
              // authoritative UNIT_FLAG_IN_COMBAT bit. vMaNGOS defaults idle creatures to
              // SHEATH_STATE_MELEE, so using SheathState alone pins the whole population in Ready1H.
              const ready = state === 'stand' && rendered.playerAnimator.updateAnimationId
                ? readyStanceAnimFor(rendered.entity)
                : undefined;
              if (ready !== undefined) {
                rendered.playerAnimator.updateAnimationId!(step, resolveAnimId(ready, rendered.modelAnimations || []), camera, rendered.modelRoot);
              } else {
                rendered.playerAnimator.update(step, state, camera, rendered.modelRoot);
              }
            }
          }
        }
        this.updateCreatureEquipmentTransforms(rendered);
        if (animationStarted >= 0) recordEntityAnimationSample(performance.now() - animationStarted);
      } else if (hasAnimator && performanceAblations.entityAnimationOff) {
        animationFrame.disabled++;
      } else if (hasAnimator && rendered.animationInView !== false) {
        animationFrame.throttled++;
      }
      // Re-seat the blob shadow on the terrain last, once this frame's group position is final —
      // otherwise a jumping/falling unit drags its shadow up into the air with it. A server-only
      // marker is skipped rather than hidden here: updateBlobShadow reassigns `visible` on every
      // path it takes, so hiding the mesh once in ensureGameObjectModel would not survive a frame.
      if (!isServerOnlyMarker(rendered.entity)) {
        const shadowX = rendered.group.position.x;
        const shadowY = rendered.group.position.y;
        updateBlobShadowLod(
          rendered.blobShadow, shadowX, shadowY, rendered.group.position.z,
          distanceSquared, rendered.animationInView !== false, this.sampleHeight, now,
        );
      }
      this.spatial.update(rendered.entity.guid, rendered, rendered.group.position.x, rendered.group.position.y);
    }
  }

  pick(camera: THREE.Camera, x: number, y: number, select = true, isBlocked?: (point: THREE.Vector3) => boolean): WorldEntityInspection | null {
    const cpuScope = beginCpuScope(CpuScopeId.HoverPicking); try { const started = performanceAblations.detail ? performance.now() : 0; this.pointer.set(x, y); this.raycaster.setFromCamera(this.pointer, camera);
    const groups = this.pickCandidates; groups.length = 0;
    const candidates = this.spatial.queryRay(
      this.raycaster.ray.origin.x, this.raycaster.ray.origin.y,
      this.raycaster.ray.direction.x, this.raycaster.ray.direction.y,
      this.getUnitDrawDist?.() ?? DEFAULT_UNIT_DRAW_DIST,
      this.spatialCandidates,
    );
    for (const rendered of candidates) {
      if (isServerOnlyMarker(rendered.entity) || !rendered.group.visible) continue;
      if (!select && rendered.entity.typeId !== TypeID.GAMEOBJECT) {
        const scale = Math.max(0.05, Math.abs(rendered.group.scale.z)); const height = this.heightFor(rendered.entity) * scale;
        const horizontal = Math.max((rendered.entity.boundingRadius ?? 0) * scale, (rendered.entity.combatReach ?? 0) * scale, height * 0.75, 0.75);
        this.pickCenter.copy(rendered.group.position); this.pickCenter.z += height * 0.5; const radius = Math.hypot(horizontal, height * 0.5) + 0.5;
        if (this.raycaster.ray.distanceSqToPoint(this.pickCenter) > radius * radius) continue;
      }
      groups.push(rendered.group);
    }
    const hit = this.raycaster.intersectObjects(groups, true)[0]; let object: THREE.Object3D | null = hit && !isBlocked?.(hit.point) ? hit.object : null;
    while (object && !object.userData.worldEntityGuid) object = object.parent; const guid = object?.userData.worldEntityGuid as string | undefined;
    if (performanceAblations.detail) recordPick({ elapsedMs: performance.now() - started, candidates: groups.length, hit: guid !== undefined, forcedClick: select });
    if (select) this.select(guid); return guid ? this.inspect(guid) : null; } finally { endCpuScope(cpuScope); }
  }

  /**
   * Turn an NPC to face a world point. Vanilla swings a gossip target round to look at you the
   * moment the window opens; without this our NPCs keep whatever facing they spawned with and
   * talk to you sideways. Rotates the render group only — no packet is sent, and the server's
   * next orientation update overrides it as usual.
   */
  faceToward(guid: string, worldX: number, worldY: number): void {
    const rendered = this.rendered.get(guid);
    if (!rendered) return;
    const desired = Math.atan2(worldY - rendered.group.position.y, worldX - rendered.group.position.x);
    rendered.group.rotation.z = desired;
    // Keep the smoothed target in step or the next frame interpolates straight back.
    if (rendered.renderTargetO !== undefined) rendered.renderTargetO = desired;
  }

  select(guid: string | undefined) {
    const previous = this.selectedGuid ? this.rendered.get(this.selectedGuid) : undefined;
    if (previous) previous.group.userData.wowSelected = false;
    this.selectedGuid = guid;
    if (this.selectionHelper) {
      this.selectionHelper.parent?.remove(this.selectionHelper);
      this.selectionHelper.geometry.dispose();
      this.selectionHelper.material.dispose();
      this.selectionHelper = undefined;
    }
    const rendered = guid ? this.rendered.get(guid) : undefined;
    if (!rendered) return;
    rendered.group.userData.wowSelected = true;
    const radius = Math.max(0.55, Math.min(3.5, rendered.entity.boundingRadius ?? rendered.entity.combatReach ?? 0.8));
    this.selectionHelper = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.88, radius, 64),
      new THREE.MeshBasicMaterial({ color: 0xffd100, side: THREE.DoubleSide }),
    );
    this.selectionHelper.position.z = 0.035;
    this.selectionHelper.material.depthTest = true;
    this.selectionHelper.material.depthWrite = false;
    this.selectionHelper.material.transparent = true;
    this.selectionHelper.material.opacity = 0.8;
    this.selectionHelper.renderOrder = 5;
    rendered.group.add(this.selectionHelper);
  }

  selectedInspection() {
    return this.selectedGuid ? this.inspect(this.selectedGuid) : null;
  }

  /** Play a one-shot animation (e.g. attack swing, vanilla id 16 = AttackUnarmed) on an entity. */
  playOneShot(guid: string, animationId: number, durationMs = 800, kind: 'melee' | 'cast' | 'reaction' | 'emoteState' = 'reaction') {
    const rendered = this.rendered.get(guid);
    if (!rendered) return;
    // Same priority rule as the player: a hit-reaction must not cancel an in-progress attack swing.
    // Without this, hitting a wolf mid-swing replaced its attack animation with a flinch, so its
    // attacks looked like they weren't happening / were out of sync.
    if (kind === 'reaction'
      && rendered.overrideAnimId !== undefined
      && (rendered.overrideKind === 'melee' || rendered.overrideKind === 'cast')
      && performance.now() < (rendered.overrideUntil ?? 0)) {
      return;
    }
    rendered.overrideAnimId = resolveAnimId(animationId, rendered.modelAnimations || []);
    rendered.overrideUntil = performance.now() + durationMs;
    rendered.overrideKind = kind;
  }

  /** Play an opcode-specified animation for its exact baked M2 sequence duration. */
  playAuthoredOneShot(
    guid: string,
    animationId: number,
    kind: 'melee' | 'cast' | 'reaction' | 'emoteState' = 'reaction',
  ) {
    const rendered = this.rendered.get(guid);
    if (!rendered) return false;
    const resolved = resolveAnimId(animationId, rendered.modelAnimations || []);
    const durationMs = rendered.modelAnimationDurations?.get(resolved);
    if (!durationMs) return false;
    this.playOneShot(guid, resolved, durationMs, kind);
    return true;
  }

  clearOneShot(guid: string) {
    const rendered = this.rendered.get(guid);
    if (!rendered) return;
    rendered.overrideAnimId = undefined;
    rendered.overrideUntil = undefined;
    rendered.overrideKind = undefined;
  }

  /** SMSG_MOUNTSPECIAL_ANIM: Build-5875 AnimationData id 94, played on the mount rig itself. */
  playMountSpecial(guid: string) {
    const rendered = this.rendered.get(guid);
    const durationMs = rendered?.mountAnimationDurations?.get(94);
    if (!rendered?.mountAnimator || !durationMs) return false;
    rendered.mountOverrideAnimId = 94;
    rendered.mountOverrideUntil = performance.now() + durationMs;
    return true;
  }

  /** Local render-space position of an entity (group origin + a head-height offset). */
  localPositionOf(guid: string): { x: number; y: number; z: number } | null {
    const rendered = this.rendered.get(guid);
    if (!rendered) return null;
    const p = rendered.group.position;
    return { x: p.x, y: p.y, z: p.z + this.renderedHeight(rendered) * rendered.group.scale.z };
  }

  /** Local render-space origin/feet position of an entity. Spell anchors build from this. */
  localOriginOf(guid: string): { x: number; y: number; z: number } | null {
    const rendered = this.rendered.get(guid);
    if (!rendered) return null;
    const p = rendered.group.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  /** Approximate rendered height in yards, after server/display scale. */
  localHeightOf(guid: string): number | null {
    const rendered = this.rendered.get(guid);
    if (!rendered) return null;
    return this.renderedHeight(rendered) * rendered.group.scale.z;
  }

  nameplateEntries(center?: { x: number; y: number }, maxDistance = Number.POSITIVE_INFINITY): WorldNameplateEntry[] {
    const out: WorldNameplateEntry[] = [];
    const candidates: Iterable<RenderedEntity> = center && Number.isFinite(maxDistance)
      ? this.spatial.queryCircle(center.x, center.y, maxDistance, this.spatialCandidates)
      : this.rendered.values();
    for (const rendered of candidates) {
      const entity = rendered.entity;
      if (entity.typeId !== TypeID.UNIT && entity.typeId !== TypeID.PLAYER) continue;
      const p = rendered.group.position;
      if (center && (p.x - center.x) ** 2 + (p.y - center.y) ** 2 > maxDistance ** 2) continue;
      out.push({
        guid: entity.guid,
        entity,
        localPosition: { x: p.x, y: p.y, z: p.z },
        height: this.renderedHeight(rendered) * rendered.group.scale.z,
      });
    }
    return out;
  }

  /** Loaded model root for a read-only unit-frame portrait clone. */
  portraitModel(guid: string, typeId?: TypeID): THREE.Group | undefined {
    const rendered = this.rendered.get(guid); return typeId === undefined || rendered?.entity.typeId === typeId ? rendered?.modelRoot : undefined;
  }

  /** Exact M2 attachment point in render-space when the creature/player model exposes one. */
  localAttachmentOf(guid: string, attachmentId: number): { x: number; y: number; z: number } | null {
    const rendered = this.rendered.get(guid);
    const getAttachmentMatrix = rendered?.animator?.getAttachmentMatrix ?? rendered?.playerAnimator?.getAttachmentMatrix;
    if (!rendered?.modelRoot || !getAttachmentMatrix) return null;
    const matrix = getAttachmentMatrix(attachmentId, this.attachmentMatrix);
    if (!matrix) return null;
    this.attachmentPosition.setFromMatrixPosition(matrix);
    rendered.modelRoot.localToWorld(this.attachmentPosition);
    return { x: this.attachmentPosition.x, y: this.attachmentPosition.y, z: this.attachmentPosition.z };
  }

  equipmentAttachmentRoot(guid: string, slot: number) {
    return this.rendered.get(guid)?.getEquipmentAttachmentRoot?.(slot);
  }

  /** Living units sorted by distance from (x, y) — used for Tab target cycling. */
  nearestUnits(x: number, y: number, maxDistance = 40): string[] {
    const out: { guid: string; d2: number }[] = [];
    const max2 = maxDistance * maxDistance;
    for (const rendered of this.spatial.queryCircle(x, y, maxDistance, this.spatialCandidates)) {
      const e = rendered.entity;
      if ((e.typeId !== TypeID.UNIT && e.typeId !== TypeID.PLAYER) || !e.displayId) continue;
      if ((e.health ?? 1) <= 0) continue;
      const dx = rendered.group.position.x - x;
      const dy = rendered.group.position.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= max2) out.push({ guid: e.guid, d2 });
    }
    return out.sort((a, b) => a.d2 - b.d2).map((entry) => entry.guid);
  }

  /**
   * The target's full CharacterInfo (race/gender/appearance + equipment), for feeding
   * CharacterPreview in the inspect frame. Null for non-player entities or before appearance
   * fields arrive. Reuses the exact builder the world model pipeline already uses.
   */
  characterInfoFor(guid: string): CharacterInfo | null {
    const entity = this.rendered.get(guid)?.entity;
    return entity ? this.remotePlayerCharacter(entity) : null;
  }

  inspect(guid: string): WorldEntityInspection | null {
    const rendered = this.rendered.get(guid);
    if (!rendered) return null;
    return {
      entity: rendered.entity,
      render: {
        modelLoaded: !!rendered.modelRoot,
        modelDisplayId: rendered.modelDisplayId,
        loadingDisplayId: rendered.loadingDisplayId,
        animated: !!(rendered.animator || rendered.playerAnimator),
        placeholderVisible: rendered.placeholder.visible,
        missingAsset: rendered.entity.displayId !== undefined && this.missingDisplayIds.has(rendered.entity.displayId),
        assetState: isServerOnlyMarker(rendered.entity)
          ? 'not-requested'
          : rendered.modelRoot
            ? 'loaded'
            : rendered.loadingDisplayId !== undefined
              ? 'loading'
              : this.gameObjectLoadFailures.get(rendered.entity.displayId ?? 0)?.kind === 'unbaked'
                ? 'unbaked'
                : this.gameObjectLoadFailures.has(rendered.entity.displayId ?? 0)
                  ? 'retrying'
                  : rendered.entity.typeId === TypeID.GAMEOBJECT
                    ? 'not-requested'
                    : undefined,
        assetRetryAt: this.gameObjectLoadFailures.get(rendered.entity.displayId ?? 0)?.retryAt || undefined,
        // GAMEOBJECT_DISPLAYID is field 0x008 in the Build 5875 object layout. A missing field on a
        // create block means the authoritative value is zero, as with invisible trap entry 2061.
        displayFieldPresent: rendered.entity.typeId === TypeID.GAMEOBJECT
          ? rendered.entity.fields.has(0x008)
          : undefined,
        serverOnlyMarker: rendered.entity.typeId === TypeID.GAMEOBJECT
          ? isServerOnlyMarker(rendered.entity)
          : undefined,
        modelSource: rendered.modelSource,
        modelParts: rendered.modelParts,
        modelTextures: rendered.modelTextures,
        modelBones: rendered.modelBones,
        modelAnimations: rendered.modelAnimations,
        activeAnimationId: rendered.activeAnimationId,
        activeAnimationName:
          rendered.activeAnimationId === 0 ? 'Stand' :
          rendered.activeAnimationId === 4 ? 'Walk' :
          rendered.activeAnimationId === 5 ? 'Run' :
          rendered.activeAnimationId === 38 ? 'Jump' :
          rendered.activeAnimationId === 1 ? 'Death' :
          undefined,
        localPosition: rendered.group.position.toArray(),
        // TERRAIN height only. On a WMO surface this is not where the entity stands, and reading it
        // as such is what produced the "NPCs sink 48 yards through the City_01 bridge" report —
        // the entity was on the deck the whole time. groundZWmo is the surface it rests on.
        groundZ: this.sampleHeight?.(rendered.group.position.x, rendered.group.position.y),
        groundZWmo: this.sampleGroundZ?.(
          rendered.group.position.x, rendered.group.position.y, rendered.group.position.z,
        ),
      },
    };
  }

  diagnostics() {
    const entities = Array.from(this.rendered.values()).map((rendered) => ({
      guid: rendered.entity.guid,
      typeId: rendered.entity.typeId,
      displayId: rendered.entity.displayId,
      modelDisplayId: rendered.modelDisplayId,
      modelLoaded: !!rendered.modelRoot,
      animated: !!(rendered.animator || rendered.playerAnimator),
      flags: rendered.entity.flags,
      movementOpcode: rendered.entity.movementOpcode,
      activeAnimationId: rendered.activeAnimationId,
      activeAnimationName:
        rendered.activeAnimationId === 0 ? 'Stand' :
        rendered.activeAnimationId === 4 ? 'Walk' :
        rendered.activeAnimationId === 5 ? 'Run' :
        rendered.activeAnimationId === 11 ? 'ShuffleLeft/TurnLeft' :
        rendered.activeAnimationId === 12 ? 'ShuffleRight/TurnRight' :
        rendered.activeAnimationId === 13 ? 'WalkBack' :
        rendered.activeAnimationId === 38 ? 'Jump' :
        rendered.activeAnimationId === 1 ? 'Death' :
        undefined,
      x: rendered.entity.x,
      y: rendered.entity.y,
      z: rendered.entity.z,
      renderX: rendered.group.position.x,
      renderY: rendered.group.position.y,
      renderZ: rendered.group.position.z,
      // TERRAIN height only. On a WMO surface this is not where the entity stands, and reading it
      // as such is what produced the "NPCs sink 48 yards through the City_01 bridge" report —
      // the entity was on the deck the whole time. groundZWmo is the surface it rests on.
      groundZ: this.sampleHeight?.(rendered.group.position.x, rendered.group.position.y),
      groundZWmo: this.sampleGroundZ?.(
        rendered.group.position.x, rendered.group.position.y, rendered.group.position.z,
      ),
      time: rendered.entity.time,
      predictionAgeMs: rendered.entity.predictionAgeMs,
      visibleItemEntries: rendered.entity.visibleItemEntries,
      visibleEquipment: rendered.entity.visibleEquipment,
    }));
    return {
      rendered: entities.length,
      models: entities.filter((entity) => entity.modelLoaded).length,
      animated: entities.filter((entity) => entity.animated).length,
      missingDisplayIds: Array.from(this.missingDisplayIds).sort((a, b) => a - b),
      gameObjectLoadFailures: Array.from(this.gameObjectLoadFailures, ([displayId, failure]) => ({
        displayId,
        ...failure,
      })).sort((a, b) => a.displayId - b.displayId),
      sharedM2Geometry: this.sharedM2Geometry.diagnostics(),
      entitySpatialIndex: this.spatial.diagnostics(),
      displayAssetCache: this.assetCache.diagnostics(),
      gameObjectAssetCache: this.gameObjectAssetCache.diagnostics(),
      creatureTextureEntries: this.creatureTexCache.size,
      entities,
    };
  }

  /** Allocation-light counters for the opt-in performance capture. */
  performanceDiagnostics() {
    let modelLoaded = 0;
    let loading = 0;
    let animated = 0;
    let visible = 0;
    let placeholders = 0;
    for (const rendered of this.rendered.values()) {
      if (rendered.modelRoot) modelLoaded++;
      if (
        rendered.loadingDisplayId !== undefined
        || rendered.loadingPlayerAppearanceKey !== undefined
        || this.hasRetryableGameObjectFailure(rendered)
      ) loading++;
      if (rendered.animator || rendered.playerAnimator) animated++;
      if (rendered.group.visible) visible++;
      if (rendered.placeholder.visible) placeholders++;
    }
    return {
      rendered: this.rendered.size,
      modelLoaded,
      loading,
      animated,
      visible,
      placeholders,
      missingDisplayIds: this.missingDisplayIds.size,
      modelCache: this.modelCache.diagnostics(),
      animationFrame: { ...this.animationFrame },
    };
  }

  private hasRetryableGameObjectFailure(rendered: RenderedEntity) {
    const displayId = rendered.entity.typeId === TypeID.GAMEOBJECT
      ? rendered.entity.displayId
      : undefined;
    return !!displayId && this.gameObjectLoadFailures.get(displayId)?.kind === 'transient';
  }

  /** Wait until all currently-visible entity model requests have been quiet for a stable window. */
  async waitForSettled(options: { timeoutMs?: number; stableMs?: number; signal?: AbortSignal; onProgress?: (pending: number, total: number) => void } = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const stableMs = options.stableMs ?? 500;
    const startedAt = performance.now();
    let stableSince = 0;
    let previousTotal = -1;
    while (!options.signal?.aborted && performance.now() - startedAt < timeoutMs) {
      const values = [...this.rendered.values()];
      const pending = values.filter((rendered) =>
        rendered.loadingDisplayId !== undefined
        || rendered.loadingPlayerAppearanceKey !== undefined
        || this.hasRetryableGameObjectFailure(rendered)
      ).length;
      const total = values.length;
      options.onProgress?.(pending, total);
      if (pending === 0 && total === previousTotal) {
        if (!stableSince) stableSince = performance.now();
        if (performance.now() - stableSince >= stableMs) return { settled: true, pending: 0, total };
      } else {
        stableSince = 0;
      }
      previousTotal = total;
      await abortableDelay(50, options.signal);
    }
    const values = [...this.rendered.values()];
    const pending = values.filter((rendered) =>
      rendered.loadingDisplayId !== undefined
      || rendered.loadingPlayerAppearanceKey !== undefined
      || this.hasRetryableGameObjectFailure(rendered)
    ).length;
    return { settled: false, aborted: options.signal?.aborted === true, pending, total: values.length };
  }

  remove(guid: string) {
    const rendered = this.rendered.get(guid);
    if (!rendered) return;
    this.scene.remove(rendered.group);
    this.clearMount(rendered);
    this.clearCreatureEquipment(rendered);
    rendered.animator?.dispose();
    rendered.playerDispose?.();
    if (!releaseSharedM2Geometry(rendered.modelRoot)) rendered.modelRoot?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
    rendered.placeholderMaterial.dispose();
    // Each disc owns its material (shared geometry/texture stay alive); free it or every despawned
    // NPC leaks one.
    disposeBlobShadow(rendered.blobShadow);
    this.rendered.delete(guid);
    this.spatial.remove(guid);
    this.transports.remove(guid);
    if (this.locallyControlledGuid === guid) this.locallyControlledGuid = undefined;
    if (this.selectedGuid === guid) this.select(undefined);
  }

  clear() {
    this.assetGeneration++; this.assetAbort.abort(); this.assetAbort = new AbortController();
    this.appliedSnapshotRevision = -1;
    this.select(undefined);
    for (const guid of Array.from(this.rendered.keys())) this.remove(guid);
    // Every rendered mesh is gone now, so the shared GPU caches no longer back any live geometry.
    // Dispose them so creature/gameobject materials and textures don't accumulate on the GPU across
    // zone changes and relogs (clear() is the map-change / logout hook — clearTiles() in main.ts).
    // assetCache / gameObjectAssetCache bake material refs into their parts[], so they must be dropped
    // alongside the materials they point at. modelCache holds only decoded CPU geometry (no GPU
    // handles) and is kept so re-entry doesn't have to re-decode every model.
    for (const material of this.materialCache.values()) material.dispose();
    this.materialCache.clear();
    this.creatureTextureRegistry.clear(); this.creatureTexCache.clear(); this.creatureTexPending.clear();
    this.assetCache.clear();
    this.gameObjectAssetCache.clear();
    this.creatureLoadFailures.clear();
    this.spatial.clear();
  }

  dispose() {
    this.clear();
    this.unitGeometry.dispose();
    this.playerGeometry.dispose();
    this.gameObjectGeometry.dispose();
  }

  private getOrCreate(entity: WorldEntity): RenderedEntity {
    const existing = this.rendered.get(entity.guid);
    if (existing && existing.typeId === entity.typeId) return existing;
    if (existing) this.remove(entity.guid);

    const group = new THREE.Group();
    Object.assign(group.userData, { worldEntityGuid: entity.guid, wowSelected: entity.guid === this.selectedGuid });
    const placeholderMaterial = new THREE.MeshStandardMaterial({
      color: this.colorFor(entity),
      emissive: 0x101010,
      roughness: 0.55,
      metalness: 0.0,
    });
    const placeholder = new THREE.Mesh(this.geometryFor(entity), placeholderMaterial);
    if (entity.typeId !== TypeID.GAMEOBJECT) placeholder.rotation.x = Math.PI / 2;
    group.add(placeholder);
    // Vanilla blob shadow — sized to the unit footprint, scales with group display scale. Kept on
    // the ground (not the feet) by updateBlobShadow() each frame.
    const blobShadow = createBlobShadow(Math.max(0.4, Math.min(2.0, this.heightFor(entity) * 0.28)));
    group.add(blobShadow);
    this.scene.add(group);

    const rendered = { entity, group, placeholder, placeholderMaterial, blobShadow, typeId: entity.typeId, splinePresentation: {} };
    this.rendered.set(entity.guid, rendered);
    return rendered;
  }

  private geometryFor(entity: WorldEntity) {
    if (entity.typeId === TypeID.PLAYER) return this.playerGeometry;
    if (entity.typeId === TypeID.GAMEOBJECT) return this.gameObjectGeometry;
    return this.unitGeometry;
  }

  private heightFor(entity: WorldEntity) {
    if (entity.typeId === TypeID.GAMEOBJECT) return 1.4;
    if (entity.combatReach) return Math.max(1.8, entity.combatReach * 1.7);
    if (entity.boundingRadius) return Math.max(1.6, entity.boundingRadius * 4.0);
    return entity.typeId === TypeID.PLAYER ? 2.2 : 2.0;
  }

  /**
   * Height (group-local yards, before the display scale on group.scale) at which the overhead name
   * should float — the top of the actual rendered model when it is loaded, falling back to the
   * heightFor() heuristic before then. heightFor() is a flat 2.2 for every player and a floored
   * heuristic for creatures, so a Tauren's name sat well below its head and a rabbit's name floated
   * a yard above it. Box3 over the real mesh fixes both. The vertical EXTENT (max.z - min.z) is
   * position/facing-invariant; dividing by the uniform group scale returns it to the group-local
   * space the callers re-multiply by group.scale.z. Cached against modelRoot so a model swap (mount,
   * shapeshift, display change) transparently remeasures.
   */
  private renderedHeight(rendered: RenderedEntity): number {
    const root = rendered.modelRoot;
    if (root) {
      if (rendered.measuredHeight !== undefined && rendered.measuredHeightRoot === root) {
        return rendered.measuredHeight;
      }
      // Measure only the skinned body mesh(es). Box3.setFromObject uses each geometry's bind-pose
      // bounds (skinning deformation is ignored), so the height is stable across animation — and
      // limiting to SkinnedMesh excludes statically-attached weapons/held items, which a raised 2H
      // staff on a caster's back would otherwise push the name a full character-height above the
      // head (the exact trap the local-player head-centroid path documents). Creatures are entirely
      // one skinned M2, so they measure correctly too. Fall back to the whole model if nothing was
      // skinned, then to the coarse heightFor() heuristic before the model finishes loading.
      root.updateWorldMatrix(true, true);
      const box = new THREE.Box3();
      let measuredSkinned = false;
      root.traverse((obj) => {
        if ((obj as THREE.SkinnedMesh).isSkinnedMesh && (obj as THREE.Mesh).geometry) {
          box.expandByObject(obj);
          measuredSkinned = true;
        }
      });
      if (!measuredSkinned) box.setFromObject(root);
      if (!box.isEmpty()) {
        const scaleZ = rendered.group.scale.z || 1;
        const localHeight = (box.max.z - box.min.z) / scaleZ;
        if (Number.isFinite(localHeight) && localHeight > 0.05) {
          rendered.measuredHeight = localHeight;
          rendered.measuredHeightRoot = root;
          return localHeight;
        }
      }
    }
    return this.heightFor(rendered.entity);
  }

  private updateAppearance(entity: WorldEntity, rendered: RenderedEntity) {
    rendered.placeholderMaterial.color.setHex(this.colorFor(entity));
    if (entity.health !== undefined && entity.maxHealth && entity.maxHealth > 0) {
      const health = Math.max(0, Math.min(1, entity.health / entity.maxHealth));
      if (health < 0.25) rendered.placeholderMaterial.color.setHex(0xc9473e);
      else if (health < 0.6) rendered.placeholderMaterial.color.setHex(0xd6a83e);
    }
  }

  private colorFor(entity: WorldEntity) {
    if (entity.typeId === TypeID.PLAYER) return 0x56c7ff;
    if (entity.typeId === TypeID.GAMEOBJECT) return 0x8fc46a;
    if (entity.typeId === TypeID.CORPSE) return 0x777777;
    if (entity.typeId === TypeID.DYNAMICOBJECT) return 0xb68cff;
    return entity.displayId ? 0xffcc66 : 0xa4a9a6;
  }

  private remotePlayerCharacter(entity: WorldEntity): CharacterInfo | null {
    if (entity.race === undefined || entity.gender === undefined) return null;
    return {
      guid: entity.guid,
      guidBytes: [],
      name: '',
      race: entity.race,
      classId: entity.classId ?? 0,
      gender: entity.gender,
      skin: entity.skin ?? 0,
      face: entity.face ?? 0,
      hairStyle: entity.hairStyle ?? 0,
      hairColor: entity.hairColor ?? 0,
      facialHair: entity.facialHair ?? 0,
      level: entity.level ?? 1,
      zone: 0,
      map: 0,
      x: entity.x ?? 0,
      y: entity.y ?? 0,
      z: entity.z ?? 0,
      equipment: entity.visibleEquipment ?? [],
    };
  }

  private remotePlayerAppearanceKey(character: CharacterInfo) {
    const cvars = getInterfaceCvars();
    return [
      // Show Helm / Show Cloak drop items from the composited look, so two different cvar
      // states must not share a key — same rule as the sheath note below.
      `hc${Number(cvars.showHelm) === 1 ? 1 : 0}${Number(cvars.showCloak) === 1 ? 1 : 0}`,
      character.race,
      character.gender,
      character.skin,
      character.face,
      character.hairStyle,
      character.hairColor,
      character.facialHair,
      // Sheath MUST be part of the key. A remote weapon first builds with sheath === undefined
      // (starter-outfit fallback / before the item query resolves), which sends a staff to the
      // generic two-hand socket 26 instead of the staff socket 31. When the query later resolves
      // ItemPrototype.Sheath, the displayId/type are unchanged, so without sheath here the key
      // would match and ensurePlayerModel would skip the reload — leaving every remote player's
      // staff mis-socketed. The local player's equipmentSignature already includes sheath.
      ...(character.equipment ?? []).map((item) => `${item.displayInfoId}:${item.inventoryType}:${item.sheath ?? ''}`),
    ].join(':');
  }

  /**
   * Rebuild every visible remote player whose composited look is now stale. Called when an
   * Interface Options change (Show Helm / Show Cloak) invalidates the appearance key: the
   * key comparison in ensurePlayerModel does the actual work, so this only has to re-run it
   * rather than track what changed.
   */
  refreshPlayerAppearances() {
    for (const rendered of this.rendered.values()) {
      if (rendered.entity?.typeId === TypeID.PLAYER) this.upsert(rendered.entity);
    }
  }

  private ensurePlayerModel(entity: WorldEntity, rendered: RenderedEntity) {
    const character = this.remotePlayerCharacter(entity);
    if (!character) return;
    const key = this.remotePlayerAppearanceKey(character);
    if (rendered.playerAppearanceKey === key || rendered.loadingPlayerAppearanceKey === key) return;
    rendered.loadingPlayerAppearanceKey = key;
    publishRemoteCharacter(character);
    void loadBakedCharacterModel(character, this.getTextureAnisotropy(), entity.sheathState ?? 0).then((model) => {
      const current = this.rendered.get(entity.guid);
      if (!current || current !== rendered || current.loadingPlayerAppearanceKey !== key) {
        model.dispose();
        return;
      }
      if (current.modelRoot) {
        current.group.remove(current.modelRoot);
        this.clearCreatureEquipment(current);
        current.animator?.dispose();
        current.animator = undefined;
        current.playerDispose?.();
        current.playerDispose = undefined;
        if (!releaseSharedM2Geometry(current.modelRoot)) current.modelRoot.traverse((object) => {
          const mesh = object as THREE.Mesh;
          mesh.geometry?.dispose?.();
        });
      }
      current.loadingPlayerAppearanceKey = undefined;
      current.loadingDisplayId = undefined;
      current.playerAppearanceKey = key;
      current.modelRoot = model.group;
      current.playerAnimator = model.animator ?? undefined;
      current.playerDispose = model.dispose;
      current.setWeaponsSheathed = model.setWeaponsSheathed;
      current.getEquipmentAttachmentRoot = model.getEquipmentAttachmentRoot;
      current.appliedSheathState = undefined; // re-apply on the next upsert
      current.animator = undefined;
      current.modelAnimations = Array.from(new Set(model.data.sequences.map((sequence) => sequence.id))).sort((a, b) => a - b);
      current.modelAnimationDurations = animationDurations(model.data.sequences);
      current.modelDisplayId = entity.displayId;
      current.modelScale = 1;
      current.modelSource = model.data.source;
      current.placeholder.visible = false;
      current.group.add(model.group);
      this.upsert(entity);
    }).catch(() => {
      const current = this.rendered.get(entity.guid);
      if (current === rendered && current.loadingPlayerAppearanceKey === key) current.loadingPlayerAppearanceKey = undefined;
      if (entity.displayId) this.missingDisplayIds.add(entity.displayId);
    });
  }

  /**
   * A creature's live weapons come from UNIT_VIRTUAL_ITEM_*, not from the display's baked
   * CreatureDisplayInfoExtra. They change after the model is built (creature_equip_template lands
   * with the spawn, scripts swap weapons mid-fight), so the humanoid-NPC load has to be keyed on
   * them the way remote players are keyed on their appearance — otherwise the displayId guard would
   * pin the very first look forever.
   */
  private npcWeaponKey(entity: WorldEntity) {
    // visibleEquipment is the post-policy list: it includes the wire-derived creature weapons but
    // excludes the main hand while UNIT_FLAG_DISARMED is set. Keying raw virtualItems here would
    // immediately compose the weapon back into a humanoid NPC after disarm.ts removed it.
    return (entity.visibleEquipment ?? [])
      .map((item) => `${item.slot}:${item.displayInfoId}:${item.inventoryType}:${item.sheath}`)
      .join('|');
  }

  private clearCreatureEquipment(rendered: RenderedEntity) {
    if (rendered.creatureEquipment) {
      for (const attachment of rendered.creatureEquipment) attachment.group.parent?.remove(attachment.group);
    }
    rendered.creatureEquipmentDispose?.();
    rendered.creatureEquipment = undefined;
    rendered.creatureEquipmentDispose = undefined;
  }

  private updateCreatureEquipmentTransforms(rendered: RenderedEntity) {
    const attachments = rendered.creatureEquipment;
    const getAttachmentMatrix = rendered.animator?.getAttachmentMatrix;
    if (!attachments?.length || !getAttachmentMatrix) return;
    // Same rule as the character pipeline: the sheath state names which SET is prepared, so a
    // creature at SHEATH_STATE_MELEE stows its ranged weapon rather than holding both.
    const sheathState = rendered.entity.sheathState ?? 0;
    for (const attachment of attachments) {
      let jointId: number;
      const drawn = isWeaponDrawn(sheathState, attachment.equipmentSlot);
      if (!drawn && attachment.sheathedJointId === 'hide') {
        attachment.group.visible = false;
        continue;
      } else if (!drawn && typeof attachment.sheathedJointId === 'number') {
        jointId = attachment.sheathedJointId;
      } else {
        jointId = attachment.drawnJointId;
      }
      const matrix = getAttachmentMatrix(jointId, this.attachmentMatrix);
      attachment.group.visible = !!matrix;
      if (!matrix) continue;
      attachment.group.matrix.copy(matrix);
      attachment.group.matrixWorldNeedsUpdate = true;
    }
  }

  private ensureCreatureModel(entity: WorldEntity, rendered: RenderedEntity) {
    const displayId = entity.displayId;
    if (!displayId || rendered.loadingDisplayId === displayId) return;
    const weaponKey = this.npcWeaponKey(entity);
    if (rendered.modelDisplayId === displayId && rendered.npcWeaponKey === weaponKey) return;
    rendered.loadingDisplayId = displayId;
    void this.loadCreatureAsset(displayId).then((asset) => {
      const current = this.rendered.get(entity.guid);
      if (!current || current !== rendered || current.loadingDisplayId !== displayId) return;
      if (!asset) { current.loadingDisplayId = undefined; return; }
      // A player display transformation must force a fresh character composition when it later
      // returns to nativeDisplayId; otherwise the unchanged appearance key would keep this creature
      // rig installed forever.
      if (entity.typeId === TypeID.PLAYER) {
        current.playerAppearanceKey = undefined;
        current.loadingPlayerAppearanceKey = undefined;
      }
      if (current.modelRoot) {
        current.group.remove(current.modelRoot);
        this.clearCreatureEquipment(current);
        current.animator?.dispose();
        current.animator = undefined;
        current.playerDispose?.();
        current.playerDispose = undefined;
        if (!releaseSharedM2Geometry(current.modelRoot)) current.modelRoot.traverse((object) => {
          const mesh = object as THREE.Mesh;
          mesh.geometry?.dispose?.();
        });
      }
      // Humanoid NPC: reuse the full player pipeline (composited skin/face/hair + worn armor + anim).
      // CRITICAL: loadingDisplayId must stay set until loadBakedCharacterModel FINISHES. upsert()
      // runs every frame for spline-moving NPCs and re-enters ensureCreatureModel; clearing the
      // guard before the async character load completed spawned a NEW multi-MB model load every
      // frame per moving humanoid NPC — the 1 GB → 10 GB+ RAM cascade in Coldridge/Shadowglen.
      if (isHumanoid(asset)) {
        if (!asset.humanoidCharacter) { current.loadingDisplayId = undefined; return; }
        // Live UNIT_VIRTUAL_ITEM_* weapons replace the baked CreatureDisplayInfoExtra weapon slots;
        // the baked armour is kept, because virtual items only ever cover main/off/ranged.
        const baked = asset.humanoidCharacter as CharacterInfo;
        const liveWeapons = entity.visibleEquipment ?? [];
        const weaponSlots = new Set(liveWeapons.map((item) => item.slot));
        const character: CharacterInfo = liveWeapons.length
          ? { ...baked, equipment: [...(baked.equipment ?? []).filter((item) => !weaponSlots.has(item.slot ?? -1)), ...liveWeapons] }
          : baked;
        void loadBakedNpcCharacterModel(
          character,
          asset.bakedBodyTextureUrl,
          this.getTextureAnisotropy(),
          entity.sheathState ?? 0,
        ).then((model) => {
          const c2 = this.rendered.get(entity.guid);
          if (!c2 || c2 !== rendered || c2.loadingDisplayId !== displayId
            || (c2.modelDisplayId === displayId && c2.npcWeaponKey === weaponKey)) { model.dispose(); return; }
          if (c2.modelRoot && c2.modelRoot !== current.modelRoot) {
            c2.group.remove(c2.modelRoot);
            c2.playerDispose?.();
            c2.playerDispose = undefined;
          }
          c2.loadingDisplayId = undefined;
          c2.npcWeaponKey = weaponKey;
          c2.modelRoot = model.group;
          c2.playerAnimator = model.animator ?? undefined;
          c2.playerDispose = model.dispose;
          c2.setWeaponsSheathed = model.setWeaponsSheathed;
          c2.getEquipmentAttachmentRoot = model.getEquipmentAttachmentRoot;
          c2.appliedSheathState = undefined; // re-apply on the next upsert
          c2.animator = undefined;
          c2.modelAnimations = Array.from(new Set(model.data.sequences.map((sequence) => sequence.id))).sort((a, b) => a - b);
          c2.modelAnimationDurations = animationDurations(model.data.sequences);
          c2.modelDisplayId = displayId;
          c2.modelScale = 1;
          c2.modelSource = model.data.source;
          c2.placeholder.visible = false;
          c2.group.add(model.group);
          this.upsert(entity);
        }).catch(() => {
          const c2 = this.rendered.get(entity.guid);
          if (c2 === rendered && c2.loadingDisplayId === displayId) c2.loadingDisplayId = undefined;
          this.missingDisplayIds.add(displayId);
        });
        return;
      }
      current.loadingDisplayId = undefined; // creature path completes synchronously below
      current.npcWeaponKey = weaponKey;
      const geometryLease = this.sharedM2Geometry.acquire(`creature:${displayId}`, asset.data, asset.parts);
      const { position, normal } = geometryLease;
      const modelRoot = createSharedM2GeometryGroup(geometryLease, asset.parts.map((part) => part.material));
      setM2PortraitFraming(modelRoot, asset.data);
      // Mesh stays unscaled — the entity group carries the full render scale (see upsert).
      current.modelRoot = modelRoot;
      current.modelDisplayId = displayId;
      current.modelScale = asset.scale || 1; // baked modelScale×displayScale: fallback for scale-less entities
      current.animator = createM2Animator(asset.data, position, normal, { skinAttributes: geometryLease.skinAttributes }) ?? undefined;
      current.animator?.bindGroup(modelRoot);
      current.modelSource = asset.data.source;
      current.modelParts = asset.data.parts.length;
      current.modelTextures = asset.data.textures.length;
      current.modelBones = asset.data.bones.length;
      current.modelAnimations = Array.from(new Set(asset.data.sequences.map((sequence) => sequence.id))).sort((a, b) => a - b);
      current.modelAnimationDurations = animationDurations(asset.data.sequences);
      current.placeholder.visible = false;
      current.group.add(modelRoot);
      const equipment = entity.visibleEquipment ?? [];
      if (equipment.length && current.animator?.getAttachmentMatrix) {
        void loadBakedCreatureEquipmentAttachments(equipment, this.getTextureAnisotropy(), entity.sheathState ?? 0).then((attachments) => {
          const latest = this.rendered.get(entity.guid);
          if (!latest || latest !== rendered || latest.modelRoot !== modelRoot || latest.npcWeaponKey !== weaponKey) {
            for (const attachment of attachments) attachment.dispose();
            return;
          }
          this.clearCreatureEquipment(latest);
          latest.creatureEquipment = attachments;
          latest.creatureEquipmentDispose = () => {
            for (const attachment of attachments) attachment.dispose();
          };
          for (const attachment of attachments) modelRoot.add(attachment.group);
          this.updateCreatureEquipmentTransforms(latest);
        });
      }
      this.upsert(entity);
    });
  }

  /**
   * Build an independent animated instance of a creature display (fresh geometry owns the
   * immutable skin attributes and the rig's draw binding).
   * Used for mounts — both remote entities and the local player's own mount.
   * Materials are shared with the cached asset; dispose() only frees geometry.
   */
  async createCreatureRig(displayId: number): Promise<{
    group: THREE.Group;
    animator: M2Animator | null;
    scale: number;
    animationIds: number[];
    animationDurations: Map<number, number>;
    dispose: () => void;
  } | null> {
    const asset = await this.loadCreatureAsset(displayId);
    if (!asset || isHumanoid(asset)) return null;
    const geometryLease = this.sharedM2Geometry.acquire(`creature:${displayId}`, asset.data, asset.parts);
    const group = createSharedM2GeometryGroup(geometryLease, asset.parts.map((part) => part.material));
    const animator = createM2Animator(asset.data, geometryLease.position, geometryLease.normal, { skinAttributes: geometryLease.skinAttributes }) ?? null;
    animator?.bindGroup(group);
    return {
      group,
      animator,
      scale: asset.scale || 1,
      animationIds: Array.from(new Set(asset.data.sequences.map((sequence) => sequence.id))).sort((a, b) => a - b),
      animationDurations: animationDurations(asset.data.sequences),
      dispose: () => {
        animator?.dispose();
        releaseSharedM2Geometry(group);
      },
    };
  }

  /**
   * Independent rig for any CreatureDisplayInfo row, including humanoid transform displays.
   * Mounts still use createCreatureRig (humanoid mounts are not valid); local SPELL_AURA_TRANSFORM
   * uses this broader path so disguises such as Orb of Deception do not silently stay native.
   */
  async createDisplayRig(displayId: number): Promise<{
    group: THREE.Group;
    animator: { update: (dt: number, animationId: number, camera?: THREE.Camera, group?: THREE.Group) => void } | null;
    scale: number;
    animationIds: number[];
    animationDurations: Map<number, number>;
    dispose: () => void;
  } | null> {
    const asset = await this.loadCreatureAsset(displayId);
    if (!asset) return null;
    if (!isHumanoid(asset)) return this.createCreatureRig(displayId);
    const model = await loadBakedNpcCharacterModel(
      asset.humanoidCharacter as CharacterInfo,
      asset.bakedBodyTextureUrl,
      this.getTextureAnisotropy(),
    );
    const animationIds = Array.from(new Set(model.data.sequences.map((sequence) => sequence.id)))
      .sort((a, b) => a - b);
    const animator = model.animator?.updateAnimationId
      ? {
          update: (dt: number, animationId: number, camera?: THREE.Camera, group?: THREE.Group) => {
            model.animator?.updateAnimationId?.(dt, animationId, camera, group ?? model.group);
          },
        }
      : null;
    return {
      group: model.group,
      animator,
      scale: 1,
      animationIds,
      animationDurations: animationDurations(model.data.sequences),
      dispose: model.dispose,
    };
  }

  private ensureMountModel(entity: WorldEntity, rendered: RenderedEntity) {
    const mountId = entity.mountDisplayId ?? 0;
    if (!mountId) {
      if (rendered.mountRoot || rendered.mountLoadingId) this.clearMount(rendered);
      return;
    }
    if (rendered.mountModelDisplayId === mountId || rendered.mountLoadingId === mountId) return;
    rendered.mountLoadingId = mountId;
    void this.createCreatureRig(mountId).then((rig) => {
      const current = this.rendered.get(entity.guid);
      if (!current || current !== rendered || current.mountLoadingId !== mountId) { rig?.dispose(); return; }
      current.mountLoadingId = undefined;
      if (!rig) return;
      this.clearMount(current); // swapping mounts: drop the previous rig first
      current.mountRoot = rig.group;
      current.mountAnimator = rig.animator ?? undefined;
      current.mountAnimationDurations = rig.animationDurations;
      current.mountModelDisplayId = mountId;
      current.mountDispose = rig.dispose;
      current.mountSeatMatrix = new THREE.Matrix4();
      current.group.add(rig.group);
    });
  }

  private clearMount(rendered: RenderedEntity) {
    if (rendered.mountRoot) {
      rendered.group.remove(rendered.mountRoot);
      rendered.mountDispose?.();
    }
    rendered.mountRoot = undefined;
    rendered.mountAnimator = undefined;
    rendered.mountAnimationDurations = undefined;
    rendered.mountOverrideAnimId = undefined;
    rendered.mountOverrideUntil = undefined;
    rendered.mountModelDisplayId = undefined;
    rendered.mountLoadingId = undefined;
    rendered.mountDispose = undefined;
    rendered.mountSeatMatrix = undefined;
    // Hand the rider its own transform back.
    if (rendered.modelRoot) {
      rendered.modelRoot.matrixAutoUpdate = true;
      rendered.modelRoot.position.set(0, 0, 0);
      rendered.modelRoot.quaternion.identity();
      rendered.modelRoot.updateMatrix();
    }
  }

  private ensureGameObjectModel(entity: WorldEntity, rendered: RenderedEntity) {
    const displayId = entity.displayId;
    if (!displayId || rendered.modelDisplayId === displayId || rendered.loadingDisplayId === displayId) return;
    if (isServerOnlyMarker(entity)) {
      // Deliberately undrawn, not a bake gap, so it stays OUT of missingDisplayIds — listing it
      // there would send the next person looking for an asset that exists and is correct.
      rendered.placeholder.visible = false;
      rendered.blobShadow.visible = false;
      return;
    }
    rendered.loadingDisplayId = displayId;
    void this.loadGameObjectAsset(displayId).then((asset) => {
      const current = this.rendered.get(entity.guid);
      if (!current || current !== rendered || current.loadingDisplayId !== displayId) return;
      if (!asset) {
        current.loadingDisplayId = undefined;
        // Only an ID absent from the full bake manifest is a known zero-geometry/collision-only
        // display. A transient request/decode failure keeps the placeholder visible while update()
        // retries it; hiding the box here was the black-cube-then-invisible duel-flag sequence.
        current.placeholder.visible = this.gameObjectLoadFailures.get(displayId)?.kind !== 'unbaked';
        return;
      }
      if (current.modelRoot) {
        current.group.remove(current.modelRoot);
        this.clearCreatureEquipment(current);
        current.animator?.dispose();
        current.animator = undefined;
        current.playerDispose?.();
        current.playerDispose = undefined;
        if (!releaseSharedM2Geometry(current.modelRoot)) current.modelRoot.traverse((object) => {
          const mesh = object as THREE.Mesh;
          mesh.geometry?.dispose?.();
        });
      }

      current.loadingDisplayId = undefined;
      this.gameObjectLoadFailures.delete(displayId);
      this.missingDisplayIds.delete(displayId);
      const geometryLease = this.sharedM2Geometry.acquire(`gameobject:${displayId}`, asset.data, asset.parts);
      const { position, normal } = geometryLease;
      const modelRoot = createSharedM2GeometryGroup(geometryLease, asset.parts.map((part) => part.material));
      setM2PortraitFraming(modelRoot, asset.data);
      current.modelRoot = modelRoot;
      current.modelDisplayId = displayId;
      current.modelScale = asset.scale || 1;
      current.animator = createM2Animator(asset.data, position, normal, { skinAttributes: geometryLease.skinAttributes }) ?? undefined;
      if (current.animator) { current.animator.bindGroup(modelRoot); centerM2BoundsOnOrigin(modelRoot); }
      current.playerAnimator = undefined;
      current.modelSource = asset.data.source;
      current.modelParts = asset.data.parts.length;
      current.modelTextures = asset.data.textures.length;
      current.modelBones = asset.data.bones.length;
      current.modelAnimations = Array.from(new Set(asset.data.sequences.map((sequence) => sequence.id))).sort((a, b) => a - b);
      current.modelAnimationDurations = animationDurations(asset.data.sequences);
      current.placeholder.visible = false;
      current.group.add(modelRoot);
      this.upsert(entity);
    });
  }

  private loadCreatureAsset(displayId: number) {
    let promise = this.assetCache.get(displayId);
    if (!promise) {
      const generation = this.assetGeneration;
      promise = this.fetchCreatureAsset(displayId).then((asset) => {
        if (generation !== this.assetGeneration) return null;
        this.creatureLoadFailures.delete(displayId);
        this.missingDisplayIds.delete(displayId);
        return asset;
      }).catch((error: unknown) => {
        if (generation !== this.assetGeneration) return null;
        const unbaked = error instanceof UnbakedCreatureDisplayError; recordAssetLoadFailure(this.creatureLoadFailures, displayId, error, unbaked);
        this.missingDisplayIds.add(displayId);
        // Permanent 404/410 misses are durable; network/decode failures must remain recoverable.
        if (!unbaked) this.assetCache.delete(displayId);
        return null;
      });
      this.assetCache.set(displayId, promise);
    }
    return promise;
  }

  private loadGameObjectAsset(displayId: number) {
    let promise = this.gameObjectAssetCache.get(displayId);
    if (!promise) {
      const generation = this.assetGeneration;
      promise = this.fetchGameObjectAsset(displayId).then((asset) => {
        if (generation !== this.assetGeneration) return null;
        this.gameObjectLoadFailures.delete(displayId);
        this.missingDisplayIds.delete(displayId);
        return asset;
      }).catch((error: unknown) => {
        if (generation !== this.assetGeneration) return null;
        const unbaked = error instanceof UnbakedGameObjectDisplayError;
        recordAssetLoadFailure(this.gameObjectLoadFailures, displayId, error, unbaked);
        this.missingDisplayIds.add(displayId);
        // Do not poison the session cache with a transient null. The render loop retries when its
        // bounded backoff expires. Known unbaked rows remain cached to avoid permanent 404 traffic.
        if (!unbaked) this.gameObjectAssetCache.delete(displayId);
        return null;
      });
      this.gameObjectAssetCache.set(displayId, promise);
    }
    return promise;
  }

  private loadGameObjectManifest(): Promise<Set<number> | null> {
    if (!this.gameObjectManifestPromise) {
      this.gameObjectManifestPromise = assetRequestQueue.run(async () => {
        const response = await fetch('/gameobjects/manifest.json', { signal: this.assetAbort.signal });
        if (!response.ok) throw new Error(`gameobject manifest HTTP ${response.status}`);
        const manifest = await response.json() as Record<string, unknown>;
        return new Set(Object.keys(manifest).map(Number).filter(Number.isFinite));
      }, { priority: 'critical', retries: 1, signal: this.assetAbort.signal, ownerId: `entities:${this.assetGeneration}` }).catch(() => {
        // A failed manifest is not evidence that every display is unbaked. Let the direct display
        // request proceed and revalidate the manifest on the next failed asset attempt.
        this.gameObjectManifestPromise = undefined;
        return null;
      });
    }
    return this.gameObjectManifestPromise;
  }

  /** Load+decode a unique model ONCE (geo.bin + model.json), shared by every display that uses it. */
  private loadModel(root: 'creatures' | 'gameobjects', key: string): Promise<DecodedModel | null> {
    const cacheKey = `${root}:${key}`;
    let promise = this.modelCache.get(cacheKey);
    if (!promise) {
      const signal = this.assetAbort.signal;
      promise = (async (): Promise<DecodedModel | null> => {
        const base = `/${root}/models/${key}`;
        // World geometry has exactly two required resources. Optional portrait metadata must never
        // be part of this critical Promise: a missing/mis-served portrait file previously rejected
        // the whole load and left every creature as the black capsule placeholder.
        const [rawBuffer, buf] = await Promise.all([
          assetRequestQueue.run(async () => {
            const response = await fetch(`${base}/model.json.gz`, { signal });
            if (!response.ok) throw new Error(`${base}/model.json.gz HTTP ${response.status}`);
            return response.arrayBuffer();
          }, { priority: 'critical', retries: 1, signal, ownerId: `entities:${this.assetGeneration}` }),
          assetRequestQueue.run(async () => {
            const response = await fetch(`${base}/geo.bin`, { signal });
            if (!response.ok) throw new Error(`${base}/geo.bin HTTP ${response.status}`);
            return response.arrayBuffer();
          }, { priority: 'critical', retries: 1, signal, ownerId: `entities:${this.assetGeneration}` }),
        ]);
        // model.json.gz holds the bone tracks gzip-compressed. Some servers (vite/sirv) auto-serve
        // .gz with Content-Encoding: gzip so the browser already inflated it; others hand back the raw
        // gzip bytes. Detect by the gzip magic (0x1f 0x8b) and inflate ourselves only if still compressed.
        const raw = new Uint8Array(rawBuffer);
        let text: string;
        if (raw[0] === 0x1f && raw[1] === 0x8b) {
          const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair);
          text = await new Response(stream).text();
        } else {
          text = new TextDecoder().decode(raw);
        }
        const meta = JSON.parse(text) as ModelMeta;
        const V = meta.vertexCount, I = meta.indexCount;
        let o = 0;
        const positions = new Float32Array(buf, o, V * 3); o += V * 3 * 4;
        const normals = new Float32Array(buf, o, V * 3); o += V * 3 * 4;
        const uvs = new Float32Array(buf, o, V * 2); o += V * 2 * 4;
        const boneWeights = new Uint8Array(buf, o, V * 4); o += V * 4;
        const boneIndices = new Uint8Array(buf, o, V * 4); o += V * 4;
        const indices = meta.indexType === 'u32' ? new Uint32Array(buf, o, I) : new Uint16Array(buf, o, I);
        return { meta, positions, normals: meta.hasNormals ? normals : null, uvs, boneWeights, boneIndices, indices };
      })().catch((error) => {
        // Geometry requests can fail transiently under world-entry pressure. Never turn the
        // rejection into a cached null: every display sharing this model must remain recoverable.
        this.modelCache.delete(cacheKey);
        throw error;
      });
      this.modelCache.set(cacheKey, promise);
    }
    return promise;
  }

  /** Load a texture once per URL (the deduped pool means many displays share the same skin file). */
  private loadCreatureTexture(url: string | null): Promise<THREE.Texture | null> {
    if (!url) return Promise.resolve(null);
    const cached = this.creatureTexCache.get(url);
    if (cached !== undefined) { if (cached) this.creatureTextureRegistry.touch(url); return Promise.resolve(cached); }
    const generation = this.assetGeneration;
    const signal = this.assetAbort.signal;
    return this.creatureTexPending.getOrCreate(url, () => loadOptimizedTexture(this.textureLoader, url, {
      signal, ownerId: `entities:${generation}`,
    }).then((tex) => {
      if (generation !== this.assetGeneration) { tex.dispose(); return null; }
      // Vanilla 1.12 did not sRGB-decode BLP textures; keep creature skins in raw texture space.
      if ('colorSpace' in tex) (tex as unknown as { colorSpace: string }).colorSpace = THREE.NoColorSpace;
      tex.flipY = false;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = (tex as THREE.Texture & { isCompressedTexture?: boolean }).isCompressedTexture !== true;
      tex.anisotropy = this.getTextureAnisotropy();
      tex.needsUpdate = true;
      this.creatureTexCache.set(url, tex);
      this.creatureTextureRegistry.register(url, tex);
      return tex;
    }));
  }

  private evictCreatureTexture(url: string): void {
    const texture = this.creatureTexCache.get(url);
    this.creatureTexCache.delete(url);
    if (!texture) return;
    for (const [key, material] of this.materialCache) {
      if ((material as THREE.ShaderMaterial).uniforms?.uMap?.value !== texture) continue;
      this.materialCache.delete(key); material.dispose();
    }
    // Descriptors embed these materials. Drop cache ownership; live roots retain resources via
    // their model leases, and later displays rebuild cheaply from the decoded model cache.
    this.assetCache.clear(); this.gameObjectAssetCache.clear();
  }

  /** Resolve a submesh's runtime texture URL from the per-display skin refs by M2 texture type. */
  private submeshTextureUrl(s: Submesh, display: DisplayJson): string | null {
    switch (s.textureType) {
      case 0: return s.type0Tex;                                   // hardcoded (model-baked)
      case 1: return display.bakeSkin;                             // character bake skin
      case 11: return display.skins[0] ?? null;                    // monster skin 1/2/3
      case 12: return display.skins[1] ?? display.skins[0] ?? null;
      case 13: return display.skins[2] ?? display.skins[0] ?? null;
      default: return display.skins[0] ?? null;
    }
  }

  private async fetchGameObjectAsset(displayId: number): Promise<CreatureDisplayAsset | null> {
    const generation = this.assetGeneration, signal = this.assetAbort.signal;
    const manifest = await this.loadGameObjectManifest();
    if (manifest && !manifest.has(displayId)) {
      throw new UnbakedGameObjectDisplayError(`display ${displayId} is absent from the full GameObject bake manifest`);
    }
    const display = await assetRequestQueue.run(async () => {
      const response = await fetch(`/gameobjects/display/${displayId}.json`, { signal });
      if (!response.ok) throw new Error(`display ${displayId} HTTP ${response.status}`);
      return await response.json() as GameObjectDisplayJson;
    }, { priority: 'critical', retries: 1, signal, ownerId: `entities:${generation}` });
    const model = await this.loadModel('gameobjects', display.model);
    if (!model) throw new Error(`display ${displayId} model ${display.model} failed to load`);
    const gpuSkinned = model.meta.bones.length > 0 && model.meta.sequences.length > 0
      && model.boneWeights.length > 0 && model.boneIndices.length > 0;

    const visible = display.visible?.length ? display.visible : model.meta.submeshes.map((_, i) => i);
    const parts = await Promise.all(visible.map(async (si) => {
      const s = model.meta.submeshes[si];
      if (!s) return null;
      const tex = await this.loadCreatureTexture(s.type0Tex);
      if (generation !== this.assetGeneration) throw new DOMException('stale entity asset generation', 'AbortError');
      if (s.type0Tex && !tex) throw new Error(`display ${displayId} texture ${s.type0Tex} failed to load`);
      return {
        indices: Array.from(model.indices.subarray(s.indexStart, s.indexStart + s.indexCount)),
        material: this.creatureMaterial(tex, s.blendMode, s.renderFlags, gpuSkinned),
      };
    }));
    const renderParts = parts.filter((p): p is { indices: number[]; material: THREE.Material } => !!p);
    const textures = [...new Set(model.meta.submeshes.map((s) => s.type0Tex).filter((u): u is string => !!u))];
    const data = {
      displayId,
      source: display.source ?? model.meta.source,
      scale: display.scale || 1,
      positions: model.positions as unknown as number[],
      normals: (model.normals ?? undefined) as unknown as number[] | undefined,
      uvs: model.uvs as unknown as number[],
      boneWeights: model.boneWeights as unknown as number[],
      boneIndices: model.boneIndices as unknown as number[],
      bones: model.meta.bones,
      attachments: model.meta.attachments,
      cameras: model.meta.cameras,
      sequences: model.meta.sequences,
      animLookup: model.meta.animLookup,
      parts: renderParts.map((p) => ({ indices: p.indices, tex: 0, blendMode: 0, renderFlags: 0 })),
      textures,
    } as unknown as CreatureDisplayJson;
    return { displayId, scale: data.scale || 1, data, parts: renderParts };
  }

  private async fetchCreatureAsset(displayId: number): Promise<LoadedAsset | null> {
    const generation = this.assetGeneration, signal = this.assetAbort.signal;
    const display = await assetRequestQueue.run(
      () => requestCreatureDisplayJson<DisplayJson>(displayId, signal),
      { priority: 'critical', retries: 1, signal, ownerId: `entities:${generation}` },
    );
    // Humanoid NPC → render through the player appearance pipeline (composited skin/face/hair + armor),
    // not the creature model. The creature geometry is skipped entirely for these.
    if (display.character) {
      if (!display.bakeSkin) { this.missingDisplayIds.add(displayId); return null; }
      return { displayId, humanoidCharacter: display.character, bakedBodyTextureUrl: display.bakeSkin };
    }
    const model = await this.loadModel('creatures', display.model);
    if (!model) { this.missingDisplayIds.add(displayId); return null; }
    const gpuSkinned = model.meta.bones.length > 0 && model.meta.sequences.length > 0
      && model.boneWeights.length > 0 && model.boneIndices.length > 0;

    // Build render parts only for the visible submeshes, resolving each one's texture by type.
    const visible = display.visible?.length ? display.visible : model.meta.submeshes.map((_, i) => i);
    const parts = await Promise.all(visible.map(async (si) => {
      const s = model.meta.submeshes[si];
      if (!s) return null;
      const tex = await this.loadCreatureTexture(this.submeshTextureUrl(s, display));
      if (generation !== this.assetGeneration) throw new DOMException('stale entity asset generation', 'AbortError');
      return {
        indices: Array.from(model.indices.subarray(s.indexStart, s.indexStart + s.indexCount)),
        material: this.creatureMaterial(tex, s.blendMode, s.renderFlags, gpuSkinned),
      };
    }));
    const renderParts = parts.filter((p): p is { indices: number[]; material: THREE.Material } => !!p);

    // Reconstruct the M2AnimationData/geometry shape the renderer + animator expect.
    const data = {
      displayId,
      source: model.meta.source,
      scale: display.scale || 1,
      positions: model.positions as unknown as number[],
      normals: (model.normals ?? undefined) as unknown as number[] | undefined,
      uvs: model.uvs as unknown as number[],
      boneWeights: model.boneWeights as unknown as number[],
      boneIndices: model.boneIndices as unknown as number[],
      bones: model.meta.bones,
      attachments: model.meta.attachments,
      cameras: display.cameras ?? model.meta.cameras,
      sequences: model.meta.sequences,
      animLookup: model.meta.animLookup,
      parts: renderParts.map((p) => ({ indices: p.indices, tex: 0, blendMode: 0, renderFlags: 0 })),
      // Accurate texture count for the inspector (skins actually wired to this display).
      textures: [...new Set([...display.skins, display.bakeSkin].filter((u): u is string => !!u))],
    } as unknown as CreatureDisplayJson;
    return { displayId, scale: data.scale || 1, data, parts: renderParts };
  }

  /**
   * Advance a remote player's interpolation target by their current velocity (dead reckoning).
   * Velocity is derived from the live movement flags + server-sent speeds and the facing, or from
   * the jump arc while airborne, including the vanilla parabolic Z path.
   */
  private predictionAgeMs(rendered: RenderedEntity, now: number, maxAgeMs: number) {
    const elapsedSincePacket = Math.max(0, now - (rendered.entity.updatedAt ?? now));
    const baseAge = rendered.entity.predictionAgeMs ?? 0;
    const age = rendered.entity.predictionAgeMs !== undefined ? baseAge + elapsedSincePacket : elapsedSincePacket;
    return Math.min(maxAgeMs, Math.max(0, age));
  }

  private deadReckonPlayer(rendered: RenderedEntity, flags: number, airborne: boolean, dt: number, now: number) {
    const target = rendered.renderTarget;
    if (!target) return airborne;
    const e = rendered.entity;
    // Only extrapolate for a bounded window after the last packet. If the mover stops sending (idle
    // with a stuck FALLING flag, mid-jump packet loss, or a logged-off entity awaiting destroy),
    // hold position instead of flying the target off to infinity — runaway is what left jumping
    // remote players "stuck floating" and unrecoverable until reload.
    // The mover's own packet decides which model solves this frame, not the `airborne` argument.
    // That argument is cleared for ANIMATION the moment our parabola touches down (and by the
    // ground-proximity guard in update()), but the mover keeps carrying the jump's locked-in
    // horizontal velocity until it sends FALL_LAND. Handing those frames to the grounded solver
    // rewound remote players (measured 1.4 yd on a flat forward jump) because the grounded
    // prediction window is 600 ms and a vanilla jump lasts 2*7.958/19.291 = 825 ms, so the solve
    // truncated a quarter of the flight — and it left them hovering at whatever height the parabola
    // had reached, since the terrain snap in update() only applies to UNITs, never PLAYERs.
    const packetFalling = (flags & (MOVEFLAG_FALLING | MOVEFLAG_FALLING_FAR)) !== 0 && e.jumpXYSpeed !== undefined;
    const solveAsJump = airborne || packetFalling;
    const packetAgeMs = this.predictionAgeMs(rendered, now, solveAsJump ? REMOTE_JUMP_MAX_MS : GROUND_PREDICTION_MAX_MS);
    const o = rendered.renderTargetO ?? rendered.group.rotation.z;
    if (!Number.isFinite(o)) return airborne;
    let vx = 0;
    let vy = 0;
    if (solveAsJump) {
      const ageMs = Math.max(0, Math.min(REMOTE_JUMP_MAX_MS, (e.fallTime ?? 0) + packetAgeMs));
      const t = ageMs / 1000;
      const jumpStart = e.jumpStartX !== undefined && e.jumpStartY !== undefined
        ? this.worldToLocal(e.jumpStartX, e.jumpStartY)
        : null;
      const sp = e.jumpXYSpeed ?? 0;
      if (sp > 0) {
        const cos = e.jumpCosAngle ?? Math.cos(o);
        const sin = e.jumpSinAngle ?? Math.sin(o);
        vx = cos * sp;
        vy = sin * sp;
        if (jumpStart) {
          target.x = jumpStart.x + vx * t;
          target.y = jumpStart.y + vy * t;
        } else {
          target.x += vx * dt;
          target.y += vy * dt;
        }
      }
      const jumpStartZ = e.jumpStartZ ?? e.z ?? target.z;
      const jumpVelocity = e.jumpVelocity ?? DEFAULT_JUMP_VELOCITY;
      target.z = jumpStartZ + jumpVelocity * t - 0.5 * WOW_JUMP_GRAVITY * t * t;
      if (this.sampleHeight && ageMs >= GROUNDED_JUMP_CLEAR_MS) {
        const ground = this.sampleHeight(target.x, target.y);
        if (Number.isFinite(ground) && target.z <= ground + 0.03) {
          target.z = ground;
          return false;
        }
      }
      return ageMs < REMOTE_JUMP_MAX_MS;
    }

    // Grounded. Solve the path ABSOLUTELY from the mover's own packet position rather than nudging
    // last frame's guess, so a bad frame can't accumulate. `extrapolateGroundMovement` owns the two
    // things this used to get wrong — turning traces an arc, and diagonals don't stack speed — with
    // the authorities written up in remote-extrapolation.ts.
    const base = e.x !== undefined && e.y !== undefined ? this.worldToLocal(e.x, e.y) : null;
    // Integrate the yaw from the PACKET's orientation, never from `o`. `o` is read out of
    // renderTargetO, which is where the integrated result gets published below — feeding that back
    // in re-integrates the whole packet age once per rendered frame instead of once per packet, so
    // a turning player spins up to omega x packetAge x framerate (~85 rad/s at 60fps against a real
    // turn rate of 2.36) and the arc chord whips them around a circle of radius speed/omega.
    // Position never had this problem because it has always solved absolutely from `base`; the yaw
    // has to be solved absolutely from `e.o` for exactly the same reason.
    const packetO = e.o ?? o;
    const step = extrapolateGroundMovement({
      x: base?.x ?? target.x,
      y: base?.y ?? target.y,
      o: packetO,
      flags,
      speeds: {
        walk: e.speeds?.walk ?? DEFAULT_WALK_SPEED,
        run: e.speeds?.run ?? DEFAULT_RUN_SPEED,
        runBack: e.speeds?.runBack ?? DEFAULT_BACK_SPEED,
        turnRate: e.speeds?.turnRate,
      },
      // A stationary turn gets the long window (it has no position component to run away, and the
      // mover sends nothing to correct it); anything that translates stays on the short one. With
      // no packet position to anchor to, the arc has no origin — advance by a single frame instead.
      ageSeconds: !base
        ? dt
        : (flags & MOVEFLAG_MASK_XZ) === 0
          ? this.predictionAgeMs(rendered, now, TURN_IN_PLACE_PREDICTION_MAX_MS) / 1000
          : Math.max(0, packetAgeMs) / 1000,
    });
    if (step) {
      target.x = step.x;
      target.y = step.y;
      // Publish the integrated facing. Without this the model holds the last packet's yaw for the
      // whole 500 ms heartbeat gap and then pivots all at once when the next packet lands, which is
      // the visual half of the same drift the arc fixes.
      if (step.o !== packetO) rendered.renderTargetO = step.o;
    }
    // The return value is "still airborne?", not "did move?". Returning true here made every remote
    // player running on the ground play Jump (animation 38) while moving.
    return false;
  }

  private advanceSpline(rendered: RenderedEntity) {
    const spline = rendered.entity.spline;
    const targetRendered = spline?.finalTargetGuid ? this.rendered.get(spline.finalTargetGuid) : undefined;
    const targetEntity = targetRendered?.entity;
    const target = targetRendered?.splinePresentation.world ?? (targetEntity?.x !== undefined && targetEntity.y !== undefined
      ? { x: targetEntity.x, y: targetEntity.y, z: targetEntity.z ?? 0 } : undefined);
    const frame = advanceUnitSplinePresentation(spline, rendered.splinePresentation, performance.now(), target);
    const sample = frame.world;
    if (!sample) {
      if (frame.retired) rendered.renderTarget = undefined;
      return false;
    }
    if (frame.retired) rendered.groundSettle = undefined;
    // Spline integration is a hot transform path. Calling upsert() here used to re-run model,
    // appearance, equipment, mount and ground-cache work for every moving NPC on every frame.
    const local = this.worldToLocal(sample.x, sample.y);
    if (local) {
      const hasModel = !!rendered.modelRoot && rendered.modelDisplayId === rendered.entity.displayId;
      const scale = Math.max(0.05, Math.min(5, rendered.entity.scale ?? rendered.modelScale ?? 1));
      const z = hasModel ? sample.z : sample.z + this.heightFor(rendered.entity) * scale * 0.5;
      rendered.group.position.set(local.x, local.y, z);
      rendered.group.rotation.z = sample.o;
      rendered.renderTarget = undefined; rendered.renderTargetO = undefined;
    }
    return frame.moving;
  }

  private creatureMaterial(texture: THREE.Texture | null, blendMode: number, renderFlags: number, gpuSkinning: boolean): THREE.Material {
    // Shared M2 material: same gamma-space hemispheric lighting + blend/flags as the player model,
    // driven by the scene-wide M2 light (setM2Light), so mobs/NPCs match the player and the world.
    const key = `${texture?.uuid ?? 'flat'}|${blendMode}|${renderFlags}|${gpuSkinning ? 1 : 0}`;
    let material = this.materialCache.get(key);
    if (!material) {
      material = createM2Material({ texture, blendMode, renderFlags, fallbackColor: 0xb3a07a, gpuSkinning });
      this.materialCache.set(key, material);
    }
    return material;
  }
}
