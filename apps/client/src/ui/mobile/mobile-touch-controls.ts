import { LegacyGameCommandAdapter } from '../../input/legacy-game-command-adapter';
import type { PerformanceProfile } from '../../platform/performance-profile';
import type { GameCommand, MoveIntent } from '../../simulation/commands';
import { VanillaCanvas } from '../vanilla-canvas';
import { installMobileCanvasKeyboardBridge } from './mobile-canvas-keyboard';
import { installMobileLandscapeChatToggle } from './mobile-chat-toggle';
import { MobileActionDrag } from './mobile-action-drag';
import {
  drawMobileMovement,
  drawMobileUtilities,
  MOBILE_ACTION_HEIGHT,
  MOBILE_ACTION_WIDTH,
  MOBILE_MOVE_SIZE,
  MOBILE_UTILITY_HEIGHT,
  MOBILE_UTILITY_WIDTH,
  mobileMoveIntentAt,
  mobileUtilityTargetAt,
  type MobileActionTarget,
  type MobileUtilityTarget,
} from './mobile-control-art';

const ZERO_MOVE: MoveIntent = { forward: 0, strafe: 0, turn: 0 };
const WORLD_STATE_ATTRIBUTE = 'data-vanillagl-world-state';

const emitUiKey = (code: string, down: boolean) => {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
    code,
    key: code === 'Escape' ? 'Escape' : code.replace(/^Key/, '').toLowerCase(),
    bubbles: true,
    cancelable: true,
  }));
};

const gameCommand = (target: MobileActionTarget, pressed: boolean): GameCommand => {
  switch (target.kind) {
    case 'action': return { kind: 'use-action-slot', slot: target.slot, pressed };
    case 'jump': return { kind: 'jump', pressed };
    case 'target': return { kind: 'target-next', pressed };
  }
};

function prepareSurface(surface: VanillaCanvas, label: string) {
  surface.canvas.style.removeProperty('width');
  surface.canvas.style.removeProperty('height');
  surface.canvas.setAttribute('role', 'application');
  surface.canvas.setAttribute('aria-label', label);
  surface.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  return surface;
}

function hasBlockingScreen() {
  const glue = document.getElementById('glue-overlay');
  const glueVisible = !!glue && getComputedStyle(glue).display !== 'none';
  return glueVisible || !!document.querySelector('#map-loading-screen, .wow-disconnect-overlay');
}

const nodeMatches = (node: Node, selector: string) =>
  node instanceof Element && (node.matches(selector) || !!node.querySelector(selector));

