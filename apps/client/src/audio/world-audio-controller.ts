import type { CombatEvent, WorldEntity, WorldSoundEvent } from '../world';
import type { PlayerAnimState } from '../model-loader';
import { TypeID } from '../world-entities';
import type { PlaySoundOptions, WowSoundManager } from './sound-manager';

type Position = { x: number; y: number; z: number };
type MovementAudioState = {
  position: Position;
  animation: PlayerAnimState;
  grounded: boolean;
  swimming: boolean;
  groundSource: 'terrain' | 'wmo';
  terrainType: number;
  waterLevel: number;
  displayId?: number;
  race?: number;
  gender?: number;
};

const HITINFO_MISS = 0x00000010;
const HITINFO_CRITICAL = 0x00000080;
const MAX_AUDIBLE_DISTANCE = 55;
const MF_JUMPING = 0x00002000;
const MF_SWIMMING = 0x00200000;

type RemoteMovementAudio = {
  position: Position;
  stepDistance: number;
  jumping: boolean;
  swimming: boolean;
};
/** Asset conversion utility. */
export class WorldAudioController {
  private worldReady = false;
  private lastStepPosition: Position | undefined;
  private stepDistance = 0;
  private wasGrounded = true;
  private wasInWater = false;
  private readonly lastCueAt = new Map<string, number>();
  private readonly healthByGuid = new Map<string, number>();
  private readonly levelByGuid = new Map<string, number>();
  private readonly deathPlayedAt = new Map<string, number>();
  private readonly remoteMovement = new Map<string, RemoteMovementAudio>();

  constructor(private readonly deps: {
    sound: WowSoundManager;
    getPlayerGuid: () => string | undefined;
    getPlayerPosition: () => Position;
    getEntity: (guid: string) => WorldEntity | undefined;
    getEntityPosition: (guid: string) => Position | undefined;
    getWeaponInfo: (guid: string) => { subclass?: number; material?: number } | undefined;
    sampleTerrainType: (x: number, y: number) => number;
    sampleWaterLevel: (x: number, y: number) => number;
  }) {}

  resetMovement(position?: Position) {
    this.lastStepPosition = position ? { ...position } : undefined;
    this.stepDistance = 0;
    this.wasGrounded = true;
    this.wasInWater = false;
  }

  setWorldReady(ready: boolean, position?: Position) {
    this.worldReady = ready;
    this.deps.sound.setWorldReady(ready);
    this.remoteMovement.clear();
    this.resetMovement(position);
  }

  updateMovement(state: MovementAudioState) {
    if (!this.worldReady) return;
    const previous = this.lastStepPosition;
    this.lastStepPosition = { ...state.position };
    if (!previous) return;

    const delta = Math.hypot(state.position.x - previous.x, state.position.y - previous.y);
    if (delta > 12) {
      this.stepDistance = 0;
      this.wasGrounded = state.grounded;
      return;
    }

    const movingOnFoot = state.grounded && !state.swimming && isFootstepAnimation(state.animation);
    const inWater = state.swimming || (Number.isFinite(state.waterLevel) && state.waterLevel > state.position.z + 0.05);
    if (!this.wasInWater && inWater) this.deps.sound.playWaterEntry('small', { volumeScale: 0.9 });
    this.wasInWater = inWater;
    if (this.wasGrounded && !state.grounded && !state.swimming && state.animation === 'jumpStart') {
      this.deps.sound.playMovementCue(state.race, state.gender, 'jump', { volumeScale: 0.9 });
    }
    if (!this.wasGrounded && state.grounded && !state.swimming) {
      this.deps.sound.playMovementCue(state.race, state.gender, 'land', { volumeScale: 0.82 });
      this.playStep(state, 0.76);
      this.stepDistance = 0;
    }
    this.wasGrounded = state.grounded;
    if (!movingOnFoot || delta < 0.0001) {
      this.stepDistance = 0;
      return;
    }

    const spacing = stepSpacing(state.animation);
    this.stepDistance += delta;
    // Never emit multiple footfalls in one frame. A loading/frame hitch used to
    // cross two spacings and produced the "two sounds at once" report.
    if (this.stepDistance >= spacing) {
      this.stepDistance %= spacing;
      this.playStep(state, state.animation === 'walk' ? 0.78 : 0.9);
    }
  }

