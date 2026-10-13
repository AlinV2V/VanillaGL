import * as THREE from 'three';
import type { PlayerPoseModifier } from './rendering/player-pose-modifier';
import { playerAnimationDuration } from './rendering/player-animation-duration';
import { checkedModelJson } from './platform/fetch-json';
import type { CharacterInfo } from './world';
import { getInterfaceCvars } from './ui/interface-runtime';
import { SHEATH_STATE_UNARMED, sheathJointFor, weaponAttachmentJoint } from './combat/virtual-items';
export { sheathJointFor } from './combat/virtual-items';
import { createM2Material } from './m2-material';
import { M2GpuSkinning, type M2StaticSkinAttributes } from './rendering/m2-gpu-skinning';
import { SharedM2GeometryPool } from './rendering/shared-m2-geometry-pool';
import { ByteBudgetPromiseCache } from './platform/byte-budget-promise-cache';
import { helmetGeosetHides } from './rendering/helmet-geoset-visibility';
import { advanceUpperBodyLayer, findHeadBone, playerLocomotionSequence, playerStrafePose, upperBodyBoneIndices } from './rendering/upper-body-bones';
import { createTrackKeyCursor, findTrackKey, type TrackKeyCursor } from './rendering/track-key-search';
import { m2SamplingMode } from './rendering/performance-controls';
import { recordM2Animator, shouldSampleM2AnimatorTiming } from './rendering/performance-subsystem-metrics';
import {
  BoundedTextureRegistry,
  retainSharedTextureForModel,
  releaseSharedTextureForModel,
  setSharedTextureDisposer,
} from './rendering/shared-texture-cache';
export const RACE_COLORS: Record<number, number> = {
  1: 0xd7b08a,
  2: 0x7aa15c,
  3: 0xc9a06e,
  4: 0x91a0df,
  5: 0xa6a2a0,
  6: 0x8a5f3d,
  7: 0xd0b7a0,
  8: 0x6db7a5,
};

export type BakedSection = {
  base: number;
  variation: number;
  color: number;
  textures: Array<string | null>;
};

export type BakedTrack = {
  interpolation: number;
  globalSequence: number;
  ranges: Array<[number, number]>;
  timestamps: number[];
  values: number[];
  components: number;
};

export type BakedBone = {
  keyBoneId: number;
  flags: number;
  parentIndex: number;
  pivot: [number, number, number];
  translation: BakedTrack;
  rotation: BakedTrack;
  scale: BakedTrack;
};

export type BakedAttachment = {
  id: number;
  bone: number;
  position: [number, number, number];
};

export type BakedCamera = {
  type: number;
  fov: number;
  farClip: number;
  nearClip: number;
  positionTrack: BakedTrack;
  positionBase: [number, number, number];
  targetTrack: BakedTrack;
  targetBase: [number, number, number];
  roll: BakedTrack;
};

export type BakedSequence = {
  id: number;
  variationIndex: number;
  timeStart: number;
  timeEnd: number;
  duration: number;
  moveSpeed: number;
  flags: number;
  frequency: number;
  blendTime: number;
};

export type BakedPart = {
  partId: number;
  boneCount: number;
  boneComboIndex: number;
  boneInfluences: number;
  centerBoneIndex: number;
  textureIndex: number;
  textureType: number;
  tex: number;
  blendMode?: number;
  renderFlags?: number;
  indices: number[];
};
/** Asset conversion utility. */
export const isEyeGlowPart = (data: BakedCharacterModel, part: BakedPart): boolean => {
  if (data.textureSlots[part.textureIndex]?.type !== 0) return false;
  const seen = new Set<number>();
  for (const index of part.indices) {
    const bone = data.boneIndices[index * 4];
    if (bone === undefined || seen.has(bone)) continue;
    seen.add(bone);
    if (!(data.bones[bone]?.flags & 0x08)) return false;
  }
  return seen.size > 0;
};

/**
 * EYE_GLOW_SEATING — why the glow needs no depth push at all.
 *
 * Build 5875 seats the glow and blinks it entirely inside the M2, with a global-sequence
 * TRANSLATION toggle on the glow bone (or its parent). Measured off the raw archives:
 *
 *   model            bone  authored |T|  values                     face in front of pivot
 *   NightElfMale     84    0.0573       [0.0573,0,0] <-> [0,0,0]    0.0102
 *   NightElfFemale   --    (none)       glow never moves            NO occluder at all
 *   UndeadMale       79/80 0.0609       [0,0,0] <-> [-0.0609,0,0]   NO occluder at all
 *   UndeadFemale     77/78 0.0437       [0,0,0] <-> [-0.0437,0,0]   NO occluder at all
 *
 * NightElfMale's track is ts [0,33,100,133,3533,3567,3600,3633,4033,4067,4100,4133,6700] over a
 * 6700 ms loop: it rests at 0.0573 (glow 4.7cm proud of the face, visible) and snaps to 0 for
 * ~100 ms three times per loop, which drops the quad 1cm BEHIND the opaque face. The face occludes
 * it and the glow reads as blinking off. Undead do the same with the sign reversed. That retract IS
 * the blink for the glow — it is NOT the human eyelid mechanism, which scales an eyelid bone to
 * zero (HumanMale bone 75 scale, gs 1, 6633 ms; NightElf has its own on bone 74 male / 77 female
 * for the SKIN eyelid, separately from the glow).
 *
 * A depth push on top of that breaks the trick twice: it shoves the resting glow further out of the
 * socket, and it lifts the retracted position back in front of the face, so instead of blinking off
 * the glow visibly jumps 5.7cm and returns. The reporter saw exactly that ("outside the socket,
 * glitching, jumping"). The model is already correct — render it as authored.
 */
export type BakedCharacterModel = {
  source: string;
  positions: number[];
  normals?: number[];
  uvs: number[];
  boneWeights: number[];
  boneIndices: number[];
  parts: BakedPart[];
  textures: string[];
  textureSlots: Array<{ type: number; flags: number; filename: string; file: number }>;
  appearance: {
    sections: BakedSection[];
    hairGeosets: Array<{ variation: number; geoset: number; showsScalp: boolean }>;
    facialHairGeosets: Array<{ variation: number; geosets: number[] }>;
  };
  sequences: BakedSequence[];
  globalSequences?: number[];
  animLookup: number[];
  bones: BakedBone[];
  attachments?: BakedAttachment[];
  cameras?: BakedCamera[];
};

type BakedItemAttachmentPart = {
  partId: number;
  textureIndex: number;
  tex: number;
  blendMode?: number;
  renderFlags?: number;
  indices: number[];
};

type BakedItemAttachmentAsset = {
  kind: string;
  jointId: number;
  source: string;
  positions: number[];
  normals?: number[];
  uvs: number[];
  textures: string[];
  parts: BakedItemAttachmentPart[];
};

type BakedItemAttachmentRef = {
  kind?: string;
  jointId: number;
  asset: string;
  source?: string;
  race?: number;
  gender?: number;
  inventoryTypes?: number[];
};

export type PlayerAnimState =
  | 'stand'
  | 'walk'
  | 'run'
  | 'walkBack'
  | 'turnLeft'
  | 'turnRight'
  | 'jumpStart'
  | 'jump'
  | 'jumpEnd'
  | 'swim'
  | 'swimIdle'
  | 'strafeLeft'
  | 'strafeRight';

export type PlayerAnimator = {
  setPoseModifier?: (modifier: PlayerPoseModifier | null) => void;
  update: (dt: number, state: PlayerAnimState, camera?: THREE.Camera, group?: THREE.Group) => void;
  updateAnimationId?: (dt: number, animationId: number, camera?: THREE.Camera, group?: THREE.Group) => void;
  updateUpperBody?: (dt: number, state: PlayerAnimState, animationId: number, camera?: THREE.Camera, group?: THREE.Group) => void;
  getAnimationDurationMs?: (animationId: number) => number | undefined;
  getAttachmentMatrix?: (jointId: number, target?: THREE.Matrix4) => THREE.Matrix4 | null;
  bindGroup?: (group: THREE.Object3D) => void;
  getSkinnedPosition?: (vertexIndex: number, target?: THREE.Vector3) => THREE.Vector3;
  dispose?: () => void;
};

export interface LoadedPlayerModel {
  group: THREE.Group;
  animator: PlayerAnimator | null;
  data: BakedCharacterModel;
  headCentroid: { x: number; y: number; z: number };
  /** Current skinned head center; used by character-create/inspect cameras after Stand is sampled. */
  getHeadCentroid: () => { x: number; y: number; z: number };
  /** Move weapons/shield between hands (drawn) and vanilla sheath points (hips/back). */
  /** Takes UNIT_FIELD_BYTES_2 byte 0 (0 unarmed / 1 melee / 2 ranged), not a drawn flag. */
  setWeaponsSheathed: (sheathState: number) => void;
  /** Mounted item mesh for an EQUIPMENT_SLOT (15 main, 16 off, 17 ranged). */
  getEquipmentAttachmentRoot: (slot: number) => THREE.Group | undefined;
  dispose: () => void;
}

const textureLoader = new THREE.TextureLoader();
const APPEARANCE_ATLAS_VERSION = 7;
// NPCs reuse a handful of race/gender models and appearance combos. Cache the parsed model JSON,
// equipment info, plain textures, and composited appearance textures so N visible NPCs don't mean
// N multi-MB JSON parses + N canvas composites + N GPU uploads (a major RAM/VRAM multiplier in
// NPC-dense starting zones). Shared textures are excluded from per-model dispose().
const modelJsonCache = new ByteBudgetPromiseCache<string, BakedCharacterModel>(128 * 1024 * 1024, 16);
const characterGeometryPool = new SharedM2GeometryPool();
const equipInfoCache = new Map<string, Promise<any | null>>();
const urlTextureCache = new Map<string, Promise<THREE.Texture | null>>();
const attachmentJsonCache = new ByteBudgetPromiseCache<string, BakedItemAttachmentAsset | null>(64 * 1024 * 1024, 512);
const appearanceCache = new Map<string, Promise<{ body: THREE.Texture; hair: THREE.Texture; cape: THREE.Texture | null; itemInfos: any[] }>>();
const sharedTextures = new Set<THREE.Texture>();