export function installMobileTouchControls(profile: PerformanceProfile): () => void {
  if (!profile.device.mobile || typeof document === 'undefined') return () => {};
  if (document.querySelector('.vanillagl-mobile-controls')) return () => {};

  const html = document.documentElement;
  html.classList.add('vanillagl-touch-device', 'vanillagl-mobile');
  html.classList.toggle('vanillagl-phone', profile.device.kind === 'phone');
  html.classList.toggle('vanillagl-tablet', profile.device.kind === 'tablet');

  const cleanupTextInput = installMobileCanvasKeyboardBridge();
  const gameCommands = new LegacyGameCommandAdapter();
  const root = document.createElement('div');
  root.className = 'vanillagl-mobile-controls';
  root.setAttribute('aria-label', 'Mobile game controls');
  root.setAttribute('aria-hidden', 'true');
  root.hidden = true;

  const movement = prepareSurface(
    new VanillaCanvas(MOBILE_MOVE_SIZE, MOBILE_MOVE_SIZE, 'vanillagl-mobile-stick'),
    'Movement control',
  );
  const actions = prepareSurface(
    new VanillaCanvas(MOBILE_ACTION_WIDTH, MOBILE_ACTION_HEIGHT, 'vanillagl-mobile-actions'),
    'Action buttons one through six, jump, and target',
  );
  const utility = prepareSurface(
    new VanillaCanvas(MOBILE_UTILITY_WIDTH, MOBILE_UTILITY_HEIGHT, 'vanillagl-mobile-utility'),
    'Backpack, world map, spellbook, and game menu',
  );
  root.append(movement.canvas, actions.canvas, utility.canvas);
  const cleanupChatToggle = installMobileLandscapeChatToggle(root, profile);
  document.body.appendChild(root);

  let movePointer: number | null = null;
  let moveIntent = ZERO_MOVE;
  const actionDrag = new MobileActionDrag(actions, (target, down) => gameCommands.dispatch(gameCommand(target, down)));
  const heldUtilities = new Map<number, MobileUtilityTarget>();
  const pressedUtilities = new Set<string>();

  movement.onRender(() => drawMobileMovement(movement, moveIntent));
  actions.onRender(() => actionDrag.draw());
  utility.onRender(() => drawMobileUtilities(utility, pressedUtilities));

  const setMove = (intent: MoveIntent) => {
    moveIntent = intent;
    gameCommands.dispatch({ kind: 'move', intent });
    movement.requestRender();
  };
  const resetMove = () => {
    movePointer = null;
    setMove(ZERO_MOVE);
  };

  movement.canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (movePointer !== null) return;
    movePointer = event.pointerId;
    movement.canvas.setPointerCapture?.(event.pointerId);
    setMove(mobileMoveIntentAt(movement.point(event)));
  });
  movement.canvas.addEventListener('pointermove', (event) => {
    if (movePointer !== event.pointerId) return;
    event.preventDefault();
    setMove(mobileMoveIntentAt(movement.point(event)));
  });
  const releaseMove = (event: PointerEvent) => {
    if (movePointer !== event.pointerId) return;
    event.preventDefault();
    resetMove();
  };
  movement.canvas.addEventListener('pointerup', releaseMove);
  movement.canvas.addEventListener('pointercancel', releaseMove);

  utility.canvas.addEventListener('pointerdown', (event) => {
    const target = mobileUtilityTargetAt(utility.point(event));
    if (!target) return;
    event.preventDefault();
    utility.canvas.setPointerCapture?.(event.pointerId);
    heldUtilities.set(event.pointerId, target);
    pressedUtilities.add(target.code);
    emitUiKey(target.code, true);
    utility.requestRender();
  });
  const releaseUtility = (event: PointerEvent) => {
    const target = heldUtilities.get(event.pointerId);
    if (!target) return;
    event.preventDefault();
    heldUtilities.delete(event.pointerId);
    pressedUtilities.delete(target.code);
    emitUiKey(target.code, false);
    utility.requestRender();
  };
  utility.canvas.addEventListener('pointerup', releaseUtility);
  utility.canvas.addEventListener('pointercancel', releaseUtility);

  const releaseAll = () => {
    resetMove();
    actionDrag.cancel();
    heldUtilities.forEach((target) => emitUiKey(target.code, false));
    heldUtilities.clear();
    pressedUtilities.clear();
    gameCommands.releaseAll();
    actions.requestRender();
    utility.requestRender();
  };

  const syncLifecycle = () => {
    const worldActive = html.getAttribute(WORLD_STATE_ATTRIBUTE) === 'active';
    const show = worldActive && !hasBlockingScreen();
    if (!show && !root.hidden) releaseAll();
    root.hidden = !show;
    root.setAttribute('aria-hidden', String(!show));
    if (show) {
      movement.requestRender();
      actions.requestRender();
      utility.requestRender();
    }
  };

  const observer = new MutationObserver((mutations) => {
    let lifecycleChanged = false;
    let actionsChanged = false;
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (mutation.type === 'attributes') {
        lifecycleChanged ||= (target === html && mutation.attributeName === WORLD_STATE_ATTRIBUTE)
          || target?.matches('#glue-overlay') === true;
      } else if (mutation.type === 'childList') {
        const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
        lifecycleChanged ||= changedNodes.some((node) => nodeMatches(node, '#map-loading-screen, .wow-disconnect-overlay'));
        actionsChanged ||= changedNodes.some((node) => nodeMatches(node, '#wow-action-bar, .wow-action-button'));
      }
      actionsChanged ||= !!target?.closest('#wow-action-bar');
    }
    if (lifecycleChanged) syncLifecycle();
    if (actionsChanged && !root.hidden) actions.requestRender();
  });
  observer.observe(html, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', WORLD_STATE_ATTRIBUTE],
  });

  syncLifecycle();
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', releaseAll);

  return () => {
    releaseAll();
    observer.disconnect();
    cleanupChatToggle();
    cleanupTextInput();
    actionDrag.destroy();
    window.removeEventListener('blur', releaseAll);
    document.removeEventListener('visibilitychange', releaseAll);
    root.remove();
  };
}
