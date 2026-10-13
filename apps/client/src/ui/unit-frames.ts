import * as THREE from 'three';
import type { CharacterInfo, WorldEntity } from '../world';
import type { WorldEntityRenderer } from '../world-entity-renderer';
import { TypeID } from '../world-entities';
import { factionIdForTemplate, getUnitReaction, type UnitReaction } from '../faction-reaction';
import { getInterfaceCvars } from './interface-runtime';
import { TargetOfTargetFrame } from './target-of-target-frame';
import { levelDifficultyColor } from '../level-difficulty';
import { LiveUnitPortrait, UnitFrameCanvas } from './unit-frame-canvas';
import { displayPowerValue } from '../combat/power-display';
import { installUnitPopup, showUnitPopup, type UnitPopupWorld } from './unit-popup';
import { withDuelReaction } from './duel-reaction';
import { raidTargetCss } from './raid-target-icons';

const POWER_TYPES = [
  { key: 'mana', label: 'Mana' },
  { key: 'rage', label: 'Rage' },
  { key: 'focus', label: 'Focus' },
  { key: 'energy', label: 'Energy' },
  { key: 'happiness', label: 'Happiness' },
] as const;

const UNIT_DYNFLAG_TAPPED = 0x0004;
const UNIT_DYNFLAG_TAPPED_BY_PLAYER = 0x0008;
// Vanilla keeps overhead unit names readable well beyond the combat/nameplate range, but the
// native health plate itself only appears in the close 20-yard bubble.  The old browser plate
// combined both states and therefore showed every wolf's level and health from 70 yards away.
const OVERHEAD_NAME_MAX_DISTANCE = 70;
const OVERHEAD_NAME_FADE_START = 52;
const NAMEPLATE_HEALTH_DISTANCE = 20;
const CON_COLORS: Record<string, string> = {
  red: '#ff2020', orange: '#ff8040', yellow: '#ffd100', green: '#40ff40', gray: '#808080',
};
const PORTRAIT_RACES: Record<number, string> = {
  1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'NightElf', 5: 'Scourge', 6: 'Tauren', 7: 'Gnome', 8: 'Troll',
};
const portraitUrl = (race?: number, gender?: number) => race
  ? `/ui/Interface/CharacterFrame/TemporaryPortrait-${gender === 1 ? 'Female' : 'Male'}-${PORTRAIT_RACES[race] ?? 'Human'}.png`
  : '/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png';
const cssImageUrl = (element: HTMLElement) => {
  const match = element.style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
  return match?.[1];
};

export type UnitFrameElements = {
  playerFrame: HTMLElement;
  pfName: HTMLElement;
  pfLevel: HTMLElement;
  pfHp: HTMLElement;
  pfHpText: HTMLElement;
  pfPower: HTMLElement;
  pfPowerText: HTMLElement;
  pfPvp: HTMLElement;
  targetFrame: HTMLElement;
  tfName: HTMLElement;
  tfLevel: HTMLElement;
  tfHp: HTMLElement;
  tfHpText: HTMLElement;
  tfPower: HTMLElement;
  tfPowerText: HTMLElement;
  tfPvp: HTMLElement;
  tfSkull: HTMLElement;
  tfArt?: HTMLElement | null;
  /** Host for the Target-of-Target frame; absent in preview harnesses that omit it. */
  totFrame?: HTMLElement | null;
};

export type UnitFrameWorld = UnitPopupWorld & {
  queryCreature(entry: number, guid?: string): void;
  queryGameObject(entry: number, guid?: string): void;
  queryPlayerName(guid: string): void;
  getCreatureName(entry: number): { name: string; subname?: string; rank?: number; type?: number } | undefined;
  getGameObjectName(entry: number): { name: string; type?: number; displayId?: number; icon?: string } | undefined;
  getPlayerName(guid: string): { name: string; race?: number; gender?: number; classId?: number } | undefined;
  /** Guild tag for an overhead player name (UnitNamePlayerGuild); undefined until a /who covers them. */
  getPlayerGuildName?(guid: string): string | undefined;
  /** Combo points the player currently holds on their target (Rogue/Druid), 0..5. */
  getComboPoints?(): number;
  /** GetRaidTargetIndex: 1..8 for a marked unit, zero otherwise. */
  getRaidTargetIndex?(guid: string): number;
  getForcedReaction?(factionId: number): number | undefined;
  /** Overhead quest markers: request a questgiver's dialog status, then read it (DIALOG_STATUS_*). */
  queryQuestGiverStatus?(guid: string, force?: boolean): void;
  getQuestGiverStatus?(guid: string): number | undefined;
};

