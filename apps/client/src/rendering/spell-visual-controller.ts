import { sceneEffectBudget } from './scene-effect-budget';
import { ChainBeamGeometryWriter } from './chain-beam-geometry';
import * as THREE from 'three';
import { xrViewState } from './xr-view-state';
import { QA_GLOBALS_ENABLED, qaGlobals } from '../qa-globals.ts';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadBakedProjectileModel, type PlayerAnimator } from '../model-loader';
import { SpellVisuals, SPELL_SEQ_HOLD, SPELL_SEQ_IN_FLIGHT, type SpellVisualHandle } from '../spell-visuals';
import type { AuraSlot, CombatEvent } from '../world';
import type { WorldEntityRenderer } from '../world-entity-renderer';
import { TypeID, type WorldEntity } from '../world-entities';
import { CameraShakeSampler, type CameraShakeComponent } from './camera-shakes';
import type { AuraModelOpacitySink } from './model-opacity';
import { disposeSpellControllerCaches } from './spell-controller-cache-cleanup';
import { ExpiringDedupe } from '../platform/expiring-dedupe';
interface SpellVisualKitJson {
  id: number;
  startAnimId: number;
  animId: number;
  soundId: number;
  /** SpellEffectCameraShakes.dbc id from SpellVisualKit col 14, or -1. */
  shakeId: number;
  /** Exact CameraShakes.dbc rows joined through SpellEffectCameraShakes.dbc. */
  shake: CameraShakeComponent[];
  effects: SpellKitEffectJson[];
  /** SpellVisualKit char-proc 0/12 joined to SpellChainEffects.dbc. */
  chainEffect?: { id: number; mode: 'channel' | 'cast' };
  characterOpacity?: number; // char-proc 14 param[0], multiplied into the character model alpha
}

interface SpellChainEffectJson {
  id: number;
  texture: string;
  textureLength: number;
  width: number;
  noise: number;
  scrollSpeed: number;
  segmentDurationMs: number;
  fadeMs: number;
}

interface SpellKitEffectJson {
  name?: string;
  model: string;
  attachment: number;
  scale: number;
  /** SpellVisualKit effect-column index — see SPELL_KIT_SLOT_ROLE. -1 for missile/area models. */
  slot: number;
}

interface SpellVisualEntry {
  name: string;
  visualId: number;
  speed: number;
  school: string;
  /** Spell.dbc effect 27: server lifetime is represented by a DynamicObject. */
  persistentArea?: boolean;
  /**
   * Where the impact kit belongs, derived from Spell.dbc EffectImplicitTargetA/B (fields 74-79)
   * against vMaNGOS `enum SpellTarget`:
   *   'caster' — TARGET_UNIT_CASTER only; the effect is on the caster no matter what is selected
   *   'source' — a LOCATION or an area sweep; ONE effect at the destination, or the caster
   *   'target' — a genuinely picked unit; one effect per unit in the SMSG_SPELL_GO hit list
   */
  impactAnchor?: 'caster' | 'source' | 'target';
  kits: {
    precast: SpellVisualKitJson | null;
    cast: SpellVisualKitJson | null;
    impact: SpellVisualKitJson | null;
    state: SpellVisualKitJson | null;
    channel: SpellVisualKitJson | null;
  };
  missile: { model: string; scale: number; speed: number; destAttachment: number; pathType: number } | null;
  area: { model: string; scale: number; kit: SpellVisualKitJson | null } | null;
}

type DynamicObjectVisual = {
  spellId: number;
  x: number;
  y: number;
  z: number;
  serial: number;
  handles: Set<SpellVisualHandle>;
};

type AuraStateVisual = {
  guid: string;
  spellId: number;
  serial: number;
  handles: Set<SpellVisualHandle>;
};

type WeaponEnchantVisual = {
  ownerGuid: string;
  equipmentSlot: number;
  enchantId: number;
  serial: number;
  getRoot: () => THREE.Object3D | undefined;
  handles: Set<SpellVisualHandle>;
};

type AmmoVisual = { displayId: number; inventoryType: number; speed: number };
type ActiveAmmoProjectile = {
  root: THREE.Group;
  start: THREE.Vector3;
  targetGuid?: string;
  fallbackEnd: THREE.Vector3;
  elapsed: number;
  duration: number;
};

type ActiveChainBeam = {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh;
  sourceGuid: string;
  targetGuid: string;
  fallbackStart: THREE.Vector3;
  fallbackEnd: THREE.Vector3;
  elapsed: number;
  duration: number;
  effect: SpellChainEffectJson;
  ownerGuid?: string;
};

type SpellEffectRole = 'hand' | 'ground' | 'head' | 'chest';
const PROJECTILE_FORWARD = new THREE.Vector3(1, 0, 0);

type PendingSpellImpact = {
  spellId: number;
  casterGuid: string;
  targetGuid?: string;
  entry: SpellVisualEntry;
  worldGeneration: number;
  visualSpawned: boolean;
  visualTimer: number;
  fallbackTimer: number;
};

/**
 * Character M2 attachment ids, resolved GEOMETRICALLY from Build 5875 bind poses rather than from
 * an enum (tools/probe-attachment-ids.ts). Model axes are Z-up with +Y to the character's left, so
 * the sign of a bone's pivot Y names the side. HumanMale / OrcMale / NightElfFemale all agree:
 *
 *   id 0  -> y=+0.549 z=1.036   LEFT, but high and swung outward — the shield / off-hand ITEM slot
 *   id 1  -> y=-0.476 z=0.904   RIGHT hand joint
 *   id 2  -> y=+0.471 z=0.904   LEFT hand joint
 *   id 11 -> y= 0.000 z=2.027   head (top centre of a ~2.2yd model)
 *   id 15 -> y= 0.000 z=1.431   chest, slightly forward
 *
 * This file used to pair the hands as [0, 1], which put every left-hand spell glow on the shield
 * slot — 8cm high and 8cm outboard of the actual hand, on every two-handed cast in the game.
 */
const SPELL_ATTACH_HAND_RIGHT = 1;
const SPELL_ATTACH_HAND_LEFT = 2;
const SPELL_CHEST_ATTACHMENT = 15;
const SPELL_HEAD_ATTACHMENT = 11;

/**
 * SpellVisualKit effect column -> where the client anchors that model.
 *
 * The column IS the anchoring decision; the SpellVisualEffectName string is an artist label and
 * disagrees with it often enough to matter (of the 501 kit entries whose name contains "Hand",
 * 445 sit in the two hand columns but 56 do not; six models named "...Base" sit in the head
 * column). The previous regex over `name + model` therefore had to guess, and it anchored
 * 344 of 1466 kit effects (23.5%) to a different body part than the DBC says — measured and
 * re-measured on every run by tools/verify-spell-visual-schema.ts.
 * Ordering recovered from raw bytes in tools/probe-svk-slots.ts — see bake-spell-visuals.ts.
 */
