import { CanvasPanel, UI_GOLD, UI_GRAY, type PanelHit } from './panel-kit';
import { DIALOG_EDGE, drawEdgedBox } from './vanilla-canvas';
import { RAID_TARGET_NAMES } from './raid-target-icons';

export type BindingCommand =
  | 'OPEN_CHARACTER' | 'TOGGLEBACKPACK' | 'TOGGLEKEYRING' | 'TOGGLEWORLDMAP' | 'OPEN_SPELLBOOK'
  | 'OPEN_SOCIAL' | 'OPEN_TALENTS' | 'TOGGLESHEATH' | 'TARGETNEARESTENEMY'
  | 'ATTACKTARGET' | 'TOGGLECOMBATLOG' | `ACTIONBUTTON${number}` | `RAIDTARGET${number}` | 'RAIDTARGETNONE';

type BindingDefinition = { command: BindingCommand; label: string; defaultCode: string };

const DEFINITIONS: BindingDefinition[] = [
  { command: 'OPEN_CHARACTER', label: 'Open Character Info', defaultCode: 'KeyC' },
  { command: 'TOGGLEBACKPACK', label: 'Toggle Backpack', defaultCode: 'KeyB' },
  { command: 'TOGGLEKEYRING', label: 'Toggle Keyring', defaultCode: '' },
  { command: 'TOGGLEWORLDMAP', label: 'Toggle World Map', defaultCode: 'KeyM' },
  { command: 'OPEN_SPELLBOOK', label: 'Open Spellbook', defaultCode: 'KeyP' },
  { command: 'OPEN_SOCIAL', label: 'Open Social Panel', defaultCode: 'KeyO' },
  { command: 'OPEN_TALENTS', label: 'Open Talent Panel', defaultCode: 'KeyN' },
  { command: 'TOGGLESHEATH', label: 'Sheathe / Unsheathe', defaultCode: 'KeyZ' },
  { command: 'TARGETNEARESTENEMY', label: 'Target Nearest Enemy', defaultCode: 'Tab' },
  { command: 'ATTACKTARGET', label: 'Attack Target', defaultCode: 'KeyT' },
  // Bindings.xml:105 declares TOGGLECOMBATLOG -> ToggleCombatLog() but ships it UNBOUND, and the

  // Leaving defaultCode empty reproduces that rather than inventing a key vanilla never used.
  { command: 'TOGGLECOMBATLOG', label: 'Toggle Combat Log', defaultCode: '' },
  ...['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal']
    .map((defaultCode, index) => ({ command: `ACTIONBUTTON${index + 1}` as BindingCommand, label: `Action Button ${index + 1}`, defaultCode })),
  ...RAID_TARGET_NAMES.map((name, index) => ({ command: `RAIDTARGET${index + 1}` as BindingCommand, label: `Assign ${name} to Target`, defaultCode: '' })),
  { command: 'RAIDTARGETNONE', label: 'Clear raid target icon', defaultCode: '' },
];

const STORAGE_KEY = 'wowBrowser.keyBindings.v1';

export class KeyBindingStore {
  private bindings = this.load();

  definitions() { return DEFINITIONS; }
  code(command: BindingCommand) { return this.bindings[command] ?? DEFINITIONS.find((entry) => entry.command === command)?.defaultCode ?? ''; }
  matches(event: KeyboardEvent, command: BindingCommand) {
    const assigned = this.code(command);
    return Boolean(assigned && event.code && event.code === assigned);
  }
  actionSlot(event: KeyboardEvent) {
    for (let slot = 1; slot <= 12; slot++) if (this.matches(event, `ACTIONBUTTON${slot}`)) return slot - 1;
    return -1;
  }
  raidTargetIndex(event: KeyboardEvent): number | undefined {
    for (let index = 1; index <= 8; index++) if (this.matches(event, `RAIDTARGET${index}`)) return index;
    return this.matches(event, 'RAIDTARGETNONE') ? 0 : undefined;
  }
  set(command: BindingCommand, code: string) {
    for (const [other, assigned] of Object.entries(this.bindings)) if (other !== command && assigned === code) delete this.bindings[other as BindingCommand];
    this.bindings[command] = code;
    this.save();
  }
  clear(command: BindingCommand) { delete this.bindings[command]; this.save(); }
  reset() { this.bindings = Object.fromEntries(DEFINITIONS.map((entry) => [entry.command, entry.defaultCode])) as Record<BindingCommand, string>; this.save(); }