// Bounded, ref-counted registries keep shared URL/appearance textures alive only while models use them.
const MAX_URL_TEXTURES = 768;
const MAX_APPEARANCE_ATLASES = 256;
setSharedTextureDisposer((tex) => {
  sharedTextures.delete(tex);
  tex.dispose();
});
const urlTextureRegistry = new BoundedTextureRegistry<THREE.Texture>(
  MAX_URL_TEXTURES,
  (tex) => [tex],
  (url) => urlTextureCache.delete(url),
);
const appearanceRegistry = new BoundedTextureRegistry<{ body: THREE.Texture; hair: THREE.Texture; cape: THREE.Texture | null }>(
  MAX_APPEARANCE_ATLASES,
  (a) => Array.from(new Set([a.body, a.hair, a.cape].filter((texture): texture is THREE.Texture => !!texture))),
  (key) => appearanceCache.delete(key),
);

function fetchEquipInfo(eqBase: string): Promise<any | null> {
  let promise = equipInfoCache.get(eqBase);
  if (!promise) {
    promise = fetch(`${eqBase}/info.json`)
      .then((res) => {
        if (res.status === 404 || res.headers.get('content-type')?.includes('text/html')) return null; if (!res.ok) throw new Error(`${eqBase}/info.json HTTP ${res.status}`);
        return res.json();
      })
      .catch(() => { equipInfoCache.delete(eqBase); return null; });
    equipInfoCache.set(eqBase, promise);
  }
  return promise;
}
function configureTexture(tex: THREE.Texture, maxAnisotropy: number, options: { repeat?: boolean } = {}) {
  // Vanilla 1.12 consumed texture bytes directly; avoid a modern browser sRGB decode pass.
  if ('colorSpace' in tex) (tex as any).colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.anisotropy = maxAnisotropy;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = (tex as THREE.Texture & { isCompressedTexture?: boolean }).isCompressedTexture !== true;
  if (options.repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

async function loadTextureUrl(url: string, maxAnisotropy: number): Promise<THREE.Texture | null> {
  let promise = urlTextureCache.get(url);
  if (!promise) {
    promise = textureLoader
      .loadAsync(url)
      .then((tex) => {
        sharedTextures.add(tex);
        const configured = configureTexture(tex, maxAnisotropy);
        urlTextureRegistry.register(url, configured);
        return configured;
      })
      .catch(() => { urlTextureCache.delete(url); return null; });
    urlTextureCache.set(url, promise);
  } else {
    urlTextureRegistry.touch(url);
  }
  return promise;
}

async function fetchAttachmentAsset(url: string): Promise<BakedItemAttachmentAsset | null> {
  let promise = attachmentJsonCache.get(url);
  if (!promise) {
    promise = fetch(url)
      .then((res) => {
        if (res.status === 404 || res.headers.get('content-type')?.includes('text/html')) return null; if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
        return res.json() as Promise<BakedItemAttachmentAsset>;
      })
      .catch(() => { attachmentJsonCache.delete(url); return null; });
    attachmentJsonCache.set(url, promise);
  }
  return promise;
}

async function createAttachmentGroup(
  baseUrl: string,
  rel: string,
  maxAnisotropy: number,
  jointIdOverride?: number,
): Promise<{ jointId: number; group: THREE.Group } | null> {
  const asset = await fetchAttachmentAsset(`${baseUrl}/${rel}`);
  if (!asset?.positions?.length || !asset.parts?.length) return null;

  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const pos = new THREE.Float32BufferAttribute(new Float32Array(asset.positions), 3);
  const normal =
    asset.normals?.length === asset.positions.length
      ? new THREE.Float32BufferAttribute(new Float32Array(asset.normals), 3)
      : null;
  const uv = new THREE.Float32BufferAttribute(asset.uvs, 2);
  const textures = await Promise.all(asset.textures.map((name) => loadTextureUrl(`${baseUrl}/${name}`, maxAnisotropy)));

  for (const part of asset.parts) {
    if (!part.indices?.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', pos);
    if (normal) geo.setAttribute('normal', normal);
    geo.setAttribute('uv', uv);
    geo.setIndex(Array.isArray(part.indices) ? part.indices : new THREE.BufferAttribute(part.indices, 1));
    if (!normal) geo.computeVertexNormals();

    const rawBlend = part.blendMode ?? 0;
    // Additive 3/4 batches are the Vanilla sphere-mapped shine overlay. The opaque diffuse
    // submesh remains underneath; forcing the shine pass opaque covered the authored blade/armor
    // texture with a flat gray reflection.
    const envShine = rawBlend === 3 || rawBlend === 4;
    const mat = createM2Material({
      texture: textures[part.tex] ?? null,
      blendMode: rawBlend,
      renderFlags: part.renderFlags ?? 0,
      fallbackColor: 0xb3a07a,
      envMap: envShine,
      // Attachment bone transforms can reverse winding. Limit the two-sided correction to
      // equipment so character skin, socket, and hair backfaces remain hidden.
      forceDoubleSided: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // Rigid equipment moves through the attachment group's matrix (marked dirty on each bone update).
    // Three transforms this local sphere by mesh.matrixWorld, including the current socket and entity.
    // Unlike skinned body geometry, its vertices have no additional shader displacement.
    geo.computeBoundingSphere();
    group.add(mesh);
  }

  return group.children.length ? { jointId: jointIdOverride ?? asset.jointId, group } : null;
}

/**
 * Build the exact projectile model named by SMSG_SPELL_START/GO's CAST_FLAG_AMMO payload.
 *
 * vMaNGOS sends an ItemDisplayInfo id, not a generic "arrow vs bullet" enum. Ammo display rows
 * resolve to Item\ObjectComponents\Ammo while thrown weapons reuse their ordinary ranged
 * attachment. Both are already represented by the patch-first equipment bake.
 */
export async function loadBakedProjectileModel(
  displayInfoId: number,
  inventoryType: number,
  maxAnisotropy: number,
): Promise<THREE.Group | null> {
  if (!displayInfoId) return null;
  for (const gender of [0, 1]) {
    const baseUrl = `/equipment/${displayInfoId}_${gender}`;
    const info = await fetchEquipInfo(baseUrl);
    if (!info) continue;
    const refs = (info.attachments ?? []) as BakedItemAttachmentRef[];
    const ref = refs.find((candidate) => (
      candidate.kind === 'projectile'
      && (!candidate.inventoryTypes || candidate.inventoryTypes.includes(inventoryType))
    )) ?? refs.find((candidate) => (
      candidate.kind === 'ranged'
      && (!candidate.inventoryTypes || candidate.inventoryTypes.includes(inventoryType))
    ));
    if (!ref?.asset) continue;
    const loaded = await createAttachmentGroup(baseUrl, ref.asset, maxAnisotropy, 0);
    if (!loaded) continue;
    // Character attachments use a manual bone matrix. A projectile is instead positioned and
    // oriented every frame by SpellVisualController.
    loaded.group.matrixAutoUpdate = true;
    loaded.group.updateMatrix();
    return loaded.group;
  }
  return null;
}

export type MountedAttachment = {
  jointId: number;             // current joint (drawn or sheathed)
  group: THREE.Group;
  drawnJointId: number;
  sheathedJointId: number | 'hide' | null; // null = not a hand/shield item (shoulders etc.)
  hidden?: boolean;            // 'hide' items (books/orbs) while sheathed
  equipmentSlot?: number;
};

export type LoadedEquipmentAttachment = MountedAttachment & { dispose: () => void };

async function loadItemAttachments(itemInfos: any[], character: CharacterInfo, maxAnisotropy: number, sheathState: number) {
  const attachments: MountedAttachment[] = [];
  for (const info of itemInfos) {
    if (!info?.baseUrl) continue;
    for (const attachment of (info.attachments ?? []) as BakedItemAttachmentRef[]) {
      if (!attachment?.asset || typeof attachment.jointId !== 'number') continue;
      if (typeof attachment.race === 'number' && attachment.race !== character.race) continue;
      if (typeof attachment.gender === 'number' && attachment.gender !== character.gender) continue;
      if (Array.isArray(attachment.inventoryTypes) && !attachment.inventoryTypes.includes(info.inventoryType)) continue;
      const loaded = await createAttachmentGroup(info.baseUrl, attachment.asset, maxAnisotropy, attachment.jointId);
      if (loaded) {
        const sheathedJointId = sheathJointFor(loaded.jointId, info.inventoryType, info.sheath, attachment.source);
        const initialJoint = weaponAttachmentJoint(sheathState, info.slot, loaded.jointId, sheathedJointId);
        attachments.push({
          ...loaded,
          jointId: typeof initialJoint === 'number' ? initialJoint : loaded.jointId,
          drawnJointId: loaded.jointId,
          sheathedJointId,
          hidden: initialJoint === 'hide',
          equipmentSlot: info.slot,
        });
      }
    }
  }
  return attachments;
}

/**
 * Load weapon/shield item M2s for a creature rig. ItemDisplayInfo uses the same baked assets as
 * player equipment; the owning creature M2 supplies the attachment matrices. Slot wins over the
 * item's generic InventoryType so a one-hand weapon placed in virtual slot 1 mounts on attachment 2.
 */
export async function loadBakedCreatureEquipmentAttachments(
  equipment: readonly {
    displayInfoId: number;
    inventoryType: number;
    sheath?: number;
    slot?: number;
  }[],
  maxAnisotropy: number,
  sheathState = SHEATH_STATE_UNARMED,
): Promise<LoadedEquipmentAttachment[]> {
  const mounted: LoadedEquipmentAttachment[] = [];
  for (const item of equipment) {
    if (!item.displayInfoId) continue;
    let finished = false;
    for (const gender of [0, 1]) {
      const baseUrl = `/equipment/${item.displayInfoId}_${gender}`;
      const info = await fetchEquipInfo(baseUrl);
      if (!info) continue;
      const refs = (info.attachments ?? []) as BakedItemAttachmentRef[];
      // Creature virtual slots are reshaped to the player equipment-slot numbers before they reach
      // the renderer (15 main, 16 off, 17 ranged). Accept raw 0/1/2 as well so this loader stays
      // usable directly against decoded UNIT_VIRTUAL_ITEM_* in tests and diagnostics.
      const preferredKind = item.slot === 1 || item.slot === 16
        ? (item.inventoryType === 14 ? 'shield' : item.inventoryType === 23 ? 'holdable' : 'offHand')
        : item.slot === 2 || item.slot === 17
          ? 'ranged'
          : 'mainHand';
      const ref = refs.find((candidate) => candidate.kind === preferredKind && !!candidate.asset)
        ?? refs.find((candidate) => (
          !!candidate.asset
          && (!candidate.inventoryTypes || candidate.inventoryTypes.includes(item.inventoryType))
        ));
      if (!ref?.asset) continue;
      const loaded = await createAttachmentGroup(baseUrl, ref.asset, maxAnisotropy, ref.jointId);
      if (!loaded) continue;

      const retainedTextures = new Set<THREE.Texture>();
      loaded.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          const uniforms = (material as THREE.ShaderMaterial).uniforms;
          const map = (material as { map?: THREE.Texture }).map ?? uniforms?.uMap?.value;
          if (map instanceof THREE.Texture && sharedTextures.has(map)) retainedTextures.add(map);
        }
      });
      for (const texture of retainedTextures) retainSharedTextureForModel(texture);
      let disposed = false;
      const sheathedJointId = sheathJointFor(loaded.jointId, item.inventoryType, item.sheath, ref.source);
      const initialJoint = weaponAttachmentJoint(sheathState, item.slot, loaded.jointId, sheathedJointId);
      loaded.group.visible = initialJoint !== 'hide';
      mounted.push({
        ...loaded,
        jointId: typeof initialJoint === 'number' ? initialJoint : loaded.jointId,
        drawnJointId: loaded.jointId,
        sheathedJointId,
        equipmentSlot: item.slot,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          loaded.group.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            child.geometry.dispose();
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) material.dispose();
          });
          for (const texture of retainedTextures) releaseSharedTextureForModel(texture);
        },
      });
      finished = true;
      break;
    }
    if (!finished) continue;
  }
  return mounted;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
}