const SPELL_KIT_SLOT_ROLE: SpellEffectRole[] = [
  'head',   // col 3  — 93% of unambiguous "Head" names land here
  'chest',  // col 4  — 70% of "Chest"
  'ground', // col 5  — 91% of "Base"
  'hand',   // col 6  — left hand  (219 "Hand" names)
  'hand',   // col 7  — right hand (226 "Hand" names, 235 kits carry the same model in both)
  'head',   // col 8  — breath; anchored at the head, the nearest binding we have
  'hand',   // col 9  — sparse (6 uses), hand-shaped contents
  'hand',   // col 10 — sparse (2 uses), hand-shaped contents
  'chest',  // col 11 — never populated in Build 5875
  'ground', // col 12 — sparse (13 uses), "Base"-shaped contents
];
const SUSTAIN_FADE_MS = 80;
/** Shortest gap between two identical SMSG_PLAY_SPELL_VISUAL pulses that is treated as real. */
const PULSE_DEDUPE_MS = 400;
/** Rolling window of spawn records kept for __wowSpellVisualDebug(). */
const SPAWN_LEDGER_LIMIT = 200;
const IMPACT_EVENT_GRACE_MS = 450;
const IMPACT_DEDUPE_MS = 2000;
export class SpellVisualController {
  private readonly visuals: SpellVisuals;
  private spellVisualChain: Record<string, SpellVisualEntry> = {};
  /** SpellVisualKit.dbc id -> kit. The only way to serve SMSG_PLAY_SPELL_VISUAL, which names a kit. */
  private spellVisualKits: Record<string, SpellVisualKitJson> = {};
  private readonly playerAttachmentMatrix = new THREE.Matrix4();
  private readonly playerAttachmentPos = new THREE.Vector3();
  private readonly cameraShakes = new CameraShakeSampler();
  private readonly cameraShakeOffset = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly beamWriter = new ChainBeamGeometryWriter();
  private readonly pendingImpacts: PendingSpellImpact[] = [];
  private readonly recentImpactSounds = new Map<string, number>();
  private readonly recentDestinations = new Map<string, { position: THREE.Vector3; recordedAt: number }>();
  private readonly dynamicObjectVisuals = new Map<string, DynamicObjectVisual>();
  private readonly desiredAuraSpellIds = new Map<string, Set<number>>();
  private readonly auraStateVisuals = new Map<string, AuraStateVisual>();
  /**
   * GUIDs whose FIRST aura snapshot has been processed.
   *
   * Logging in with Frost Armor up delivers those auras as a fresh add, which is indistinguishable
   * from a cast unless we remember that we had never seen this unit before. Without it, entering
   * the world replayed the cast sound and the camera shake of every buff already running — audible
   * during the loading screen, because the aura path calls playSoundId directly and that has no
   * world-ready gate. The state MODEL still spawns for a pre-existing aura (a shimmering Frost
   * Armor is correct on login); only the one-shot cast feedback is suppressed.
   */
  private readonly auraSnapshotSeen = new Set<string>();
  private weaponEnchantModels: Record<string, string[]> = {};
  private readonly weaponEnchantVisuals = new Map<string, WeaponEnchantVisual>();
  private readonly ammoTemplates = new Map<string, Promise<THREE.Group | null>>();
  private readonly activeAmmoProjectiles: ActiveAmmoProjectile[] = [];
  private spellChainEffects: Record<string, SpellChainEffectJson> = {};
  private readonly chainTextureLoader = new THREE.TextureLoader();
  private readonly chainTextures = new Map<string, Promise<THREE.Texture | null>>();
  private readonly activeChainBeams: ActiveChainBeam[] = [];
  private readonly activeChannelTargets = new Map<string, { spellId: number; durationMs: number; targetGuids: Set<string> }>();
  private readonly activeChannelHandles = new Map<string, Set<SpellVisualHandle>>();
  /**
   * Precast/cast handles, per caster, so an interrupted cast can retract its own visual.
   *
   * These used to be spawned and forgotten — only the channel stage kept its handles — so
   * `stopCasterSustain` silenced the sound and left the glow emitting for the REST OF THE CAST
   * TIME. On a long cast that is very visible: Hearthstone's precast kit keeps burning in the
   * caster's hands long after the cast was cancelled, which is the reported symptom.
   */
  private readonly activeCastHandles = new Map<string, Set<SpellVisualHandle>>();
  /** Invalidates delayed missile/impact callbacks whenever the authoritative world is torn down. */
  private worldGeneration = 1;
  private nextDynamicObjectSerial = 1;
  private nextAuraStateSerial = 1;
  /** Casters with a live keyed precast/cast/channel loop; see `stopAllCasterSounds`. */
  private readonly activeSustainCasters = new Set<string>();
  /** (unit, kit) -> last SMSG_PLAY_SPELL_VISUAL time, for the pulse dedupe above. */
  private readonly recentVisualKits = new ExpiringDedupe(PULSE_DEDUPE_MS, 10_000);
  /**
   * Every model spawn, with the stage that caused it. Read with `__wowSpellVisualDebug()`.
   * This exists because "the spell visually triggers more than once" cannot be diagnosed from
   * the manifests alone — it needs the live sequence of stages and models.
   */
  private readonly spawnLedger: Array<{ t: number; stage: string; spellId: number; model: string; slot: number; guid?: string }> = [];
  /**
   * Every castSpellVisual() call, independent of whether it spawned anything. Proven necessary:
   * a headless run showed ONE call produces exactly the 4 authored models for Arcane Explosion,
   * so a repeat on screen means the realm delivered the event twice — which only this shows.
   */
  private readonly castLedger: Array<{ t: number; stage: string; spellId: number; casterGuid: string; hits: number }> = [];

