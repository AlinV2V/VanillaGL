import type { CombatEvent } from '../world';
import {
  areaSpiritHealMessage,
  summonConfirmMessage,
  WAITING_TO_RESURRECT_SPELL_ID,
  zoneUnderAttackMessage,
} from '../world/world-notices';
import { instanceBootMessage, raidGroupErrorMessage } from '../world/service-feedback';

export type WorldNoticeDeps = {
  areaName: (areaId: number) => string | undefined;
  systemMessage: (message: string) => void;
  queueSpiritHeal: (healerGuid: string) => void;
  cancelAuraSpell: (spellId: number) => void;
  queryPlayerName: (guid: string) => void;
  playerName: (guid: string) => string | undefined;
  acceptSummon: (summonerGuid: string) => void;
  inCombat: () => boolean;
  showAction: (message: string, label: string, action: () => void) => void;
  showConfirm: (message: string, accept: () => void, decline: () => void, disabled: boolean) => void;
  showNotice: (message: string) => void;
  uiError: (message: string) => void;
  updateActionMessage: (message: string) => void;
  setActionDisabled: (disabled: boolean) => void;
  hideAction: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, intervalMs: number) => number;
  clearTimer?: (timer: number) => void;
};

/** Owns FrameXML's world-notice side effects without adding another feature to main.ts. */
export class WorldNoticeController {
  private spiritTimer?: number;
  private spiritDeadline = 0;
  private summonTimer?: number;
  private summon?: { guid: string; area: string; deadline: number };
  private instanceBootTimer?: number;
  private instanceBoot?: { area: string; deadline: number };

  constructor(private readonly deps: WorldNoticeDeps) {}

  handle(event: CombatEvent): boolean {
    if (event.kind === 'raidGroupOnly') {
      this.handleRaidGroupOnly(event.timerMs, event.errorCode, event.bindAreaId);
      return true;
    }
    if (event.kind === 'zoneUnderAttack') {
      const area = this.deps.areaName(event.areaId) ?? `Area ${event.areaId}`;
      this.deps.systemMessage(zoneUnderAttackMessage(area));
      return true;
    }
    if (event.kind === 'summonRequest') {
      this.showSummon(event.summonerGuid, event.areaId, event.autoDeclineDelayMs);
      return true;
    }
    if (event.kind === 'playerNameResponse' && this.summon?.guid === event.guid) {
      this.updateSummon();
      return true;
    }
    if (event.kind !== 'areaSpiritHealerTime') return false;

    this.stopSpiritTimer();
    this.stopSummonTimer();
    this.stopInstanceBootTimer();
    // StaticPopupDialogs["AREA_SPIRIT_HEAL"].OnShow auto-accepts into the resurrection queue.
    this.deps.queueSpiritHeal(event.healerGuid);
    const now = this.deps.now ?? (() => performance.now());
    const displayMs = Math.max(0, Math.floor(event.timeRemainingMs / 1000) * 1000);
    this.spiritDeadline = now() + displayMs;
    this.deps.showAction(areaSpiritHealMessage(displayMs), 'Cancel', () => {
      this.stopSpiritTimer();
      this.deps.cancelAuraSpell(WAITING_TO_RESURRECT_SPELL_ID);
    });
    if (displayMs <= 0) return true;

    const setTimer = this.deps.setTimer ?? ((callback, intervalMs) => window.setInterval(callback, intervalMs));
    this.spiritTimer = setTimer(() => {
      const remaining = Math.max(0, this.spiritDeadline - now());
      if (remaining <= 0) {
        this.stopSpiritTimer();
        this.deps.hideAction();
        return;
      }
      this.deps.updateActionMessage(areaSpiritHealMessage(remaining));
    }, 250);
    return true;
  }

  dispose() {
    this.stopSpiritTimer();
    this.stopSummonTimer();
    this.stopInstanceBootTimer();
  }

