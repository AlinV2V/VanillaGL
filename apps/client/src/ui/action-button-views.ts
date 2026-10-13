/** Asset conversion utility. */
import type { ActionButton, ItemInfo } from '../world';
import type { MainMenuActionView, MainMenuMultiBarView } from './main-menu-bar-canvas';
import {
  MULTI_BAR_IDS,
  multiBarActionOffset,
  NUM_MULTIBAR_BUTTONS,
  type MultiBarId,
  type MultiBarVisibility,
} from './multi-action-bars';

export type ActionViewDeps = {
  /** spells.json field 2 — the SpellIcon.dbc row the button draws. */
  spellIconId: (spellId: number) => number | undefined;
  /** Server-advised usability plus an open reaction window (Overpower, Riposte, ...). */
  readiness: (spellId: number) => { usable: boolean; reactive: boolean };
  /** Remaining/total cooldown for a spell, or undefined when it is ready. */
  cooldown: (spellId: number, now: number) => { remainingMs: number; durationMs: number } | undefined;
  itemInfo: (entry: number) => ItemInfo | undefined;
  itemIconUrl: (displayInfoId: number | undefined, entry: number) => string;
  itemCount: (entry: number) => number | undefined;
  hotkey: (slot: number, bar?: MultiBarId) => string | undefined;
  queuedMeleeSpellId: number;
  autoAttacking: boolean;
  attackSpellId: number;
  attackIconId: number;
  spellActionType: number;
  itemActionType: number;
};

/**
 * One button's view. `cell` is the legacy DOM button for the main bar, which still owns the
 * out-of-range tint and the drop highlight; multibar slots have no DOM twin and pass undefined.
 */
export function actionButtonView(
  button: ActionButton | null | undefined,
  slot: number,
  deps: ActionViewDeps,
  now: number,
  cell?: HTMLElement,
  bar?: MultiBarId,
): MainMenuActionView {
  let iconUrl: string | undefined;
  let count: number | undefined;
  let cooldown: MainMenuActionView['cooldown'];
  let usable = true;
  let reactive = false;

  if (button?.type === deps.spellActionType) {
    const iconId = button.action === deps.attackSpellId ? deps.attackIconId : deps.spellIconId(button.action);
    if (iconId) iconUrl = `/spells/icons/${iconId}.png`;
    const state = deps.readiness(button.action);
    usable = state.usable;
    reactive = state.reactive;
    const active = deps.cooldown(button.action, now);
    if (active && active.remainingMs > 0) cooldown = active;
  } else if (button?.type === deps.itemActionType) {
    iconUrl = deps.itemIconUrl(deps.itemInfo(button.action)?.displayInfoId, button.action) || undefined;
    count = deps.itemCount(button.action);
  }

  return {
    slot,
    iconUrl,
    hotkey: deps.hotkey(slot, bar),
    count,
    enabled: !!button,
    usable,
    reactive,
    queued: button?.type === deps.spellActionType && button.action === deps.queuedMeleeSpellId,
    activeAttack: button?.type === deps.spellActionType
      && button.action === deps.attackSpellId
      && deps.autoAttacking,
    outOfRange: cell?.classList.contains('is-out-of-range') ?? false,
    dropState: cell?.classList.contains('is-drop-valid')
      ? 'valid'
      : cell?.classList.contains('is-drop-invalid') ? 'invalid' : 'none',
    cooldown,
  };
}

/**
 * Views for both horizontal multibars.
 *
 * Unlike the main bar these are NOT paged: MultiBarBottomLeft always draws page 6 and
 * MultiBarBottomRight always page 5 (ActionButton.lua:6-7 via ActionButton_GetPagedID at :457-459),
 * so they read straight out of the flat SMSG_ACTION_BUTTONS array at a fixed offset. A hidden bar
 * builds no views at all.
 */
export function multiBarActionViews(
  allActions: readonly ActionButton[],
  visible: MultiBarVisibility,
  deps: ActionViewDeps,
  now: number,
): MainMenuMultiBarView {
  const actions: MainMenuMultiBarView['actions'] = {};
  for (const id of MULTI_BAR_IDS) {
    if (!visible[id]) continue;
    const offset = multiBarActionOffset(id);
    actions[id] = Array.from({ length: NUM_MULTIBAR_BUTTONS }, (_, slot) =>
      actionButtonView(allActions[offset + slot], slot, deps, now, undefined, id));
  }
  return { visible, actions };
}
