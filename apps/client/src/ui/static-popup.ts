/** Asset conversion utility. */
import { CanvasPanel, drawInputBox, type PanelHit } from './panel-kit';
import { drawMoney } from './money';
import { DIALOG_EDGE, drawEdgedBox } from './vanilla-canvas';

const WIDTH = 320;
const HEIGHT = 130;

export class StaticPopupPanel extends CanvasPanel {
  private message = '';
  private confirmCallback?: () => void;
  private cancelCallback?: () => void;
  private primaryLabel = 'Okay';
  private secondaryLabel = 'Cancel';
  private actionOnly = false;
  private noticeOnly = false;
  private primaryDisabled = false;
  private money?: number;
  private inputValue = '';
  private inputMaxLength = 255;
  private inputFilter?: (char: string) => boolean;
  private inputValidator?: (value: string) => boolean;
  private inputCallback?: (value: string) => void;
  private readonly queue: Array<{ message: string; callback?: () => void }> = [];

  constructor(private readonly host: HTMLElement, deps: { playUi: (name: string) => void } ) {
    super(host, WIDTH, HEIGHT, 'wow-native-panel-canvas', deps);
  }

  show(message: string) {
    if (this.isOpen()) { this.queue.push({ message }); return; }
    this.message = message;
    this.confirmCallback = undefined;
    this.noticeOnly = false;
    this.money = undefined;
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  confirm(message: string, callback: () => void) {
    if (this.isOpen()) { this.queue.push({ message, callback }); return; }
    this.message = message;
    this.confirmCallback = callback;
    this.noticeOnly = false;
    this.money = undefined;
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  /** Replace any queued interaction with a non-closable Vanilla-style action. */
  forceAction(message: string, label: string, callback: () => void, disabled = false) {
    this.queue.length = 0;
    this.message = message;
    this.confirmCallback = callback;
    this.cancelCallback = undefined;
    this.inputCallback = undefined;
    this.focusField(undefined);
    this.primaryLabel = label;
    this.secondaryLabel = 'Cancel';
    this.actionOnly = true;
    this.noticeOnly = false;
    this.primaryDisabled = disabled;
    this.money = undefined;
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  /** Replace any queued interaction with an explicit Accept/Decline dialog. */
  forceConfirm(
    message: string,
    onAccept: () => void,
    onDecline: () => void,
    acceptLabel = 'Accept',
    declineLabel = 'Decline',
    acceptDisabled = false,
    money?: number,
  ) {
    this.queue.length = 0;
    this.message = message;
    this.confirmCallback = onAccept;
    this.cancelCallback = onDecline;
    this.inputCallback = undefined;
    this.focusField(undefined);
    this.primaryLabel = acceptLabel;
    this.secondaryLabel = declineLabel;
    this.actionOnly = false;
    this.noticeOnly = false;
    this.primaryDisabled = acceptDisabled;
    this.money = money;
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  /** Replace queued interactions with a buttonless, non-closable timed notice. */
  forceNotice(message: string) {
    this.queue.length = 0;
    this.message = message;
    this.confirmCallback = undefined;
    this.cancelCallback = undefined;
    this.inputCallback = undefined;
    this.focusField(undefined);
    this.noticeOnly = true;
    this.money = undefined;
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  /** Canvas-native EditBox dialog for the rare packet workflows that require a string. */
  forceInput(
    message: string,
    initialValue: string,
    onAccept: (value: string) => void,
    options: {
      acceptLabel?: string;
      maxLength?: number;
      filter?: (char: string) => boolean;
      validate?: (value: string) => boolean;
    } = {},
  ) {
    this.queue.length = 0;
    this.message = message;
    this.confirmCallback = undefined;
    this.cancelCallback = undefined;
    this.inputValue = initialValue.slice(0, options.maxLength ?? 255);
    this.inputMaxLength = options.maxLength ?? 255;
    this.inputFilter = options.filter;
    this.inputValidator = options.validate ?? ((value) => value.trim().length > 0);
    this.inputCallback = onAccept;
    this.primaryLabel = options.acceptLabel ?? 'Okay';
    this.secondaryLabel = 'Cancel';
    this.actionOnly = false;
    this.noticeOnly = false;
    this.primaryDisabled = !this.inputValidator(this.inputValue);
    this.money = undefined;
    this.host.classList.remove('is-hidden');
    this.focusField('input');
  }

  /**
   * Retarget the text of an already-open dialog without disturbing its buttons or queue.
   * Vanilla's StaticPopup_OnUpdate rewrites `StaticPopup1Text` in place once a second for the
   * timed dialogs (StaticPopup.lua:1290-1309); this is the same idea.
   */
  setMessage(message: string) {
    if (!this.isOpen() || this.message === message) return;
    this.message = message;
    this.surface.requestRender();
  }

  /** StaticPopup OnUpdate hooks can enable/disable the primary button without reopening it. */
  setPrimaryDisabled(disabled: boolean) {
    if (!this.isOpen() || this.primaryDisabled === disabled) return;
    this.primaryDisabled = disabled;
    this.surface.requestRender();
  }

  hide() {
    this.queue.length = 0;
    this.confirmCallback = undefined;
    this.cancelCallback = undefined;
    this.resetButtons();
    this.host.classList.add('is-hidden');
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    drawEdgedBox(s, { x: 0, y: 0, width: WIDTH, height: HEIGHT }, DIALOG_EDGE);
    const lines = s.wrapText(this.message, WIDTH - 60, { size: 12 });
    lines.slice(0, 3).forEach((line, index) => {
      s.text(line, WIDTH / 2, (this.inputCallback ? 25 : 34) + index * 16, { size: 12, color: '#ffffff', align: 'center' });
    });
    if (this.inputCallback) drawInputBox(s, 55, 59, 210, this.inputValue, { focused: this.focusedField === 'input' });
    if (this.money !== undefined) drawMoney(s, WIDTH / 2 + 64, 78, this.money, { align: 'right' });
    if (this.noticeOnly) return;
    const hasSecondButton = (!!this.confirmCallback || !!this.inputCallback) && !this.actionOnly;
    const okRect = hasSecondButton
      ? { x: WIDTH / 2 - 87, y: HEIGHT - 40, width: 78, height: 22 }
      : { x: WIDTH / 2 - 39, y: HEIGHT - 40, width: 78, height: 22 };
    const state = this.state('ok');
    s.panelButton(this.primaryLabel, okRect, this.primaryDisabled ? 'disabled' : state);
    this.hit('ok', okRect);
    if (hasSecondButton) {
      const cancelRect = { x: WIDTH / 2 + 9, y: HEIGHT - 40, width: 78, height: 22 };
      const cancelState = this.state('cancel');
      s.panelButton(this.secondaryLabel, cancelRect, cancelState === 'disabled' ? 'normal' : cancelState);
      this.hit('cancel', cancelRect);
    }
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'ok') {
      if (this.primaryDisabled) return;
      this.playUi('igMainMenuOptionCheckBoxOn');
      if (this.inputCallback) {
        const callback = this.inputCallback;
        const value = this.inputValue.trim();
        this.inputCallback = undefined;
        callback(value);
        this.advanceQueue();
        return;
      }
      const callback = this.confirmCallback;
      this.confirmCallback = undefined;
      callback?.();
      this.advanceQueue();
    } else if (hit.id === 'cancel') {
      this.playUi('igMainMenuOptionCheckBoxOff');
      const callback = this.cancelCallback;
      this.confirmCallback = undefined;
      this.cancelCallback = undefined;
      callback?.();
      this.advanceQueue();
    }
  }

  protected onFieldKey = (
    field: string,
    key: 'char' | 'backspace' | 'enter' | 'escape' | 'tab',
    char?: string,
  ) => {
    if (field !== 'input' || !this.inputCallback) return;
    if (key === 'enter') { this.activate({ id: 'ok', rect: { x: 0, y: 0, width: 0, height: 0 } }); return; }
    if (key === 'escape') { this.activate({ id: 'cancel', rect: { x: 0, y: 0, width: 0, height: 0 } }); return; }
    if (key === 'tab') { this.focusField(undefined); return; }
    if (key === 'backspace') this.inputValue = this.inputValue.slice(0, -1);
    else if (char && (!this.inputFilter || this.inputFilter(char))) {
      this.inputValue = `${this.inputValue}${char}`.slice(0, this.inputMaxLength);
    }
    this.primaryDisabled = !(this.inputValidator?.(this.inputValue) ?? true);
  };

  private advanceQueue() {
    const next = this.queue.shift();
    if (!next) {
      this.resetButtons();
      this.host.classList.add('is-hidden');
      return;
    }
    this.message = next.message;
    this.confirmCallback = next.callback;
    this.cancelCallback = undefined;
    this.resetButtons();
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  private resetButtons() {
    this.primaryLabel = 'Okay';
    this.secondaryLabel = 'Cancel';
    this.actionOnly = false;
    this.noticeOnly = false;
    this.primaryDisabled = false;
    this.money = undefined;
    this.inputCallback = undefined;
    this.inputFilter = undefined;
    this.inputValidator = undefined;
    this.inputValue = '';
    this.focusField(undefined);
  }
}
