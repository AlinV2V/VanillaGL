import { trackedMeterActors } from './meter-actors';
import type { CombatEvent, WorldEntity } from '../world';
import { isBuiltInAddonEnabled, onBuiltInAddonSettings } from './builtin-addons';
import { VanillaCanvas } from './vanilla-canvas';

type MeterEntry = {
  damage: number;
  healing: number;
  deaths: number;
  activeMs: number;
  lastEventAt: number;
  damageByAction: Map<string, number>;
  healingByAction: Map<string, number>;
};
type MeterMode = 'damage' | 'dps';
type MeterSegment = 'current' | 'overall';

export type DamageMeterLiteDeps = {
  resolveName: (guid: string) => string | undefined;
  resolveClassId: (guid: string) => number | undefined;
  resolveSpellName: (spellId: number) => string | undefined;
  getPlayerGuid: () => string | undefined;
  getPlayerEntity: () => WorldEntity | undefined;
  getEntity: (guid: string) => WorldEntity | undefined;
  isTrackedActor: (guid: string) => boolean;
  normalizeActorGuid: (guid: string) => string;
};

const WIDTH = 240;
const HEIGHT = 166;
const ROW_TOP = 23;
const ROW_HEIGHT = 15;
const ROW_COUNT = 8;
const CLASS_COLORS: Record<number, string> = {
  1: '#c79c6e', 2: '#f58cba', 3: '#abd473', 4: '#fff569', 5: '#ffffff',
  7: '#0070de', 8: '#69ccf0', 9: '#9482c9', 11: '#ff7d0a',
};

