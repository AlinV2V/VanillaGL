import * as THREE from 'three';
import type { RealmWorldClient, WorldEntity } from '../world';
import type { WorldEntityInspection, WorldEntityRenderer } from '../world-entity-renderer';
import { TypeID } from '../world-entities';
import { factionIdForTemplate, getUnitReaction, type UnitReaction } from '../faction-reaction';
import { levelDifficultyColor } from '../level-difficulty';
import { BASE_MELEE_RANGE_OFFSET, MIN_COMBAT_REACH, MIN_MELEE_RANGE } from './action-combat';
import type { InventoryCursorController, WowCursorName } from './inventory-cursor';
import { getInterfaceCvars } from './interface-runtime';
// Single source for the vanilla NPCFlags bits, shared with world.ts. This file used to keep a
// 1.12 specification handling.
// sets — so the banker cursor never appeared.
import { UNIT_NPC_FLAG, UNIT_NPC_FLAG_SPEAK } from '../world/alpha-opcodes';
import { showUnitPopup } from './unit-popup';
import { withDuelReaction } from './duel-reaction';
import { hoverPickingHz, hoverPickingMode } from '../rendering/performance-controls';
import { recordHoverRequest } from '../rendering/performance-subsystem-metrics';

const UNIT_DYNFLAG_LOOTABLE = 0x0001;
const INTERACTION_DISTANCE = 5.0;

const CREATURE_TYPE_NAMES: Record<number, string> = {
  1: 'Beast', 2: 'Dragonkin', 3: 'Demon', 4: 'Elemental', 5: 'Giant',
  6: 'Undead', 7: 'Humanoid', 8: 'Critter', 9: 'Mechanical', 11: 'Totem',
};

const CLASSIFICATION_NAMES: Record<number, string> = {
  1: 'Elite', 2: 'Rare Elite', 3: 'World Boss', 4: 'Rare',
};

const CON_HEX: Record<string, string> = {
  red: '#ff2020',
  orange: '#ff8040',
  yellow: '#ffff00',
  green: '#40bf40',
  gray: '#9d9d9d',
};

type LocalPosition = { x: number; y: number; z: number };

export class TargetingController {
  private tabCycleIndex = -1;
  private inspectPointerDown: { id: number; x: number; y: number; touch: boolean; moved: boolean } | undefined;
  private unitTooltipKey: string | undefined;
  private hoverEvent: PointerEvent | undefined;
  private hoverPickScheduled = false;
  private lastHoverPickAt = -Infinity;
  private readonly flushHoverPick = (at: number): void => {
    if (!this.hoverEvent) { this.hoverPickScheduled = false; return; }
    if (at - this.lastHoverPickAt < 1000 / hoverPickingHz()) { requestAnimationFrame(this.flushHoverPick); return; }
    const event = this.hoverEvent; this.hoverEvent = undefined; this.hoverPickScheduled = false; this.lastHoverPickAt = at;
    this.updateHover(event);
  };

