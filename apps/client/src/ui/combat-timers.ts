import type { AuraSlot, CombatEvent, WorldEntity } from '../world';
import { isBuiltInAddonEnabled, onBuiltInAddonSettings } from './builtin-addons';
import { VanillaCanvas } from './vanilla-canvas';

type CastTimer = {
  casterGuid: string;
  spellId: number;
  startedAt: number;
  endsAt: number;
  durationMs: number;
  channel: boolean;
};
type SwingTimer = { label: string; startedAt: number; durationMs: number };
type AuraTimer = { slot: number; spellId: number; expiresAt: number; estimated: boolean };

export type CombatTimersDeps = {
  getPlayerGuid: () => string | undefined;
  getTargetGuid: () => string | undefined;
  getPlayerEntity: () => WorldEntity | undefined;
  getTargetAuras: () => readonly AuraSlot[];
  getSpellMeta: (spellId: number) => readonly unknown[] | undefined;
  isAutoRepeatSpell: (spellId: number) => boolean;
};

const remainingText = (ms: number) => ms >= 10_000
  ? `${Math.ceil(ms / 1_000)}s`
  : `${(Math.max(0, ms) / 1_000).toFixed(1)}s`;

/**
 * Vanilla addon-style combat timing:
 * - ShaguTweaks target casts are a 140x10 status bar attached below TargetFrame.
 * - ShaguTweaks target debuff timers are text overlays on the target debuff icons.
 * - VGAttackBar's player swing bar is 195x13 at TOP, 125 px down.
 */
export class CombatTimersAddon {
  private readonly targetSurface = new VanillaCanvas(166, 52, 'wow-combat-target-timers-canvas');
  private readonly swingSurface = new VanillaCanvas(206, 20, 'wow-combat-swing-timer-canvas');
  private cast?: CastTimer;
  private swing?: SwingTimer;
  private auraTarget?: string;
  private readonly auras = new Map<string, AuraTimer>();
  private readonly activeAuras = new Set<string>();
  private timer?: number;

  constructor(parent: HTMLElement, private readonly deps: CombatTimersDeps) {
    const targetFrame = parent.querySelector<HTMLElement>('#wow-target-frame') ?? parent;
    Object.assign(this.targetSurface.canvas.style, {
      position: 'absolute', left: '12px', top: '88px', zIndex: '4', pointerEvents: 'none',
    });
    Object.assign(this.swingSurface.canvas.style, {
      position: 'absolute', left: '50%', top: '125px', transform: 'translateX(-50%)',
      zIndex: '32', pointerEvents: 'none',
    });
    targetFrame.appendChild(this.targetSurface.canvas);
    parent.appendChild(this.swingSurface.canvas);
    this.targetSurface.onRender(() => this.paintTargetTimers());
    this.swingSurface.onRender(() => this.paintSwingTimer());
    onBuiltInAddonSettings((settings) => {
      if (!settings.combatTimers) this.clear();
      this.requestRender();
    });
    this.requestRender();
  }