const amount = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m`
  : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(Math.round(value));
const rate = (value: number) => value >= 1_000 ? amount(value) : value.toFixed(1);
const dps = (entry: MeterEntry) => entry.damage / Math.max(1, entry.activeMs / 1_000);
const emptyEntry = (now = 0): MeterEntry => ({
  damage: 0, healing: 0, deaths: 0, activeMs: 1_000, lastEventAt: now,
  damageByAction: new Map(), healingByAction: new Map(),
});

/** Compact ShaguDPS-style meter: status-bar rows, mode/segment controls and per-action hover detail. */
export class DamageMeterLiteAddon {
  private readonly host = document.createElement('div');
  private readonly surface = new VanillaCanvas(WIDTH, HEIGHT, 'wow-damage-meter-lite-canvas');
  private readonly detail = new VanillaCanvas(250, 136, 'wow-damage-meter-detail-canvas');
  private readonly current = new Map<string, MeterEntry>();
  private readonly overall = new Map<string, MeterEntry>();
  private readonly deadByGuid = new Map<string, boolean>();
  private mode: MeterMode = 'dps';
  private segment: MeterSegment = 'current';
  private hoveredGuid?: string;
  private lastEventAt = 0;
  private cachedRows?: Array<[string, MeterEntry]>;
  private cachedMode?: MeterMode;
  private cachedSegment?: MeterSegment;

  constructor(parent: HTMLElement, private readonly deps: DamageMeterLiteDeps) {
    this.host.className = 'wow-damage-meter-lite-addon has-canvas-ui';
    Object.assign(this.host.style, {
      position: 'absolute', right: '20px', top: '225px', zIndex: '31', pointerEvents: 'auto',
    });
    Object.assign(this.detail.canvas.style, {
      position: 'absolute', right: `${WIDTH + 5}px`, top: '23px', pointerEvents: 'none', display: 'none',
    });
    this.host.append(this.surface.canvas, this.detail.canvas);
    parent.appendChild(this.host);
    this.surface.canvas.setAttribute('role', 'meter');
    this.surface.canvas.setAttribute('aria-label', 'Damage Meter Lite');
    this.surface.onRender(() => this.paint());
    this.detail.onRender(() => this.paintDetail());
    this.installPointerBehavior();
    onBuiltInAddonSettings((settings) => {
      if (!settings.damageMeterLite) this.resetAll();
      this.host.style.display = settings.damageMeterLite ? 'block' : 'none';
      this.requestRender();
    });
    window.setInterval(() => this.tick(), 250);
    this.host.style.display = isBuiltInAddonEnabled('damageMeterLite') ? 'block' : 'none';
    this.requestRender();
  }

  handleCombatEvent(event: CombatEvent) {
    if (!isBuiltInAddonEnabled('damageMeterLite')) return;
    if (event.kind === 'meleeDamage') this.add(event.attackerGuid, event.totalDamage, 0, 'Auto Attack');
    else if (event.kind === 'spellDamage') this.add(event.attackerGuid, event.damage, 0, this.spellName(event.spellId));
    else if (event.kind === 'damageShield') this.add(event.shieldGuid, event.damage, 0, 'Damage Shield');
    else if (event.kind === 'spellHeal') this.add(event.healerGuid, 0, event.amount, this.spellName(event.spellId));
    else if (event.kind === 'periodicAura' && (event.auraType === 3 || event.auraType === 89)) {
      this.add(event.casterGuid, event.amount, 0, this.spellName(event.spellId));
    } else if (event.kind === 'periodicAura' && (event.auraType === 8 || event.auraType === 20)) {
      this.add(event.casterGuid, 0, event.amount, this.spellName(event.spellId));
    }
  }

  private add(sourceGuid: string, damage: number, healing: number, action: string) {
    if (!sourceGuid || !this.deps.isTrackedActor(sourceGuid) || (damage <= 0 && healing <= 0)) return;
    const guid = this.deps.normalizeActorGuid(sourceGuid);
    const mergedAction = guid === sourceGuid ? action : `Pet: ${action}`;
    const now = performance.now(); this.cachedRows = undefined;
    if (this.lastEventAt && now - this.lastEventAt > 8_000) this.resetFight();
    this.lastEventAt = now;
    for (const table of [this.current, this.overall]) {
      const entry = table.get(guid) ?? emptyEntry(now);
      if (entry.lastEventAt && entry.lastEventAt !== now) {
        // ShaguDPS caps idle gaps at five seconds, measuring active combat rather than window age.
        entry.activeMs += Math.min(5_000, Math.max(0, now - entry.lastEventAt));
      }
      entry.lastEventAt = now;
      entry.damage += Math.max(0, damage);
      entry.healing += Math.max(0, healing);
      if (damage > 0) entry.damageByAction.set(mergedAction, (entry.damageByAction.get(mergedAction) ?? 0) + damage);
      if (healing > 0) entry.healingByAction.set(mergedAction, (entry.healingByAction.get(mergedAction) ?? 0) + healing);
      table.set(guid, entry);
    }
    this.requestRender();
  }

  private tick() {
    if (!isBuiltInAddonEnabled('damageMeterLite')) return;
    const player = this.deps.getPlayerGuid();
    let changed = false;
    const actors = trackedMeterActors(this.overall, player);
    for (const guid of actors) {
      const entity = guid === player ? this.deps.getPlayerEntity() : this.deps.getEntity(guid);
      if (!entity?.maxHealth) continue;
      const dead = (entity.health ?? 1) <= 0;
      if (dead && !this.deadByGuid.get(guid)) {
        for (const table of [this.current, this.overall]) {
          const entry = table.get(guid) ?? emptyEntry();
          entry.deaths++; changed = true;
          table.set(guid, entry);
        }
      }
      this.deadByGuid.set(guid, dead);
    }
    if (changed) { this.cachedRows = undefined; this.requestRender(); }
  }

  private installPointerBehavior() {
    this.surface.canvas.addEventListener('pointermove', (event) => {
      const point = this.surface.point(event);
      const index = Math.floor((point.y - ROW_TOP) / ROW_HEIGHT);
      this.hoveredGuid = index >= 0 && index < ROW_COUNT ? this.rows()[index]?.[0] : undefined;
      this.requestRender();
    });
    this.surface.canvas.addEventListener('pointerleave', () => {
      this.hoveredGuid = undefined;
      this.requestRender();
    });
    this.surface.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const { x, y } = this.surface.point(event);
      if (y > 3 && y < 21 && x >= 3 && x <= 49) this.segment = this.segment === 'current' ? 'overall' : 'current';
      else if (y > 3 && y < 21 && x >= 52 && x <= 113) this.mode = 'damage';
      else if (y > 3 && y < 21 && x >= 115 && x <= 176) this.mode = 'dps';
      else if (y > 3 && y < 21 && x >= 215 && x <= 237) this.resetAll();
      this.hoveredGuid = undefined;
      this.requestRender();
    });
  }

  private paint() {
    if (!isBuiltInAddonEnabled('damageMeterLite')) return;
    const s = this.surface;
    s.clear();
    const ctx = s.ctx;
    ctx.fillStyle = 'rgba(7,7,7,.82)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = '#727272';
    ctx.strokeRect(.5, .5, WIDTH - 1, HEIGHT - 1);
    ctx.strokeStyle = '#161616';
    ctx.strokeRect(1.5, 1.5, WIDTH - 3, HEIGHT - 3);
    ctx.fillStyle = 'rgba(0,0,0,.72)';
    ctx.fillRect(2, 2, WIDTH - 4, 20);
    this.paintHeaderButton(3, 4, 46, this.segment === 'current' ? 'Current' : 'Overall', true);
    this.paintHeaderButton(52, 4, 61, 'Damage', this.mode === 'damage');
    this.paintHeaderButton(115, 4, 61, 'DPS', this.mode === 'dps');
    this.paintHeaderButton(215, 4, 22, 'Ø', false);

    const rows = this.rows();
    const values = rows.map(([, entry]) => this.value(entry));
    const best = Math.max(1, ...values);
    const total = Math.max(1, values.reduce((sum, value) => sum + value, 0));
    rows.forEach(([guid, entry], index) => {
      const y = ROW_TOP + index * ROW_HEIGHT;
      const value = values[index];
      ctx.fillStyle = 'rgba(0,0,0,.78)';
      ctx.fillRect(2, y, WIDTH - 4, ROW_HEIGHT - 1);
      const fill = (WIDTH - 4) * value / best;
      const color = CLASS_COLORS[this.deps.resolveClassId(guid) ?? 0] ?? '#707d8a';
      const gradient = ctx.createLinearGradient(2, y, Math.max(3, fill), y);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, '#252525');
      ctx.globalAlpha = .86;
      ctx.fillStyle = gradient;
      ctx.fillRect(2, y, fill, ROW_HEIGHT - 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      ctx.fillRect(2, y, fill, 2);
      if (guid === this.hoveredGuid) {
        ctx.strokeStyle = '#ffd100';
        ctx.strokeRect(2.5, y + .5, WIDTH - 5, ROW_HEIGHT - 2);
      }
      const percent = value / total * 100;
      const shown = this.mode === 'dps' ? rate(value) : amount(value);
      s.text(`${index + 1}. ${this.deps.resolveName(guid) ?? `Unit-${guid.slice(-4)}`}`, 6, y + 7,
        { size: 10, color: '#ffffff', baseline: 'middle', maxWidth: 132 });
      s.text(`${shown} - ${percent.toFixed(1)}%`, WIDTH - 6, y + 7,
        { family: 'sans', size: 10, color: '#ffffff', align: 'right', baseline: 'middle', maxWidth: 96 });
    });
    if (!rows.length) s.text('No combat data', WIDTH / 2, 78,
      { size: 11, color: '#a0a0a0', align: 'center', baseline: 'middle' });

    const table = this.table();
    const healing = [...table.values()].reduce((sum, entry) => sum + entry.healing, 0);
    const deaths = [...table.values()].reduce((sum, entry) => sum + entry.deaths, 0);
    s.text(`Healing ${amount(healing)}`, 5, HEIGHT - 7, { family: 'sans', size: 8, color: '#86d89a' });
    s.text(`Deaths ${deaths}`, WIDTH - 5, HEIGHT - 7,
      { family: 'sans', size: 8, color: '#c8c8c8', align: 'right' });
    this.detail.requestRender();
  }

  private paintHeaderButton(x: number, y: number, width: number, label: string, selected: boolean) {
    const ctx = this.surface.ctx;
    ctx.fillStyle = selected ? '#272727' : '#161616';
    ctx.fillRect(x, y, width, 17);
    ctx.strokeStyle = selected ? '#817347' : '#4c4c4c';
    ctx.strokeRect(x + .5, y + .5, width - 1, 16);
    this.surface.text(label, x + width / 2, y + 9,
      { family: 'sans', size: 9, color: selected ? '#ffe900' : '#a8a8a8', align: 'center', baseline: 'middle' });
  }

  private paintDetail() {
    const guid = this.hoveredGuid;
    const entry = guid ? this.table().get(guid) : undefined;
    this.detail.canvas.style.display = entry ? 'block' : 'none';
    if (!guid || !entry) return;
    const s = this.detail;
    s.clear();
    const ctx = s.ctx;
    ctx.fillStyle = 'rgba(25,13,10,.91)';
    ctx.fillRect(0, 0, 250, 136);
    ctx.strokeStyle = '#8b7668';
    ctx.strokeRect(.5, .5, 249, 135);
    const value = this.mode === 'dps' ? dps(entry) : entry.damage;
    s.text(this.mode === 'dps' ? 'DPS' : 'Damage', 12, 22, { size: 13, color: '#ffe600' });
    s.text(this.mode === 'dps' ? rate(value) : amount(value), 238, 22,
      { family: 'sans', size: 13, color: '#ffffff', align: 'right' });
    s.text('Damage Done', 12, 44, { size: 12, color: '#ffe600' });
    s.text(amount(entry.damage), 238, 44, { family: 'sans', size: 12, color: '#ffffff', align: 'right' });
    const actions = [...entry.damageByAction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    actions.forEach(([name, damage], index) => {
      const y = 69 + index * 15;
      s.text(name, 12, y, { family: 'sans', size: 10, color: '#ffffff', maxWidth: 132 });
      s.text(`${amount(damage)} - ${(damage / Math.max(1, entry.damage) * 100).toFixed(1)}%`, 238, y,
        { family: 'sans', size: 10, color: '#ffffff', align: 'right', maxWidth: 98 });
    });
  }

  private table() { return this.segment === 'current' ? this.current : this.overall; }
  private value(entry: MeterEntry) { return this.mode === 'dps' ? dps(entry) : entry.damage; }
  private rows() {
    if (!this.cachedRows || this.cachedMode !== this.mode || this.cachedSegment !== this.segment) {
      this.cachedRows = [...this.table().entries()].sort((a, b) => this.value(b[1]) - this.value(a[1])).slice(0, ROW_COUNT);
      this.cachedMode = this.mode; this.cachedSegment = this.segment;
    }
    return this.cachedRows;
  }
  private spellName(spellId: number) { return this.deps.resolveSpellName(spellId) ?? `Spell ${spellId}`; }
  private requestRender() { this.surface.requestRender(); this.detail.requestRender(); }
  private resetFight() { this.cachedRows = undefined; this.current.clear(); this.lastEventAt = 0; }
  private resetAll() { this.resetFight(); this.overall.clear(); this.deadByGuid.clear(); this.hoveredGuid = undefined; }
}