  handleEntity(entity: WorldEntity) {
    this.updateRemoteMovement(entity);
    if (entity.level !== undefined) {
      const previousLevel = this.levelByGuid.get(entity.guid);
      this.levelByGuid.set(entity.guid, entity.level);
    }
    if (entity.health === undefined) return;
    const previous = this.healthByGuid.get(entity.guid);
    this.healthByGuid.set(entity.guid, entity.health);
    if (previous !== undefined && previous > 0 && entity.health <= 0) this.playDeath(entity.guid, false);
    if (entity.health > 0) this.deathPlayedAt.delete(entity.guid);
  }

  removeEntity(guid: string) {
    this.healthByGuid.delete(guid);
    this.levelByGuid.delete(guid);
    this.deathPlayedAt.delete(guid);
    this.remoteMovement.delete(guid);
    for (const key of [...this.lastCueAt.keys()]) if (key.startsWith(`${guid}:`)) this.lastCueAt.delete(key);
  }

  handleInteraction(guid: string | undefined) {
    if (!guid || !this.allowCue(guid, 'greeting', 3500)) return;
    const entity = this.deps.getEntity(guid);
    if (!entity) return;
    const options = this.optionsForGuid(guid);
    if (options) this.deps.sound.playNpcCue(entity.displayId, 'greeting', options);
  }

  handleCombatEvent(event: CombatEvent) {
    if (event.kind === 'levelUp') {
      this.deps.sound.playUi('LEVELUP');
      return;
    }
    if (event.kind === 'aiReaction') {
      // SharedDefines.h AIReaction: ALERT(0) and HOSTILE(2) are the two values used by the
      // 1.12 client handler. CreatureAI sends ALERT; Unit::Attack sends HOSTILE.
      const cue = event.reaction === 0 ? 'alert' : event.reaction === 2 ? 'aggro' : null;
      if (cue && this.allowCue(event.guid, cue, 6000)) {
        const entity = this.deps.getEntity(event.guid);
        const options = this.optionsForGuid(event.guid);
        if (options) this.deps.sound.playCreatureCue(entity?.displayId, cue, options);
      }
      return;
    }
    if (event.kind === 'attackStart') {
      if (event.attackerGuid !== this.deps.getPlayerGuid() && this.allowCue(event.attackerGuid, 'aggro', 6000)) {
        const attacker = this.deps.getEntity(event.attackerGuid);
        const options = this.optionsForGuid(event.attackerGuid);
        if (options) this.deps.sound.playCreatureCue(attacker?.displayId, 'aggro', options);
      }
      return;
    }
    if (event.kind === 'meleeDamage') this.handleMeleeDamage(event);
    else if (event.kind === 'spellDamage' && !event.periodic && event.damage > 0) {
      this.playWoundOrDeath(event.targetGuid, event.damage, (event.hitInfo & 0x02) !== 0);
    }
  }

  handleWorldSound(event: WorldSoundEvent) {
    if (event.kind === 'music') {
      this.deps.sound.playServerMusic(event.soundId);
      return;
    }
    const options = event.sourceGuid ? this.optionsForGuid(event.sourceGuid) : {};
    if (options) this.deps.sound.playServerSound(event.soundId, options);
  }