  private load() {
    const defaults = Object.fromEntries(DEFINITIONS.map((entry) => [entry.command, entry.defaultCode])) as Record<BindingCommand, string>;
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') }; } catch { return defaults; }
  }
  private save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings)); }
}

export class KeyBindingCanvasPanel extends CanvasPanel {
  private openState = false;
  private capturing?: BindingCommand;
  private offset = 0;

  constructor(private readonly layer: HTMLElement, private readonly store: KeyBindingStore, playUi?: (name: string) => unknown) {
    super(layer, 520, 560, 'wow-native-panel-canvas', { playUi });
    layer.dataset.frameId = 'keybindings';
    window.addEventListener('keydown', (event) => this.onKey(event), true);
  }

  open() { this.openState = true; this.layer.classList.remove('is-hidden'); this.surface.requestRender(); }
  close() { this.openState = false; this.capturing = undefined; this.layer.classList.add('is-hidden'); }
  isOpen() { return this.openState; }

  protected paint() {
    const s = this.surface;
    s.clear();
    drawEdgedBox(s, { x: 12, y: 12, width: 496, height: 536 }, DIALOG_EDGE);
    s.image('/ui/Interface/DialogFrame/UI-DialogBox-Header.png', 132, 0, 256, 64);
    s.text('Key Bindings', 260, 27, { size: 14, align: 'center', baseline: 'middle' });
    s.text('Click a key slot, then press a key.', 36, 66, { size: 11, color: UI_GOLD });
    const visible = this.store.definitions().slice(this.offset, this.offset + 15);
    visible.forEach((entry, row) => {
      const y = 88 + row * 27;
      s.text(entry.label, 42, y + 16, { size: 12, color: '#ffffff', maxWidth: 260 });
      const rect = { x: 316, y, width: 142, height: 22 };
      const isCapture = this.capturing === entry.command;
      s.panelButton(isCapture ? 'Press Key...' : displayCode(this.store.code(entry.command)), rect, this.state(`bind:${entry.command}`));
      this.hit(`bind:${entry.command}`, rect, { data: entry.command });
      const clear = { x: 464, y, width: 24, height: 22 };
      s.panelButton('x', clear, this.state(`clear:${entry.command}`));
      this.hit(`clear:${entry.command}`, clear, { data: entry.command });
    });
    const maxOffset = Math.max(0, this.store.definitions().length - 15);
    const prev = { x: 38, y: 503, width: 80, height: 22 };
    const next = { x: 126, y: 503, width: 80, height: 22 };
    const reset = { x: 288, y: 503, width: 92, height: 22 };
    const close = { x: 388, y: 503, width: 92, height: 22 };
    s.panelButton('Previous', prev, this.offset <= 0 ? 'disabled' : this.state('previous'));
    s.panelButton('Next', next, this.offset >= maxOffset ? 'disabled' : this.state('next'));
    s.panelButton('Defaults', reset, this.state('defaults'));
    s.panelButton('Okay', close, this.state('close'));
    this.hit('previous', prev, { disabled: this.offset <= 0 });
    this.hit('next', next, { disabled: this.offset >= maxOffset });
    this.hit('defaults', reset);
    this.hit('close', close);
  }

  protected activate(hit: PanelHit) {
    if (hit.id.startsWith('bind:')) this.capturing = hit.data as BindingCommand;
    else if (hit.id.startsWith('clear:')) this.store.clear(hit.data as BindingCommand);
    else if (hit.id === 'previous') this.offset = Math.max(0, this.offset - 15);
    else if (hit.id === 'next') this.offset = Math.min(this.store.definitions().length - 15, this.offset + 15);
    else if (hit.id === 'defaults') this.store.reset();
    else if (hit.id === 'close') this.close();
    this.playUi('igMainMenuOptionClick');
  }

  private onKey(event: KeyboardEvent) {
    if (!this.openState) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.capturing) {
      if (event.code === 'Escape') this.capturing = undefined;
      else if (!['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(event.code)) {
        this.store.set(this.capturing, event.code);
        this.capturing = undefined;
      }
      this.surface.requestRender();
    } else if (event.code === 'Escape') this.close();
  }
}

const displayCode = (code: string) => (code ? code : 'Not Bound')
  .replace(/^Key/, '')
  .replace(/^Digit/, '')
  .replace('Minus', '-')
  .replace('Equal', '=');