export type UnitFrameControllerDeps = {
  elements: UnitFrameElements;
  camera: THREE.Camera;
  getEntityRenderer: () => WorldEntityRenderer | undefined;
  getWorld: () => UnitFrameWorld | undefined;
  getPlayerGuid: () => string | undefined;
  getPlayerModelGroup: () => THREE.Group | undefined;
  getPlayerOverheadPosition: () => { x: number; y: number; z: number } | undefined;
  getCurrentCharacter: () => CharacterInfo | undefined;
  getPlayerEntity: () => WorldEntity | undefined;
  getSelectedTargetGuid: () => string | undefined;
  getPlayerLocalPosition: () => { x: number; y: number; z: number };
  isNameplateBlockedByWmo: (target: THREE.Vector3) => boolean;
  /** Raid membership, for the Target-of-Target "In Raids" mode. */
  isInRaid?: () => boolean;
  applyPvpBadge: (el: HTMLElement, entity: WorldEntity) => void;
  escapeHtml: (value: string) => string;
  raceName: (race: number) => string;
  className: (classId: number) => string;
  targetNameBg: Record<'hostile' | 'neutral' | 'friendly', string>;
  tappedNameBg: string;
  targetFrameArt: string;
  eliteFrameArt: Record<number, string>;
  playUi?: (name: string) => unknown;
  startWhisper?: (name: string) => void;
};

export class UnitFrameController {
  private readonly nameplateLayer = document.createElement('div');
  private readonly nameplateElements = new Map<string, HTMLElement>();
  // Skip unchanged layout-affecting strings; transform and opacity remain compositor-only writes.
  private readonly nameplateRender = new WeakMap<HTMLElement, { cls: string; font: string; html: string }>();
  private readonly nameplateProject = new THREE.Vector3();
  private readonly nameplateWorldPoint = new THREE.Vector3();
  private readonly nameplateCameraPoint = new THREE.Vector3();
  private readonly nameplateWmoVisibility = new Map<string, { checkedAt: number; hidden: boolean }>();
  // Overhead quest ! / ? markers float above a questgiver's head, one DOM node per guid.
  private readonly questMarkerLayer = document.createElement('div');
  private readonly questMarkerElements = new Map<string, HTMLElement>();
  private readonly questMarkerPoint = new THREE.Vector3();
  private readonly playerCanvas: UnitFrameCanvas;
  private readonly targetCanvas: UnitFrameCanvas;
  private readonly playerPortrait: LiveUnitPortrait;
  private readonly targetPortrait: LiveUnitPortrait;
  private playerAttacking = false;
  private playerAttackBlocked = false;
  private playerPortraitLive = false;
  private targetPortraitLive = false;
  private lastPortraitAt = 0;
  private readonly totFrame?: TargetOfTargetFrame;

  constructor(private readonly deps: UnitFrameControllerDeps) {
    this.nameplateLayer.className = 'wow-nameplate-layer';
    document.body.appendChild(this.nameplateLayer);
    this.questMarkerLayer.className = 'wow-quest-marker-layer';
    document.body.appendChild(this.questMarkerLayer);
    deps.elements.playerFrame.classList.add('has-canvas-ui');
    deps.elements.targetFrame.classList.add('has-canvas-ui');
    this.playerPortrait = new LiveUnitPortrait(deps.elements.playerFrame, 'player');
    this.targetPortrait = new LiveUnitPortrait(deps.elements.targetFrame, 'target');
    this.playerCanvas = new UnitFrameCanvas(deps.elements.playerFrame);
    this.targetCanvas = new UnitFrameCanvas(deps.elements.targetFrame);
    installUnitPopup({ getWorld: deps.getWorld, getPlayerGuid: deps.getPlayerGuid, playUi: deps.playUi, startWhisper: deps.startWhisper });
    deps.elements.playerFrame.addEventListener('contextmenu', (event) => {
      const guid = deps.getPlayerGuid();
      if (!guid) return;
      event.preventDefault();
      showUnitPopup(guid, event.clientX, event.clientY);
    });
    deps.elements.targetFrame.addEventListener('contextmenu', (event) => {
      const guid = deps.getSelectedTargetGuid();
      const entity = guid ? deps.getEntityRenderer()?.inspect(guid)?.entity : undefined;
      if (!guid || !entity || entity.typeId !== TypeID.PLAYER && entity.typeId !== TypeID.UNIT) return;
      const raidTargetOnly = entity.typeId !== TypeID.PLAYER;
      if (raidTargetOnly && !deps.getWorld()?.canSetRaidTarget?.()) return;
      event.preventDefault();
      showUnitPopup(guid, event.clientX, event.clientY, raidTargetOnly);
    });
    if (deps.elements.totFrame) {
      this.totFrame = new TargetOfTargetFrame(deps.elements.totFrame, {
        getSelectedTargetEntity: () => {
          const guid = this.deps.getSelectedTargetGuid();
          return guid ? this.deps.getEntityRenderer()?.inspect(guid)?.entity : undefined;
        },
        getEntity: (guid) => this.deps.getEntityRenderer()?.inspect(guid)?.entity,
        nameFor: (guid, entity) => this.nameForEntity(guid, entity),
        isInRaid: () => this.deps.isInRaid?.() ?? false,
      });
    }
  }

