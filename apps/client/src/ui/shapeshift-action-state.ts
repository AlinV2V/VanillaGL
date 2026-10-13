import type { MainMenuShapeshiftView } from './main-menu-bar-model';
import { spellButtonTooltip } from './action-tooltip';
import { activeShapeshiftAttackIcon, collectShapeshiftForms, SHAPESHIFT_META } from './shapeshift-forms';
export { AQUATIC_FORM_ID, SHAPESHIFT_META } from './shapeshift-forms';

type MetaEntry = ReadonlyArray<unknown>;
type Cooldown = { start: number; durationMs: number } | undefined;

/** Runtime adapter for the native Get*ShapeshiftForm/CastShapeshiftForm UI contract. */
export class ShapeshiftActionState {
  constructor(private readonly deps: {
    knownSpellIds: () => readonly number[];
    auraSpellIds: () => readonly number[];
    meta: (spellId: number) => MetaEntry | undefined;
    usability: (spellId: number) => { usable: boolean };
    cooldown: (spellId: number, now: number) => Cooldown;
    cast: (spellId: number) => void;
  }) {}

  private forms() {
    return collectShapeshiftForms(
      this.deps.knownSpellIds(), this.deps.auraSpellIds(), this.deps.meta,
    );
  }

  attackIconId(fallback: number) {
    return activeShapeshiftAttackIcon(this.deps.auraSpellIds(), this.deps.meta) ?? fallback;
  }

  bonusActionBar(spellId: number) {
    return Number(this.deps.meta(spellId)?.[SHAPESHIFT_META.bonusActionBar]) || 0;
  }

  views(now = performance.now()): MainMenuShapeshiftView[] {
    return this.forms().map((form, slot) => {
      const active = this.deps.cooldown(form.spellId, now);
      return {
        slot, spellId: form.spellId, name: form.name,
        iconUrl: `/spells/icons/${form.iconId}.png`, active: form.active,
        usable: this.deps.usability(form.spellId).usable,
        cooldown: active ? {
          remainingMs: Math.max(0, active.start + active.durationMs - now),
          durationMs: active.durationMs,
        } : undefined,
      };
    });
  }

  use(slot: number) {
    const form = this.forms()[slot];
    if (form) this.deps.cast(form.spellId);
  }

  tooltip(slot: number) {
    const form = this.forms()[slot];
    return form ? spellButtonTooltip(form.spellId, this.deps.meta(form.spellId), form.name) : undefined;
  }
}