function createCanvasTexture(canvas: HTMLCanvasElement, maxAnisotropy: number) {
  const tex = new THREE.CanvasTexture(canvas);
  return configureTexture(tex, maxAnisotropy);
}

function selectSection(sections: BakedSection[], base: number, variation: number, color: number) {
  return (
    sections.find((s) => s.base === base && s.variation === variation && s.color === color) ??
    sections.find((s) => s.base === base && s.variation === variation) ??
    sections.find((s) => s.base === base && s.color === color) ??
    sections.find((s) => s.base === base)
  );
}

async function drawComponent(ctx: CanvasRenderingContext2D, baseUrl: string, rel: string | null | undefined, x: number, y: number) {
  if (!rel) return;
  try {
    const img = await loadImage(`${baseUrl}/${rel}`);
    ctx.drawImage(img, x, y);
  } catch {
    /* Missing optional character overlays are expected for some race/gender choices. */
  }
}

async function buildAppearanceTextures(data: BakedCharacterModel, character: CharacterInfo, baseUrl: string, maxAnisotropy: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const tint = new THREE.Color(RACE_COLORS[character.race] ?? 0xd8c0a0);
  ctx.fillStyle = `rgb(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const sections = data.appearance.sections;
  const skin = selectSection(sections, 0, 0, character.skin);
  const face = selectSection(sections, 1, character.face, character.skin);
  const facial = selectSection(sections, 2, character.facialHair, character.hairColor);
  const hair = selectSection(sections, 3, character.hairStyle, character.hairColor);
  const itemInfos: any[] = [];
  for (const item of character.equipment ?? []) {
    if (!item.displayInfoId) continue;
    const eqBase = `/equipment/${item.displayInfoId}_${character.gender}`;
    try {
      const info = await fetchEquipInfo(eqBase);
      if (!info) continue;
      itemInfos.push({ ...info, baseUrl: eqBase, displayInfoId: item.displayInfoId, inventoryType: item.inventoryType, sheath: item.sheath, slot: item.slot });
    } catch { /* item not baked */ }
  }

  await drawComponent(ctx, baseUrl, skin?.textures[0] ?? skin?.textures[1] ?? skin?.textures[2], 0, 0);

  // CHR-06: CharSections type 4 = underwear, matched by skin color. The client composites it
  // directly over the skin and UNDER any equipment components, so naked characters wear the
  // pelvic wrap (textures[0] -> LegUpper region) and females the chest wrap (textures[1] ->
  // TorsoUpper region) instead of bare skin.
  const underwear = selectSection(sections, 4, 0, character.skin);
  await drawComponent(ctx, baseUrl, underwear?.textures[0], 128, 96);
  await drawComponent(ctx, baseUrl, underwear?.textures[1], 128, 0);

  const q = new URLSearchParams(location.search);
  if (q.get('nooverlay') === null) {
    // The client always composites BOTH face sections: FaceLower at (0,192) 128x64 and
    // FaceUpper at (0,160) 128x32 (the upper section carries the eyes/brows on several
    // race/face combos — gating it behind a debug flag left those faces eyeless).
    await drawComponent(ctx, baseUrl, face?.textures[0], 0, 192);
    await drawComponent(ctx, baseUrl, face?.textures[1], 0, 160);

    // CharSections type 3 layers [hair, scalpLower, scalpUpper] — the hairline painted on the head.
    // They follow the hair MESH, not ShowScalp (which gates the bald head-cap submesh chosen below).
    // Client spec, Human Male: style 0 is bald, ShowScalp=1, composites NOTHING; styles 1-11 have
    // ShowScalp=0 and DO composite. Gating on ShowScalp inverted that and skipped 116 of the 144
    // styles that ship these layers. Bald paints nothing; a hair-hiding helmet still forces them on.
    const hairRows = data.appearance.hairGeosets.filter((row) => row.variation === character.hairStyle);
    const styleUsesHairMesh = hairRows.length === 0 || hairRows.some((row) => row.geoset > 0);
    if (styleUsesHairMesh || helmetGeosetHides(itemInfos, character.race, 'hair')) {
      await drawComponent(ctx, baseUrl, hair?.textures[1], 0, 192);
      await drawComponent(ctx, baseUrl, hair?.textures[2], 0, 160);
    }

    if (q.get('nofacial') === null && !helmetGeosetHides(itemInfos, character.race, 'beard')) {
      await drawComponent(ctx, baseUrl, facial?.textures[0], 0, 192);
      await drawComponent(ctx, baseUrl, facial?.textures[1], 0, 160);
    }
  }

  const EQUIP_REGIONS: Record<string, [number, number, number, number]> = {
    armUpper: [0, 0, 128, 64],
    armLower: [0, 64, 128, 64],
    hand: [0, 128, 128, 32],
    torsoUpper: [128, 0, 128, 64],
    torsoLower: [128, 64, 128, 32],
    legUpper: [128, 96, 128, 64],
    legLower: [128, 160, 128, 64],
    foot: [128, 224, 128, 32],
  };

  // Composite body-texture components in the client's CharComponentTextureSections order, NOT the

  // (7-9) BEFORE ChestTorso/ChestPants (11-12), then Gloves (13) — so a robe's leg texture
  // (ChestPants) must paint OVER the equipped pants (Pants). In equipment order the pants often
  // drew last and the robe skirt showed the darker pants texture instead of the blue robe (Henmond).
  // Keyed by inventoryType; non-body slots (head/shoulder/weapon) carry no torso/leg component so
  // their order is irrelevant — a neutral middle key keeps them stable.
  const COMPONENT_LAYER: Record<number, number> = { 4: 0, 7: 1, 8: 2, 5: 3, 20: 3, 6: 4, 10: 5, 19: 6 };
  const layerOf = (info: any) => COMPONENT_LAYER[info.inventoryType as number] ?? 3;
  const orderedInfos = [...itemInfos].sort((a, b) => layerOf(a) - layerOf(b));
  for (const info of orderedInfos) {
    const eqBase = info.baseUrl;
    try {
      for (const [key, file] of Object.entries(info.components ?? {})) {
        const region = EQUIP_REGIONS[key];
        if (!region) continue;
        try {
          const img = await loadImage(`${eqBase}/${file as string}`);
          ctx.drawImage(img, region[0], region[1], region[2], region[3]);
        } catch { /* missing component png */ }
      }
    } catch { /* item not baked */ }
  }

  if (q.get('facedebug') !== null) {
    ctx.fillStyle = 'rgba(255,0,0,1)';
    ctx.fillRect(68, 246, 26, 10);
    ctx.fillStyle = 'rgba(0,80,255,0.8)';
    ctx.fillRect(0, 230, 30, 12);
  }

  // ALPHA QA: expose the composited 256x256 atlas for the ?atlas inspector view (main.ts).
  (window as unknown as { __bodyCanvas?: HTMLCanvasElement }).__bodyCanvas = canvas;

  const body = createCanvasTexture(canvas, maxAnisotropy);
  body.flipY = false;
  body.needsUpdate = true;
  const hairUrl = hair?.textures[0] || null;
  const hairTexture = hairUrl ? await loadTextureUrl(`${baseUrl}/${hairUrl}`, maxAnisotropy) : null;
  const capeInfo = [...itemInfos].reverse().find((info) => info.inventoryType === 16 && info.capeTexture), cape = capeInfo ? await loadTextureUrl(`${capeInfo.baseUrl}/${capeInfo.capeTexture}`, maxAnisotropy) : null;
  return { body, hair: hairTexture ?? body, cape, itemInfos };
}

async function buildNpcAppearanceTextures(
  data: BakedCharacterModel,
  character: CharacterInfo,
  baseUrl: string,
  bakedBodyTextureUrl: string,
  maxAnisotropy: number,
) {
  const sections = data.appearance.sections;
  const hair = selectSection(sections, 3, character.hairStyle, character.hairColor);
  const hairUrl = hair?.textures[0] || null;

  const [body, hairTexture, itemInfos] = await Promise.all([
    loadTextureUrl(bakedBodyTextureUrl, maxAnisotropy),
    hairUrl ? loadTextureUrl(`${baseUrl}/${hairUrl}`, maxAnisotropy) : Promise.resolve(null),
    Promise.all(
      (character.equipment ?? [])
        .filter((item) => item.displayInfoId > 0)
        .map(async (item) => {
          const eqBase = `/equipment/${item.displayInfoId}_${character.gender}`;
          const info = await fetchEquipInfo(eqBase);
          return info ? { ...info, baseUrl: eqBase, displayInfoId: item.displayInfoId, inventoryType: item.inventoryType, sheath: item.sheath, slot: item.slot } : null;
        }),
    ),
  ]);

  if (!body) throw new Error(`NPC baked body texture unavailable: ${bakedBodyTextureUrl}`);
  const resolvedItemInfos = itemInfos.filter(Boolean);
  const capeInfo = [...resolvedItemInfos].reverse().find((info) => info.inventoryType === 16 && info.capeTexture);
  const cape = capeInfo ? await loadTextureUrl(`${capeInfo.baseUrl}/${capeInfo.capeTexture}`, maxAnisotropy) : null;
  return { body, hair: hairTexture ?? body, cape, itemInfos: resolvedItemInfos };
}

function getItemType(components: Record<string, string>): 'chest' | 'gloves' | 'boots' | 'pants' | 'unknown' {
  if ('torsoUpper' in components || 'torsoLower' in components) return 'chest';
  if ('hand' in components) return 'gloves';
  if ('foot' in components) return 'boots';
  if ('legUpper' in components) return 'pants';
  return 'unknown';
}

function computeBodyGeosets(parts: BakedPart[], itemInfos: any[] = []) {
  const result = new Set<number>();

  // Naked defaults = the "x01" skin variant of each group ONLY (bare hands 401, feet 501,
  // briefs 1301, neck/horns 1501…). Groups that ship only higher variants (sleeves 802/803, kneepads
  // 902/903, trousers 1102/1103) are pure clothing and MUST stay hidden on a naked body — otherwise it
  // renders flared bell-sleeves / pant-cuffs (regression if this uses min-per-group instead). The
  // equipment logic below overrides per-group when items are actually worn.
  for (const p of parts) {
    const group = Math.floor(p.partId / 100);
    if (p.partId >= 400 && p.partId % 100 === 1 && group !== 10) result.add(p.partId);
  }

  // EARS (group 700) are the one exception to the x01 rule: in the vanilla client "show ears" is
  // the default and maps to geoset 702 (701 = ears hidden). Trolls only ship 702 — under the x01
  // rule they rendered with no ears at all. Dwarf/Night Elf males have no group 700 (ears are part
  // of the head mesh), which is fine.
  const ear702 = parts.some((p) => p.partId === 702);
  if (ear702) {
    result.delete(701);
    result.add(702);
  }

  // Naked character: just return the base body defaults (no robes or flares)
  if (!itemInfos || itemInfos.length === 0) {
    return result;
  }

  let hasRobe = false;
  let robeVar = 0;
  let hasBoots = false;
  let bootsVar = 0;
  let hasGloves = false;
  let glovesVar = 0;
  let hasPants = false;
  let pantsVar = 0;
  let hasChest = false;
  let hasTabard = false;

  for (const info of itemInfos) {
    const comps = info.components ?? {};
    const type = getItemType(comps);
    const gs = info.geosetGroups ?? [0, 0, 0];

    // InventoryType 19 is a tabard. Character M2 group 10 uses x01 for hidden and x02
    // for the cloth flap; the previous naked-default pass omitted the group but never
    // enabled it again when a tabard was equipped.
    if (info.inventoryType === 19) hasTabard = true;

    if (type === 'chest') {
      hasChest = true;
      // Build-5875 ItemDisplayInfo fields 6..8 are baked in wire order. Robe displays such as
      // Apprentice's Robe 12647 are [1,0,1]; GeosetGroup[2] selects the robe skirt.
      if (gs[2] > 0 || info.inventoryType === 20) {
        hasRobe = true;
        robeVar = Math.max(robeVar, gs[2]);
      }
    } else if (type === 'boots') {
      hasBoots = true;
      bootsVar = gs[0];
    } else if (type === 'gloves') {
      hasGloves = true;
      glovesVar = gs[0];
    } else if (type === 'pants') {
      hasPants = true;
      pantsVar = gs[1];
      // Kilts are legs items that carry the robe-skirt geoset in group 3
      // (same slot chest robes use). Without this they lose their skirt.
      if (gs[2] > 0) {
        hasRobe = true;
        robeVar = Math.max(robeVar, gs[2]);
      }
    }
  }

  const deleteGroup = (groupNum: number) => {
    for (const id of Array.from(result)) {
      if (Math.floor(id / 100) === groupNum) {
        result.delete(id);
      }
    }
  };

  // Not every model ships every variant (the ear rule already special-cases
  // 702-only trolls). Adding a geoset the mesh lacks after deleting the base
  // leaves the region bare — trolls lost their whole lower body to a robe
  // variant they don't have. Snap to the closest shipped variant instead, and
  // report whether anything was actually enabled so callers can decide whether
  // to hide the skin underneath.
  const shipped = new Set(parts.map((part) => part.partId));
  const swapToVariant = (groupNum: number, variant: number): boolean => {
    for (let v = variant; v >= 0; v--) {
      const candidate = groupNum * 100 + v + 1;
      if (shipped.has(candidate)) {
        deleteGroup(groupNum);
        result.add(candidate);
        return v > 0; // reached a real clothing variant, not just the x01 base
      }
    }
    return false;
  };

  // Robe skirt (Group 1300)
  if (hasRobe) {
    const skirtShown = swapToVariant(13, robeVar);
    // The skirt covers the legs, so hide shins (Group 5) and thighs (Group 11)
    // — but only when it actually rendered, or the character turns invisible
    // below the waist.
    if (skirtShown) {
      deleteGroup(5);
      deleteGroup(11);
    }
  }

  // Boots/lower-leg flare (Group 500). Group 700 is the head-height ear geometry (701/702);
  // swapping it for boots was visibly changing ears instead of footwear.
  if (hasBoots && bootsVar > 0) {
    swapToVariant(5, bootsVar);
  }

  // Gloves (Group 400). Group 800 contains sleeve/wrist clothing and is not the hand variant.
  if (hasGloves && glovesVar > 0) {
    swapToVariant(4, glovesVar);
  }

  // Pants/kneepad cuffs (Group 900) - only if not wearing a robe. Group 500 is boots.
  if (!hasRobe && hasPants && pantsVar > 0) {
    swapToVariant(9, pantsVar);
  }

  // Chest doublet (Group 400)
  if (hasChest) {
    result.add(401);
  }

  if (hasTabard && parts.some((part) => part.partId === 1002)) {
    deleteGroup(10);
    result.add(1002);
  }

  // KNOWN GAP (unfixed, do not "fix" blind): group 12 ships exactly one variant on the character
  // models — HumanMale has 1202 and no 1201 — so the x01 default rule can never select it, and no
  // other code path references it. Geoset 1202 is therefore unreachable on every character.
  // Force-enabling it was tested against display 2072 (?creature=2072): the mesh count rose 17->18,
  // confirming it renders, but the back gap that prompted the investigation did NOT change, so what
  // 1202 represents is still unknown. Recover its meaning from CharComponent/ItemDisplayInfo geoset
  // fields before wiring it, rather than enabling it speculatively.

  return result;
}

function visibleCharacterPart(
  data: BakedCharacterModel,
  character: CharacterInfo,
  part: BakedPart,
  bodyGeosets: Set<number>,
  itemInfos: any[],
) {
  const partId = part.partId;
  if (partId === 0) return true;

  const hideHair = new URLSearchParams(location.search).get('nohair') !== null;
  const helmetHidesHair = helmetGeosetHides(itemInfos, character.race, 'hair');
  const helmetHidesBeard = helmetGeosetHides(itemInfos, character.race, 'beard');
  const helmetHidesEars = helmetGeosetHides(itemInfos, character.race, 'ears');
  const helmetHidesHorns = helmetGeosetHides(itemInfos, character.race, 'horns');
  const helmetHidesExtra = helmetGeosetHides(itemInfos, character.race, 'extra');
  const hairRows = data.appearance.hairGeosets.filter((row) => row.variation === character.hairStyle);
  if (partId > 0 && partId < 100) {
    // Group 0 is the CharHairGeosets family. A style can deliberately select both a
    // skin-textured scalp/head-cap submesh and a type-6 hair card with the same part id;
    // filtering the skin submeshes by face+1 rendered TWO unrelated hairstyles at once,
    // causing scalp/head geometry to clip through long hair. Face variation is supplied
    // by CharSections atlas layers, not by swapping this geoset group.
    if (hideHair || helmetHidesHair) return false;
    if (!hairRows.length) return partId === 1;
    return hairRows.some((hair) => partId === (hair.geoset === 0 ? 1 : hair.geoset));
  }
  if ((hideHair || helmetHidesBeard) && partId >= 100 && partId < 400) return false;
  // Helmets hide ears/horns/extras — NOT the neck. Group 15 starts at 1501, which is the neck base
  // (see the x01 default rule in computeBodyGeosets, "neck/horns 1501"); 1502+ are the ear/horn/
  // extra variants a helmet is allowed to remove. Hiding the whole 1501-1510 range deleted the neck
  // along with them, leaving an open hole between the shoulders on every helmeted character —
  // visible on NPC display 2072 (?creature=2072). Start the hide range at 1502.
  if (helmetHidesEars && partId === 702 && character.race !== 4) return false;
  if ((helmetHidesEars || helmetHidesHorns || helmetHidesExtra) && partId >= 1502 && partId <= 1510) return false;

  if (partId >= 100 && partId < 400) {
    const facial = data.appearance.facialHairGeosets.find((row) => row.variation === character.facialHair);
    return facial ? facial.geosets.includes(partId) : false;
  }

  return bodyGeosets.has(partId);
}

function createPlayerAnimator(
  data: BakedCharacterModel,
  positionAttr: THREE.Float32BufferAttribute,
  normalAttr: THREE.Float32BufferAttribute | null,
  sharedSkin?: M2StaticSkinAttributes,
): PlayerAnimator | null {
  if (!data.bones.length || !data.sequences.length || !data.boneWeights.length || !data.boneIndices.length) return null;
  if (data.boneWeights.length !== positionAttr.count * 4 || data.boneIndices.length !== positionAttr.count * 4) return null;

  void normalAttr;
  const matrices = data.bones.map(() => new THREE.Matrix4());
  let poseModifier: PlayerPoseModifier | null = null;
  const gpuSkinning = new M2GpuSkinning(data.boneWeights, data.boneIndices, data.bones.length, sharedSkin);
  const attachmentById = new Map((data.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  const rootInv = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const anim = new THREE.Matrix4();
  const attachmentLocal = new THREE.Matrix4();
  const pivotMat = new THREE.Matrix4();
  const negPivotMat = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const pivot = new THREE.Vector3();
  const trans = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const quat = new THREE.Quaternion();
  
  const camLocal = new THREE.Vector3();
  const bonePos = new THREE.Vector3();
  const boneScale = new THREE.Vector3();
  const billRot = new THREE.Quaternion();
  const billPitchQuat = new THREE.Quaternion();
  const sampledRot = new THREE.Quaternion();
  const blendPrevRot = new THREE.Quaternion();
  const blendTargetRot = new THREE.Quaternion();
  const upperCounterRot = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const zero3: [number, number, number] = [0, 0, 0];
  const one3: [number, number, number] = [1, 1, 1];
  const vectorA = [0, 0, 0];
  const vectorB = [0, 0, 0];
  const sampledTranslation = [0, 0, 0];
  const sampledScale = [1, 1, 1];
  const blendTranslation = [0, 0, 0];
  const blendScale = [1, 1, 1];
  const quatA = [0, 0, 0, 1];
  const quatB = [0, 0, 0, 1];
  const trackCursors = data.bones.map(() => ({
    translation: [createTrackKeyCursor(), createTrackKeyCursor()],
    rotation: [createTrackKeyCursor(), createTrackKeyCursor()],
    scale: [createTrackKeyCursor(), createTrackKeyCursor()],
  }));
  let cachedSampling = true;
  const upperBodyBones = upperBodyBoneIndices(data.bones);
  const upperBodyRoot = [...upperBodyBones].find((index) => !upperBodyBones.has(data.bones[index].parentIndex)) ?? -1;
  const headRoot = findHeadBone(data.bones);

  const sequenceFor = (id: number) => {
    const lookup = data.animLookup[id];
    if (lookup !== undefined && lookup >= 0 && data.sequences[lookup]) return lookup;
    return data.sequences.findIndex((seq) => seq.id === id);
  };

  // M2 stores multiple variations per animation id (e.g. Attack1H 0x11 has several swing
  // variants). animLookup/sequenceFor only ever return variation 0, so every attack looked
  // identical. Group every sequence index by its animation id so one-shots can roll a variant.
  const variationsById = new Map<number, number[]>();
  data.sequences.forEach((seq, i) => {
    const list = variationsById.get(seq.id);
    if (list) list.push(i);
    else variationsById.set(seq.id, [i]);
  });
  const pickVariation = (id: number): number => {
    const variants = variationsById.get(id);
    if (!variants || variants.length === 0) return sequenceFor(id);
    if (variants.length === 1) return variants[0];
    // Vanilla weights variants by `frequency` (a relative probability); fall back to uniform
    // when the bake has no frequency data so we still cycle instead of locking to variant 0.
    const total = variants.reduce((sum, i) => sum + Math.max(0, data.sequences[i].frequency || 0), 0);
    if (total > 0) {
      let roll = Math.random() * total;
      for (const i of variants) {
        roll -= Math.max(0, data.sequences[i].frequency || 0);
        if (roll <= 0) return i;
      }
    }
    return variants[Math.floor(Math.random() * variants.length)];
  };

  const stand = sequenceFor(0);
  const walk = sequenceFor(4);
  const run = sequenceFor(5);
  const turnLeft = sequenceFor(11);
  const turnRight = sequenceFor(12);
  const walkBack = sequenceFor(13);
  const jumpStart = sequenceFor(37);
  const jump = sequenceFor(38);
  const jumpEnd = sequenceFor(39);
  const swim = sequenceFor(42); // AnimationData.dbc: 42 = Swim, 41 = SwimIdle
  const swimIdle = sequenceFor(41);
  const locomotionSequences = { stand, walk, run, walkBack, turnLeft, turnRight, jumpStart, jump, jumpEnd, swim, swimIdle };
  let active = stand >= 0 ? stand : 0;
  let elapsedMs = 0;
  let globalElapsedMs = 0;
  let blendFromActive = -1;
  let blendFromElapsedMs = 0;
  let blendFromHoldLastFrame = false;
  let blendElapsedMs = 0;
  let blendDurationMs = 0;
  let activeHoldsLastFrame = false;

  const valueAt = (track: BakedTrack, valueIndex: number, target: number[]) => {
    const start = valueIndex * track.components;
    for (let i = 0; i < track.components; i++) target[i] = track.values[start + i] ?? target[i];
  };

  const sampleVector = (
    track: BakedTrack,
    seqIndex: number,
    time: number,
    fallback: [number, number, number],
    target: number[],
    cursor: TrackKeyCursor,
  ) => {
    target[0] = fallback[0];
    target[1] = fallback[1];
    target[2] = fallback[2];
    const valueCount = Math.floor(track.values.length / track.components);
    if (!track.timestamps.length || valueCount === 0) return target;
    const globalDuration = track.globalSequence >= 0 ? data.globalSequences?.[track.globalSequence] ?? 0 : 0;
    const isGlobal = globalDuration > 0;
    const range = isGlobal ? undefined : track.ranges[seqIndex];
    // Character sheath attachment bones use a one-key global sequence and no
    // per-animation range. Ignoring that global key leaves their bind rotation
    // as identity, so stowed weapons remain in hand-space (horizontal through
    // the shoulder). A single global key is a static transform in every pose.
    if (!isGlobal && !range) {
      if (track.globalSequence < 0 || valueCount !== 1) return target;
      valueAt(track, 0, target);
      return target;
    }

    const start = isGlobal ? 0 : Math.max(0, Math.min(valueCount - 1, range![0]));
    const end = isGlobal ? valueCount - 1 : Math.max(start, Math.min(valueCount - 1, range![1]));
    if (isGlobal) time = globalElapsedMs % globalDuration;
    const ts0 = track.timestamps[start];
    if (ts0 === undefined) return target;
    // Vanilla frequently shares broad key ranges; the helper preserves the legacy inclusive end.
    const a = findTrackKey(track.timestamps, start, end, time, cursor, cachedSampling);
    if (start === end || track.interpolation === 0) {
      valueAt(track, a, target);
      return target;
    }
    const b = Math.min(end, a + 1);
    const ta = track.timestamps[a] ?? time;
    const tb = track.timestamps[b] ?? ta;
    const f = tb > ta ? Math.max(0, Math.min(1, (time - ta) / (tb - ta))) : 0;
    vectorA[0] = fallback[0]; vectorA[1] = fallback[1]; vectorA[2] = fallback[2];
    vectorB[0] = fallback[0]; vectorB[1] = fallback[1]; vectorB[2] = fallback[2];
    valueAt(track, a, vectorA);
    valueAt(track, b, vectorB);
    target[0] = vectorA[0] + (vectorB[0] - vectorA[0]) * f;
    target[1] = vectorA[1] + (vectorB[1] - vectorA[1]) * f;
    target[2] = vectorA[2] + (vectorB[2] - vectorA[2]) * f;
    return target;
  };

  const setQuat = (target: THREE.Quaternion, values: number[]) => {
    target.set(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1);
    return target.lengthSq() > 0.000001 ? target.normalize() : target.identity();
  };

  const sampleQuat = (track: BakedTrack, seqIndex: number, time: number, cursor: TrackKeyCursor) => {

    const valueCount = Math.floor(track.values.length / track.components);
    if (!track.timestamps.length || valueCount === 0) return quat.identity();
    const globalDuration = track.globalSequence >= 0 ? data.globalSequences?.[track.globalSequence] ?? 0 : 0;
    const isGlobal = globalDuration > 0;
    const range = isGlobal ? undefined : track.ranges[seqIndex];
    if (!isGlobal && !range) {
      if (track.globalSequence < 0 || valueCount !== 1) return quat.identity();
      quatA[0] = 0; quatA[1] = 0; quatA[2] = 0; quatA[3] = 1;
      valueAt(track, 0, quatA);
      return setQuat(quat, quatA);
    }

    const start = isGlobal ? 0 : Math.max(0, Math.min(valueCount - 1, range![0]));
    const end = isGlobal ? valueCount - 1 : Math.max(start, Math.min(valueCount - 1, range![1]));
    if (isGlobal) time = globalElapsedMs % globalDuration;
    const ts0 = track.timestamps[start];
    if (ts0 === undefined) return quat.identity();
    const a = findTrackKey(track.timestamps, start, end, time, cursor, cachedSampling);
    quatA[0] = 0; quatA[1] = 0; quatA[2] = 0; quatA[3] = 1;
    valueAt(track, a, quatA);
    setQuat(qa, quatA);
    if (start === end || track.interpolation === 0) return quat.copy(qa);
    const b = Math.min(end, a + 1);
    quatA[0] = 0; quatA[1] = 0; quatA[2] = 0; quatA[3] = 1;
    quatB[0] = 0; quatB[1] = 0; quatB[2] = 0; quatB[3] = 1;
    valueAt(track, a, quatA);
    valueAt(track, b, quatB);
    setQuat(qa, quatA);
    setQuat(qb, quatB);
    const ta = track.timestamps[a] ?? time;
    const tb = track.timestamps[b] ?? ta;
    const f = tb > ta ? Math.max(0, Math.min(1, (time - ta) / (tb - ta))) : 0;
    return quat.slerpQuaternions(qa, qb, f);
  };

  const sequenceForState = (state: PlayerAnimState) => playerLocomotionSequence(state, locomotionSequences);

  const updateSequence = (dt: number, wanted: number, camera?: THREE.Camera, group?: THREE.Group,
    holdLastFrame = false, upperSequence = -1, upperTime = 0, torsoCounterYaw = 0, headCounterYaw = 0) => {
    const samplingMode = m2SamplingMode();
    if (samplingMode === 'off') return;
    cachedSampling = samplingMode === 'cached';
    const samplingStarted = shouldSampleM2AnimatorTiming() ? performance.now() : -1;
    if (wanted < 0) wanted = stand >= 0 ? stand : 0;
    if (wanted !== active) {
      // Vanilla sequence records carry their own transition duration. Keep the outgoing
      // sequence advancing during that window and cross-fade local bone TRS values; an
      // immediate timer reset was the visible Stand -> Walk -> Combat pose pop.
      const wantedBlend = data.sequences[wanted]?.blendTime ?? 0;
      blendFromActive = wantedBlend > 0 ? active : -1;
      blendFromElapsedMs = elapsedMs;
      // A stateful sequence such as Loot has already clamped on its final pose. Preserve that
      // exact outgoing pose during the cross-fade. Sampling it with modulo would wrap the source
      // back to the beginning for a few frames, which looked like a second kneel on LootFrame close.
      blendFromHoldLastFrame = activeHoldsLastFrame;
      blendElapsedMs = 0;
      blendDurationMs = wantedBlend;
      active = wanted;
      elapsedMs = 0;
    }
    activeHoldsLastFrame = holdLastFrame;

    const seq = data.sequences[active];
    if (!seq) return;
    globalElapsedMs += dt * 1000;
    elapsedMs += dt * 1000;
    if (blendFromActive >= 0) {
      blendElapsedMs += dt * 1000;
      blendFromElapsedMs += dt * 1000;
      if (blendElapsedMs >= blendDurationMs) {
        blendFromActive = -1;
        blendFromHoldLastFrame = false;
        blendDurationMs = 0;
      }
    }
    const duration = Math.max(1, seq.duration || seq.timeEnd - seq.timeStart || 1);
    const time = holdLastFrame
      ? seq.timeStart + Math.min(elapsedMs, duration - 1)
      : seq.timeStart + (elapsedMs % duration);
    const blending = blendFromActive >= 0 && blendDurationMs > 0;
    const blendWeight = blending ? Math.max(0, Math.min(1, blendElapsedMs / blendDurationMs)) : 1;
    const blendSeq = blending ? data.sequences[blendFromActive] : undefined;
    const blendDuration = blendSeq
      ? Math.max(1, blendSeq.duration || blendSeq.timeEnd - blendSeq.timeStart || 1)
      : 1;
    const blendTime = blendSeq
      ? blendSeq.timeStart + (blendFromHoldLastFrame
        ? Math.min(blendFromElapsedMs, blendDuration - 1)
        : blendFromElapsedMs % blendDuration)
      : 0;

    if (camera && group) {
      camLocal.copy(camera.position);
      group.worldToLocal(camLocal);
    }

    for (let index = 0; index < data.bones.length; index++) {
      const bone = data.bones[index];
      const cursors = trackCursors[index];
      const upperBody = upperSequence >= 0 && upperBodyBones.has(index);
      const sampledSequence = upperBody ? upperSequence : active;
      const sampledTime = upperBody ? upperTime : time;
      sampleVector(bone.translation, sampledSequence, sampledTime, zero3, sampledTranslation, cursors.translation[0]);
      sampleVector(bone.scale, sampledSequence, sampledTime, one3, sampledScale, cursors.scale[0]);
      sampledRot.copy(sampleQuat(bone.rotation, sampledSequence, sampledTime, cursors.rotation[0]));
      if (blending && !upperBody) {
        sampleVector(bone.translation, blendFromActive, blendTime, zero3, blendTranslation, cursors.translation[1]);
        sampleVector(bone.scale, blendFromActive, blendTime, one3, blendScale, cursors.scale[1]);
        blendTargetRot.copy(sampledRot);
        blendPrevRot.copy(sampleQuat(bone.rotation, blendFromActive, blendTime, cursors.rotation[1]));
        sampledTranslation[0] = blendTranslation[0] + (sampledTranslation[0] - blendTranslation[0]) * blendWeight;
        sampledTranslation[1] = blendTranslation[1] + (sampledTranslation[1] - blendTranslation[1]) * blendWeight;
        sampledTranslation[2] = blendTranslation[2] + (sampledTranslation[2] - blendTranslation[2]) * blendWeight;
        sampledScale[0] = blendScale[0] + (sampledScale[0] - blendScale[0]) * blendWeight;
        sampledScale[1] = blendScale[1] + (sampledScale[1] - blendScale[1]) * blendWeight;
        sampledScale[2] = blendScale[2] + (sampledScale[2] - blendScale[2]) * blendWeight;
        sampledRot.slerpQuaternions(blendPrevRot, blendTargetRot, blendWeight);
      }
      // Q/E turns the pelvis/legs fully into travel. The torso follows part-way at SpineLow; the
      // semantic head root receives the rest of the counter-turn and retains forward eye-line.
      if (index === upperBodyRoot && torsoCounterYaw !== 0) {
        upperCounterRot.setFromAxisAngle(zAxis, torsoCounterYaw);
        sampledRot.premultiply(upperCounterRot);
      }
      if (index === headRoot && headCounterYaw !== 0) {
        upperCounterRot.setFromAxisAngle(zAxis, headCounterYaw);
        sampledRot.premultiply(upperCounterRot);
      }
      trans.set(sampledTranslation[0], sampledTranslation[1], sampledTranslation[2]);
      scale.set(sampledScale[0], sampledScale[1], sampledScale[2]);
      pivot.set(bone.pivot[0], bone.pivot[1], bone.pivot[2]);
      pivotMat.makeTranslation(pivot.x, pivot.y, pivot.z);
      negPivotMat.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
      anim.compose(trans, sampledRot, scale);
      local.copy(pivotMat).multiply(anim).multiply(negPivotMat);
      const parent = bone.parentIndex;
      if (parent >= 0 && matrices[parent]) matrices[index].multiplyMatrices(matrices[parent], local);
      else matrices[index].copy(local);

      if ((bone.flags & 0x08) && camera && group) {
        // Spherical billboard (M2 bone flag 0x8): vertices are authored around
        // the bone PIVOT, so the camera-facing rotation must spin about the
        // transformed pivot — rotating about the matrix origin flings quads
        // away from the head (undead eye glow "out of its socket").
        bonePos.copy(pivot).applyMatrix4(matrices[index]);
        const dx = camLocal.x - bonePos.x;
        const dy = camLocal.y - bonePos.y;
        const dz = camLocal.z - bonePos.z;
        const yaw = Math.atan2(dy, dx);
        const pitch = Math.atan2(dz, Math.hypot(dx, dy));
        boneScale.setFromMatrixScale(matrices[index]);
        billRot.setFromAxisAngle(zAxis, yaw);
        billPitchQuat.setFromAxisAngle(tmp.set(0, 1, 0), -pitch);
        billRot.multiply(billPitchQuat);
        anim.compose(bonePos, billRot, boneScale);
        matrices[index].copy(anim).multiply(negPivotMat);
      }
    }

    rootInv.copy(matrices[0] ?? local.identity()).invert();
    poseModifier?.({ bones: data.bones, matrices, rootInverse: rootInv, dt });
    gpuSkinning.update(matrices, rootInv);
    recordM2Animator(samplingStarted >= 0 ? performance.now() - samplingStarted : undefined);
  };

  const upperLayer = { animationId: -1, sequence: -1, elapsedMs: 0 };

  const update = (dt: number, state: PlayerAnimState, camera?: THREE.Camera, group?: THREE.Group) => {
    upperLayer.animationId = -1;
    const pose = playerStrafePose(state);
    updateSequence(dt, sequenceForState(state), camera, group, false, -1, 0, pose.torsoCounterYaw, pose.headCounterYaw);
  };

  let oneShotId = -1;
  let oneShotSeq = -1;
  const updateAnimationId = (dt: number, animationId: number, camera?: THREE.Camera, group?: THREE.Group) => {
    upperLayer.animationId = -1;
    const variants = variationsById.get(animationId);
    // Roll a fresh variant only when this one-shot is STARTING — i.e. the requested id changed,
    // or the currently-playing sequence isn't one of this id's variants (we returned to idle/
    // locomotion between swings). While the swing plays, `active` stays in the set so we hold it.
    if (!variants || variants.length <= 1 || oneShotId !== animationId || !variants.includes(active)) {
      oneShotSeq = pickVariation(animationId);
      oneShotId = animationId;
    }
    // Death (1) and Loot (50) are stateful poses in the native client. Loot plays into the kneel,
    // then remains on its final frame until LootFrame is released instead of looping the reach.
    updateSequence(dt, oneShotSeq, camera, group, animationId === 1 || animationId === 50);
  };

  const updateUpperBody = (dt: number, state: PlayerAnimState, animationId: number, camera?: THREE.Camera, group?: THREE.Group) => {
    if (upperBodyBones.size === 0) {
      updateAnimationId(dt, animationId, camera, group);
      return;
    }
    const upper = advanceUpperBodyLayer(upperLayer, animationId, dt, pickVariation, data.sequences);
    if (!upper) return;
    const pose = playerStrafePose(state);
    updateSequence(dt, sequenceForState(state), camera, group, false, upper.sequence, upper.time, pose.torsoCounterYaw, pose.headCounterYaw);
  };

  const getAttachmentMatrix = (jointId: number, target = new THREE.Matrix4()) => {
    const attachment = attachmentById.get(jointId);
    if (!attachment) return null;
    const boneMatrix = matrices[attachment.bone];
    if (!boneMatrix) return null;
    attachmentLocal.makeTranslation(attachment.position[0], attachment.position[1], attachment.position[2]);
    return target.copy(rootInv).multiply(boneMatrix).multiply(attachmentLocal);
  };

  return {
    update,
    updateAnimationId,
    updateUpperBody,
    getAnimationDurationMs: id => playerAnimationDuration(data.sequences, variationsById.get(id) ?? [sequenceFor(id)]),
    setPoseModifier: (modifier) => { poseModifier = modifier; },
    getAttachmentMatrix,
    bindGroup: (animatedGroup) => gpuSkinning.bindGroup(animatedGroup),
    getSkinnedPosition: (vertexIndex, target = new THREE.Vector3()) =>
      gpuSkinning.getSkinnedPosition(vertexIndex, data.positions, target),
    dispose: () => gpuSkinning.dispose(),
  };
}

async function loadBakedCharacterModelInternal(
  character: CharacterInfo,
  maxAnisotropy = 8,
  npcBakedBodyTextureUrl?: string,
  initialSheathState = SHEATH_STATE_UNARMED,
): Promise<LoadedPlayerModel> {
  const group = new THREE.Group();
  const key = `${character.race}_${character.gender}`;
  const baseUrl = `/characters/${key}`;

  let dataPromise = modelJsonCache.get(baseUrl);
  if (!dataPromise) {
    dataPromise = fetch(`${baseUrl}/model.json`).then(checkedModelJson<BakedCharacterModel>);
    modelJsonCache.set(baseUrl, dataPromise);
  }
  const data = await dataPromise;
  const portraitCamera = data.cameras?.find((entry) => entry.type === 0);
  if (portraitCamera) {
    const firstVector = (track: BakedTrack) => track.values.length >= 3
      ? track.values.slice(0, 3) as [number, number, number]
      : [0, 0, 0] as [number, number, number];
    const positionOffset = firstVector(portraitCamera.positionTrack);
    const targetOffset = firstVector(portraitCamera.targetTrack);
    group.userData.portraitCamera = {
      fov: portraitCamera.fov,
      nearClip: portraitCamera.nearClip,
      farClip: portraitCamera.farClip,
      position: portraitCamera.positionBase.map((value, index) => value + positionOffset[index]),
      target: portraitCamera.targetBase.map((value, index) => value + targetOffset[index]),
    };
  }

  const gpuSkinned = data.bones.length > 0 && data.sequences.length > 0
    && data.boneWeights.length === data.positions.length / 3 * 4 && data.boneIndices.length === data.positions.length / 3 * 4;

  const textures: (THREE.Texture | null)[] = await Promise.all(
    data.textures.map((name) => loadTextureUrl(`${baseUrl}/${name}`, maxAnisotropy)),
  );

  // Composited appearance (skin+face+hair+armor canvas) is deterministic per appearance combo —
  // share it across every NPC/player instance with the same look.
  const appearanceKey = npcBakedBodyTextureUrl ? [
    APPEARANCE_ATLAS_VERSION,
    'npc',
    key,
    npcBakedBodyTextureUrl,
    character.hairStyle,
    character.hairColor,
    character.facialHair,
    ...(character.equipment ?? []).map((e) => `${e.displayInfoId}:${e.inventoryType}:${e.sheath ?? ''}:${e.slot ?? ''}`),
  ].join('|') : [
    APPEARANCE_ATLAS_VERSION,
    'player',
    key,
    character.skin,
    character.face,
    character.hairStyle,
    character.hairColor,
    character.facialHair,
    ...(character.equipment ?? []).map((e) => `${e.displayInfoId}:${e.inventoryType}:${e.sheath ?? ''}:${e.slot ?? ''}`),
  ].join('|');
  let appearancePromise = appearanceCache.get(appearanceKey);
  if (!appearancePromise) {
    appearancePromise = (npcBakedBodyTextureUrl
      ? buildNpcAppearanceTextures(data, character, baseUrl, npcBakedBodyTextureUrl, maxAnisotropy)
      : buildAppearanceTextures(data, character, baseUrl, maxAnisotropy)
    ).then((a) => {
      sharedTextures.add(a.body);
      sharedTextures.add(a.hair);
      if (a.cape) sharedTextures.add(a.cape);
      appearanceRegistry.register(appearanceKey, { body: a.body, hair: a.hair, cape: a.cape });
      return a;
    });
    appearanceCache.set(appearanceKey, appearancePromise);
  } else {
    appearanceRegistry.touch(appearanceKey);
  }
  const appearance = await appearancePromise;
  const tint = RACE_COLORS[character.race] ?? 0xd8c0a0;
  const materialCache = new Map<string, THREE.Material>();

  const materialFor = (part: BakedPart) => {
    const slot = data.textureSlots[part.textureIndex];
    const runtimeTexture =
      slot?.type === 1 ? appearance.body :
      slot?.type === 2 ? appearance.cape ?? appearance.body :
      slot?.type === 6 || slot?.type === 8 ? appearance.hair :
      null;
    const texture = runtimeTexture ?? textures[part.tex] ?? null;
    const blend = part.blendMode ?? 0;
    const flags = part.renderFlags ?? 0;
    // NO eye-glow depth push. Build 5875 seats and blinks the glow entirely in the M2 itself, and
    // any push here fights that data — see EYE_GLOW_SEATING for the byte trace.
    const cacheKey = `${slot?.type ?? -1}:${part.tex}:${texture?.uuid ?? 'flat'}:${blend}:${flags}`;
    const cached = materialCache.get(cacheKey);
    if (cached) return cached;

    const mat = createM2Material({
      texture,
      blendMode: blend,
      renderFlags: flags,
      fallbackColor: tint,
      gpuSkinning: gpuSkinned,
    });
    materialCache.set(cacheKey, mat);
    return mat;
  };

  const bodyGeosets = computeBodyGeosets(data.parts, appearance.itemInfos);
  const mountedAttachments = await loadItemAttachments(appearance.itemInfos, character, maxAnisotropy, initialSheathState);
  const geometryLease = characterGeometryPool.acquire(baseUrl, data, data.parts);
  try {
  const { position: pos, normal } = geometryLease;
  const sharedGeometries = new Set(geometryLease.geometries);
  const inspectQuery = new URLSearchParams(location.search);
  const inspectPartIds = inspectQuery.get('meshParts')?.split(',').map(Number).filter(Number.isFinite);
  const inspectTextureType = inspectQuery.get('meshType');
  const baseAnimator = createPlayerAnimator(data, pos, normal, geometryLease.skinAttributes);
  try {
    for (const [partIndex, part] of data.parts.entries()) {
      if (inspectPartIds?.length && !inspectPartIds.includes(part.partId)) continue;
      if (inspectTextureType !== null && part.textureType !== Number(inspectTextureType)) continue;
      if (!visibleCharacterPart(data, character, part, bodyGeosets, appearance.itemInfos)) continue;
      const mesh = new THREE.Mesh(geometryLease.geometries[partIndex], materialFor(part));
      // Additive eyes follow the opaque face; ordinary skin retains its authored ordering.
      if (isEyeGlowPart(data, part)) mesh.renderOrder = 10;
      group.add(mesh);
    }
    baseAnimator?.bindGroup?.(group);
    baseAnimator?.update(0, 'stand');
  } catch (error) {
    baseAnimator?.dispose?.(); geometryLease.release();
    throw error;
  }
  for (const attachment of mountedAttachments) group.add(attachment.group);

  const attachmentMatrix = new THREE.Matrix4();
  // Sheathed items mount RAW on the socket — no flip, no inset, no pitch. The socket
  // bone's static rotation IS the authored pose (WoWModelViewer applies none either).
  // The small standoff gap behind the back is AUTHENTIC vanilla: sockets are authored
  // with an armor-clearance buffer so items clear plate/capes as well as cloth. An
  // inset+pitch "hug" was tried here and clipped items through cloth-wearing bodies
  // (and would gore Tauren/Orc humps worse) — do not re-add offsets; if a weapon sits
  // wrong, the fix lives in the sheathJointFor SOCKET-PAIR mapping, not in transforms.
  const updateAttachmentTransforms = () => {
    if (!baseAnimator?.getAttachmentMatrix) return;
    for (const attachment of mountedAttachments) {
      if (attachment.hidden) { attachment.group.visible = false; continue; }
      const matrix = baseAnimator.getAttachmentMatrix(attachment.jointId, attachmentMatrix);
      attachment.group.visible = !!matrix;
      if (!matrix) continue;
      attachment.group.matrix.copy(matrix);
      attachment.group.matrixWorldNeedsUpdate = true;
    }
  };

  /**
   * Move weapons/shield between hands and their vanilla sheath points (UNIT_FIELD_BYTES_2 sheath
   * state 0 = put away). Live: the per-frame attachment pass reads jointId, no rebuild needed.
   */
  /**
   * `sheathState` is UNIT_FIELD_BYTES_2 byte 0, not a boolean: it names which weapon SET is
   * prepared, so the other set stows. See isWeaponDrawn in combat/virtual-items.ts.
   */
  const setWeaponsSheathed = (sheathState: number) => {
    for (const attachment of mountedAttachments) {
      if (attachment.sheathedJointId === null) continue;
      const jointId = weaponAttachmentJoint(
        sheathState,
        attachment.equipmentSlot,
        attachment.drawnJointId,
        attachment.sheathedJointId,
      );
      if (jointId === 'hide') {
        attachment.hidden = true;
        continue;
      }
      attachment.hidden = false;
      attachment.jointId = jointId;
    }
    updateAttachmentTransforms();
  };
  const getEquipmentAttachmentRoot = (slot: number) =>
    mountedAttachments.find((attachment) => attachment.equipmentSlot === slot)?.group;

  if (baseAnimator && mountedAttachments.length) {
    updateAttachmentTransforms();
  }

  const animator: PlayerAnimator | null = baseAnimator
    ? {
        update: (dt, state, camera, animatedGroup) => {
          group.rotation.z = playerStrafePose(state).bodyYaw;
          baseAnimator.update(dt, state, camera, animatedGroup);
          updateAttachmentTransforms();
        },
        updateAnimationId: baseAnimator.updateAnimationId
          ? (dt, animationId, camera, animatedGroup) => {
              group.rotation.z = 0;
              baseAnimator.updateAnimationId?.(dt, animationId, camera, animatedGroup);
              updateAttachmentTransforms();
            }
          : undefined,
        updateUpperBody: baseAnimator.updateUpperBody
          ? (dt, state, animationId, camera, animatedGroup) => {
              group.rotation.z = playerStrafePose(state).bodyYaw;
              baseAnimator.updateUpperBody?.(dt, state, animationId, camera, animatedGroup);
              updateAttachmentTransforms();
            }
          : undefined,
        getAnimationDurationMs: baseAnimator.getAnimationDurationMs,
        setPoseModifier: baseAnimator.setPoseModifier,
        getAttachmentMatrix: baseAnimator.getAttachmentMatrix,
      }
    : null;

  // Compute the head-vertex set once, then derive either the bind or current animated centroid.
  // Hunched races move their head substantially in Stand, so a bind-pose-only camera target crops
  // the face in character creation even though the model itself is correct.
  let headCentroid = { x: 0, y: 0, z: 1.7 };
  const headVertexIndices: number[] = [];
  {
    const skinPart = data.parts.find((p) => p.partId === 0);
    const hb = skinPart?.centerBoneIndex ?? -1;
    let cx = 0, cy = 0, cz = 0, n = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const seen = new Set<number>();
    for (const i of skinPart?.indices ?? []) {
      if (seen.has(i)) continue;
      seen.add(i);
      let best = -1, bw = 0;
      for (let k = 0; k < 4; k++) {
        const w = data.boneWeights[i * 4 + k];
        if (w > bw) {
          bw = w;
          best = data.boneIndices[i * 4 + k];
        }
      }
      if (best === hb) {
        headVertexIndices.push(i);
        const x = data.positions[i * 3];
        const y = data.positions[i * 3 + 1];
        const z = data.positions[i * 3 + 2];
        cx += x;
        cy += y;
        cz += z;
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
        n++;
      }
    }
    if (n > 0) {
      headCentroid = { x: cx / n, y: cy / n, z: cz / n };
      group.userData.portraitFraming = {
        focus: [headCentroid.x, headCentroid.y, headCentroid.z],
        radius: Math.max(0.06, (maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5),
      };
    }
  }
  const skinnedHeadScratch = new THREE.Vector3();
  const getHeadCentroid = () => {
    if (!headVertexIndices.length) return { ...headCentroid };
    const animatedPositions = pos.array as Float32Array;
    let x = 0, y = 0, z = 0;
    for (const i of headVertexIndices) {
      if (baseAnimator?.getSkinnedPosition) {
        baseAnimator.getSkinnedPosition(i, skinnedHeadScratch);
        x += skinnedHeadScratch.x;
        y += skinnedHeadScratch.y;
        z += skinnedHeadScratch.z;
      } else {
        x += animatedPositions[i * 3];
        y += animatedPositions[i * 3 + 1];
        z += animatedPositions[i * 3 + 2];
      }
    }
    const n = headVertexIndices.length;
    return { x: x / n, y: y / n, z: z / n };
  };

  // Reference-count the shared textures this finished model wears, so the bounded caches never evict
  // and dispose one while it is still on-screen. Released in dispose() below. The set is fixed at
  // build time: swapToVariant only toggles geoset visibility and setWeaponsSheathed only repositions
  // attachments, so a model never picks up a new shared texture after this point.
  const modelSharedTextures = new Set<THREE.Texture>();
  const collectSharedFrom = (mat: THREE.Material | undefined) => {
    if (!mat) return;
    // Standard materials hold the texture on .map; the M2 ShaderMaterial holds it in uniforms
    // (uMap.value). Scan both, filtered to textures the shared caches actually own, so equipment
    // and body/hair atlases are all pinned while this model is alive.
    const map = (mat as { map?: THREE.Texture }).map;
    if (map instanceof THREE.Texture && sharedTextures.has(map)) modelSharedTextures.add(map);
    const uniforms = (mat as THREE.ShaderMaterial).uniforms;
    if (uniforms) {
      for (const name in uniforms) {
        const value = uniforms[name]?.value;
        if (value instanceof THREE.Texture && sharedTextures.has(value)) modelSharedTextures.add(value);
      }
    }
  };
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const material = child.material;
    for (const mat of Array.isArray(material) ? material : material ? [material] : []) collectSharedFrom(mat);
  });
  for (const tex of modelSharedTextures) retainSharedTextureForModel(tex);

  let disposed = false;
  const dispose = () => {
    // Idempotent: a second dispose() must not double-release the shared-texture refcounts (which
    // would let the cache free a texture another live model still wears).
    if (disposed) return;
    disposed = true;
    baseAnimator?.dispose?.();
    // Body geometry lives until its last character releases it; equipment geometry is instance-owned.
    // Shared textures are released through the bounded registries below.
    const disposedTextures = new Set<THREE.Texture>();
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (!sharedGeometries.has(child.geometry)) child.geometry?.dispose?.();
        const material = child.material;
        if (material) {
          for (const mat of Array.isArray(material) ? material : [material]) {
            const map = (mat as any).map as THREE.Texture | undefined;
            if (map && !disposedTextures.has(map) && !sharedTextures.has(map)) {
              disposedTextures.add(map);
              map.dispose();
            }
            mat.dispose?.();
          }
        }
      }
    });
    for (const tex of textures) {
      if (tex && !disposedTextures.has(tex) && !sharedTextures.has(tex)) {
        tex.dispose();
      }
    }
    for (const tex of modelSharedTextures) releaseSharedTextureForModel(tex);
    geometryLease.release();
  };

  return {
    group,
    animator,
    data,
    headCentroid,
    getHeadCentroid,
    setWeaponsSheathed,
    getEquipmentAttachmentRoot,
    dispose,
  };
  } catch (error) {
    geometryLease.release();
    throw error;
  }
}

/**
 * Interface Options → "Show Helm" / "Show Cloak".
 *
 * Dropping the item from the equipment list ahead of everything else is what the client
 * itself does: with the helm gone, `helmetGeosetHides` stops suppressing hair/ears/beard,
 * the head attachment is never loaded, and the cape geoset and its texture component are
 * never composited. Doing it here also means the equipment list that feeds the appearance
 * cache key differs between the two states, so toggling the option rebuilds the atlas
 * instead of serving the previous look from cache.
 *
 * Returns the original object when nothing is hidden, so the common path allocates nothing.
 */
const INVENTORY_TYPE_HEAD = 1;
const INVENTORY_TYPE_CLOAK = 16;

function applyEquipmentVisibilityCvars(character: CharacterInfo): CharacterInfo {
  const cvars = getInterfaceCvars();
  const hideHelm = Number(cvars.showHelm) !== 1;
  const hideCloak = Number(cvars.showCloak) !== 1;
  if (!hideHelm && !hideCloak) return character;
  const equipment = (character.equipment ?? []).filter((item) => {
    if (hideHelm && item.inventoryType === INVENTORY_TYPE_HEAD) return false;
    if (hideCloak && item.inventoryType === INVENTORY_TYPE_CLOAK) return false;
    return true;
  });
  return { ...character, equipment };
}

export async function loadBakedCharacterModel(
  character: CharacterInfo,
  maxAnisotropy = 8,
  initialSheathState = SHEATH_STATE_UNARMED,
): Promise<LoadedPlayerModel> {
  return loadBakedCharacterModelInternal(applyEquipmentVisibilityCvars(character), maxAnisotropy, undefined, initialSheathState);
}

export async function loadBakedNpcCharacterModel(
  character: CharacterInfo,
  bakedBodyTextureUrl: string,
  maxAnisotropy = 8,
  initialSheathState = SHEATH_STATE_UNARMED,
): Promise<LoadedPlayerModel> {
  return loadBakedCharacterModelInternal(character, maxAnisotropy, bakedBodyTextureUrl, initialSheathState);
}
