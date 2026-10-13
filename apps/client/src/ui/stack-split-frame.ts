/** Asset conversion utility. */
import { CanvasPanel, type PanelHit } from './panel-kit';
import type { CanvasRect } from './vanilla-canvas';

const WIDTH = 172;
const HEIGHT = 96;
const LAYOUT = {
  left: { x: 11, y: 22, width: 16, height: 16 },
  right: { x: 150, y: 22, width: 16, height: 16 },
  okay: { x: 19, y: 52, width: 64, height: 24 },
  cancel: { x: 91, y: 52, width: 64, height: 24 },
} as const;

export type StackSplitAnchor = {
  left: number;
  right: number;
  top: number;
  /** Which owner edge receives the matching bottom edge of StackSplitFrame. */
  align: 'left' | 'right';
};

type ParentBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
};

/** Convert FrameXML owner anchoring from viewport pixels into the scaled HUD's layout space. */
export const stackSplitPosition = (anchor: StackSplitAnchor, parent: ParentBounds) => {
  const scaleX = parent.width / Math.max(1, parent.clientWidth);
  const scaleY = parent.height / Math.max(1, parent.clientHeight);
  const ownerX = (anchor.align === 'right' ? anchor.right : anchor.left) - parent.left;
  return {
    left: Math.round(ownerX / Math.max(Number.EPSILON, scaleX) - (anchor.align === 'right' ? WIDTH : 0)),
    top: Math.round((anchor.top - parent.top) / Math.max(Number.EPSILON, scaleY) - HEIGHT),
  };
};

/** Resolve one logical canvas hit to the viewport rectangle used by FrameXML-style anchoring. */
export const stackSplitAnchorFromCanvas = (
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  canvasWidth: number,
  canvasHeight: number,
  rect: CanvasRect,
  align: StackSplitAnchor['align'],
): StackSplitAnchor => {
  const scaleX = bounds.width / Math.max(1, canvasWidth);
  const scaleY = bounds.height / Math.max(1, canvasHeight);
  return {
    left: bounds.left + rect.x * scaleX,
    right: bounds.left + (rect.x + rect.width) * scaleX,
    top: bounds.top + rect.y * scaleY,
    align,
  };
};

export type StackSplitState = { maxStack: number; split: number; typing: boolean };

export const initialStackSplit = (maxStack: number): StackSplitState => ({
  maxStack: Math.max(1, Math.floor(Number.isFinite(maxStack) ? maxStack : 1)),
  split: 1,
  typing: false,
});

export function typeStackSplitDigit(state: StackSplitState, char: string): StackSplitState {
  if (!/^\d$/.test(char)) return state;
  const base = state.typing ? state.split : 0;
  const split = (base * 10) + Number(char);
  // StackSplitFrame.lua sets typing before it handles a leading zero, so the next digit appends
  // to the visible fallback value one (typing 0 then 5 yields 15, not 5).
  if (split === 0) return { ...state, split: 1, typing: true };
  if (split > state.maxStack) return split === 0 ? { ...state, split: 1 } : state;
  return { ...state, split, typing: true };
}

export function backspaceStackSplit(state: StackSplitState): StackSplitState {
  if (!state.typing || state.split === 1) return state;
  const split = Math.floor(state.split / 10);
  return { ...state, split: Math.max(1, split), typing: split > 1 };
}

export const stepStackSplit = (state: StackSplitState, delta: -1 | 1): StackSplitState => ({
  ...state,
  split: Math.max(1, Math.min(state.maxStack, state.split + delta)),
});

export class StackSplitCanvasPanel extends CanvasPanel {
  private readonly host: HTMLElement;
  private readonly parent: HTMLElement;
  private stateValue = initialStackSplit(1);
  private onSplit?: (count: number) => void;