  constructor(private readonly deps: {
    canvas: HTMLElement;
    camera: THREE.Camera;
    cursor: InventoryCursorController;
    /** Click-to-inspect entity JSON dump is a developer tool; only shown under ?debugtools. */
    debugToolsEnabled?: boolean;
    elements: {
      gameTooltip: HTMLElement;
      entityDebug: HTMLElement;
      entityDebugTitle: HTMLElement;
      entityDebugContent: HTMLElement;
      entityDebugCopy: HTMLButtonElement;
      entityDebugClose: HTMLButtonElement;
    };
    getEntityRenderer: () => WorldEntityRenderer | null | undefined;
    isWorldPointBlockedByWmo: (target: THREE.Vector3) => boolean;
    getWorld: () => RealmWorldClient | undefined;
    getPlayerEntity: () => WorldEntity | undefined;
    getPlayerLocalPosition: () => LocalPosition;
    getSelectedTargetGuid: () => string | undefined;
    setSelectedTargetGuid: (guid: string | undefined) => void;
    getAutoAttacking: () => boolean;
    stopAttack: () => void;
    attackTarget: (guid: string) => void;
    /** Returns true when a pending spell-target cursor consumed the click. */
    targetPendingSpell?: (entity: WorldEntity) => boolean;
    refreshTargetFrame: () => void;
    updateEntityDebugExternal?: () => void;
    escapeHtml: (value: string) => string;
    nameForEntity: (guid: string, entity: WorldEntity) => string;
    raceName: (race: number) => string;
    className: (classId: number) => string;
    inspectionPayload: (inspection: WorldEntityInspection) => unknown;
    playUi?: (name: string) => boolean;
  }) {
    deps.canvas.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.pointerType === 'touch' && this.inspectPointerDown) { this.inspectPointerDown = undefined; return; }
      if (event.button === 0 || event.button === 2) {
        this.inspectPointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch', moved: false };
      }
    });

    deps.canvas.addEventListener('pointermove', (event: PointerEvent) => {
      const down = this.inspectPointerDown;
      if (down?.id === event.pointerId) {
        down.moved ||= Math.hypot(event.clientX - down.x, event.clientY - down.y) > (down.touch ? 12 : 5);
      }
      // Fingers do not hover. Avoid raycasting and tooltip churn while the same gesture rotates the
      // camera; pointerup performs one authoritative pick if it remained a tap.
      if (event.pointerType === 'touch') return;
      const mode = hoverPickingMode();
      recordHoverRequest(mode === 'throttled' && this.hoverEvent !== undefined);
      if (mode === 'baseline') { this.updateHover(event); return; }
      if (mode === 'off') { this.hoverEvent = undefined; deps.cursor.setWowCursor('Point'); this.hideUnitTooltip(); return; }
      this.hoverEvent = event;
      if (!this.hoverPickScheduled) { this.hoverPickScheduled = true; requestAnimationFrame(this.flushHoverPick); }
    });

    deps.canvas.addEventListener('pointerleave', () => {
      this.hoverEvent = undefined;
      deps.cursor.setWowCursor('Point');
      this.hideUnitTooltip();
    });

    deps.canvas.addEventListener('pointerup', (event: PointerEvent) => {
      if (!this.inspectPointerDown || this.inspectPointerDown.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - this.inspectPointerDown.x, event.clientY - this.inspectPointerDown.y);
      const touch = this.inspectPointerDown.touch;
      const dragged = this.inspectPointerDown.moved;
      this.inspectPointerDown = undefined;
      if (dragged || moved > (touch ? 12 : 5)) return;
      if (event.button === 0) {
        const picked = this.pickAt(event);
        if (picked?.entity && deps.targetPendingSpell?.(picked.entity)) {
          this.updateEntityDebug();
          return;
        }
        // Interface Options → "Sticky Targeting": clicking empty ground keeps the current
        // selection instead of dropping it. Clicking another unit still switches target.
        if (picked?.entity || Number(getInterfaceCvars().stickyTargeting) !== 1) {
          this.setTarget(picked?.entity.guid);
        }
        // Touch has no right mouse button. A clean tap on an interactable world object or NPC
        // performs vanilla's right-click interaction after selecting it; hostile units remain a
        // selection-only tap so an imprecise finger cannot accidentally start combat.
        if (touch && picked?.entity && (
          picked.entity.typeId === TypeID.GAMEOBJECT
          || ((picked.entity.dynamicFlags ?? 0) & UNIT_DYNFLAG_LOOTABLE) !== 0
          || (picked.entity.npcFlags ?? 0) !== 0
        )) deps.getWorld()?.interact(picked.entity.guid);
        this.updateEntityDebug();
      } else if (event.button === 2) {
        const picked = this.pickAt(event);
        if (picked?.entity) {
          this.setTarget(picked.entity.guid);
          if (picked.entity.typeId === TypeID.PLAYER) {
            if ((picked.entity.health ?? 1) > 0 && this.reactionFor(picked.entity) === 'hostile') {
              deps.attackTarget(picked.entity.guid);
            } else {
              showUnitPopup(picked.entity.guid, event.clientX, event.clientY);
            }
          } else if (picked.entity.typeId === TypeID.GAMEOBJECT) {
            deps.getWorld()?.interact(picked.entity.guid);
          } else if ((picked.entity.dynamicFlags ?? 0) & UNIT_DYNFLAG_LOOTABLE || (picked.entity.npcFlags ?? 0) !== 0) {
            deps.getWorld()?.interact(picked.entity.guid);
          } else if (
            picked.entity.typeId === TypeID.UNIT
            && (picked.entity.health ?? 1) > 0
            // Vanilla right-click auto-attacks hostiles only; neutral (yellow)
            // units are merely selected and friendly ones never enter combat.
            && this.reactionFor(picked.entity) === 'hostile'
          ) {
            deps.attackTarget(picked.entity.guid);
          }
        }
        this.updateEntityDebug();
      }
    });

    deps.canvas.addEventListener('contextmenu', (event: Event) => event.preventDefault());
    deps.canvas.addEventListener('pointercancel', () => {
      this.inspectPointerDown = undefined;
    });

    deps.elements.entityDebugClose.addEventListener('click', () => {
      deps.getEntityRenderer()?.select(undefined);
      this.updateEntityDebug();
    });

    deps.elements.entityDebugCopy.addEventListener('click', () => {
      void navigator.clipboard.writeText(deps.elements.entityDebugContent.textContent ?? '').then(() => {
        deps.elements.entityDebugCopy.textContent = 'Copied';
        window.setTimeout(() => {
          deps.elements.entityDebugCopy.textContent = 'Copy JSON';
        }, 1200);
      });
    });
  }

  setTarget(guid: string | undefined) {
    this.selectTarget(guid, true);
  }

  cycleTabTarget() {
    const pos = this.deps.getPlayerLocalPosition();
    const candidates = this.deps.getEntityRenderer()?.nearestUnits(pos.x, pos.y, 40) ?? [];
    if (!candidates.length) return;
    this.tabCycleIndex = (this.tabCycleIndex + 1) % candidates.length;
    this.selectTarget(candidates[this.tabCycleIndex], false);
  }

  updateEntityDebug() {
    // The JSON inspector is a dev overlay. Off by default so a normal left/right click only targets
    // the unit (target frame) without dumping raw entity fields on screen. ?debugtools re-enables it.
    if (!this.deps.debugToolsEnabled) {
      this.deps.elements.entityDebug.classList.remove('visible');
      this.deps.elements.entityDebugContent.textContent = '';
      return;
    }
    const inspection = this.deps.getEntityRenderer()?.selectedInspection();
    if (!inspection) {
      this.deps.elements.entityDebug.classList.remove('visible');
      this.deps.elements.entityDebugContent.textContent = '';
      return;
    }
    this.deps.elements.entityDebug.classList.add('visible');
    const entity = inspection.entity;
    this.deps.elements.entityDebugTitle.textContent =
      `${entity.typeName} · entry ${entity.entry ?? '?'} · display ${entity.displayId ?? '?'} · ${entity.guid.slice(-8)}`;
    this.deps.elements.entityDebugContent.textContent = JSON.stringify(this.deps.inspectionPayload(inspection), null, 2);
  }

  private selectTarget(guid: string | undefined, resetCycle: boolean) {
    const previousGuid = this.deps.getSelectedTargetGuid();
    const changed = guid !== previousGuid;
    const previousEntity = previousGuid ? this.deps.getEntityRenderer()?.inspect(previousGuid)?.entity : undefined;
    if (changed && this.deps.getAutoAttacking()) this.deps.stopAttack();
    this.deps.setSelectedTargetGuid(guid);
    if (resetCycle) this.tabCycleIndex = -1;
    const renderer = this.deps.getEntityRenderer();
    const world = this.deps.getWorld();
    renderer?.select(guid);
    world?.setSelection(guid ?? null);
    const entity = guid ? renderer?.inspect(guid)?.entity : undefined;
    if (changed) {
      if (entity) this.playSelectionCue(entity, true);
      else if (previousEntity) this.playSelectionCue(previousEntity, false);
      else this.deps.playUi?.('targetLost');
    }
    if (guid && entity?.typeId === TypeID.PLAYER) world?.queryPlayerName(guid);
    else if (entity?.typeId === TypeID.UNIT && entity.entry) world?.queryCreature(entity.entry, guid);
    else if (entity?.typeId === TypeID.GAMEOBJECT && entity.entry) world?.queryGameObject(entity.entry, guid);
    this.deps.refreshTargetFrame();
  }

  private playSelectionCue(entity: WorldEntity, selected: boolean) {
    const suffix = selected ? 'Select' : 'Deselect';
    if (entity.typeId === TypeID.PLAYER) {
      this.deps.playUi?.(`targetPlayer${suffix}`);
      return;
    }
    if (entity.typeId !== TypeID.UNIT) return;
    const reaction = this.reactionFor(entity);
    if (reaction === 'hostile') this.deps.playUi?.(`targetAggro${suffix}`);
    else if (reaction === 'neutral') this.deps.playUi?.(`targetNeutral${suffix}`);
    else this.deps.playUi?.(`targetNpc${suffix}`);
  }

  private reactionFor(entity: WorldEntity): UnitReaction {
    const factionId = factionIdForTemplate(entity.faction);
    const forced = factionId === undefined ? undefined : this.deps.getWorld()?.getForcedReaction(factionId);
    const player = this.deps.getPlayerEntity();
    return withDuelReaction(
      player,
      entity,
      getUnitReaction(player?.faction, entity.faction, forced),
    );
  }

  private pickAt(event: PointerEvent, select = true) {
    const rect = this.deps.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return this.deps.getEntityRenderer()?.pick(this.deps.camera, x, y, select, this.deps.isWorldPointBlockedByWmo) ?? null;
  }

  private updateHover(event: PointerEvent): void {
    const picked = this.pickAt(event, false);
    this.deps.cursor.setWowCursor(this.hoverCursorForInspection(picked));
    if (picked) this.showUnitTooltip(picked);
    else this.hideUnitTooltip();
  }

  private distanceToInspection(picked: WorldEntityInspection) {
    const p = this.deps.getEntityRenderer()?.localPositionOf(picked.entity.guid);
    if (!p) return Number.POSITIVE_INFINITY;
    const self = this.deps.getPlayerLocalPosition();
    return Math.hypot(p.x - self.x, p.y - self.y);
  }

  private inInteractionRange(picked: WorldEntityInspection) {
    return this.distanceToInspection(picked) <= INTERACTION_DISTANCE;
  }

  private inAttackRange(picked: WorldEntityInspection) {
    const distance = this.distanceToInspection(picked);
    const player = this.deps.getPlayerEntity();
    const selfReach = Math.max(player?.combatReach ?? MIN_COMBAT_REACH, MIN_COMBAT_REACH);
    const targetReach = Math.max(picked.entity.combatReach ?? MIN_COMBAT_REACH, MIN_COMBAT_REACH);
    const reach = Math.max(selfReach + targetReach + BASE_MELEE_RANGE_OFFSET, MIN_MELEE_RANGE);
    return distance <= reach;
  }

  private hoverCursorForInspection(picked: WorldEntityInspection | null): WowCursorName {
    if (!picked?.entity || this.deps.cursor.heldCursor) return 'Point';
    const entity = picked.entity;
    const npcFlags = entity.npcFlags ?? 0;
    const interactable = this.inInteractionRange(picked);
    const attackable = this.inAttackRange(picked);
    if ((entity.dynamicFlags ?? 0) & UNIT_DYNFLAG_LOOTABLE) return interactable ? 'LootAll' : 'UnableLootAll';
    if (npcFlags & UNIT_NPC_FLAG.REPAIR) return interactable ? 'Repair' : 'UnableRepair';
    if (npcFlags & UNIT_NPC_FLAG.VENDOR) return interactable ? 'Buy' : 'UnableBuy';
    if (npcFlags & UNIT_NPC_FLAG.TRAINER) return interactable ? 'Trainer' : 'UnableTrainer';
    if (npcFlags & UNIT_NPC_FLAG.FLIGHTMASTER) return interactable ? 'Taxi' : 'UnableTaxi';
    // Vanilla ships no dedicated banker/innkeeper/auctioneer/stable cursor art — they all fall
    // back to UI-Cursor-Speak, which is why they share one branch.
    if (npcFlags & UNIT_NPC_FLAG_SPEAK) return interactable ? 'Speak' : 'UnableSpeak';
    if (entity.typeId === TypeID.PLAYER) {
      if (this.reactionFor(entity) === 'hostile') return attackable ? 'Attack' : 'UnableAttack';
      return interactable ? 'Inspect' : 'Point';
    }
    if (entity.typeId === TypeID.UNIT && (entity.health ?? 1) > 0) {
      if (this.reactionFor(entity) !== 'friendly') return attackable ? 'Attack' : 'UnableAttack';
      return 'Point';
    }
    if (entity.typeId === TypeID.GAMEOBJECT) return interactable ? 'Interact' : 'UnableInteract';
    return 'Point';
  }

  private hideUnitTooltip() {
    if (this.unitTooltipKey === undefined) return;
    this.unitTooltipKey = undefined;
    this.deps.elements.gameTooltip.classList.remove('is-unit-default-anchor');
    this.deps.elements.gameTooltip.classList.add('is-hidden');
  }

  private showUnitTooltip(picked: WorldEntityInspection) {
    const entity = picked.entity;
    if (entity.typeId === TypeID.GAMEOBJECT) {
      const name = this.deps.nameForEntity(entity.guid, entity);
      const key = `${entity.guid}|${name}`;
      if (key !== this.unitTooltipKey) {
        this.unitTooltipKey = key;
        this.deps.elements.gameTooltip.innerHTML =
          `<div class="wow-game-tooltip-name">${this.deps.escapeHtml(name)}</div>`;
        this.deps.elements.gameTooltip.classList.remove('is-hidden');
      }
      this.deps.elements.gameTooltip.classList.add('is-unit-default-anchor');
      return;
    }
    if (entity.typeId !== TypeID.UNIT && entity.typeId !== TypeID.PLAYER) {
      this.hideUnitTooltip();
      return;
    }
    const player = this.deps.getPlayerEntity();
    const reaction = this.reactionFor(entity);
    const nameColor = reaction === 'hostile' ? '#ff4040' : reaction === 'friendly' ? '#40ff40' : '#ffff00';
    const creatureCache = entity.entry !== undefined ? this.deps.getWorld()?.getCreatureName(entity.entry) : undefined;
    const levelText = entity.level !== undefined ? `Level ${entity.level}` : 'Level ??';
    const conHex = player?.level && entity.level !== undefined ? CON_HEX[levelDifficultyColor(player.level, entity.level)] : '#ffffff';
    let detail = '';
    if (entity.typeId === TypeID.PLAYER) {
      detail = ` ${this.deps.raceName(entity.race ?? -1)} ${this.deps.className(entity.classId ?? -1)}`.trimEnd();
    } else {
      const rank = creatureCache?.rank ?? 0;
      detail = rank ? ` ${CLASSIFICATION_NAMES[rank] ?? ''}` : ` ${CREATURE_TYPE_NAMES[creatureCache?.type ?? -1] ?? ''}`;
      detail = detail.trimEnd();
    }
    const name = this.deps.nameForEntity(entity.guid, entity);
    const key = `${entity.guid}|${name}|${levelText}|${detail}|${reaction}`;
    if (key !== this.unitTooltipKey) {
      this.unitTooltipKey = key;
      this.deps.elements.gameTooltip.innerHTML =
        `<div class="wow-game-tooltip-name" style="color:${nameColor}">${this.deps.escapeHtml(name)}</div>` +
        `<div class="wow-game-tooltip-line" style="color:${conHex}">${this.deps.escapeHtml(levelText)}${this.deps.escapeHtml(detail)}</div>`;
      this.deps.elements.gameTooltip.classList.remove('is-hidden');
    }
    this.deps.elements.gameTooltip.classList.add('is-unit-default-anchor');
  }
}