  hidePlayerFrame() {
    this.deps.elements.playerFrame.classList.add('is-hidden');
    this.playerPortrait.canvas.style.display = 'none';
  }

  playerPortraitSource(requireLive = true) { return requireLive && !this.playerPortraitLive ? undefined : this.playerPortrait.canvas; }

  refreshPlayerFrame() {
    const currentCharacter = this.deps.getCurrentCharacter();
    const playerEntity = this.deps.getPlayerEntity();
    if (!currentCharacter) {
      this.hidePlayerFrame();
      return;
    }
    const { playerFrame, pfName, pfLevel, pfHp, pfHpText, pfPower, pfPowerText, pfPvp } = this.deps.elements;
    playerFrame.classList.remove('is-hidden');
    pfName.textContent = currentCharacter.name;
    pfLevel.textContent = String(playerEntity?.level ?? currentCharacter.level);
    this.setStatusBar(pfHp, pfHpText, playerEntity?.health, playerEntity?.maxHealth);
    this.setPowerBar(pfPower, pfPowerText, playerEntity);
    if (playerEntity) this.deps.applyPvpBadge(pfPvp, playerEntity);
    else pfPvp.classList.add('is-hidden');
    playerFrame.classList.toggle('is-dead', (playerEntity?.health ?? 1) <= 0);
    playerFrame.title =
      `${currentCharacter.name} - ${this.deps.raceName(currentCharacter.race)} ` +
      `${this.deps.className(currentCharacter.classId)}`;
    const power = this.powerState(playerEntity);
    this.playerCanvas.setView({
      side: 'player',
      name: currentCharacter.name,
      level: String(playerEntity?.level ?? currentCharacter.level),
      health: { current: playerEntity?.health, maximum: playerEntity?.maxHealth },
      power,
      dead: (playerEntity?.health ?? 1) <= 0,
      attacking: this.playerAttacking,
      attackBlocked: this.playerAttackBlocked,
      pvpIconUrl: cssImageUrl(pfPvp),
      fallbackPortraitUrl: portraitUrl(currentCharacter.race, currentCharacter.gender),
      livePortrait: this.playerPortraitLive,
    });
  }

  updateAttackIndicator(autoAttacking: boolean) {
    this.playerAttacking = autoAttacking;
    this.deps.elements.playerFrame.classList.toggle('is-attacking', autoAttacking);
    this.refreshPlayerFrame();
  }

  updateAttackBlocked(autoAttacking: boolean, meleeBlocked: boolean) {
    const blocked = autoAttacking && meleeBlocked;
    if (blocked === this.playerAttackBlocked) return;
    this.playerAttackBlocked = blocked;
    this.deps.elements.playerFrame.classList.toggle('is-attack-blocked', blocked);
    this.refreshPlayerFrame();
  }