  private handleMeleeDamage(event: Extract<CombatEvent, { kind: 'meleeDamage' }>) {
    const critical = (event.hitInfo & HITINFO_CRITICAL) !== 0;
    const attackerOptions = this.optionsForGuid(event.attackerGuid, 0.86);
    const victimOptions = this.optionsForGuid(event.victimGuid, 0.88);
    if (attackerOptions) {
      this.deps.sound.playWeaponSwing(this.weaponSize(event.attackerGuid), critical, attackerOptions);
      const attacker = this.deps.getEntity(event.attackerGuid);
      if (this.allowCue(event.attackerGuid, 'attack', 180)) {
        this.deps.sound.playCreatureCue(attacker?.displayId, critical ? 'attackCritical' : 'attack', {
          ...attackerOptions,
          volumeScale: 0.92,
        });
      }
    }

    // selects that row bit from the attacker's weapon Material.dbc flags. Parry and block instead

    const parried = event.targetState === 3;
    const madeContact = event.totalDamage > 0 || event.blocked > 0;
    if ((madeContact || parried) && victimOptions) {
      const weapon = this.deps.getWeaponInfo(event.attackerGuid);
      this.deps.sound.playWeaponImpact(
        weapon?.subclass,
        weapon?.material,
        critical,
        this.contactItem(event.victimGuid, parried, event.blocked > 0),
        victimOptions,
      );
      if (madeContact) this.playWoundOrDeath(event.victimGuid, event.totalDamage, critical);
    } else if ((event.hitInfo & HITINFO_MISS) !== 0) {
      // The swing layer already communicates a miss; no impact or wound layer.
    }
  }

  private contactItem(guid: string, parried: boolean, blocked: boolean) {
    const equipment = this.deps.getEntity(guid)?.visibleEquipment ?? [];
    if (parried) {
      const weapon = equipment.find((item) => item.slot === 15 && item.classId === 2)
        ?? equipment.find((item) => item.slot === 16 && item.classId === 2);
      return weapon ? { itemClass: 2, material: weapon.material } : { itemClass: 2 };
    }
    if (blocked) {
      const shield = equipment.find((item) => item.slot === 16 && item.classId === 4);
      return shield ? { itemClass: 4, material: shield.material } : { itemClass: 4 };
    }
    return {};
  }

  private playWoundOrDeath(guid: string, damage: number, critical: boolean) {
    const entity = this.deps.getEntity(guid);
    const knownHealth = entity?.health ?? this.healthByGuid.get(guid);
    if (knownHealth !== undefined && knownHealth > 0 && damage >= knownHealth) {
      this.playDeath(guid, critical);
      return;
    }
    if (!entity || !this.allowCue(guid, 'wound', 220)) return;
    const options = this.optionsForGuid(guid);
    if (options) this.deps.sound.playCreatureCue(entity.displayId, critical ? 'woundCritical' : 'wound', options);
  }

  private playDeath(guid: string, critical: boolean) {
    const now = performance.now();
    if (now - (this.deathPlayedAt.get(guid) ?? -Infinity) < 2500) return;
    this.deathPlayedAt.set(guid, now);
    const entity = this.deps.getEntity(guid);
    const options = this.optionsForGuid(guid);
    if (options) this.deps.sound.playCreatureCue(entity?.displayId, critical ? 'deathCritical' : 'death', options);
  }

  private playStep(state: MovementAudioState, volumeScale: number) {
    // WMO collision means a constructed floor; without per-polygon material in
    // the current collision bake, stone is the most faithful deterministic cue.
    const terrainType = Number.isFinite(state.terrainType) && state.terrainType > 0
      ? state.terrainType
      : (state.groundSource === 'wmo' ? 3 : 1);
    const shallowWater = Number.isFinite(state.waterLevel)
      && state.waterLevel > state.position.z + 0.05
      && state.waterLevel - state.position.z < 1.5;
    this.deps.sound.playFootstep(state.displayId, terrainType, shallowWater, { volumeScale });
  }