  handleCombatEvent(event: CombatEvent) {
    if (!isBuiltInAddonEnabled('combatTimers')) return;
    const now = performance.now();
    const target = this.deps.getTargetGuid();
    const player = this.deps.getPlayerGuid();
    if (event.kind === 'spellStart' && event.casterGuid === target && event.castTimeMs > 0) {
      this.cast = { casterGuid: event.casterGuid, spellId: event.spellId, startedAt: now,
        endsAt: now + event.castTimeMs, durationMs: event.castTimeMs, channel: false };
    } else if (event.kind === 'channelStart' && event.casterGuid === target && event.durationMs > 0) {
      this.cast = { casterGuid: event.casterGuid, spellId: event.spellId, startedAt: now,
        endsAt: now + event.durationMs, durationMs: event.durationMs, channel: true };
    } else if (event.kind === 'spellDelayed' && this.cast?.casterGuid === event.casterGuid) {
      this.cast.endsAt += event.delayMs;
      this.cast.durationMs += event.delayMs;
    } else if (event.kind === 'channelUpdate' && this.cast?.casterGuid === event.casterGuid) {
      if (event.timeRemainingMs <= 0) this.cast = undefined;
      else this.cast = { ...this.cast, startedAt: now, endsAt: now + event.timeRemainingMs,
        durationMs: event.timeRemainingMs };
    } else if ((event.kind === 'spellGo' || event.kind === 'spellFailure')
      && this.cast?.casterGuid === event.casterGuid) {
      this.cast = undefined;
    }

    // VGAttackBar starts the next weapon cycle when an outgoing swing lands (a zero-damage
    // ATTACKERSTATEUPDATE is still a miss and therefore still starts the next cycle).
    if (event.kind === 'meleeDamage' && event.attackerGuid === player) {
      const durationMs = this.deps.getPlayerEntity()?.baseAttackTimeMs ?? 0;
      if (durationMs > 0) this.swing = { label: 'Melee Swing', startedAt: now, durationMs };
    } else if (event.kind === 'spellGo' && event.casterGuid === player
      && this.deps.isAutoRepeatSpell(event.spellId)) {
      const durationMs = this.deps.getPlayerEntity()?.rangedAttackTimeMs ?? 0;
      if (durationMs > 0) this.swing = { label: 'Auto Shot', startedAt: now, durationMs };
    } else if (event.kind === 'combatCancelled' || event.kind === 'autoRepeatCancelled'
      || (event.kind === 'attackStop' && event.attackerGuid === player)) {
      this.swing = undefined;
    }
    this.requestRender();
  }

  refreshTarget() { this.syncTargetDebuffs(performance.now()); this.tick(); this.requestRender(); }

  private tick() {
    if (!isBuiltInAddonEnabled('combatTimers')) return;
    const now = performance.now();
    const hadVisible = !!this.cast || !!this.swing || this.auras.size > 0;
    if (this.cast && (this.cast.endsAt <= now || this.cast.casterGuid !== this.deps.getTargetGuid())) {
      this.cast = undefined;
    }
    if (this.swing && now - this.swing.startedAt >= this.swing.durationMs) this.swing = undefined;
    for (const [key, aura] of this.auras) if (aura.expiresAt <= now) this.auras.delete(key);
    if (hadVisible || this.auras.size > 0) this.requestRender();
  }

  private syncTargetDebuffs(now: number) {
    const target = this.deps.getTargetGuid();
    if (target !== this.auraTarget) {
      this.auraTarget = target;
      this.auras.clear();
    }
    if (!target) return;
    const active = this.activeAuras; active.clear();
    // TargetFrameDebuffTimer augments harmful TargetFrameDebuff buttons only. Helpful target
    // buffs are deliberately not duplicated into this addon row.
    for (const aura of this.deps.getTargetAuras()) {
      if (aura.slot < 32) continue;
      const key = `${aura.slot}:${aura.spellId}`;
      active.add(key);
      const exact = aura.timeRemainingMs ?? 0;
      const base = Number(this.deps.getSpellMeta(aura.spellId)?.[29] ?? 0);
      const durationMs = exact > 0 ? exact : base;
      if (durationMs <= 0) continue;
      const existing = this.auras.get(key);
      if (!existing) {
        this.auras.set(key, { slot: aura.slot, spellId: aura.spellId,
          expiresAt: now + durationMs, estimated: exact <= 0 });
      } else if (exact > 0 && Math.abs(existing.expiresAt - now - exact) > 500) {
        existing.expiresAt = now + exact;
        existing.estimated = false;
      }
    }
    for (const [key, aura] of this.auras) {
      if (!active.has(key) || aura.expiresAt <= now) this.auras.delete(key);
    }
  }