  refreshTargetFrame() {
    const selectedTargetGuid = this.deps.getSelectedTargetGuid();
    const entity = selectedTargetGuid ? this.deps.getEntityRenderer()?.inspect(selectedTargetGuid)?.entity : undefined;
    const { targetFrame, tfName, tfLevel, tfHp, tfHpText, tfPower, tfPowerText, tfPvp, tfSkull, tfArt } = this.deps.elements;
    // Target-of-Target hangs off the same refresh: it can only change when the selection or
    // the selection's own target does, and both land here.
    this.totFrame?.refresh();
    if (!entity) {
      targetFrame.classList.add('is-hidden');
      this.targetPortrait.canvas.style.display = 'none';
      return;
    }
    const world = this.deps.getWorld();
    if (selectedTargetGuid && entity.typeId === TypeID.PLAYER) world?.queryPlayerName(selectedTargetGuid);
    else if (entity.typeId === TypeID.UNIT && entity.entry) world?.queryCreature(entity.entry, selectedTargetGuid);
    else if (entity.typeId === TypeID.GAMEOBJECT && entity.entry) world?.queryGameObject(entity.entry, selectedTargetGuid);
    const creatureCache = entity.entry !== undefined ? world?.getCreatureName(entity.entry) : undefined;
    const gameObjectCache = entity.entry !== undefined ? world?.getGameObjectName(entity.entry) : undefined;
    const playerCache = selectedTargetGuid ? world?.getPlayerName(selectedTargetGuid) : undefined;
    if (entity.typeId === TypeID.PLAYER && playerCache) {
      tfName.textContent = playerCache.name;
    } else if (entity.typeId === TypeID.UNIT && creatureCache) {
      tfName.textContent = creatureCache.name;
    } else if (entity.typeId === TypeID.GAMEOBJECT && gameObjectCache) {
      tfName.textContent = gameObjectCache.name;
    } else {
      tfName.textContent = entity.typeId === TypeID.PLAYER ? 'Player'
        : entity.typeId === TypeID.GAMEOBJECT ? `GameObject #${entity.entry ?? '?'}`
          : `Creature #${entity.entry ?? '?'}`;
    }

    const playerEntity = this.deps.getPlayerEntity();
    const reaction = this.reactionFor(entity);
    const tfDynFlags = entity.dynamicFlags ?? 0;
    const tappedByOther =
      (tfDynFlags & UNIT_DYNFLAG_TAPPED) !== 0 && (tfDynFlags & UNIT_DYNFLAG_TAPPED_BY_PLAYER) === 0;
    tfName.style.background = tappedByOther ? this.deps.tappedNameBg : this.deps.targetNameBg[reaction];

    const targetRank = entity.typeId === TypeID.UNIT ? creatureCache?.rank ?? 0 : 0;
    const isEnemy = reaction === 'hostile';
    const showSkull =
      targetRank === 3 ||
      (isEnemy && playerEntity?.level !== undefined && entity.level !== undefined && playerEntity.level <= entity.level - 10);
    tfSkull.classList.toggle('is-hidden', !showSkull);
    tfLevel.classList.toggle('is-hidden', showSkull);
    tfLevel.textContent = entity.level !== undefined ? String(entity.level) : '?';
    tfLevel.classList.remove('con-red', 'con-orange', 'con-yellow', 'con-green', 'con-gray');
    if (playerEntity?.level && entity.level !== undefined) {
      tfLevel.classList.add(`con-${levelDifficultyColor(playerEntity.level, entity.level)}`);
    }
    if (tfArt) {
      const rank = entity.typeId === TypeID.UNIT ? creatureCache?.rank ?? 0 : 0;
      tfArt.style.backgroundImage = `url('${this.deps.eliteFrameArt[rank] ?? this.deps.targetFrameArt}')`;
    }
    this.deps.applyPvpBadge(tfPvp, entity);
    this.setStatusBar(tfHp, tfHpText, entity.health, entity.maxHealth);
    this.setPowerBar(tfPower, tfPowerText, entity);
    targetFrame.classList.toggle('is-dead', (entity.health ?? 1) <= 0);
    targetFrame.classList.remove('is-hidden');
    const con = playerEntity?.level && entity.level !== undefined
      ? levelDifficultyColor(playerEntity.level, entity.level)
      : undefined;
    const frameArt = this.deps.eliteFrameArt[targetRank] ?? this.deps.targetFrameArt;
    this.targetCanvas.setView({
      side: 'target',
      name: tfName.textContent || 'Target',
      level: entity.level !== undefined ? String(entity.level) : '?',
      levelColor: con ? CON_COLORS[con] : undefined,
      health: { current: entity.health, maximum: entity.maxHealth },
      power: this.powerState(entity),
      dead: (entity.health ?? 1) <= 0,
      skull: showSkull,
      frameArt,
      nameBackground: tappedByOther ? this.deps.tappedNameBg : this.deps.targetNameBg[reaction],
      pvpIconUrl: cssImageUrl(tfPvp),
      fallbackPortraitUrl: entity.typeId === TypeID.PLAYER
        ? portraitUrl(playerCache?.race ?? entity.race, playerCache?.gender ?? entity.gender)
        : '/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png',
      livePortrait: this.targetPortraitLive,
      // Server-authoritative: points are cleared server-side when the combo target changes, so a
      // stale target never keeps someone else's points on screen.
      comboPoints: this.deps.getWorld()?.getComboPoints?.() ?? 0,
      raidTargetIndex: selectedTargetGuid ? world?.getRaidTargetIndex?.(selectedTargetGuid) : 0,
    });
  }

