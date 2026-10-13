/** Asset conversion utility. */
export const hudTransformScale = (hud: HTMLElement): number => {
  const rect = hud.getBoundingClientRect();
  return rect.width > 0 && hud.offsetWidth > 0 ? rect.width / hud.offsetWidth : 1;
};

export const installDraggableFrames = (deps: {
  ingameHud: HTMLElement;
  panels: HTMLElement[];
  containerLayer: HTMLElement;
  draggedFramePositions: Map<string, { left: number; top: number }>;
}) => {
  let dragZ = 60;
  const beginFrameDrag = (panel: HTMLElement, event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, [data-action], [data-native-interactive], .wow-item-slot')) return;
    event.preventDefault();
    const hudRect = deps.ingameHud.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const scale = hudTransformScale(deps.ingameHud);
    const startX = event.clientX / scale;
    const startY = event.clientY / scale;
    const startLeft = (panelRect.left - hudRect.left) / scale;
    const startTop = (panelRect.top - hudRect.top) / scale;
    panel.style.left = `${startLeft}px`;
    panel.style.top = `${startTop}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.zIndex = String(++dragZ);
    panel.classList.add('is-dragging');
    panel.setPointerCapture(event.pointerId);
    const saveDraggedPosition = () => {
      const frameId = panel.dataset.frameId;
      if (!frameId) return;
      deps.draggedFramePositions.set(frameId, {
        left: Math.round(Number.parseFloat(panel.style.left || '0')),
        top: Math.round(Number.parseFloat(panel.style.top || '0')),
      });
    };
    const move = (moveEvent: PointerEvent) => {
      const maxLeft = Math.max(0, deps.ingameHud.offsetWidth - panel.offsetWidth);
      const maxTop = Math.max(0, deps.ingameHud.offsetHeight - panel.offsetHeight);
      const nextLeft = Math.max(0, Math.min(maxLeft, startLeft + moveEvent.clientX / scale - startX));
      const nextTop = Math.max(0, Math.min(maxTop, startTop + moveEvent.clientY / scale - startY));
      panel.style.left = `${Math.round(nextLeft)}px`;
      panel.style.top = `${Math.round(nextTop)}px`;
      saveDraggedPosition();
    };
    const up = (upEvent: PointerEvent) => {
      panel.classList.remove('is-dragging');
      saveDraggedPosition();
      panel.releasePointerCapture(upEvent.pointerId);
      panel.removeEventListener('pointermove', move);
      panel.removeEventListener('pointerup', up);
      panel.removeEventListener('pointercancel', up);
    };
    panel.addEventListener('pointermove', move);
    panel.addEventListener('pointerup', up);
    panel.addEventListener('pointercancel', up);
  };

  for (const panel of deps.panels) panel.addEventListener('pointerdown', (event) => beginFrameDrag(panel, event));
  deps.containerLayer.addEventListener('pointerdown', (event) => {
    const panel = (event.target as HTMLElement).closest<HTMLElement>('.wow-container-frame');
    if (panel) beginFrameDrag(panel, event);
  });
};

export const installGameTooltip = (deps: {
  ingameHud: HTMLElement;
  gameTooltip: HTMLElement;
  escapeHtml: (value: string) => string;
}) => {
  const positionTooltip = (event: PointerEvent) => {
    const margin = 8;
    const offset = 16;
    const rect = deps.gameTooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - rect.width - margin, event.clientX + offset);
    const top = Math.min(window.innerHeight - rect.height - margin, event.clientY + offset);
    deps.gameTooltip.style.left = `${Math.max(margin, left)}px`;
    deps.gameTooltip.style.top = `${Math.max(margin, top)}px`;
  };

  deps.ingameHud.addEventListener('pointerover', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-tooltip]');
    const text = target?.dataset.tooltip;
    if (!text) return;
    deps.gameTooltip.classList.remove('is-unit-default-anchor');
    deps.gameTooltip.innerHTML = text.split('\n').map((line, index) =>
      `<div class="${index === 0 ? 'wow-game-tooltip-name' : 'wow-game-tooltip-line'}">${deps.escapeHtml(line)}</div>`
    ).join('');
    deps.gameTooltip.classList.remove('is-hidden');
    positionTooltip(event);
  });

  deps.ingameHud.addEventListener('pointermove', (event) => {
    if (!deps.gameTooltip.classList.contains('is-hidden')) positionTooltip(event);
  });

  deps.ingameHud.addEventListener('pointerout', (event) => {
    if (!(event.target as HTMLElement).closest('[data-tooltip]')) return;
    deps.gameTooltip.classList.add('is-hidden');
  });

  return { positionTooltip };
};

export const installHudKeybindings = (deps: {
  isBlocked: (target: EventTarget | null) => boolean;
  hasCharacter: () => boolean;
  toggleCharacter: () => void;
  toggleBackpack: (allBags: boolean) => void;
  toggleKeyring: () => void;
  toggleWorldMap: () => void;
  toggleSpellbook: () => void;
  toggleSocial: () => void;
  commandFor?: (event: KeyboardEvent) => 'character' | 'backpack' | 'keyring' | 'world' | 'spellbook' | 'social' | undefined;
}) => {
  window.addEventListener('keydown', (e) => {
    if (deps.isBlocked(e.target)) return;
    const command = deps.commandFor?.(e);
    if (command === 'character' || (!deps.commandFor && e.code === 'KeyC')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (deps.hasCharacter()) deps.toggleCharacter();
      return;
    }
    if (command === 'backpack' || (!deps.commandFor && e.code === 'KeyB')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!deps.hasCharacter()) return;
      deps.toggleBackpack(e.shiftKey);
      return;
    }
    if (command === 'keyring') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (deps.hasCharacter()) deps.toggleKeyring();
      return;
    }
    if (command === 'world' || (!deps.commandFor && e.code === 'KeyM')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!deps.hasCharacter()) return;
      deps.toggleWorldMap();
      return;
    }
    if (command === 'spellbook' || (!deps.commandFor && e.code === 'KeyP')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (deps.hasCharacter()) deps.toggleSpellbook();
      return;
    }
    if (command === 'social' || (!deps.commandFor && e.code === 'KeyO')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (deps.hasCharacter()) deps.toggleSocial();
    }
  });
};