  private paintTargetTimers() {
    const enabled = isBuiltInAddonEnabled('combatTimers');
    const now = performance.now();
    const auras = [...this.auras.values()].filter((aura) => aura.expiresAt > now).slice(0, 7);
    const visible = enabled && (!!this.cast || auras.length > 0);
    this.targetSurface.canvas.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    const s = this.targetSurface;
    s.clear();
    if (auras.length) {
      auras.forEach((aura, index) => {
        const x = 18 + index * 21;
        const icon = Number(this.deps.getSpellMeta(aura.spellId)?.[2] ?? 0);
        if (icon) s.image(`/spells/icons/${icon}.png`, x, 0, 18, 18);
        s.text(`${aura.estimated ? '~' : ''}${remainingText(aura.expiresAt - now)}`, x + 9, 9,
          { family: 'sans', size: 9, color: '#ffffff', align: 'center', baseline: 'middle' });
      });
    }
    if (this.cast) this.paintTargetCast(auras.length ? 27 : 4, now);
  }

  private paintTargetCast(y: number, now: number) {
    const cast = this.cast;
    if (!cast) return;
    const s = this.targetSurface;
    const remaining = Math.max(0, cast.endsAt - now);
    const progress = cast.channel ? remaining / cast.durationMs : 1 - remaining / cast.durationMs;
    const icon = Number(this.deps.getSpellMeta(cast.spellId)?.[2] ?? 0);
    if (icon) s.image(`/spells/icons/${icon}.png`, 0, y - 3, 16, 16);
    const ctx = s.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(16,13,0,.88)';
    ctx.fillRect(20, y, 140, 10);
    ctx.fillStyle = cast.channel ? '#704090' : '#cca300';
    ctx.fillRect(21, y + 1, 138 * Math.max(0, Math.min(1, progress)), 8);
    ctx.strokeStyle = '#c8a65b';
    ctx.strokeRect(19.5, y - .5, 141, 11);
    ctx.restore();
    s.text(this.spellName(cast.spellId), 90, y + 5,
      { size: 8, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 112 });
  }

  private paintSwingTimer() {
    const visible = isBuiltInAddonEnabled('combatTimers') && !!this.swing;
    this.swingSurface.canvas.style.display = visible ? 'block' : 'none';
    if (!visible || !this.swing) return;
    const now = performance.now();
    const elapsed = Math.max(0, now - this.swing.startedAt);
    const remaining = Math.max(0, this.swing.durationMs - elapsed);
    const progress = Math.min(1, elapsed / this.swing.durationMs);
    const s = this.swingSurface;
    s.clear();
    const ctx = s.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(5, 3, 195, 13);
    ctx.fillStyle = '#3030bb';
    ctx.fillRect(6, 4, 193 * progress, 11);
    ctx.strokeStyle = '#a89868';
    ctx.strokeRect(4.5, 2.5, 196, 14);
    ctx.restore();
    s.text(this.swing.label, 10, 10, { size: 9, color: '#ffffff', baseline: 'middle' });
    s.text(`${remainingText(remaining)} / ${(this.swing.durationMs / 1_000).toFixed(2)}`,
      196, 10, { family: 'sans', size: 9, color: '#ffffff', align: 'right', baseline: 'middle' });
  }

  private requestRender() {
    this.targetSurface.requestRender();
    this.swingSurface.requestRender();
    if (this.timer === undefined && isBuiltInAddonEnabled('combatTimers') && (this.cast || this.swing || this.auras.size)) {
      this.timer = window.setTimeout(() => { this.timer = undefined; this.tick(); }, 50);
    }
  }

  private spellName(spellId: number) {
    return String(this.deps.getSpellMeta(spellId)?.[0] ?? `Spell ${spellId}`);
  }

  private clear() {
    if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined;
    this.cast = undefined;
    this.swing = undefined;
    this.auras.clear();
    this.targetSurface.canvas.style.display = 'none';
    this.swingSurface.canvas.style.display = 'none';
  }
}