  private updateRemoteMovement(entity: WorldEntity) {
    if (!this.worldReady) return;
    if (entity.guid === this.deps.getPlayerGuid() || (entity.typeId !== TypeID.PLAYER && entity.typeId !== TypeID.UNIT)) return;
    const position = this.deps.getEntityPosition(entity.guid);
    if (!position) return;
    const flags = entity.flags ?? 0;
    const jumping = (flags & MF_JUMPING) !== 0;
    const swimming = (flags & MF_SWIMMING) !== 0;
    const previous = this.remoteMovement.get(entity.guid);
    if (!previous) {
      this.remoteMovement.set(entity.guid, { position: { ...position }, stepDistance: 0, jumping, swimming });
      return;
    }

    const delta = Math.hypot(position.x - previous.position.x, position.y - previous.position.y);
    previous.position = { ...position };
    if (delta > 12) previous.stepDistance = 0;
    const remoteOptions = this.optionsForGuid(entity.guid);
    if (!previous.swimming && swimming && remoteOptions) this.deps.sound.playWaterEntry('small', { ...remoteOptions, volumeScale: 0.72 });
    if (entity.typeId === TypeID.PLAYER && !previous.jumping && jumping && !swimming && remoteOptions) {
      this.deps.sound.playMovementCue(entity.race, entity.gender, 'jump', { ...remoteOptions, volumeScale: 0.76 });
    }
    if (entity.typeId === TypeID.PLAYER && previous.jumping && !jumping && !swimming && remoteOptions) {
      this.deps.sound.playMovementCue(entity.race, entity.gender, 'land', { ...remoteOptions, volumeScale: 0.7 });
    }
    previous.jumping = jumping;
    previous.swimming = swimming;
    if (delta < 0.02 || delta > 12 || jumping || swimming || !remoteOptions) return;

    previous.stepDistance += delta;
    if (previous.stepDistance < 2.3) return;
    previous.stepDistance %= 2.3;
    const terrainType = this.deps.sampleTerrainType(position.x, position.y);
    const waterLevel = this.deps.sampleWaterLevel(position.x, position.y);
    const shallowWater = Number.isFinite(waterLevel) && waterLevel > position.z + 0.05 && waterLevel - position.z < 1.5;
    this.deps.sound.playFootstep(entity.displayId, terrainType, shallowWater, { ...remoteOptions, volumeScale: 0.68 });
  }

  private weaponSize(guid: string): 0 | 1 | 2 {
    const equipment = this.deps.getEntity(guid)?.visibleEquipment;
    const mainHand = equipment?.find((item) => item.displayInfoId > 0 && (item.inventoryType === 13 || item.inventoryType === 17 || item.inventoryType === 21));
    if (!mainHand) return 0;
    return mainHand.inventoryType === 17 ? 2 : 1;
  }

  private optionsForGuid(guid: string, volumeScale = 1): PlaySoundOptions | null {
    if (guid === this.deps.getPlayerGuid()) return { volumeScale };
    const position = this.deps.getEntityPosition(guid);
    if (!position) return null;
    const player = this.deps.getPlayerPosition();
    const distance = Math.hypot(position.x - player.x, position.y - player.y, position.z - player.z);
    if (distance >= MAX_AUDIBLE_DISTANCE) return null;
    return { volumeScale, position: { ...position } };
  }

  private allowCue(guid: string, cue: string, cooldownMs: number) {
    const key = `${guid}:${cue}`;
    const now = performance.now();
    if (now - (this.lastCueAt.get(key) ?? -Infinity) < cooldownMs) return false;
    this.lastCueAt.set(key, now);
    return true;
  }
}

const isFootstepAnimation = (animation: PlayerAnimState) =>
  animation === 'walk' || animation === 'run' || animation === 'walkBack' || animation === 'strafeLeft' || animation === 'strafeRight';

const stepSpacing = (animation: PlayerAnimState) => {
  if (animation === 'walk') return 1.25;
  if (animation === 'walkBack') return 1.55;
  if (animation === 'strafeLeft' || animation === 'strafeRight') return 1.8;
  return 2.3;
};
