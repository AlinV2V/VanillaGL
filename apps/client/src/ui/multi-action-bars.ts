/** Asset conversion utility. */
import type { CanvasRect } from './vanilla-canvas';

export type MultiBarId = 'bottomLeft' | 'bottomRight';

/** MultiActionBars.lua:1 */
export const NUM_MULTIBAR_BUTTONS = 12;
/** ActionButtonTemplate.xml:4-6 */
export const MULTIBAR_BUTTON_SIZE = 36;
/** 36 wide + the 6px LEFT@RIGHT offset every button after the first carries. */
export const MULTIBAR_BUTTON_PITCH = MULTIBAR_BUTTON_SIZE + 6;
/** MultiActionBars.xml:37-39 — the declared frame box, 2px taller than its buttons. */
export const MULTIBAR_FRAME_WIDTH = 500;
export const MULTIBAR_FRAME_HEIGHT = 38;
/** MultiActionBars.xml:498-502 — BOTTOMLEFT of the bar to TOPLEFT of ActionButton1. */
export const MULTIBAR_ABOVE_ACTION_BUTTON = 17;
/** MultiActionBars.xml:507-511 — LEFT of BottomRight to RIGHT of BottomLeft. */
export const MULTIBAR_BOTTOMRIGHT_GAP = 10;

/** ActionButton.lua:2 */
export const NUM_ACTIONBAR_PAGES = 6;
/** ActionButton.lua:3 */
export const NUM_ACTIONBAR_BUTTONS = 12;

/**
 * One-based action-bar page each multibar draws, per ActionButton.lua:6-9.
 * `ActionButton_GetPagedID` (ActionButton.lua:457-463) then resolves a button to
 * `id + (page - 1) * NUM_ACTIONBAR_BUTTONS`.
 */
export const MULTIBAR_ACTION_PAGE = {
  bottomLeft: 6,
  bottomRight: 5,
  /** Not drawn yet — see the header. Kept so the page rotation below stays honest. */
  right: 3,
  left: 4,
} as const;

export const MULTI_BAR_IDS: readonly MultiBarId[] = ['bottomLeft', 'bottomRight'];

/** Zero-based offset of a multibar's first slot in the flat SMSG_ACTION_BUTTONS array. */
export const multiBarActionOffset = (id: MultiBarId) =>
  (MULTIBAR_ACTION_PAGE[id] - 1) * NUM_ACTIONBAR_BUTTONS;

export type MultiBarVisibility = Record<MultiBarId, boolean>;

export const NO_MULTI_BARS: MultiBarVisibility = { bottomLeft: false, bottomRight: false };

/**
 * Button rectangles for one horizontal multibar.
 *
 * `actionButton1` is the main bar's first button rect in canvas pixels — the XML anchors the whole
 * bar to it, so passing it keeps the two in lockstep if the main bar ever moves. The returned row
 * sits `MULTIBAR_ABOVE_ACTION_BUTTON` above that button's top edge, and the buttons hang from the
 * bottom of the 38px frame because `$parentButton1` anchors BOTTOMLEFT.
 */
export function multiBarButtonRects(id: MultiBarId, actionButton1: CanvasRect): CanvasRect[] {
  const frameBottom = actionButton1.y - MULTIBAR_ABOVE_ACTION_BUTTON;
  const y = frameBottom - MULTIBAR_BUTTON_SIZE;
  const x0 = id === 'bottomLeft'
    ? actionButton1.x
    : actionButton1.x + MULTIBAR_FRAME_WIDTH + MULTIBAR_BOTTOMRIGHT_GAP;
  return Array.from({ length: NUM_MULTIBAR_BUTTONS }, (_, index) => ({
    x: x0 + index * MULTIBAR_BUTTON_PITCH,
    y,
    width: MULTIBAR_BUTTON_SIZE,
    height: MULTIBAR_BUTTON_SIZE,
  }));
}

/** Topmost canvas row any visible multibar occupies, for sizing the surface. */
export function multiBarTopExtent(actionButton1: CanvasRect): number {
  return actionButton1.y - MULTIBAR_ABOVE_ACTION_BUTTON - MULTIBAR_BUTTON_SIZE;
}

/**
 * `VIEWABLE_ACTION_BAR_PAGES` (ActionButton.lua:13), one-based, as MultiActionBar_Update maintains
 * it: a page whose multibar is SHOWING is drawn by that bar, so the main bar must skip it
 * (MultiActionBars.lua:50-79 sets the entry to nil when the bar is shown, 1 when hidden).
 */
export function viewableActionBarPages(visible: MultiBarVisibility): boolean[] {
  const pages = Array.from({ length: NUM_ACTIONBAR_PAGES }, () => true);
  for (const id of MULTI_BAR_IDS) {
    if (visible[id]) pages[MULTIBAR_ACTION_PAGE[id] - 1] = false;
  }
  return pages;
}

/**
 * ActionBar_PageUp / ActionBar_PageDown (ActionButton.lua:63-101), one-based in and out.
 *
 * Up scans forward for the next viewable page and wraps to 1 when it runs off the end — note that
 * vanilla wraps to page 1 unconditionally there, without re-checking viewability, because page 1
 * has no multibar and is therefore always viewable. Down scans backward, then wraps by scanning
 * from the last page down.
 */
export function nextViewableActionPage(
  current: number,
  direction: 'up' | 'down',
  visible: MultiBarVisibility,
): number {
  const viewable = viewableActionBarPages(visible);
  if (direction === 'up') {
    for (let page = current + 1; page <= NUM_ACTIONBAR_PAGES; page++) {
      if (viewable[page - 1]) return page;
    }
    return 1;
  }
  for (let page = current - 1; page >= 1; page--) {
    if (viewable[page - 1]) return page;
  }
  for (let page = NUM_ACTIONBAR_PAGES; page >= 1; page--) {
    if (viewable[page - 1]) return page;
  }
  return current;
}