  /** Refresh the two live model portraits at a capped 12 Hz. */
  updatePortraits(now = performance.now()) {
    if (now - this.lastPortraitAt < 83) return;
    this.lastPortraitAt = now;
    const playerLive = this.playerPortrait.render(this.deps.getPlayerModelGroup());
    const targetGuid = this.deps.getSelectedTargetGuid();
    const targetLive = this.targetPortrait.render(targetGuid ? this.deps.getEntityRenderer()?.portraitModel(targetGuid) : undefined);
    if (playerLive !== this.playerPortraitLive) {
      this.playerPortraitLive = playerLive;
      this.refreshPlayerFrame();
    }
    if (targetLive !== this.targetPortraitLive) {
      this.targetPortraitLive = targetLive;
      this.refreshTargetFrame();
    }
  }

  updateNameplates(spawned: boolean) {
    const entityRenderer = this.deps.getEntityRenderer();
    if (!spawned || !entityRenderer) {
      for (const el of this.nameplateElements.values()) el.remove();
      this.nameplateElements.clear();
      this.nameplateWmoVisibility.clear();
      return;
    }
    const seen = new Set<string>();
    const questSeen = new Set<string>();
    const playerPos = this.deps.getPlayerLocalPosition();
    const selectedTargetGuid = this.deps.getSelectedTargetGuid();
    const playerEntity = this.deps.getPlayerEntity();
    const entries = entityRenderer.nameplateEntries(playerPos, OVERHEAD_NAME_MAX_DISTANCE);
    const currentCharacter = this.deps.getCurrentCharacter();
    const playerGuid = this.deps.getPlayerGuid() ?? currentCharacter?.guid;
    // The local player is intentionally not owned by WorldEntityRenderer, but Vanilla's
    // UNIT_NAME_PLAYER_GUILD option still projects the player's own blue overhead name.
    if (playerGuid && playerEntity && currentCharacter && Number(getInterfaceCvars().UnitNameOwn) === 1) {
      entries.push({
        guid: playerGuid,
        entity: playerEntity,
        localPosition: playerPos,
        height: 2,
      });
    }
    for (const entry of entries) {
      const { guid, entity, localPosition, height } = entry;
      const dx = localPosition.x - playerPos.x;
      const dy = localPosition.y - playerPos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > OVERHEAD_NAME_MAX_DISTANCE) continue;

      const localPlayerOverhead = guid === playerGuid ? this.deps.getPlayerOverheadPosition() : undefined;
      if (localPlayerOverhead) {
        // SetPortraitTexture and unit-name rendering both follow the animated model, not its
        // equipment-inclusive Box3. The old Box3 anchor included raised weapons/attachments and
        // pushed the player's name more than a character-height above their head.
        this.nameplateWorldPoint.set(localPlayerOverhead.x, localPlayerOverhead.y, localPlayerOverhead.z + 0.28);
      } else {
        this.nameplateWorldPoint.set(localPosition.x, localPosition.y, localPosition.z + height + 0.45);
      }
      // Build 5875's final name draw disables depth testing, but the native scene decides which
      // indoor units reach that draw before PlayerName.cpp runs. BrowserPort has no equivalent
      // entity/WMO submission graph, so reproduce that boundary with WMO shells only. The M2
      // collision registered for fences, trees and props is deliberately excluded by the callback.
      this.nameplateCameraPoint.copy(this.nameplateWorldPoint).applyMatrix4(this.deps.camera.matrixWorldInverse);
      if (this.nameplateCameraPoint.z >= -((this.deps.camera as THREE.PerspectiveCamera).near ?? 0.1)) continue;
      this.nameplateProject.copy(this.nameplateWorldPoint).project(this.deps.camera);
      if (this.nameplateProject.z < -1 || this.nameplateProject.z > 1) continue;
      const x = (this.nameplateProject.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-this.nameplateProject.y * 0.5 + 0.5) * window.innerHeight;
      if (x < -90 || x > window.innerWidth + 90 || y < -40 || y > window.innerHeight + 80) continue;

      // Interface Options overhead-name toggles (UnitNamePlayer / UnitNameNPC). Health plates are
      // attackable-unit combat chrome governed separately, so only pure overhead names are gated.
      // The local player's own name is gated at the entries push above (UnitNameOwn).
      const isPlayerLabel = entity.typeId === TypeID.PLAYER;
      const wouldHealthPlate = !isPlayerLabel && this.nameplateKindFor(entity) !== 'friendly'
        && (entity.health ?? 0) > 0 && dist <= NAMEPLATE_HEALTH_DISTANCE;
      if (!wouldHealthPlate && guid !== playerGuid) {
        const cvars = getInterfaceCvars();
        const nameOff = isPlayerLabel ? Number(cvars.UnitNamePlayer) !== 1 : Number(cvars.UnitNameNPC) !== 1;
        if (nameOff) {
          const stale = this.nameplateElements.get(guid);
          if (stale) { stale.remove(); this.nameplateElements.delete(guid); }
          continue;
        }
      }

      const now = performance.now();
      let wmoVisibility = this.nameplateWmoVisibility.get(guid);
      // WMO BVH raycasts are heavier than projection. Stagger the short cache by GUID while keeping
      // transform updates outside this gate, so a hidden label can never freeze at an old position.
      if (!wmoVisibility || now - wmoVisibility.checkedAt >= 150 + (this.guidHash(guid) % 70)) {
        wmoVisibility = {
          checkedAt: now,
          hidden: guid !== playerGuid && this.deps.isNameplateBlockedByWmo(this.nameplateWorldPoint),
        };
        this.nameplateWmoVisibility.set(guid, wmoVisibility);
      }

      seen.add(guid);
      let el = this.nameplateElements.get(guid);
      if (!el) {
        el = document.createElement('div');
        el.className = 'wow-nameplate';
        this.nameplateLayer.appendChild(el);
        this.nameplateElements.set(guid, el);
      }
      const kind = this.nameplateKindFor(entity);
      const hpMax = Math.max(1, entity.maxHealth ?? 1);
      const hp = Math.max(0, Math.min(hpMax, entity.health ?? hpMax));
      const hpPct = Math.max(0, Math.min(100, (hp / hpMax) * 100));
      const fade = dist <= OVERHEAD_NAME_FADE_START
        ? 1
        : Math.max(0.25, 1 - (dist - OVERHEAD_NAME_FADE_START) / (OVERHEAD_NAME_MAX_DISTANCE - OVERHEAD_NAME_FADE_START));
      const level = entity.level !== undefined ? String(entity.level) : '?';
      const selected = guid === selectedTargetGuid;
      const playerName = entity.typeId === TypeID.PLAYER;
      // Friendly units (vendors, trainers, quest givers, guards) use the green world name only.
      // Native health plates are combat/attackable-unit chrome, never friendly-NPC decoration.
      const healthPlate = !playerName && kind !== 'friendly' && hp > 0 && dist <= NAMEPLATE_HEALTH_DISTANCE;
      const dynFlags = entity.dynamicFlags ?? 0;
      const tapped = (dynFlags & UNIT_DYNFLAG_TAPPED) !== 0 && (dynFlags & UNIT_DYNFLAG_TAPPED_BY_PLAYER) === 0;
      const conClass =
        playerEntity?.level && entity.level !== undefined
          ? ` con-${levelDifficultyColor(playerEntity.level, entity.level)}`
          : '';
      const className =
        `wow-nameplate ${healthPlate ? 'is-healthplate' : 'is-overhead'} is-${kind}` +
        `${playerName ? ' is-player' : ' is-creature'}${selected ? ' is-selected' : ''}${tapped ? ' is-tapped' : ''}`;
      this.deps.camera.getWorldPosition(this.nameplateCameraPoint);
      const cameraDistance = Math.max(1, this.nameplateCameraPoint.distanceTo(this.nameplateWorldPoint));
      // UNIT_NAME_FONT is a world-space font in the 1.12.1 client (CGxFont size 0.99), so nearby
      // names grow with perspective while distant names collapse to the small readable floor.
      // 210/distance reproduces the supplied real-client reference: ~34 px on the local player,
      // ~18-22 px on nearby NPCs, and 12 px at long range.
      const overheadFontPx = Math.max(12, Math.min(34, 210 / cameraDistance));
      const fontValue = `${overheadFontPx.toFixed(2)}px`;
      // Screen position and fade change every frame; transform + opacity are compositor-only
      // (no layout, no reparse) so they are always written.
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      el.style.opacity = fade.toFixed(2);
      const name = this.deps.escapeHtml(this.nameForEntity(guid, entity));
      const subtitle = this.overheadSubtitle(guid, entity, playerName);
      const raidTarget = this.deps.getWorld()?.getRaidTargetIndex?.(guid) ?? 0;
      const raidIcon = raidTarget ? `<span class="wow-raid-target-icon" style="${raidTargetCss(raidTarget)}"></span>` : '';
      const html = healthPlate
        ? `${raidIcon}<div class="wow-nameplate-name">${name}</div>` +
          `<div class="wow-nameplate-health"><span class="wow-nameplate-health-fill" style="width:${(hpPct * 1.02).toFixed(1)}px"></span>` +
          `<span class="wow-nameplate-level${conClass}">${this.deps.escapeHtml(level)}</span></div>`
        : `${raidIcon}<div class="wow-nameplate-name">${name}</div>${subtitle}`;
      // className, font size and innerHTML each cost a style recalc / HTML reparse + layout.
      // Only write them when the computed value actually changed — for a standing, full-health
      // plate that is every frame, so this removes ~all per-plate DOM churn while staying
      // pixel-identical to the unconditional writes it replaces.
      const rendered = this.nameplateRender.get(el);
      if (!rendered || rendered.cls !== className) el.className = className;
      if (!rendered || rendered.font !== fontValue) el.style.setProperty('--wow-unit-name-size', fontValue);
      if (!rendered || rendered.html !== html) el.innerHTML = html;
      if (rendered) {
        rendered.cls = className;
        rendered.font = fontValue;
        rendered.html = html;
      } else {
        this.nameplateRender.set(el, { cls: className, font: fontValue, html });
      }
      // `hidden` is applied directly to the body-level overlay node. The old HUD-scoped is-hidden
      // class did not match this layer, which left an occluded label visible at its stale transform.
      el.hidden = wmoVisibility.hidden;
      if (!wmoVisibility.hidden) this.updateQuestMarker(guid, entity, localPosition, height, fade, questSeen);
    }
    for (const [guid, el] of this.nameplateElements) {
      if (!seen.has(guid)) {
        el.remove();
        this.nameplateElements.delete(guid);
        this.nameplateWmoVisibility.delete(guid);
      }
    }
    for (const [guid, el] of this.questMarkerElements) {
      if (!questSeen.has(guid)) {
        el.remove();
        this.questMarkerElements.delete(guid);
      }
    }
  }

  private guidHash(guid: string) {
    let hash = 0;
    for (let i = 0; i < guid.length; i++) hash = ((hash << 5) - hash + guid.charCodeAt(i)) | 0;
    return Math.abs(hash);
  }

  // DIALOG_STATUS_* (vMaNGOS QuestDef.h) -> the overhead glyph and its colour class. AVAILABLE(5) is
  // the yellow "!"; UNAVAILABLE(1) is the silver "!" for a quest you cannot pick up yet (too low
  // level); INCOMPLETE(3) is the silver "?" while a quest is still in progress; REWARD_REP(4),
  // REWARD_OLD(6) and REWARD2(7) are the yellow turn-in "?". NONE(0) and CHAT(2) show nothing.
  private static readonly QUEST_MARKER: Record<number, { cls: string } | undefined> = {
    1: { cls: 'is-quest-lowlevel' }, 3: { cls: 'is-quest-incomplete' },
    4: { cls: 'is-quest-reward' }, 5: { cls: 'is-quest-available' },
    6: { cls: 'is-quest-reward' }, 7: { cls: 'is-quest-reward' },
  };

  /**
   * Draw (or clear) the overhead quest marker for one unit. Only NPCs flagged
   * UNIT_NPC_FLAG_QUESTGIVER (0x2) ever carry one — mobs, vendors without quests, and the local
   * player never do. The status comes from SMSG_QUESTGIVER_STATUS; queryQuestGiverStatus is
   * throttled and cached in the world client, so calling it every frame for a visible giver is
   * cheap and simply keeps the marker current. Anchored a fixed bit above the measured head so it
   * scales correctly across races/sizes, and shares the name's fade + occlusion (it is only reached
   * for on-screen, non-occluded entities).
   */
  private updateQuestMarker(
    guid: string,
    entity: WorldEntity,
    localPosition: { x: number; y: number; z: number },
    height: number,
    fade: number,
    questSeen: Set<string>,
  ) {
    const world = this.deps.getWorld();
    const isQuestGiver = ((entity.npcFlags ?? 0) & 0x2) !== 0;
    if (!world?.queryQuestGiverStatus || !isQuestGiver || guid === this.deps.getPlayerGuid()) return;
    world.queryQuestGiverStatus(guid);
    const status = world.getQuestGiverStatus?.(guid);
    const marker = status === undefined ? undefined : UnitFrameController.QUEST_MARKER[status];
    if (!marker) {
      const stale = this.questMarkerElements.get(guid);
      if (stale) { stale.remove(); this.questMarkerElements.delete(guid); }
      return;
    }
    this.questMarkerPoint.set(localPosition.x, localPosition.y, localPosition.z + height + 0.9);
    this.nameplateCameraPoint.copy(this.questMarkerPoint).applyMatrix4(this.deps.camera.matrixWorldInverse);
    if (this.nameplateCameraPoint.z >= -((this.deps.camera as THREE.PerspectiveCamera).near ?? 0.1)) return;
    this.nameplateProject.copy(this.questMarkerPoint).project(this.deps.camera);
    if (this.nameplateProject.z < -1 || this.nameplateProject.z > 1) return;
    const x = (this.nameplateProject.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this.nameplateProject.y * 0.5 + 0.5) * window.innerHeight;
    let el = this.questMarkerElements.get(guid);
    if (!el) {
      el = document.createElement('div');
      this.questMarkerLayer.appendChild(el);
      this.questMarkerElements.set(guid, el);
    }
    const cls = `wow-quest-marker ${marker.cls}`;
    if (el.className !== cls) el.className = cls;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    el.style.opacity = fade.toFixed(2);
    questSeen.add(guid);
  }

  /**
   * The `<...>` line under an overhead name: a player's guild tag, or an NPC's title
   * ("<Mage Trainer>"). Returns markup, or '' when there is nothing to show.
   *
   * NPC titles are not separately toggleable in vanilla — they ride along with the NPC
   * name itself — so only the guild line consults a cvar.
   */
  private overheadSubtitle(guid: string, entity: WorldEntity, isPlayer: boolean): string {
    const world = this.deps.getWorld();
    if (isPlayer) {
      if (Number(getInterfaceCvars().UnitNamePlayerGuild) !== 1) return '';
      const guild = world?.getPlayerGuildName?.(guid);
      return guild ? `<div class="wow-nameplate-guild">&lt;${this.deps.escapeHtml(guild)}&gt;</div>` : '';
    }
    const subname = entity.entry ? world?.getCreatureName(entity.entry)?.subname : undefined;
    return subname ? `<div class="wow-nameplate-guild">&lt;${this.deps.escapeHtml(subname)}&gt;</div>` : '';
  }

  nameForEntity(guid: string, entity: WorldEntity) {
    const world = this.deps.getWorld();
    if (entity.typeId === TypeID.PLAYER) {
      if (guid === this.deps.getPlayerGuid() && this.deps.getCurrentCharacter()) return this.deps.getCurrentCharacter()!.name;
      world?.queryPlayerName(guid);
      return world?.getPlayerName(guid)?.name ?? 'Player';
    }
    if (entity.typeId === TypeID.UNIT && entity.entry) {
      world?.queryCreature(entity.entry, guid);
      return world?.getCreatureName(entity.entry)?.name ?? `Creature #${entity.entry}`;
    }
    if (entity.typeId === TypeID.GAMEOBJECT && entity.entry) {
      world?.queryGameObject(entity.entry, guid);
      return world?.getGameObjectName(entity.entry)?.name ?? `GameObject #${entity.entry}`;
    }
    return entity.entry ? `Unit #${entity.entry}` : 'Unit';
  }

  private setStatusBar(fill: HTMLElement, text: HTMLElement, value: number | undefined, max: number | undefined) {
    const hasValues = value !== undefined && max !== undefined && max > 0;
    const ratio = hasValues ? Math.max(0, Math.min(1, value / max)) : 0;
    fill.style.width = `${Math.round(ratio * 100)}%`;
    text.textContent = hasValues ? `${value} / ${max}` : '';
  }

  private setPowerBar(fill: HTMLElement, text: HTMLElement, entity: WorldEntity | undefined) {
    const state = this.powerState(entity);
    const powerType = Math.max(0, POWER_TYPES.findIndex((entry) => entry.key === state.kind));
    const info = POWER_TYPES[powerType];
    fill.className = `wow-unit-status-fill wow-unit-status-fill--${info.key}`;
    this.setStatusBar(fill, text, state.current, state.maximum);
  }

  private powerState(entity: WorldEntity | undefined) {
    const rawPowerType = entity?.powerType ?? 0;
    const powerType = rawPowerType >= 0 && rawPowerType < POWER_TYPES.length ? rawPowerType : 0;
    return {
      current: displayPowerValue(powerType, entity?.powers?.[powerType]),
      maximum: displayPowerValue(powerType, entity?.maxPowers?.[powerType]),
      kind: POWER_TYPES[powerType].key,
    };
  }

  private nameplateKindFor(entity: WorldEntity): 'dead' | 'hostile' | 'neutral' | 'friendly' {
    if ((entity.health ?? 1) <= 0 && (entity.maxHealth ?? 0) > 0) return 'dead';
    return this.reactionFor(entity);
  }

  private reactionFor(entity: WorldEntity): UnitReaction {
    const factionId = factionIdForTemplate(entity.faction);
    const forced = factionId === undefined ? undefined : this.deps.getWorld()?.getForcedReaction?.(factionId);
    const player = this.deps.getPlayerEntity();
    return withDuelReaction(
      player,
      entity,
      getUnitReaction(player?.faction, entity.faction, forced),
    );
  }
}
