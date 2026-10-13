import { QA_GLOBALS_ENABLED, qaGlobals } from '../qa-globals.ts';
/** Asset conversion utility. */
import type { CombatEvent, RealmWorldClient } from '../world';

const EVENT_CAP = 200;

const SPELL_EVENT_KINDS = new Set<CombatEvent['kind']>([
  'castSent', 'spellStart', 'spellGo', 'spellFailure', 'castResult', 'spellDelayed',
  'channelStart', 'channelUpdate', 'spellCooldown', 'cooldownEvent', 'clearCooldown',
  'spellDamage', 'spellHeal', 'spellEnergize', 'spellMiss', 'periodicAura',
]);

type SpellTrace = {
  sentAt?: number;
  targetGuid?: string;
  startAt?: number;
  castTimeMs?: number;
  goAt?: number;
  failure?: { at: number; reason: number; source: 'castResult' | 'spellFailure' };
  damage?: { at: number; amount: number; school: number };
  heal?: { at: number; amount: number; critical: boolean };
  miss?: { at: number; missInfo: number };
  cooldownMs?: number;
};

export type SpellVisualSummary = {
  visualId: number;
  precast: boolean; cast: boolean; impact: boolean; state: boolean; channel: boolean;
  missile: boolean; area: boolean;
  precastAnim: number; castAnim: number;
} | null;

export class SpellDebugTracker {
  private readonly events: { at: number; ev: CombatEvent }[] = [];
  private readonly traces = new Map<number, SpellTrace>();

  constructor(private readonly deps: {
    getWorld: () => RealmWorldClient | undefined;
    getSpellName: (spellId: number) => string;
    /** spells.json tuple; later columns include nested reagent pairs. */
    getSpellMetaEntry: (spellId: number) => readonly unknown[] | undefined;
    getBarActions: () => readonly ({ action: number; type: number } | null)[];
    getSpellVisualSummary: (spellId: number) => SpellVisualSummary | undefined;
  }) {}

  /** Feed from the same onCombat subscription that drives the UI. */
  record(ev: CombatEvent) {
    this.events.push({ at: Date.now(), ev });
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
    const spellId = 'spellId' in ev ? ev.spellId : undefined;
    if (spellId === undefined) return;
    const prior = this.traces.get(spellId);
    const at = Date.now();
    switch (ev.kind) {
      case 'castSent':
        this.traces.set(spellId, { sentAt: at, targetGuid: ev.targetGuid }); // new cast: fresh trace
        break;
      case 'spellStart':
        this.traces.set(spellId, { ...prior, startAt: at, castTimeMs: ev.castTimeMs });
        break;
      case 'spellGo':
        this.traces.set(spellId, { ...prior, goAt: at });
        break;
      case 'spellFailure':
        this.traces.set(spellId, { ...prior, failure: { at, reason: ev.reason, source: 'spellFailure' } });
        break;
      case 'castResult':
        if (!ev.success) this.traces.set(spellId, { ...prior, failure: { at, reason: ev.reason ?? 0, source: 'castResult' } });
        break;
      case 'spellDamage':
        this.traces.set(spellId, { ...prior, damage: { at, amount: ev.damage, school: ev.school } });
        break;
      case 'spellHeal':
        this.traces.set(spellId, { ...prior, heal: { at, amount: ev.amount, critical: ev.critical } });
        break;
      case 'spellMiss':
        this.traces.set(spellId, { ...prior, miss: { at, missInfo: ev.missInfo } });
        break;
      case 'spellCooldown':
        this.traces.set(spellId, { ...prior, cooldownMs: ev.cooldownMs });
        break;
      default:
        break;
    }
  }

  private barButtonFor(spellId: number) {
    const bar = this.deps.getBarActions();
    for (let slot = 0; slot < bar.length; slot++) {
      const b = bar[slot];
      if (b && b.type === 0x00 && b.action === spellId) return { slot, type: b.type };
    }
    return null;
  }

  spellSnapshot(spellId: number) {
    const meta = this.deps.getSpellMetaEntry(spellId);
    const attributes = Number(meta?.[5] ?? 0);
    const known = this.deps.getWorld()?.getKnownSpells().includes(spellId) ?? false;
    return {
      spellId,
      name: this.deps.getSpellName(spellId),
      known,
      actionButton: this.barButtonFor(spellId),
      meta: meta
        ? {
            rank: (meta[1] as string) || undefined,
            iconId: Number(meta[2] ?? 0),
            recoveryMs: Number(meta[3] ?? 0),
            gcdMs: Number(meta[4] ?? 0),
            passive: (attributes & 0x40) !== 0,
            hidden: (attributes & 0x80) !== 0,
          }
        : null,
      visual: this.deps.getSpellVisualSummary(spellId) ?? null,
      lastCast: this.traces.get(spellId) ?? null,
    };
  }

  knownSpellsSnapshot() {
    const known = this.deps.getWorld()?.getKnownSpells() ?? [];
    return known.map((id) => {
      const meta = this.deps.getSpellMetaEntry(id);
      const attributes = Number(meta?.[5] ?? 0);
      return {
        spellId: id,
        name: this.deps.getSpellName(id),
        rank: (meta?.[1] as string) || undefined,
        passive: (attributes & 0x40) !== 0,
        hidden: (attributes & 0x80) !== 0,
        onBar: this.barButtonFor(id) !== null,
        visualBaked: this.deps.getSpellVisualSummary(id) != null,
      };
    });
  }

  actionBarSnapshot() {
    return this.deps.getBarActions().map((b, slot) => {
      if (!b) return { slot, empty: true };
      return {
        slot,
        action: b.action,
        type: b.type === 0x00 ? 'spell' : b.type === 0x80 ? 'item' : b.type === 0x40 ? 'macro' : `0x${b.type.toString(16)}`,
        name: b.type === 0x00 ? this.deps.getSpellName(b.action) : undefined,
      };
    });
  }

  recentEvents(spellOnly = false, limit = 50) {
    const source = spellOnly ? this.events.filter((e) => SPELL_EVENT_KINDS.has(e.ev.kind)) : this.events;
    return source.slice(-limit).map(({ at, ev }) => ({ at: new Date(at).toISOString().slice(11, 23), ...ev }));
  }

  install() {
    if (!QA_GLOBALS_ENABLED) return;
    const g = qaGlobals;
    g.__wowCombatDebug = (limit = 50) => this.recentEvents(false, limit);
    g.__wowLastSpellPackets = (limit = 50) => this.recentEvents(true, limit);
    g.__wowKnownSpellsDebug = () => this.knownSpellsSnapshot();
    g.__wowActionBarDebug = () => this.actionBarSnapshot();
    g.__wowSpellDebug = (spellId: number) => this.spellSnapshot(spellId);
  }
}