  private showSummon(guid: string, areaId: number, delayMs: number) {
    this.stopSpiritTimer();
    this.stopSummonTimer();
    this.stopInstanceBootTimer();
    this.deps.queryPlayerName(guid);
    const now = this.deps.now ?? (() => performance.now());
    const displayMs = Math.max(0, Math.floor(delayMs / 1000) * 1000);
    this.summon = { guid, area: this.deps.areaName(areaId) ?? `Area ${areaId}`, deadline: now() + displayMs };
    this.deps.showConfirm(this.summonMessage(displayMs), () => {
      if (this.deps.inCombat()) return;
      this.stopSummonTimer();
      this.deps.acceptSummon(guid);
    }, () => this.stopSummonTimer(), this.deps.inCombat());
    if (displayMs <= 0) return;
    const setTimer = this.deps.setTimer ?? ((callback, intervalMs) => window.setInterval(callback, intervalMs));
    this.summonTimer = setTimer(() => this.updateSummon(), 250);
  }

  private updateSummon() {
    if (!this.summon) return;
    const now = this.deps.now ?? (() => performance.now());
    const remaining = Math.max(0, this.summon.deadline - now());
    if (remaining <= 0) {
      this.stopSummonTimer();
      this.deps.hideAction();
      return;
    }
    this.deps.updateActionMessage(this.summonMessage(remaining));
    this.deps.setActionDisabled(this.deps.inCombat());
  }

  private summonMessage(remainingMs: number) {
    const pending = this.summon!;
    return summonConfirmMessage(this.deps.playerName(pending.guid) ?? 'Another player', pending.area, remainingMs);
  }

  private handleRaidGroupOnly(timerMs: number, errorCode: number, bindAreaId?: number) {
    if (timerMs <= 0) {
      if (this.instanceBoot) {
        this.stopInstanceBootTimer();
        this.deps.hideAction();
      } else {
        this.deps.uiError(raidGroupErrorMessage(errorCode));
      }
      return;
    }
    this.stopSpiritTimer();
    this.stopSummonTimer();
    this.stopInstanceBootTimer();
    const now = this.deps.now ?? (() => performance.now());
    const displayMs = Math.max(0, Math.floor(timerMs / 1000) * 1000);
    this.instanceBoot = {
      area: bindAreaId ? this.deps.areaName(bindAreaId) ?? 'your home' : 'your home',
      deadline: now() + displayMs,
    };
    this.deps.showNotice(instanceBootMessage(this.instanceBoot.area, displayMs));
    const setTimer = this.deps.setTimer ?? ((callback, intervalMs) => window.setInterval(callback, intervalMs));
    this.instanceBootTimer = setTimer(() => {
      if (!this.instanceBoot) return;
      const remaining = Math.max(0, this.instanceBoot.deadline - now());
      if (remaining <= 0) {
        this.stopInstanceBootTimer();
        this.deps.hideAction();
        return;
      }
      this.deps.updateActionMessage(instanceBootMessage(this.instanceBoot.area, remaining));
    }, 250);
  }

  private stopSpiritTimer() {
    if (this.spiritTimer === undefined) return;
    const clearTimer = this.deps.clearTimer ?? ((timer: number) => window.clearInterval(timer));
    clearTimer(this.spiritTimer);
    this.spiritTimer = undefined;
  }

  private stopSummonTimer() {
    if (this.summonTimer !== undefined) {
      const clearTimer = this.deps.clearTimer ?? ((timer: number) => window.clearInterval(timer));
      clearTimer(this.summonTimer);
    }
    this.summonTimer = undefined;
    this.summon = undefined;
  }

  private stopInstanceBootTimer() {
    if (this.instanceBootTimer !== undefined) {
      const clearTimer = this.deps.clearTimer ?? ((timer: number) => window.clearInterval(timer));
      clearTimer(this.instanceBootTimer);
    }
    this.instanceBootTimer = undefined;
    this.instanceBoot = undefined;
  }
}
