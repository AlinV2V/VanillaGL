import { CanvasPanel, drawItemButton, UI_GOLD, type PanelHit } from './panel-kit';
import { DIALOG_EDGE, drawEdgedBox } from './vanilla-canvas';

export type MacroRecord = { name: string; iconId: number; body: string };
type SpellMeta = Record<number, [string, string, number]>;

const LEGACY_STORAGE_KEY = 'wowBrowser.macros.v1';
const MIGRATION_STORAGE_KEY = 'wowBrowser.macros.v1.migratedToCharacter';
const MAX_MACROS = 18;

const emptyMacros = (): Array<MacroRecord | null> => Array.from({ length: MAX_MACROS }, () => null);

export class MacroSystem extends CanvasPanel {
  private macros: Array<MacroRecord | null> = emptyMacros();
  private loadedStorageKey: string | undefined;
  private selected = 0;
  private openState = false;
  private spellMeta: SpellMeta = {};
  private iconPalette: number[] = [1];
  private readonly nameInput = document.createElement('input');
  private readonly bodyInput = document.createElement('textarea');

  constructor(
    private readonly layer: HTMLElement,
    private readonly deps: {
      getCharacterGuid: () => string | undefined;
      getKnownSpells: () => readonly number[];
      executeLine: (line: string) => void | Promise<void>;
      assignMacro: (index: number) => void;
      playUi?: (name: string) => unknown;
    },
  ) {
    super(layer, 520, 520, 'wow-native-panel-canvas', { playUi: deps.playUi });
    layer.dataset.frameId = 'macros';
    this.nameInput.className = 'wow-macro-name-input';
    this.bodyInput.className = 'wow-macro-body-input';
    this.bodyInput.maxLength = 255;
    this.nameInput.maxLength = 16;
    layer.append(this.nameInput, this.bodyInput);
    this.nameInput.addEventListener('input', () => this.commitEditor());
    this.bodyInput.addEventListener('input', () => this.commitEditor());
    window.addEventListener('keydown', (event) => {
      if (!this.openState || event.code !== 'Escape') return;
      if (event.target === this.nameInput || event.target === this.bodyInput) {
        (event.target as HTMLElement).blur();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
    }, true);
  }

  async open() {
    this.ensureLoaded();
    this.openState = true;
    this.layer.classList.remove('is-hidden');
    if (!Object.keys(this.spellMeta).length) {
      try { this.spellMeta = await (await fetch('/spells/spells.json')).json(); } catch { this.spellMeta = {}; }
    }
    this.iconPalette = [...new Set(this.deps.getKnownSpells().map((spellId) => this.spellMeta[spellId]?.[2]).filter((id): id is number => !!id))];
    if (!this.iconPalette.length) this.iconPalette = [1];
    this.syncEditor();
    this.surface.requestRender();
  }

  close() { this.openState = false; this.layer.classList.add('is-hidden'); }
  isOpen() { return this.openState; }

  async execute(index: number) {
    this.ensureLoaded();
    const macro = this.macros[index];
    if (!macro) return;
    for (const rawLine of macro.body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      await this.deps.executeLine(line);
    }
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    drawEdgedBox(s, { x: 10, y: 10, width: 500, height: 500 }, DIALOG_EDGE);
    s.image('/ui/Interface/DialogFrame/UI-DialogBox-Header.png', 132, -1, 256, 64);
    s.text('Create Macros', 260, 26, { size: 14, align: 'center', baseline: 'middle' });
    for (let i = 0; i < MAX_MACROS; i++) {
      const col = i % 6;
      const row = Math.floor(i / 6);
      const x = 32 + col * 54;
      const y = 68 + row * 54;
      const macro = this.macros[i];
      drawItemButton(s, x, y, 38, { iconUrl: macro ? this.iconUrl(macro.iconId) : undefined, hover: this.isHover(`macro:${i}`), pushed: i === this.selected });
      this.hit(`macro:${i}`, { x, y, width: 38, height: 38 }, { data: i, tooltip: macro ? [{ text: macro.name, color: '#ffffff' }] : undefined });
    }
    const macro = this.macros[this.selected];
    s.text('Name', 33, 248, { size: 11, color: UI_GOLD });
    s.text('Macro Commands', 33, 292, { size: 11, color: UI_GOLD });
    const iconRect = { x: 388, y: 244, width: 38, height: 38 };
    drawItemButton(s, iconRect.x, iconRect.y, 38, { iconUrl: macro ? this.iconUrl(macro.iconId) : undefined, hover: this.isHover('icon') });
    this.hit('icon', iconRect, { disabled: !macro, tooltip: [{ text: 'Change Icon', color: '#ffd100' }] });
    s.ctx.save();
    s.ctx.fillStyle = 'rgba(0,0,0,.72)';
    s.ctx.fillRect(30, 263, 335, 24);
    s.ctx.fillRect(30, 308, 458, 130);
    s.ctx.strokeStyle = '#8c6d35';
    s.ctx.strokeRect(30.5, 263.5, 335, 24);
    s.ctx.strokeRect(30.5, 308.5, 458, 130);
    s.ctx.restore();
    const buttons = [
      ['new', 'New', 30], ['delete', 'Delete', 120], ['assign', 'Assign', 276], ['execute', 'Run', 366], ['close', 'Close', 426],
    ] as const;
    for (const [id, label, x] of buttons) {
      const rect = { x, y: 464, width: id === 'close' ? 64 : 82, height: 22 };
      const disabled = id !== 'new' && id !== 'close' && !macro;
      s.panelButton(label, rect, disabled ? 'disabled' : this.state(id));
      this.hit(id, rect, { disabled });
    }
  }

  protected activate(hit: PanelHit) {
    if (hit.id.startsWith('macro:')) {
      this.selected = hit.data as number;
      this.syncEditor();
    } else if (hit.id === 'new') {
      const slot = this.macros.findIndex((macro) => !macro);
      if (slot >= 0) {
        this.selected = slot;
        this.macros[slot] = { name: `Macro ${slot + 1}`, iconId: this.iconPalette[0] ?? 1, body: '' };
        this.save();
        this.syncEditor();
        this.nameInput.focus();
        this.nameInput.select();
      }
    } else if (hit.id === 'delete') {
      this.macros[this.selected] = null;
      this.save();
      this.syncEditor();
    } else if (hit.id === 'icon') {
      const macro = this.macros[this.selected];
      if (macro) {
        const index = Math.max(0, this.iconPalette.indexOf(macro.iconId));
        macro.iconId = this.iconPalette[(index + 1) % this.iconPalette.length] ?? macro.iconId;
        this.save();
      }
    } else if (hit.id === 'assign') this.deps.assignMacro(this.selected);
    else if (hit.id === 'execute') void this.execute(this.selected);
    else if (hit.id === 'close') this.close();
    this.playUi('igMainMenuOptionClick');
  }

  private syncEditor() {
    const macro = this.macros[this.selected];
    this.nameInput.value = macro?.name ?? '';
    this.bodyInput.value = macro?.body ?? '';
    this.nameInput.disabled = !macro;
    this.bodyInput.disabled = !macro;
  }
  private commitEditor() {
    const macro = this.macros[this.selected];
    if (!macro) return;
    macro.name = this.nameInput.value;
    macro.body = this.bodyInput.value;
    this.save();
    this.surface.requestRender();
  }
  private iconUrl(iconId: number) { return `/spells/icons/${iconId}.png`; }
  private characterStorageKey() {
    const guid = this.deps.getCharacterGuid()?.trim().toLowerCase();
    return guid ? `${LEGACY_STORAGE_KEY}.character.${guid}` : undefined;
  }
  private ensureLoaded() {
    const storageKey = this.characterStorageKey();
    if (!storageKey || storageKey === this.loadedStorageKey) return;
    this.macros = this.load(storageKey);
    this.loadedStorageKey = storageKey;
    this.selected = 0;
  }
  private load(storageKey: string): Array<MacroRecord | null> {
    try {
      let encoded = localStorage.getItem(storageKey);
      // Earlier builds had a single account-wide key. Give that data to the first character
      // opened after this change without deleting it or copying it to every later character.
      if (encoded === null && localStorage.getItem(MIGRATION_STORAGE_KEY) === null) {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy !== null) {
          encoded = legacy;
          localStorage.setItem(storageKey, legacy);
          localStorage.setItem(MIGRATION_STORAGE_KEY, storageKey);
        }
      }
      const value = JSON.parse(encoded ?? '[]') as Array<MacroRecord | null>;
      return Array.from({ length: MAX_MACROS }, (_, index) => value[index] ?? null);
    } catch { return emptyMacros(); }
  }
  private save() {
    const storageKey = this.characterStorageKey();
    if (!storageKey) return;
    this.loadedStorageKey = storageKey;
    localStorage.setItem(storageKey, JSON.stringify(this.macros));
  }
}
