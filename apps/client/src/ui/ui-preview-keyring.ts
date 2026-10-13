import { BagCanvasPanel } from './bag-canvas';
import { StackSplitCanvasPanel } from './stack-split-frame';

const KEYS = [
  ['The Scarlet Key', 'INV_Misc_Key_01', 1],
  ['Workshop Key', 'INV_Misc_Key_06', 1],
  ['Skeleton Key', 'INV_Misc_Key_10', 4],
] as const;

/** Offline level-60 keyring: twelve slots, exact -Keyring atlas, and both Shift split gestures. */
export function showKeyringPreview(hud: HTMLElement) {
  const layer = hud.querySelector<HTMLElement>('#wow-container-layer')!;
  const host = document.createElement('section');
  host.className = 'wow-container-frame has-canvas-ui is-keyring';
  host.style.cssText = 'right:40px;bottom:70px;width:192px;height:177px;';
  layer.appendChild(host);
  const split = new StackSplitCanvasPanel(hud, { playUi: () => {} });
  new BagCanvasPanel(host, {
    bagId: -2,
    name: 'Keyring',
    slotCount: 12,
    isKeyring: true,
    items: KEYS.map(([name, icon, count], slot) => ({
      slot,
      iconUrl: `/ui/Interface/Icons/${icon}.png`,
      count,
      tooltip: [{ text: name, color: '#ffffff' }],
    })),
    emptySlotTooltip: (slot) => [{ text: `Keyring ${slot + 1}`, color: '#ffd100' }],
  }, {
    onSlotActivate: (action) => {
      if (action.shiftKey && !action.ctrlKey && (action.item?.count ?? 0) > 1) {
        split.show(action.item!.count!, () => {}, action.anchor);
      }
    },
  });
  return true;
}
