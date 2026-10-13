/** Asset conversion utility. */
import { getInterfaceCvars } from './interface-runtime';
import type { InterfaceCvars } from './interface-cvars';
import type { MultiBarVisibility } from './multi-action-bars';

export const ACTION_BAR_TOGGLE_BITS: ReadonlyArray<{ key: keyof InterfaceCvars; bit: number }> = [
  { key: 'showBottomLeftActionBar', bit: 0x01 },
  { key: 'showBottomRightActionBar', bit: 0x02 },
  { key: 'showRightActionBar', bit: 0x04 },
  { key: 'showRightActionBar2', bit: 0x08 },
];

/** The u8 payload for CMSG_SET_ACTIONBAR_TOGGLES. */
export function actionBarToggleMask(cvars: InterfaceCvars): number {
  let mask = 0;
  for (const { key, bit } of ACTION_BAR_TOGGLE_BITS) {
    if (Number(cvars[key]) === 1) mask |= bit;
  }
  return mask & 0xff;
}

/**
 * Which horizontal multibars are showing, for the renderer.
 *
 * These two cvars already existed and already reached the server through the toggle byte above, but
 * nothing read them back to actually draw a bar — the options checkboxes were inert. This is the
 * read side, and it is the direct analogue of MultiActionBars.lua:50-65, where SHOW_MULTI_ACTIONBAR_1
 * shows MultiBarBottomLeft and SHOW_MULTI_ACTIONBAR_2 shows MultiBarBottomRight.
 */
export function multiBarVisibility(cvars: InterfaceCvars = getInterfaceCvars()): MultiBarVisibility {
  return {
    bottomLeft: Number(cvars.showBottomLeftActionBar) === 1,
    bottomRight: Number(cvars.showBottomRightActionBar) === 1,
  };
}

/**
 * "Lock ActionBars" — with bars locked a button cannot be dragged off, which is the whole
 * point of the option (it exists to stop you flinging spells off the bar mid-fight).
 * Placing onto a locked bar is blocked for the same reason.
 */
export function areActionBarsLocked(): boolean {
  return Number(getInterfaceCvars().lockActionBars) === 1;
}
