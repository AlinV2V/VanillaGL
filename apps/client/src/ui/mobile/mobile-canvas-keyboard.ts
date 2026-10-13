import { CanvasPanel } from '../panel-kit';

type FieldKey = 'char' | 'backspace' | 'enter' | 'escape' | 'tab';
type CanvasPanelRuntime = CanvasPanel & {
  focusedField?: string;
  onFieldKey?: (field: string, key: FieldKey, char?: string) => void;
  surface: { requestRender: () => void };
};

let installed = false;
let originalFocusField: ((this: CanvasPanelRuntime, field: string | undefined) => void) | undefined;
const proxies = new Set<HTMLInputElement>();
const proxyForPanel = new WeakMap<object, HTMLInputElement>();

const isMobileUi = () => document.documentElement.classList.contains('vanillagl-mobile');

function send(panel: CanvasPanelRuntime, key: FieldKey, char?: string) {
  const field = panel.focusedField;
  if (!field || !panel.onFieldKey) return;
  panel.onFieldKey(field, key, char);
  panel.surface.requestRender();
}

function ensureProxy(panel: CanvasPanelRuntime) {
  const cached = proxyForPanel.get(panel);
  if (cached) return cached;

  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'text';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.className = 'vanillagl-mobile-keyboard-proxy';
  input.setAttribute('aria-label', 'Game text input');

  // 16px prevents Safari's automatic zoom-on-focus. Keep a one-character sentinel so
  // deleteContentBackward still fires reliably even though the actual value lives in CanvasPanel.
  const resetSentinel = () => {
    input.value = '\u200b';
    try { input.setSelectionRange(1, 1); } catch { /* unsupported selection API */ }
  };
  resetSentinel();

  input.addEventListener('focus', resetSentinel);
  input.addEventListener('beforeinput', (event) => {
    if (!isMobileUi() || !panel.focusedField || !panel.onFieldKey) return;
    const e = event as InputEvent;
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward') {
      event.preventDefault();
      send(panel, 'backspace');
      resetSentinel();
      return;
    }
    if (e.inputType.startsWith('insert') && e.data) {
      event.preventDefault();
      for (const char of Array.from(e.data)) send(panel, 'char', char);
      resetSentinel();
    }
  });
  input.addEventListener('keydown', (event) => {
    if (!panel.focusedField) return;
    let key: FieldKey | undefined;
    if (event.key === 'Enter') key = 'enter';
    else if (event.key === 'Escape') key = 'escape';
    else if (event.key === 'Tab') key = 'tab';
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    send(panel, key);
    resetSentinel();
  });

  document.body.appendChild(input);
  proxyForPanel.set(panel, input);
  proxies.add(input);
  return input;
}

export function installMobileCanvasKeyboardBridge(): () => void {
  if (installed || typeof document === 'undefined') return () => {};
  installed = true;

  const proto = CanvasPanel.prototype as unknown as { focusField: (this: CanvasPanelRuntime, field: string | undefined) => void };
  originalFocusField = proto.focusField;
  proto.focusField = function mobileAwareFocusField(field) {
    originalFocusField?.call(this, field);
    if (!isMobileUi()) return;
    const input = ensureProxy(this);
    if (!field) {
      input.blur();
      return;
    }
    // focusField is called synchronously from CanvasPanel.activate(), which is still inside the
    // user's pointer gesture and therefore satisfies iOS/Android software-keyboard requirements.
    input.focus({ preventScroll: true });
  };

  const dismissBeforeCanvasAction = (event: PointerEvent) => {
    if (!(event.target instanceof HTMLCanvasElement)) return;
    for (const input of proxies) if (document.activeElement === input) input.blur();
  };
  document.addEventListener('pointerdown', dismissBeforeCanvasAction, true);

  return () => {
    document.removeEventListener('pointerdown', dismissBeforeCanvasAction, true);
    if (originalFocusField) proto.focusField = originalFocusField;
    for (const input of proxies) input.remove();
    proxies.clear();
    installed = false;
  };
}