  constructor(private readonly deps: {
    scene: THREE.Scene;
    skyScene?: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    getControls: () => OrbitControls | undefined;
    getPlayerGuid: () => string | undefined;
    getSelectedTargetGuid: () => string | undefined;
    getCharPos: () => THREE.Vector3;
    getPlayerAnimator: () => PlayerAnimator | undefined;
    getPlayerModelGroup: () => THREE.Group | undefined;
    getEntityRenderer: () => WorldEntityRenderer | undefined;
    getMaxAnisotropy: () => number;
    worldToLocal: (worldX: number, worldY: number) => { x: number; y: number } | null;
    playSoundId?: (soundId: number, key?: string) => unknown;
    preloadSoundId?: (soundId: number) => unknown;
    stopSound?: (key: string, fadeOutMs?: number) => unknown;
    isLoopingSound?: (soundId: number) => boolean;
    modelOpacity?: AuraModelOpacitySink;
  }) {
    this.visuals = new SpellVisuals({ scene: deps.scene, skyScene: deps.skyScene, camera: deps.camera });
    fetch('spells/spell-visuals.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        this.spellVisualChain = j;
        // Entity creation can beat the manifest fetch on first world entry.
        for (const [guid, active] of this.dynamicObjectVisuals) {
          if (active.handles.size === 0) this.spawnDynamicObjectEntry(guid, active);
        }
        for (const [guid, spellIds] of this.desiredAuraSpellIds) this.reconcileAuraStates(guid, spellIds);
      })
      .catch(() => {});
    fetch('spells/spell-visual-kits.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => { this.spellVisualKits = j; })
      .catch(() => {});
    fetch('spells/spell-chain-effects.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        this.spellChainEffects = j;
        // A direct MSG_CHANNEL_START can beat this small manifest request on first entry.
        for (const [casterGuid, active] of this.activeChannelTargets) {
          const entry = this.spellVisualChain[String(active.spellId)];
          if (entry) this.spawnChannelBeams(casterGuid, entry, active.targetGuids, active.durationMs);
        }
      })
      .catch(() => {});
    fetch('spells/weapon-enchants.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        this.weaponEnchantModels = j;
        for (const active of this.weaponEnchantVisuals.values()) this.spawnWeaponEnchant(active);
      })
      .catch(() => {});
    this.installDebugHooks();
  }

  update(dt: number, elapsedDt = dt) {
    this.visuals.update(dt, elapsedDt);
    this.updateAmmoProjectiles(elapsedDt);
    this.updateChainBeams(elapsedDt);
    this.deps.camera.getWorldDirection(this.cameraForward);
    this.cameraShakes.sample(
      this.deps.camera.position,
      this.cameraForward,
      performance.now(),
      this.cameraShakeOffset,
    );
    if (xrViewState.active) this.cameraShakeOffset.set(0, 0, 0); else this.deps.camera.position.add(this.cameraShakeOffset);
  }

  prepareCameraFrame() {
    this.deps.camera.position.sub(this.cameraShakeOffset);
    this.cameraShakeOffset.set(0, 0, 0);
  }

  setSkybox(modelPath: string | null) {
    void this.visuals.setSkybox(modelPath, () => this.deps.camera.position);
  }

  handleCombatEvent(event: CombatEvent) {
    switch (event.kind) {
      case 'spellFailure':
        this.stopCasterSustain(event.casterGuid);
        this.cancelPendingImpacts(event.casterGuid, event.spellId);
        this.recentDestinations.delete(this.destinationKey(event.casterGuid, event.spellId));
        break;
      case 'castResult':
        if (!event.success) {
          const playerGuid = this.deps.getPlayerGuid();
          if (playerGuid) this.stopCasterSustain(playerGuid);
        }
        break;
      case 'spellGo':
        if (event.hitGuids.length === 0 && event.misses.length > 0) {
          this.stopCasterSustain(event.casterGuid);
          this.cancelPendingImpacts(event.casterGuid, event.spellId);
          this.recentDestinations.delete(this.destinationKey(event.casterGuid, event.spellId));
        }
        break;
      case 'channelUpdate':
        if (event.timeRemainingMs <= 0) {
          this.stopChannel(event.casterGuid);
        }
        break;
      case 'spellDamage':
        if (!event.periodic) this.resolveAuthoritativeImpact(event.spellId, event.attackerGuid, event.targetGuid);
        break;
      case 'spellHeal':
        this.resolveAuthoritativeImpact(event.spellId, event.healerGuid, event.targetGuid);
        break;
      case 'spellEnergize':
        this.resolveAuthoritativeImpact(event.spellId, event.casterGuid, event.targetGuid);
        break;
      case 'spellMiss':
        this.resolveAuthoritativeImpact(event.spellId, event.casterGuid, event.targetGuid);
        break;
      case 'playSpellVisualKit':
        this.playSpellVisualKit(event.guid, event.kitId);
        break;
      case 'spellChainTargets':
        this.updateChannelTargets(event.casterGuid, event.spellId, event.targetGuids);
        break;
      case 'spellExecute':
        for (const effect of event.effects) {
          if (effect.effectId !== 68) continue;
          for (const record of effect.records) {
            if (record.targetGuid) this.stopChannel(record.targetGuid);
          }
        }
        break;
    }
  }

  /**
   * Caster animation for a cast stage, from the baked SpellVisualKit chain (kit animId column is
   * AnimationData.dbc — verified in bake-spell-visuals.ts: Fireball precast kit 30 → anim 51).
   * Returns: a positive anim id to play; `null` when the spell IS in the manifest but this stage has
   * no kit/anim (vanilla plays nothing — e.g. next-melee-swing abilities like Heroic Strike must NOT
   * throw a caster pose); `undefined` when the spell isn't baked (caller picks a generic fallback).
   */
  getCastAnim(spellId: number, stage: 'start' | 'go' | 'channel'): number | null | undefined {
    const entry = this.spellVisualChain[String(spellId)];
    if (!entry) return undefined;
    const kit = stage === 'start'
      ? entry.kits.precast
      : stage === 'channel'
        ? entry.kits.channel ?? entry.kits.cast
        : entry.kits.cast;
    if (!kit || !kit.animId || kit.animId <= 0) return null; // animId 0 = Stand → no one-shot
    return kit.animId;
  }

  /** Compact manifest coverage summary for QA tooling; undefined = spell not baked. */
  getVisualSummary(spellId: number) {
    const e = this.spellVisualChain[String(spellId)];
    if (!e) return undefined;
    return {
      visualId: e.visualId,
      precast: !!e.kits.precast, cast: !!e.kits.cast, impact: !!e.kits.impact,
      state: !!e.kits.state, channel: !!e.kits.channel,
      missile: !!e.missile, area: !!e.area,
      persistentArea: !!e.persistentArea,
      precastAnim: e.kits.precast?.animId ?? 0, castAnim: e.kits.cast?.animId ?? 0,
    };
  }

  castSpellVisual(
    spellId: number,
    casterGuid: string,
    targetGuid: string | undefined,
    stage: 'start' | 'go' | 'channel',
    durationMs: number,
    destination?: { x: number; y: number; z: number },
    hitGuids?: string[],
    ammo?: AmmoVisual,
    /**
     * SMSG_SPELL_GO landed on nobody (every target missed/resisted/immune). The caster still cast,
     * so its cast kit and any caster/source-anchored impact still play; only an impact that would
     * land on a unit that was never hit is dropped.
     */
    suppressTargetImpact = false,
  ) {
    this.castLedger.push({ t: Math.round(performance.now()), stage, spellId, casterGuid, hits: hitGuids?.length ?? 0 });
    if (this.castLedger.length > SPAWN_LEDGER_LIMIT) this.castLedger.shift();
    const playerGuid = this.deps.getPlayerGuid();
    const target = targetGuid ?? (casterGuid === playerGuid ? this.deps.getSelectedTargetGuid() : undefined) ?? casterGuid;
    if (ammo) {
      if (stage === 'start') {
        void this.ammoTemplate(ammo);
      } else if (stage === 'go') {
        const projectileTargets = hitGuids?.length ? hitGuids : [target];
        for (const projectileTarget of projectileTargets) {
          void this.launchAmmoProjectile(ammo, casterGuid, projectileTarget);
        }
      }
    }
    // Auto Shot, Shoot and Throw intentionally have SpellVisual=0 in Build 5875. Their packet-
    // authored ammo projectile above is still a complete visual path, so only return after it.
    const entry = this.spellVisualChain[String(spellId)];
    if (!entry) return;
    const destinationKey = this.destinationKey(casterGuid, spellId);
    if (destination) {
      this.recentDestinations.set(destinationKey, {
        position: new THREE.Vector3(destination.x, destination.y, destination.z),
        recordedAt: performance.now(),
      });
    }
    const groundDestination = destination
      ? new THREE.Vector3(destination.x, destination.y, destination.z)
      : this.recentDestination(casterGuid, spellId);
    this.preloadSpellSounds(entry);
    if (stage === 'start') {
      this.stopCasterSustain(casterGuid);
      this.playKitSound(entry.kits.precast, this.sustainKey(casterGuid, 'precast'));
      // The precast glow covers the cast bar, so a timed cast emits for exactly its cast time and
      // loops the (shorter) authored sequence to fill it. An INSTANT cast has no bar to cover: the
      // old Math.max(400, …) floor — 600ms in practice, since spellStart passed `castTimeMs || 600`
      // — invented a window that, plus the hands' 0.6-1.2s particle tail, replayed 15 of the 24
      // precast meshes up to 1.8x. 'authored' plays it once and holds, like every other one-shot.
      this.spawnSpellKit(entry.kits.precast, casterGuid, durationMs > 0 ? durationMs : 'authored', undefined, 'precast');
    }
    else if (stage === 'channel') {
      this.stopChannel(casterGuid);
      this.playKitSound(entry.kits.channel ?? entry.kits.cast, this.sustainKey(casterGuid, 'channel'));
      this.activeChannelTargets.set(casterGuid, {
        spellId,
        durationMs: Math.max(1500, durationMs),
        targetGuids: new Set(target ? [target] : []),
      });
      this.spawnSpellKit(
        entry.kits.channel ?? entry.kits.cast,
        casterGuid,
        Math.max(800, durationMs),
        undefined,
        'channel',
        casterGuid,
        spellId,
      );
      this.spawnChannelBeams(casterGuid, entry, target ? new Set([target]) : new Set(), Math.max(1500, durationMs));
      this.spawnSpellImpact(entry, target, groundDestination, Math.max(1500, durationMs));
    } else {
      this.stopCasterSustain(casterGuid);
      this.playKitSound(entry.kits.cast, this.sustainKey(casterGuid, 'cast'));
      // 'authored': every one of the 77 archive-resolved cast models runs longer than the 250ms
      // this used to be pinned to (median 1000ms), so the effect was cut off mid-animation.
      this.spawnSpellKit(entry.kits.cast, casterGuid, 'authored', undefined, 'cast');
      // Spell.dbc's implicit targets decide whether the impact belongs on the caster, on one
      // location, or on every unit hit. Fanning it over the SMSG_SPELL_GO hit list unconditionally
      // made Arcane Explosion (an area sweep at the caster's own location) draw one full chest
      // explosion per victim, and let Ice Armor (self-only) land on whatever mob was selected.
      const anchor = entry.impactAnchor ?? 'target';
      // A target-anchored impact has nowhere to land when every target missed. Caster- and
      // source-anchored impacts are unaffected: they never depended on a hit in the first place.
      const victims = anchor === 'target'
        ? (suppressTargetImpact ? [] : (hitGuids?.length ? hitGuids : [target]).filter((guid): guid is string => !!guid))
        : [casterGuid];
      const chainTargets = hitGuids === undefined
        ? (target ? [target] : [])
        : hitGuids;
      this.spawnCastChain(entry.kits.cast, casterGuid, chainTargets);
      // 'caster' is on the unit itself, so it must ignore any remembered ground destination.
      // 'source' uses the destination when the spell has one (Flamestrike) and otherwise falls
      // back to the caster's own position (Arcane Explosion, Frost Nova).
      const at = anchor === 'caster' ? null : groundDestination;
      if (entry.missile) {
        for (const victim of victims) this.launchSpellMissile(spellId, entry, casterGuid, victim);
      } else {
        for (const [index, victim] of victims.entries()) {
          this.spawnSpellImpact(entry, victim, index === 0 ? at : null);
          this.playImpactSounds(spellId, entry, casterGuid, victim);
        }
      }
    }
  }

  private ammoTemplate(ammo: AmmoVisual) {
    const key = `${ammo.displayId}:${ammo.inventoryType}`;
    let promise = this.ammoTemplates.get(key);
    if (!promise) {
      promise = loadBakedProjectileModel(ammo.displayId, ammo.inventoryType, this.deps.getMaxAnisotropy());
      this.ammoTemplates.set(key, promise);
    }
    return promise;
  }

  private async launchAmmoProjectile(ammo: AmmoVisual, casterGuid: string, targetGuid: string | undefined) {
    const generation = this.worldGeneration;
    const template = await this.ammoTemplate(ammo);
    if (!template || generation !== this.worldGeneration) return;
    const start = this.spellAnchor(casterGuid, SPELL_ATTACH_HAND_RIGHT, 'hand');
    const end = this.spellAnchor(targetGuid, SPELL_CHEST_ATTACHMENT, 'chest');
    if (!start || !end) return;
    const root = template.clone(true);
    root.matrixAutoUpdate = true;
    root.visible = true;
    root.position.copy(start);
    const direction = end.clone().sub(start);
    if (direction.lengthSq() > 1e-6) {
      root.quaternion.setFromUnitVectors(PROJECTILE_FORWARD, direction.normalize());
    }
    this.deps.scene.add(root);
    this.activeAmmoProjectiles.push({
      root,
      start: start.clone(),
      targetGuid,
      fallbackEnd: end.clone(),
      elapsed: 0,
      duration: Math.max(0.12, start.distanceTo(end) / Math.max(1, ammo.speed || 40)),
    });
  }

  private updateAmmoProjectiles(dt: number) {
    for (let i = this.activeAmmoProjectiles.length - 1; i >= 0; i--) {
      const projectile = this.activeAmmoProjectiles[i];
      projectile.elapsed += dt;
      const end = this.spellAnchor(projectile.targetGuid, SPELL_CHEST_ATTACHMENT, 'chest')
        ?? projectile.fallbackEnd;
      const t = Math.min(1, projectile.elapsed / projectile.duration);
      projectile.root.position.lerpVectors(projectile.start, end, t);
      const direction = end.clone().sub(projectile.root.position);
      if (direction.lengthSq() > 1e-6) {
        projectile.root.quaternion.setFromUnitVectors(PROJECTILE_FORWARD, direction.normalize());
      }
      projectile.root.updateMatrix();
      if (t < 1) continue;
      this.deps.scene.remove(projectile.root);
      this.activeAmmoProjectiles.splice(i, 1);
    }
  }

  private chainTexture(path: string) {
    let promise = this.chainTextures.get(path);
    if (!promise) {
      promise = new Promise((resolve) => {
        this.chainTextureLoader.load(
          `spells/${path}`,
          (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.minFilter = THREE.LinearMipMapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.anisotropy = this.deps.getMaxAnisotropy();
            resolve(texture);
          },
          undefined,
          () => resolve(null),
        );
      });
      this.chainTextures.set(path, promise);
    }
    return promise;
  }

  
  private spawnChainBeam(
    effect: SpellChainEffectJson,
    sourceGuid: string,
    targetGuid: string,
    durationSeconds: number,
    ownerGuid?: string,
  ) {
    const start = this.spellAnchor(sourceGuid, SPELL_ATTACH_HAND_RIGHT, 'hand');
    const end = this.spellAnchor(targetGuid, SPELL_CHEST_ATTACHMENT, 'chest');
    if (!start || !end) return;

    if (!sceneEffectBudget(this.deps.scene).admitBeam(sourceGuid === this.deps.getPlayerGuid() || targetGuid === this.deps.getSelectedTargetGuid())) return;
    const segments = 8;
    const strands = 3;
    const vertexCount = strands * (segments + 1) * 2;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint16Array(strands * segments * 6);
    let cursor = 0;
    for (let strand = 0; strand < strands; strand++) {
      const base = strand * (segments + 1) * 2;
      for (let segment = 0; segment < segments; segment++) {
        const a = base + segment * 2;
        const b = a + 2;
        indices[cursor++] = a;
        indices[cursor++] = a + 1;
        indices[cursor++] = b;
        indices[cursor++] = a + 1;
        indices[cursor++] = b + 1;
        indices[cursor++] = b;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    mesh.renderOrder = 4;
    this.deps.scene.add(mesh);
    const active: ActiveChainBeam = {
      geometry,
      material,
      mesh,
      sourceGuid,
      targetGuid,
      fallbackStart: start.clone(),
      fallbackEnd: end.clone(),
      elapsed: 0,
      duration: durationSeconds,
      effect,
      ownerGuid,
    };
    this.activeChainBeams.push(active);
    this.updateChainBeamGeometry(active);
    void this.chainTexture(effect.texture).then((texture) => {
      if (!texture || !this.activeChainBeams.includes(active)) return;
      material.map = texture;
      material.needsUpdate = true;
    });
  }

  private updateChainBeamGeometry(beam: ActiveChainBeam) {
    const start = this.spellAnchor(beam.sourceGuid, SPELL_ATTACH_HAND_RIGHT, 'hand')
      ?? beam.fallbackStart;
    const end = this.spellAnchor(beam.targetGuid, SPELL_CHEST_ATTACHMENT, 'chest')
      ?? beam.fallbackEnd;
    beam.fallbackStart.copy(start);
    beam.fallbackEnd.copy(end);
    this.beamWriter.update(beam.geometry, beam.effect, beam.elapsed, start, end, this.deps.camera);
  }

  private updateChainBeams(dt: number) {
    for (let i = this.activeChainBeams.length - 1; i >= 0; i--) {
      const beam = this.activeChainBeams[i];
      beam.elapsed += dt;
      if (beam.elapsed >= beam.duration) {
        this.removeChainBeam(i);
        continue;
      }
      const fadeSeconds = beam.effect.fadeMs / 1000;
      beam.material.opacity = Number.isFinite(beam.duration) && fadeSeconds > 0
        ? Math.min(1, Math.max(0, (beam.duration - beam.elapsed) / fadeSeconds))
        : 1;
      this.updateChainBeamGeometry(beam);
    }
  }

  private removeChainBeam(index: number) {
    const beam = this.activeChainBeams[index];
    if (!beam) return;
    sceneEffectBudget(this.deps.scene).releaseBeam();
    this.deps.scene.remove(beam.mesh);
    beam.geometry.dispose();
    beam.material.dispose();
    this.activeChainBeams.splice(index, 1);
  }

  private removeChainBeams(predicate: (beam: ActiveChainBeam) => boolean) {
    for (let i = this.activeChainBeams.length - 1; i >= 0; i--) {
      if (predicate(this.activeChainBeams[i])) this.removeChainBeam(i);
    }
  }

  private chainEffect(kit: SpellVisualKitJson | null, mode: 'channel' | 'cast') {
    const link = kit?.chainEffect;
    if (!link || link.mode !== mode) return null;
    return this.spellChainEffects[String(link.id)] ?? null;
  }

  private spawnChannelBeams(
    casterGuid: string,
    entry: SpellVisualEntry,
    targetGuids: Iterable<string>,
    durationMs: number,
  ) {
    const effect = this.chainEffect(entry.kits.channel ?? entry.kits.cast, 'channel');
    if (!effect) return;
    this.removeChainBeams((beam) => beam.ownerGuid === casterGuid);
    const duration = Number.isFinite(durationMs) ? Math.max(0.1, durationMs / 1000) : Number.POSITIVE_INFINITY;
    for (const targetGuid of targetGuids) {
      if (targetGuid && targetGuid !== casterGuid) {
        this.spawnChainBeam(effect, casterGuid, targetGuid, duration, casterGuid);
      }
    }
  }

  private spawnCastChain(kit: SpellVisualKitJson | null, casterGuid: string, targetGuids: string[]) {
    const effect = this.chainEffect(kit, 'cast');
    if (!effect || targetGuids.length === 0) return;
    const ordered = [casterGuid, ...targetGuids.filter((guid, index, all) => guid && all.indexOf(guid) === index)];
    const duration = Math.max(0.1, (effect.segmentDurationMs + effect.fadeMs) / 1000);
    for (let i = 0; i + 1 < ordered.length; i++) {
      this.spawnChainBeam(effect, ordered[i], ordered[i + 1], duration);
    }
  }

  private updateChannelTargets(casterGuid: string, spellId: number, targetGuids: string[]) {
    const entry = this.spellVisualChain[String(spellId)];
    if (!entry) return;
    let active = this.activeChannelTargets.get(casterGuid);
    if (!active || active.spellId !== spellId) {
      // MSG_CHANNEL_START is direct-to-caster in vMaNGOS; observers learn the remote caster and
      // exact targets from SMSG_SPELL_UPDATE_CHAIN_TARGETS. Start its channel kit here as well.
      const durationMs = 1500;
      this.stopChannel(casterGuid);
      active = { spellId, durationMs, targetGuids: new Set() };
      this.activeChannelTargets.set(casterGuid, active);
      this.spawnSpellKit(
        entry.kits.channel ?? entry.kits.cast,
        casterGuid,
        durationMs,
        undefined,
        'channelTargets',
        casterGuid,
        spellId,
      );
    }
    const previousTargets = active.targetGuids;
    const replacementTargets = new Set(targetGuids);
    active.targetGuids = replacementTargets;
    this.spawnChannelBeams(casterGuid, entry, replacementTargets, active.durationMs);
    for (const targetGuid of replacementTargets) {
      if (previousTargets.has(targetGuid)) continue;
      this.spawnSpellImpact(entry, targetGuid, null, active.durationMs);
    }
  }

  /**
   * Public UNIT_FIELD_CHANNEL_OBJECT + UNIT_CHANNEL_SPELL are the observer authority. Chain-target
   * packets refine a live channel but never create a separate accumulating lifetime.
   */
  syncEntityChannel(entity: WorldEntity) {
    const spellId = entity.channelSpellId ?? 0;
    const targetGuid = entity.channelObjectGuid || undefined;
    const active = this.activeChannelTargets.get(entity.guid);
    if (!spellId) {
      if (active) this.stopChannel(entity.guid);
      return;
    }
    if (active?.spellId === spellId) {
      active.targetGuids = new Set(targetGuid ? [targetGuid] : []);
      const entry = this.spellVisualChain[String(spellId)];
      if (entry) this.spawnChannelBeams(entity.guid, entry, active.targetGuids, active.durationMs);
      return;
    }
    this.stopChannel(entity.guid);
    const entry = this.spellVisualChain[String(spellId)];
    const durationMs = Number.POSITIVE_INFINITY;
    this.activeChannelTargets.set(entity.guid, {
      spellId,
      durationMs,
      targetGuids: new Set(targetGuid ? [targetGuid] : []),
    });
    if (!entry) return;
    this.spawnSpellKit(
      entry.kits.channel ?? entry.kits.cast,
      entity.guid,
      durationMs,
      undefined,
      'channelField',
      entity.guid,
      spellId,
    );
    this.spawnChannelBeams(entity.guid, entry, targetGuid ? new Set([targetGuid]) : new Set(), durationMs);
    if (targetGuid) this.spawnSpellImpact(entry, targetGuid, null, 1500);
  }

  /**
   * SMSG_PLAY_SPELL_VISUAL / SMSG_PLAY_SPELL_IMPACT: the server names a SpellVisualKit.dbc id
   * directly, with no spell attached. vMaNGOS reaches the client only this way for channelled
   * pulses (Spells/Spell.cpp:4219 re-sends m_channeledVisualKit every tick) and for eating and
   * drinking (Objects/Player.cpp:2281/2290, kits 406/438 per Spells/SpellDefines.h:782).
   *
   * Channel pulses ARE meant to re-spawn — vMaNGOS re-sends the same kit every channel tick, and
   * each tick is a fresh burst. But a realm that also emits this opcode alongside SMSG_SPELL_GO
   * would double every cast, so an identical (unit, kit) pair inside PULSE_DEDUPE_MS is dropped.
   * Vanilla channel ticks are >= 1s apart, so this cannot suppress a legitimate pulse.
   */
  playSpellVisualKit(guid: string, kitId: number) {
    const kit = this.spellVisualKits[String(kitId)];
    if (!kit) return;
    const key = `${guid}:${kitId}`;
    const now = performance.now();
    if (!this.recentVisualKits.accept(key, now)) return;
    this.spawnSpellKit(kit, guid, 'authored', undefined, 'playSpellVisualKit');
    if (kit.soundId && kit.soundId < 0xffffffff) this.deps.playSoundId?.(kit.soundId);
  }

  /**
   * Render every Vanilla area-spell DynamicObject from its server-owned lifecycle.
   *
   * vMaNGOS sends no model id or duration here: entry/spellId selects the Build-5875
   * SpellVisual area model, and object removal is the authoritative end signal.
   */
  upsertDynamicObject(entity: WorldEntity) {
    if (
      entity.typeId !== TypeID.DYNAMICOBJECT
      || entity.dynamicObjectType !== 1
      || entity.x === undefined
      || entity.y === undefined
      || entity.z === undefined
    ) return;
    const spellId = entity.dynamicObjectSpellId ?? entity.entry ?? 0;
    if (!spellId) return;
    const local = this.deps.worldToLocal(entity.x, entity.y);
    if (!local) return;
    const current = this.dynamicObjectVisuals.get(entity.guid);
    if (
      current
      && current.spellId === spellId
      && Math.abs(current.x - local.x) < 0.01
      && Math.abs(current.y - local.y) < 0.01
      && Math.abs(current.z - entity.z) < 0.01
    ) return;

    this.removeDynamicObject(entity.guid);
    const active: DynamicObjectVisual = {
      spellId,
      x: local.x,
      y: local.y,
      z: entity.z,
      serial: this.nextDynamicObjectSerial++,
      handles: new Set(),
    };
    this.dynamicObjectVisuals.set(entity.guid, active);
    this.spawnDynamicObjectEntry(entity.guid, active);
  }

  private spawnDynamicObjectEntry(guid: string, active: DynamicObjectVisual) {
    const entry = this.spellVisualChain[String(active.spellId)];
    if (!entry) return;
    const at = new THREE.Vector3(active.x, active.y, active.z);
    if (entry.area?.model) {
      this.spawnOwnedDynamicObjectModel(guid, active, entry.area.model, at, entry.area.scale || 1);
      this.spawnOwnedDynamicObjectKit(guid, active, entry.area.kit, at);
    } else {
      // Some NPC persistent-area rows have no SpellVisual "area" slot; their state kit is the
      // only client-authored persistent visual. Keep this data-driven rather than spell-id based.
      this.spawnOwnedDynamicObjectKit(guid, active, entry.kits.state, at);
    }
  }

  removeDynamicObject(guid: string) {
    const active = this.dynamicObjectVisuals.get(guid);
    if (!active) return;
    this.dynamicObjectVisuals.delete(guid);
    for (const handle of active.handles) handle.stop();
    active.handles.clear();
  }

  /** Mirror UNIT_FIELD_AURA into state kits. The reversed client rebuilds its aura cache from these
   * fields and runs visual callbacks on add/remove, so this stays data-driven and authoritative. */
  syncEntityAuras(guid: string, auras: readonly AuraSlot[]) {
    const spellIds = new Set(auras.map((aura) => aura.spellId).filter((spellId) => spellId > 0));
    if (spellIds.size) this.desiredAuraSpellIds.set(guid, spellIds);
    else this.desiredAuraSpellIds.delete(guid);
    const firstSnapshot = !this.auraSnapshotSeen.has(guid);
    this.auraSnapshotSeen.add(guid);
    this.reconcileAuraStates(guid, spellIds, firstSnapshot);
  }

  private auraStateKey(guid: string, spellId: number) {
    return `${guid}:${spellId}`;
  }

  private reconcileAuraStates(guid: string, spellIds: ReadonlySet<number>, firstSnapshot = false) {
    for (const [key, active] of this.auraStateVisuals) {
      if (active.guid === guid && !spellIds.has(active.spellId)) this.removeAuraState(key);
    }
    for (const spellId of spellIds) {
      const entry = this.spellVisualChain[String(spellId)];
      const stateKit = entry?.kits.state;
      const hasStatePayload = !!stateKit && (
        stateKit.effects.some((effect) => !!effect.model)
        || !!stateKit.shake?.length
        || (stateKit.soundId > 0 && stateKit.soundId < 0xffffffff)
        || stateKit.characterOpacity !== undefined
      );
      if (!stateKit || !hasStatePayload) continue;
      const key = this.auraStateKey(guid, spellId);
      if (this.auraStateVisuals.has(key)) continue;
      const active: AuraStateVisual = {
        guid,
        spellId,
        serial: this.nextAuraStateSerial++,
        handles: new Set(),
      };
      this.auraStateVisuals.set(key, active);
      this.deps.modelOpacity?.setAura(key, guid, active.serial, stateKit.characterOpacity);
      const kit = stateKit;
      // Shake and sound are cast feedback. An aura that was already running when we first saw the
      // unit was not cast now, so replaying either is wrong — see auraSnapshotSeen.
      if (!firstSnapshot) this.triggerKitShake(kit, this.entityOrigin(guid));
      for (const effect of kit.effects) {
        if (!effect.model) continue;
        // State models are authored around the target origin (Ice Block spans z=-0.94..3.44).
        // Treating the kit slot as a character attachment would put that volume on a hand.
        void this.visuals.spawn(effect.model, {
          follow: () => this.spellAnchor(guid, effect.attachment, 'ground'),
          scale: effect.scale || 1,
          durationMs: Number.POSITIVE_INFINITY,
          // 62 spell models author a Hold sequence (AnimationData 158) — the sustained state a
          // buff/shield sits in. icebarrier_state.m2 ships 0:867ms, 158:1000ms, 159:1000ms.
          // Models without one fall back to Stand inside SpellModelInstance.
          sequenceId: SPELL_SEQ_HOLD,
        }).then((handle) => {
          if (!handle) return;
          const current = this.auraStateVisuals.get(key);
          if (current !== active || current.serial !== active.serial) {
            handle.stop();
            return;
          }
          active.handles.add(handle);
        });
      }
      // A looping sound belongs to the aura lifetime, but one-shot cast feedback must not replay
      // for an aura that was already active when the first snapshot arrived.
      if (kit.soundId && kit.soundId < 0xffffffff) {
        const soundKey = `aura:${key}`;
        const looping = this.deps.isLoopingSound?.(kit.soundId) ?? false;
        if (looping || !firstSnapshot) {
          this.deps.playSoundId?.(kit.soundId, looping ? soundKey : undefined);
        }
      }
    }
  }

  private removeAuraState(key: string) {
    const active = this.auraStateVisuals.get(key);
    if (!active) return;
    this.auraStateVisuals.delete(key);
    for (const handle of active.handles) handle.stop();
    active.handles.clear();
    this.deps.stopSound?.(`aura:${key}`, SUSTAIN_FADE_MS);
    this.deps.modelOpacity?.removeAura(key);
  }

  removeEntityAuraStates(guid: string) {
    this.desiredAuraSpellIds.delete(guid);
    // Despawn/relog: the next time this GUID appears, its auras are a fresh snapshot again.
    this.auraSnapshotSeen.delete(guid);
    for (const [key, active] of this.auraStateVisuals) {
      if (active.guid === guid) this.removeAuraState(key);
    }
    this.deps.modelOpacity?.clearEntity(guid);
    for (const [key, active] of this.weaponEnchantVisuals) {
      if (active.ownerGuid === guid) this.removeWeaponEnchant(key);
    }
  }

  /**
   * Mirror the two public visible-item enchant fields. Temporary enchant visuals replace the
   * permanent visual while present; when they expire/clear the permanent visual is restored.
   */
  syncEntityWeaponEnchants(
    entity: WorldEntity,
    localAttachmentRoot?: (equipmentSlot: number) => THREE.Object3D | undefined,
  ) {
    for (const equipmentSlot of [15, 16, 17]) {
      const visible = entity.visibleItemEnchantments?.[equipmentSlot];
      const enchantId = visible?.temporary || visible?.permanent || 0;
      const key = `${entity.guid}:${equipmentSlot}`;
      const current = this.weaponEnchantVisuals.get(key);
      if (current?.enchantId === enchantId) continue;
      if (current) this.removeWeaponEnchant(key);
      if (!enchantId) continue;
      const active: WeaponEnchantVisual = {
        ownerGuid: entity.guid,
        equipmentSlot,
        enchantId,
        serial: this.nextAuraStateSerial++,
        getRoot: () => localAttachmentRoot?.(equipmentSlot)
          ?? this.deps.getEntityRenderer()?.equipmentAttachmentRoot(entity.guid, equipmentSlot),
        handles: new Set(),
      };
      this.weaponEnchantVisuals.set(key, active);
      this.spawnWeaponEnchant(active);
    }
  }

  private spawnWeaponEnchant(active: WeaponEnchantVisual) {
    if (active.handles.size) return;
    const models = this.weaponEnchantModels[String(active.enchantId)] ?? [];
    const key = `${active.ownerGuid}:${active.equipmentSlot}`;
    for (const model of models) {
      const position = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      void this.visuals.spawn(model, {
        follow: () => {
          const root = active.getRoot();
          if (!root) return null;
          root.updateWorldMatrix(true, false);
          return root.getWorldPosition(position);
        },
        followRotation: () => {
          const root = active.getRoot();
          if (!root) return null;
          root.updateWorldMatrix(true, false);
          return root.getWorldQuaternion(rotation);
        },
        durationMs: Number.POSITIVE_INFINITY,
        sequenceId: SPELL_SEQ_HOLD,
      }).then((handle) => {
        if (!handle) return;
        const current = this.weaponEnchantVisuals.get(key);
        if (current !== active || current.serial !== active.serial) {
          handle.stop();
          return;
        }
        active.handles.add(handle);
      });
    }
  }

  private removeWeaponEnchant(key: string) {
    const active = this.weaponEnchantVisuals.get(key);
    if (!active) return;
    this.weaponEnchantVisuals.delete(key);
    for (const handle of active.handles) handle.stop();
    active.handles.clear();
  }

  private spawnOwnedDynamicObjectKit(
    guid: string,
    active: DynamicObjectVisual,
    kit: SpellVisualKitJson | null,
    position: THREE.Vector3,
  ) {
    if (!kit) return;
    this.triggerKitShake(kit, position);
    for (const effect of kit.effects) {
      if (effect.model) {
        this.spawnOwnedDynamicObjectModel(guid, active, effect.model, position, effect.scale || 1);
      }
    }
  }

  private spawnOwnedDynamicObjectModel(
    guid: string,
    active: DynamicObjectVisual,
    model: string,
    position: THREE.Vector3,
    scale: number,
  ) {
    void this.visuals.spawn(model, {
      position: position.clone(),
      scale,
      durationMs: Number.POSITIVE_INFINITY,
    }).then((handle) => {
      if (!handle) return;
      const current = this.dynamicObjectVisuals.get(guid);
      if (current !== active || current.serial !== active.serial) {
        handle.stop();
        return;
      }
      active.handles.add(handle);
    });
  }

  /**
   * Exact Vanilla system effect model; 11540/11541 are creature display IDs, not spell IDs.
   *
   * 'authored', not a hand-picked 3200ms: LevelUp.m2's only sequence runs 0..1867ms in the raw
   * M2 (replayMin=replayMax=0, so it plays once). Emitting for 3200ms drove the mesh 1.7x through
   * its own animation before the particle tail pushed it past twice — the "it plays, then plays
   * again" report.
   */
  spawnLevelUp(guid: string) {
    void this.visuals.spawn('Spells\\LevelUp\\LevelUp.m2', {
      follow: () => this.spellAnchor(guid, SPELL_CHEST_ATTACHMENT, 'ground'),
      scale: 1,
      durationMs: 'authored',
    });
  }

  spawnDebug(model: string, x: number, durationMs: number) {
    return this.visuals.spawn(model, { position: new THREE.Vector3(x, 0, 1.2), durationMs, scale: 1 });
  }

  /**
   * Where a kit effect anchors. The SpellVisualKit column decides; the name is only consulted
   * for models that reach us outside a kit (missile/area, baked with slot -1).
   */
  private spellEffectRole(effect: SpellKitEffectJson): SpellEffectRole {
    const bySlot = SPELL_KIT_SLOT_ROLE[effect.slot];
    if (bySlot) return bySlot;
    const label = `${effect.name ?? ''} ${effect.model}`;
    if (/hand/i.test(label)) return 'hand';
    if (/base|ground|area/i.test(label)) return 'ground';
    if (/head/i.test(label)) return 'head';
    return 'chest';
  }

  private fallbackAnchorHeight(guid: string | undefined, role: SpellEffectRole) {
    const playerGuid = this.deps.getPlayerGuid();
    const renderer = this.deps.getEntityRenderer();
    if (role === 'ground') return 0.05;
    if (role === 'head') return (guid && guid !== playerGuid ? renderer?.localHeightOf(guid) : null) ?? 1.85;
    if (role === 'hand') return ((guid && guid !== playerGuid ? renderer?.localHeightOf(guid) : null) ?? 1.8) * 0.58;
    return ((guid && guid !== playerGuid ? renderer?.localHeightOf(guid) : null) ?? 1.8) * 0.55;
  }

  private playerAttachmentAnchor(attach: number): THREE.Vector3 | null {
    const playerAnimator = this.deps.getPlayerAnimator();
    const playerModelGroup = this.deps.getPlayerModelGroup();
    if (!playerAnimator?.getAttachmentMatrix || !playerModelGroup) return null;
    const matrix = playerAnimator.getAttachmentMatrix(attach, this.playerAttachmentMatrix);
    if (!matrix) return null;
    this.playerAttachmentPos.setFromMatrixPosition(matrix);
    playerModelGroup.localToWorld(this.playerAttachmentPos);
    return this.playerAttachmentPos.clone();
  }

  private spellAnchor(guid: string | undefined, attach = SPELL_CHEST_ATTACHMENT, role: SpellEffectRole = 'chest'): THREE.Vector3 | null {
    if (!guid) return null;
    const playerGuid = this.deps.getPlayerGuid();
    if (guid === playerGuid) {
      if (role !== 'ground') {
        const exact = this.playerAttachmentAnchor(attach);
        if (exact) return exact;
      }
      const charPos = this.deps.getCharPos();
      return new THREE.Vector3(charPos.x, charPos.y, charPos.z + this.fallbackAnchorHeight(guid, role));
    }
    if (role !== 'ground') {
      const exact = this.deps.getEntityRenderer()?.localAttachmentOf(guid, attach);
      if (exact) return new THREE.Vector3(exact.x, exact.y, exact.z);
    }
    const base = this.deps.getEntityRenderer()?.localOriginOf(guid) ?? null;
    if (!base) return null;
    return new THREE.Vector3(base.x, base.y, base.z + this.fallbackAnchorHeight(guid, role));
  }

  /** Original kit shakes use the owning object's root/world position, not an effect attachment. */
  private entityOrigin(guid: string | undefined): THREE.Vector3 | null {
    if (!guid) return null;
    if (guid === this.deps.getPlayerGuid()) return this.deps.getCharPos().clone();
    const base = this.deps.getEntityRenderer()?.localOriginOf(guid);
    return base ? new THREE.Vector3(base.x, base.y, base.z) : null;
  }

  private triggerKitShake(kit: SpellVisualKitJson | null, source: THREE.Vector3 | null) {
    if (!kit?.shake?.length || !source) return;
    this.cameraShakes.add(kit.shake, source);
  }

  /** Kit slot 3 is the left-hand column, slots 4/6/7 the right-hand ones. */
  private handAttachment(slot: number) {
    return slot === 3 ? SPELL_ATTACH_HAND_LEFT : SPELL_ATTACH_HAND_RIGHT;
  }

  /** Record a spawn for __wowSpellVisualDebug(). Cheap enough to leave on: one push per model. */
  private note(stage: string, kitId: number, model: string, slot: number, guid?: string) {
    this.spawnLedger.push({ t: Math.round(performance.now()), stage, spellId: kitId, model, slot, guid });
    if (this.spawnLedger.length > SPAWN_LEDGER_LIMIT) this.spawnLedger.shift();
  }

  private spawnSpellKit(
    kit: SpellVisualKitJson | null,
    guid: string | undefined,
    durationMs: number | 'authored',
    sequenceId?: number,
    stage = 'kit',
    channelOwnerGuid?: string,
    channelSpellId?: number,
  ) {
    if (!kit) return;
    this.triggerKitShake(kit, this.entityOrigin(guid));
    // Snapshot taken BEFORE the async spawn: if the cast is cancelled while the model loads, the
    // serial moves on and the resolved handle is stopped instead of being retained.
    const castSerial = guid ? this.castVisualSerial.get(guid) ?? 0 : 0;
    for (const e of kit.effects) {
      if (!e.model) continue;
      this.note(stage, kit.id, e.model, e.slot, guid);
      const role = this.spellEffectRole(e);
      const attach = role === 'hand'
        ? this.handAttachment(e.slot)
        : role === 'head'
          ? SPELL_HEAD_ATTACHMENT
          : role === 'ground'
            ? e.attachment
            : SPELL_CHEST_ATTACHMENT;
      void this.visuals.spawn(e.model, {
        important: guid === this.deps.getPlayerGuid() || guid === this.deps.getSelectedTargetGuid(),
        follow: () => this.spellAnchor(guid, attach, role),
        scale: e.scale || 1,
        durationMs,
        sequenceId,
      }).then((handle) => {
        if (!handle) return;
        if (!channelOwnerGuid) {
          // Precast/cast: retain the handle so an interrupt can retract it. The spawn resolves a
          // frame or more after the request, so a cast that was already cancelled while the model
          // was loading must not leave a glow behind either.
          if (guid && (stage === 'precast' || stage === 'cast')) this.retainCastHandle(guid, castSerial, handle);
          return;
        }
        if (this.activeChannelTargets.get(channelOwnerGuid)?.spellId !== channelSpellId) {
          handle.stop();
          return;
        }
        let handles = this.activeChannelHandles.get(channelOwnerGuid);
        if (!handles) {
          handles = new Set();
          this.activeChannelHandles.set(channelOwnerGuid, handles);
        }
        handles.add(handle);
      });
    }
  }

  private spawnSpellKitAt(
    kit: SpellVisualKitJson | null,
    position: THREE.Vector3,
    durationMs: number | 'authored',
    sequenceId?: number,
    stage = 'kitAt',
  ) {
    if (!kit) return;
    this.triggerKitShake(kit, position);
    for (const effect of kit.effects) {
      if (!effect.model) continue;
      this.note(stage, kit.id, effect.model, effect.slot);
      void this.visuals.spawn(effect.model, {
        important: true, position: position.clone(),
        scale: effect.scale || 1,
        durationMs,
        sequenceId,
      });
    }
  }

  private spawnSpellImpact(
    entry: SpellVisualEntry,
    targetGuid: string | undefined,
    destination?: THREE.Vector3 | null,
    areaDurationMs: number | 'authored' = 'authored',
  ) {
    // Impacts are the worst offender: all 125 archive-resolved impact models author a sequence
    // longer than 250ms (median 1900ms, Flamestrike_Impact 6000ms, Blizzard_Impact_Base 3300ms),
    // and ArcaneExplosion_Impact_Chest does not key three of its six emitters ON until 1000ms.
    if (destination) this.spawnSpellKitAt(entry.kits.impact, destination, 'authored', undefined, 'impactAt');
    else this.spawnSpellKit(entry.kits.impact, targetGuid, 'authored', undefined, 'impact');
    // Effect 27 areas are owned by a server DynamicObject. Spawning the same area model here as a
    // guessed 1.5-second one-shot caused the visible 1-2-frame flash and duplicated the real layer.
    //
    // The non-persistent path defaults to 'authored' for the same reason the impact layer above
    // does. A numeric duration gates emission AND makes the sequence loop (`elapsed % duration`);
    // 'authored' plays it once and holds the last frame, which is what Build 5875 authors —
    // replayMin/Max are 0 on every probed sequence. Measured over the baked corpus: the old 1500
    // constant ended 225 of 394 non-persistent area entries (25 distinct models) before their
    // authored sequence finished — Flamestrike_Impact_Base is 12000ms of mesh fade cut to 1500ms
    // — while over-extending 48 entries (11 models) whose sequence is shorter than 1500ms.
    // Channel callers still pass an explicit lifetime; theirs is server-authoritative.
    if (entry.area && !entry.persistentArea) {
      const at = destination?.clone() ?? this.spellAnchor(targetGuid, 6, 'ground');
      if (at) {
        void this.visuals.spawn(entry.area.model, {
          important: true,
          position: at.clone(),
          scale: entry.area.scale || 1,
          durationMs: areaDurationMs,
        });
        if (destination) this.spawnSpellKitAt(entry.area.kit, destination, areaDurationMs);
        else this.spawnSpellKit(entry.area.kit, targetGuid, areaDurationMs);
      }
    }
  }

  private destinationKey(casterGuid: string, spellId: number) {
    return `${casterGuid}:${spellId}`;
  }

  private recentDestination(casterGuid: string, spellId: number) {
    const key = this.destinationKey(casterGuid, spellId);
    const recent = this.recentDestinations.get(key);
    if (!recent) return null;
    if (performance.now() - recent.recordedAt > 30_000) {
      this.recentDestinations.delete(key);
      return null;
    }
    return recent.position.clone();
  }

  private clearCasterDestinations(casterGuid: string) {
    for (const key of this.recentDestinations.keys()) {
      if (key.startsWith(`${casterGuid}:`)) this.recentDestinations.delete(key);
    }
  }

  private sustainKey(casterGuid: string, stage: 'precast' | 'cast' | 'channel') {
    return `spell:${casterGuid}:${stage}`;
  }

  /**
   * Stops the looping precast/cast/channel voice for one caster.
   *
   * Combat events (`spellFailure`, `castResult`, `channelUpdate`) are the normal end of a sustain
   * loop, but they are not guaranteed to arrive — a caster can despawn, die out of range, or be
   * left behind by a zone change mid-cast. `stopCasterSounds`/`stopAllCasterSounds` below give the
   * despawn and world-transfer paths a way to close those loops, which otherwise played forever.
   */
  private stopCasterSustain(casterGuid: string) {
    this.activeSustainCasters.delete(casterGuid);
    for (const stage of ['precast', 'cast', 'channel'] as const) {
      this.deps.stopSound?.(this.sustainKey(casterGuid, stage), SUSTAIN_FADE_MS);
    }
    // Retract the precast/cast VISUAL too, not just its sound. `stop()` ends emission and lets
    // already-emitted particles live out their authored lifetime, so the glow fades instead of
    // popping. Bumping the serial also disowns any spawn still resolving from the cancelled cast.
    this.castVisualSerial.set(casterGuid, (this.castVisualSerial.get(casterGuid) ?? 0) + 1);
    for (const handle of this.activeCastHandles.get(casterGuid) ?? []) handle.stop();
    this.activeCastHandles.delete(casterGuid);
  }

  /** Serial per caster, bumped whenever a cast is superseded, completed or cancelled. */
  private readonly castVisualSerial = new Map<string, number>();

  private retainCastHandle(casterGuid: string, serial: number, handle: SpellVisualHandle) {
    if ((this.castVisualSerial.get(casterGuid) ?? 0) !== serial) {
      handle.stop();
      return;
    }
    let handles = this.activeCastHandles.get(casterGuid);
    if (!handles) {
      handles = new Set();
      this.activeCastHandles.set(casterGuid, handles);
    }
    handles.add(handle);
  }

  private stopChannel(casterGuid: string) {
    this.stopCasterSustain(casterGuid);
    for (const handle of this.activeChannelHandles.get(casterGuid) ?? []) handle.stop();
    this.activeChannelHandles.delete(casterGuid);
    this.removeChainBeams((beam) => beam.ownerGuid === casterGuid);
    this.activeChannelTargets.delete(casterGuid);
    this.clearCasterDestinations(casterGuid);
  }

  /** Called when an entity despawns, so its in-flight cast loop does not outlive it. */
  stopCasterSounds(casterGuid: string) {
    for (const active of this.activeChannelTargets.values()) active.targetGuids.delete(casterGuid);
    this.removeChainBeams((beam) => beam.sourceGuid === casterGuid || beam.targetGuid === casterGuid);
    this.stopChannel(casterGuid);
    this.cancelPendingImpacts(casterGuid);
  }

  /** Called on world transfer / world teardown: no sustain loop may survive into the next map. */
  stopAllCasterSounds() {
    this.worldGeneration++;
    for (const casterGuid of [...this.activeSustainCasters]) this.stopCasterSustain(casterGuid);
    // A caster can hold a precast VISUAL without a sustained sound, so it is not in that set.
    for (const casterGuid of [...this.activeCastHandles.keys()]) this.stopCasterSustain(casterGuid);
    for (const casterGuid of [...this.activeChannelTargets.keys()]) this.stopChannel(casterGuid);
    for (const pending of this.pendingImpacts) {
      window.clearTimeout(pending.visualTimer);
      window.clearTimeout(pending.fallbackTimer);
    }
    this.pendingImpacts.length = 0;
    this.recentImpactSounds.clear(); this.recentDestinations.clear(); this.recentVisualKits.clear();
    for (const projectile of this.activeAmmoProjectiles) this.deps.scene.remove(projectile.root);
    this.activeAmmoProjectiles.length = 0;
    this.removeChainBeams(() => true);
    disposeSpellControllerCaches(this.chainTextures, this.ammoTemplates);
    for (const guid of [...this.dynamicObjectVisuals.keys()]) this.removeDynamicObject(guid);
    this.desiredAuraSpellIds.clear();
    this.auraSnapshotSeen.clear();
    for (const key of [...this.auraStateVisuals.keys()]) this.removeAuraState(key);
    this.deps.modelOpacity?.clear();
    for (const key of [...this.weaponEnchantVisuals.keys()]) this.removeWeaponEnchant(key);
    this.prepareCameraFrame();
    this.cameraShakes.clear();
    this.visuals.clear(); this.visuals.clearCaches();
  }

  private playKitSound(kit: SpellVisualKitJson | null, key?: string) {
    if (!kit?.soundId || kit.soundId >= 0xffffffff) return;
    this.deps.playSoundId?.(kit.soundId, key);
    // Remember which casters own a live keyed loop so world transfer can close all of them.
    if (key?.startsWith('spell:')) {
      const casterGuid = key.slice('spell:'.length, key.lastIndexOf(':'));
      if (casterGuid) this.activeSustainCasters.add(casterGuid);
    }
  }

  private preloadSpellSounds(entry: SpellVisualEntry) {
    const kits = [
      entry.kits.precast,
      entry.kits.cast,
      entry.kits.impact,
      entry.kits.state,
      entry.kits.channel,
      entry.area?.kit ?? null,
    ];
    for (const kit of kits) {
      if (kit?.soundId && kit.soundId < 0xffffffff) this.deps.preloadSoundId?.(kit.soundId);
    }
  }

  private impactKey(spellId: number, casterGuid: string) {
    return `${spellId}:${casterGuid}`;
  }

  private impactWasRecentlyPlayed(spellId: number, casterGuid: string) {
    const now = performance.now();
    for (const [key, playedAt] of this.recentImpactSounds) {
      if (now - playedAt > IMPACT_DEDUPE_MS) this.recentImpactSounds.delete(key);
    }
    return now - (this.recentImpactSounds.get(this.impactKey(spellId, casterGuid)) ?? -Infinity) <= IMPACT_DEDUPE_MS;
  }

  private playImpactSounds(spellId: number, entry: SpellVisualEntry, casterGuid: string, _targetGuid: string | undefined) {
    if (this.impactWasRecentlyPlayed(spellId, casterGuid)) return;
    const soundIds = new Set<number>();
    const impactSound = entry.kits.impact?.soundId;
    const areaSound = entry.area?.kit?.soundId;
    const stateSound = entry.kits.state?.soundId;
    if (impactSound && impactSound < 0xffffffff) soundIds.add(impactSound);
    if (areaSound && areaSound < 0xffffffff) soundIds.add(areaSound);
    // Looping state sounds belong to aura/channel lifecycle and must not be started as unowned one-shots.
    if (stateSound && stateSound < 0xffffffff && !this.deps.isLoopingSound?.(stateSound)) soundIds.add(stateSound);
    for (const soundId of soundIds) this.deps.playSoundId?.(soundId);
    this.recentImpactSounds.set(this.impactKey(spellId, casterGuid), performance.now());
  }

  private spawnPendingImpactVisual(pending: PendingSpellImpact, targetGuid: string | undefined) {
    if (
      pending.worldGeneration !== this.worldGeneration
      || !this.pendingImpacts.includes(pending)
      || pending.visualSpawned
    ) return;
    pending.visualSpawned = true;
    this.spawnSpellImpact(pending.entry, targetGuid ?? pending.targetGuid);
  }

  private resolvePendingImpact(pending: PendingSpellImpact, targetGuid: string | undefined) {
    const index = this.pendingImpacts.indexOf(pending);
    if (index < 0) return;
    window.clearTimeout(pending.visualTimer);
    window.clearTimeout(pending.fallbackTimer);
    if (pending.worldGeneration !== this.worldGeneration) {
      this.pendingImpacts.splice(index, 1);
      return;
    }
    this.spawnPendingImpactVisual(pending, targetGuid);
    this.playImpactSounds(pending.spellId, pending.entry, pending.casterGuid, targetGuid ?? pending.targetGuid);
    this.pendingImpacts.splice(index, 1);
  }

  private resolveAuthoritativeImpact(spellId: number, casterGuid: string, targetGuid: string) {
    const pending = this.pendingImpacts.find((candidate) =>
      candidate.spellId === spellId
      && candidate.casterGuid === casterGuid
      && (!candidate.targetGuid || candidate.targetGuid === targetGuid),
    );
    if (pending) {
      this.resolvePendingImpact(pending, targetGuid);
      return;
    }
    if (this.impactWasRecentlyPlayed(spellId, casterGuid)) return;
    const entry = this.spellVisualChain[String(spellId)];
    if (!entry?.missile) return;
    this.spawnSpellImpact(entry, targetGuid);
    this.playImpactSounds(spellId, entry, casterGuid, targetGuid);
  }

  private cancelPendingImpacts(casterGuid: string, spellId?: number) {
    for (let index = this.pendingImpacts.length - 1; index >= 0; index--) {
      const pending = this.pendingImpacts[index];
      if (pending.casterGuid !== casterGuid || (spellId !== undefined && pending.spellId !== spellId)) continue;
      window.clearTimeout(pending.visualTimer);
      window.clearTimeout(pending.fallbackTimer);
      this.pendingImpacts.splice(index, 1);
    }
  }

  private launchSpellMissile(spellId: number, entry: SpellVisualEntry, casterGuid: string, targetGuid: string | undefined) {
    // Missiles leave the right hand (attachment 1), not the shield slot this used to use.
    const start = this.spellAnchor(casterGuid, SPELL_ATTACH_HAND_RIGHT, 'hand');
    const endAttach = SPELL_CHEST_ATTACHMENT;
    const endNow = this.spellAnchor(targetGuid, endAttach || SPELL_CHEST_ATTACHMENT, 'chest');
    if (!entry.missile || !start || !endNow) {
      this.spawnSpellImpact(entry, targetGuid);
      this.playImpactSounds(spellId, entry, casterGuid, targetGuid);
      return;
    }
    const dist = start.distanceTo(endNow);
    const travelMs = Math.max(150, (dist / Math.max(4, entry.missile.speed || entry.speed || 20)) * 1000);
    const t0 = performance.now();
    // SpellVisual missilePathType 0 is Vanilla's direct line path. Keep the arc only as a
    // conservative placeholder for nonzero path types until those rows are byte-verified.
    const arc = entry.missile.pathType === 0 ? 0 : Math.min(3, dist * 0.1);
    const pos = new THREE.Vector3();
    void this.visuals.spawn(entry.missile.model, {
      scale: entry.missile.scale || 1,
      durationMs: travelMs,
      // 8 spell models author AnimationData 144 "InFlight" — the travelling state of a projectile.
      // Falls back to Stand for the rest.
      sequenceId: SPELL_SEQ_IN_FLIGHT,
      follow: () => {
        const t = Math.min(1, (performance.now() - t0) / travelMs);
        pos.lerpVectors(start, this.spellAnchor(targetGuid, endAttach || SPELL_CHEST_ATTACHMENT, 'chest') ?? endNow, t);
        if (arc > 0) pos.z += 4 * arc * t * (1 - t); // peak `arc` yards at midpoint
        return pos;
      },
    });
    const pending: PendingSpellImpact = {
      spellId,
      casterGuid,
      targetGuid,
      entry,
      worldGeneration: this.worldGeneration,
      visualSpawned: false,
      visualTimer: 0,
      fallbackTimer: 0,
    };
    pending.visualTimer = window.setTimeout(() => this.spawnPendingImpactVisual(pending, targetGuid), travelMs);
    pending.fallbackTimer = window.setTimeout(
      () => this.resolvePendingImpact(pending, targetGuid),
      travelMs + IMPACT_EVENT_GRACE_MS,
    );
    this.pendingImpacts.push(pending);
  }

  private installDebugHooks() {
    if (!QA_GLOBALS_ENABLED) return;
    /**
     * `__wowSpellVisualDebug()` — what actually spawned, and in what order.
     * Cast the suspect spell once, then call it. `byStage` counts spawns per pipeline stage:
     * two entries for the same model under different stages means two stages fired; two under the
     * SAME stage with different slots is authored (both hands) and correct.
     */
    qaGlobals.__wowSpellVisualDebug = (sinceMs = 6000) => {
      const cutoff = performance.now() - sinceMs;
      const recent = this.spawnLedger.filter((r) => r.t >= cutoff);
      const byStage: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      for (const r of recent) {
        byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
        byModel[r.model] = (byModel[r.model] ?? 0) + 1;
      }
      const calls = this.castLedger.filter((r) => r.t >= cutoff);
      const t0 = Math.min(recent[0]?.t ?? Infinity, calls[0]?.t ?? Infinity);
      // One press should produce ONE castSpellVisual per stage. Anything else is the realm (or the
      // action bar) delivering the event twice, and no renderer change can fix that.
      const perStage: Record<string, number> = {};
      for (const c of calls) perStage[`${c.stage}:${c.spellId}`] = (perStage[`${c.stage}:${c.spellId}`] ?? 0) + 1;
      return {
        windowMs: sinceMs,
        castCalls: calls.length,
        castCallsByStageAndSpell: perStage,
        repeatedEvents: Object.entries(perStage).filter(([, n]) => n > 1),
        castTimeline: calls.map((c) => `+${String(c.t - t0).padStart(5)}ms  CALL stage=${c.stage} spell=${c.spellId} hits=${c.hits}`),
        spawns: recent.length,
        byStage,
        duplicatedModels: Object.entries(byModel).filter(([, n]) => n > 1),
        timeline: recent.map((r) => `+${String(r.t - t0).padStart(5)}ms  ${r.stage.padEnd(20)} kit=${r.spellId} slot=${r.slot} ${r.model}`),
        liveInstances: this.visuals.activeCount,
        activeCameraShakes: this.cameraShakes.activeCount,
        cameraShakeOffset: this.cameraShakeOffset.toArray(),
      };
    };
    qaGlobals.__wowCameraShakeDebug = (kitId?: number) => {
      if (kitId !== undefined) {
        const kit = this.spellVisualKits[String(kitId)];
        this.triggerKitShake(
          kit ?? null,
          this.entityOrigin(this.deps.getPlayerGuid()) ?? this.deps.camera.position.clone(),
        );
      }
      return {
        active: this.cameraShakes.activeCount,
        offset: this.cameraShakeOffset.toArray(),
        ...(kitId === undefined ? {} : { triggered: kitId }),
      };
    };
    qaGlobals.__wowSpellTest = (model: string, dur = 1500, frame = false) => {
      const controls = this.deps.getControls();
      const p = this.spellAnchor(this.deps.getPlayerGuid(), 1) ?? controls?.target.clone() ?? new THREE.Vector3();
      void this.visuals.spawn(model, { position: p.clone(), durationMs: dur, scale: 1 });
      if (frame && controls) {
        controls.target.copy(p);
        this.deps.camera.position.set(p.x + 3, p.y - 3, p.z + 1.5);
        controls.autoRotate = false;
        controls.update();
      }
      return `spawned ${model} at ${p.toArray().map((v) => v.toFixed(1)).join(',')}`;
    };
    qaGlobals.__wowDebug = {
      spellActive: () => this.visuals.activeCount,
      spellChain: () => Object.keys(this.spellVisualChain).length,
      spellInspect: () => this.visuals.debugInfo(),
      castSpell: (id: number, target?: string) => this.castSpellVisual(id, this.deps.getPlayerGuid() ?? '', target, 'go', 0),
    };
  }
}