  constructor(parent: HTMLElement, deps: { playUi: (name: string) => void }) {
    const host = document.createElement('div');
    host.className = 'wow-native-frame wow-stack-split-frame is-hidden';
    parent.appendChild(host);
    super(host, WIDTH, HEIGHT, 'wow-native-panel-canvas', deps);
    this.host = host;
    this.parent = parent;
    this.surface.canvas.addEventListener('keydown', (event) => {
      if (event.key === 'Delete' && this.isOpen()) {
        this.stateValue = backspaceStackSplit(this.stateValue);
        this.surface.requestRender();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : 0;
      if (!delta || !this.isOpen()) return;
      this.stateValue = stepStackSplit(this.stateValue, delta);
      this.surface.requestRender();
      event.preventDefault();
      event.stopImmediatePropagation();
    });
  }

  show(maxStack: number, onSplit: (count: number) => void, anchor?: StackSplitAnchor) {
    this.stateValue = initialStackSplit(maxStack);
    if (this.stateValue.maxStack < 2) { this.hide(); return; }
    this.onSplit = onSplit;
    if (anchor) {
      const bounds = this.parent.getBoundingClientRect();
      const position = stackSplitPosition(anchor, {
        left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
        clientWidth: this.parent.clientWidth, clientHeight: this.parent.clientHeight,
      });
      this.host.style.left = `${position.left}px`;
      this.host.style.top = `${position.top}px`;
      this.host.style.transform = 'none';
    } else {
      this.host.style.removeProperty('left');
      this.host.style.removeProperty('top');
      this.host.style.removeProperty('transform');
    }
    this.host.classList.remove('is-hidden');
    this.focusField('amount');
  }

  hide() {
    this.onSplit = undefined;
    this.focusField(undefined);
    this.host.classList.add('is-hidden');
  }

  isOpen() { return !this.host.classList.contains('is-hidden'); }

  protected paint() {
    const s = this.surface;
    s.clear();
    // The power-of-two PNG is 256x128; FrameXML's TexCoords select its 172x96 painted region.
    s.spriteFraction('/ui/Interface/MoneyFrame/UI-MoneyFrame.png', 0, 0, 0.671875, 0.75, 0, 0, 172, 96);
    s.text(String(this.stateValue.split), 122, 30, { size: 12, color: '#ffffff', align: 'right', baseline: 'middle' });

    const leftDisabled = this.stateValue.split === 1;
    const rightDisabled = this.stateValue.split === this.stateValue.maxStack;
    this.arrow('left', LAYOUT.left, leftDisabled);
    this.arrow('right', LAYOUT.right, rightDisabled);
    const okay = LAYOUT.okay;
    const cancel = LAYOUT.cancel;
    s.panelButton('Okay', okay, this.state('okay'));
    s.panelButton('Cancel', cancel, this.state('cancel'));
    this.hit('okay', okay);
    this.hit('cancel', cancel);
  }

  private arrow(id: 'left' | 'right', rect: CanvasRect, disabled: boolean) {
    const state = disabled ? 'Disabled' : this.isPressed(id) ? 'Down' : 'Up';
    this.surface.image(`/ui/Interface/MoneyFrame/Arrow-${id === 'left' ? 'Left' : 'Right'}-${state}.png`, rect.x, rect.y, rect.width, rect.height);
    this.hit(id, rect, { disabled });
  }

  protected onFieldKey = (_field: string, key: 'char' | 'backspace' | 'enter' | 'escape' | 'tab', char?: string) => {
    if (key === 'char') this.stateValue = typeStackSplitDigit(this.stateValue, char ?? '');
    else if (key === 'backspace') this.stateValue = backspaceStackSplit(this.stateValue);
    else if (key === 'enter') this.submit();
    else if (key === 'escape') this.hide();
  };

  protected activate(hit: PanelHit) {
    if (hit.id === 'left') this.stateValue = stepStackSplit(this.stateValue, -1);
    else if (hit.id === 'right') this.stateValue = stepStackSplit(this.stateValue, 1);
    else if (hit.id === 'okay') this.submit();
    else if (hit.id === 'cancel') this.hide();
  }

  private submit() {
    const callback = this.onSplit;
    const count = this.stateValue.split;
    callback?.(count);
    this.hide();
  }
}
