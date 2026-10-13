/** Asset conversion utility. */
import type { ItemInfo, TrainerSpell, TrainerState } from '../world';
import { drawMoney } from './money';
import { CanvasPanel, drawItemButton, drawScrollBar, UI_GRAY, type PanelHit } from './panel-kit';
import { trainerSpellCanLearn } from './trainer-rules';

const LIST = { x: 22, y: 100, rowHeight: 16, rows: 11 };
const STATE_COLORS: Record<number, string> = { 0: '#33e838', 1: '#e60b0b', 2: '#808080' };
const STATE_LABELS: Record<number, string> = { 0: 'available', 1: 'unavailable', 2: 'used' };

export class TrainerCanvasPanel extends CanvasPanel {
  private current?: TrainerState;
  private selectedSpellId = 0;
  private scroll = 0;
  private filters = { available: true, unavailable: true, used: true };
  private portraitGuid?: string;
  private portraitSource?: CanvasImageSource;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    buySpell: (guid: string, spellId: number) => void;
    getSpellName: (spellId: number) => string;
    getSpellIconUrl: (spellId: number) => string | undefined;
    getPlayerMoney: () => number;
    getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
    getItemInfo?: (entry: number) => ItemInfo | undefined;
    confirmPurchase?: (spell: TrainerSpell, onConfirm: () => void) => void;
    onClose: () => void;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    this.onWheel = (direction) => {
      const spells = this.visibleSpells();
      const max = Math.max(0, spells.length - LIST.rows);
      this.scroll = Math.max(0, Math.min(max, this.scroll + direction));
      this.surface.requestRender();
    };
  }

  show(state: TrainerState) {
    if (state.guid !== this.portraitGuid) {
      this.portraitGuid = state.guid;
      this.portraitSource = undefined;
    }
    this.current = state;
    this.scroll = 0;
    if (!state.spells.some((spell) => spell.spellId === this.selectedSpellId)) {
      this.selectedSpellId = state.spells.find((spell) => spell.state === 0)?.spellId ?? state.spells[0]?.spellId ?? 0;
    }
    this.host.classList.remove('is-hidden');
    this.updatePortrait();
    this.surface.requestRender();
  }

  updatePortrait() {
    const guid = this.current?.guid;
    if (!guid || !this.isOpen()) return;
    const source = this.deps.getUnitPortraitSource?.(guid);
    if (source && source !== this.portraitSource) {
      this.portraitSource = source;
      this.surface.requestRender();
    }
  }

  hide() {
    this.host.classList.add('is-hidden');
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  private visibleSpells(): TrainerSpell[] {
    const spells = this.current?.spells ?? [];
    return spells.filter((spell) =>
      (spell.state === 0 && this.filters.available)
      || (spell.state === 1 && this.filters.unavailable)
      || (spell.state >= 2 && this.filters.used));
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.fourSlice('/ui/Interface/ClassTrainerFrame', ['UI-ClassTrainer-TopLeft', 'UI-ClassTrainer-TopRight', 'UI-ClassTrainer-BotLeft', 'UI-ClassTrainer-BotRight']);
    if (this.portraitSource) s.source(this.portraitSource, 7, 6, 60, 60, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 7, 6, 60, 60);
    const state = this.current;
    s.text(state?.title || 'Trainer', 192, 24, { size: 13, align: 'center', baseline: 'middle', maxWidth: 280 });
    s.closeButton(323, 8, this.buttonState('close'));
    this.hit('close', { x: 323, y: 8, width: 32, height: 32 });
    s.text('Greetings! Select a skill to review its details.', 76, 46, { size: 12, color: '#ffffff', maxWidth: 260 });

    this.paintFilterBar();

    // Horizontal divider between list and detail (UI-ClassTrainer-HorizontalBar rows).
    s.sprite('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-HorizontalBar.png', 0, 0, 256, 16, 15, 275, 256, 16);
    s.sprite('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-HorizontalBar.png', 0, 16, 75, 16, 271, 275, 75, 16);

    const spells = this.visibleSpells();
    const maxScroll = Math.max(0, spells.length - LIST.rows);
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll));
    spells.slice(this.scroll, this.scroll + LIST.rows).forEach((spell, index) => {
      const y = LIST.y + index * LIST.rowHeight;
      const id = `spell:${spell.spellId}`;
      if (spell.spellId === this.selectedSpellId) {
        s.image('/ui/Interface/Buttons/UI-Listbox-Highlight2.png', LIST.x, y, 293, LIST.rowHeight, 0.65);
      } else if (this.state(id) === 'hover') {
        s.addImage('/ui/Interface/Buttons/UI-Listbox-Highlight2.png', LIST.x, y, 293, LIST.rowHeight, 0.35);
      }
      const name = this.deps.getSpellName(spell.spellId);
      s.text(name, LIST.x + 22, y + 12, { size: 12, color: STATE_COLORS[Math.min(spell.state, 2)] ?? '#ffffff', maxWidth: 210 });
      if (spell.requiredLevel > 1 && spell.state === 1) {
        s.text(`(${spell.requiredLevel})`, LIST.x + 271, y + 12, { size: 10, align: 'right', color: '#b0b0b0' });
      }
      this.hit(id, { x: LIST.x, y, width: 293, height: LIST.rowHeight }, { data: spell.spellId });
    });
    if (!spells.length) {
      s.text('No training available.', 170, 190, { size: 12, align: 'center', color: UI_GRAY });
    }
    if (spells.length > LIST.rows) {
      drawScrollBar(this, 'scroll', 324, LIST.y, LIST.rows * LIST.rowHeight, this.scroll, maxScroll);
    }

    this.paintDetail(spells);

    const trainRect = { x: 184, y: 409, width: 80, height: 22 };
    const cancelRect = { x: 265, y: 409, width: 80, height: 22 };
    const selected = this.selectedSpell();
    const trainDisabled = !trainerSpellCanLearn(
      selected,
      this.deps.getPlayerMoney(),
      !!this.deps.confirmPurchase,
    );
    s.panelButton('Train', trainRect, trainDisabled ? 'disabled' : this.buttonState('train'));
    s.panelButton('Cancel', cancelRect, this.buttonState('cancel'));
    this.hit('train', trainRect, { disabled: trainDisabled });
    this.hit('cancel', cancelRect);
    drawMoney(s, 180, 420, this.deps.getPlayerMoney(), { align: 'right' });
  }

  private paintFilterBar() {
    const s = this.surface;
    const bar = { x: 92, y: 65, width: 252, height: 32 };
    const file = '/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-FilterBorder.png';
    s.sprite(file, 0, 0, 12, 32, bar.x, bar.y, 12, 32);
    s.sprite(file, 12, 0, 104, 32, bar.x + 12, bar.y, bar.width - 24, 32);
    s.sprite(file, 116, 0, 12, 32, bar.x + bar.width - 12, bar.y, 12, 32);
    let x = bar.x + 14;
    for (const [key, label] of [['available', 'Available'], ['unavailable', 'Unavailable'], ['used', 'Used']] as const) {
      const checked = this.filters[key];
      const boxY = bar.y + 5;
      s.image(`/ui/Interface/Buttons/UI-CheckBox-${this.state(`filter:${key}`) === 'down' ? 'Down' : 'Up'}.png`, x, boxY, 22, 22);
      if (checked) s.image('/ui/Interface/Buttons/UI-CheckBox-Check.png', x, boxY, 22, 22);
      if (this.state(`filter:${key}`) === 'hover') s.addImage('/ui/Interface/Buttons/UI-CheckBox-Highlight.png', x, boxY, 22, 22, 0.7);
      const labelWidth = s.measureText(label, { size: 10 });
      s.text(label, x + 23, bar.y + 20, { size: 10, color: '#ffd100' });
      this.hit(`filter:${key}`, { x, y: boxY, width: 23 + labelWidth + 4, height: 22 }, { data: key });
      x += 23 + labelWidth + 10;
    }
  }

  private selectedSpell(): TrainerSpell | undefined {
    return this.current?.spells.find((spell) => spell.spellId === this.selectedSpellId);
  }

  private paintDetail(visible: TrainerSpell[]) {
    const s = this.surface;
    const spell = this.selectedSpell() ?? visible[0];
    if (!spell) return;
    const base = { x: 21, y: 288 };
    s.image('/ui/Interface/Buttons/UI-EmptySlot.png', base.x + 5 - 13, base.y + 4 - 13, 64, 64);
    drawItemButton(s, base.x + 5, base.y + 4, 37, { iconUrl: this.deps.getSpellIconUrl(spell.spellId) });
    const stateColor = STATE_COLORS[Math.min(spell.state, 2)] ?? '#ffd100';
    s.text(this.deps.getSpellName(spell.spellId), base.x + 46, base.y + 14, { size: 13, color: stateColor, maxWidth: 240 });
    const requirements: string[] = [];
    if (spell.requiredLevel > 1) requirements.push(`Requires Level ${spell.requiredLevel}`);
    if (spell.requiredSkill) requirements.push(`Requires skill ${spell.requiredSkill} (${spell.requiredSkillValue})`);
    if (spell.state >= 2) requirements.push('Already known');
    requirements.forEach((line, index) => {
      s.text(line, base.x + 46, base.y + 30 + index * 13, { size: 11, color: '#ffffff' });
    });
    if (spell.cost > 0) {
      s.text('Cost:', base.x + 5, base.y + 62, { size: 11 });
      const affordable = this.deps.getPlayerMoney() >= spell.cost;
      drawMoney(s, base.x + 5 + s.measureText('Cost:', { size: 11 }) + 8, base.y + 58, spell.cost, {
        align: 'left', color: affordable ? '#ffffff' : '#ff2020',
      });
    }
    s.text(`This ability is ${STATE_LABELS[Math.min(spell.state, 2)]}.`, base.x + 5, base.y + 80, { size: 10, color: '#ffffff' });
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close' || hit.id === 'cancel') {
      this.playUi('igCharacterInfoClose');
      this.hide();
      this.deps.onClose();
      return;
    }
    if (hit.id.startsWith('filter:')) {
      const key = hit.data as 'available' | 'unavailable' | 'used';
      this.filters = { ...this.filters, [key]: !this.filters[key] };
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.scroll = 0;
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('spell:')) {
      this.selectedSpellId = Number(hit.data);
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'scroll:up') { this.scroll--; this.surface.requestRender(); return; }
    if (hit.id === 'scroll:down') { this.scroll++; this.surface.requestRender(); return; }
    if (hit.id === 'train') {
      const guid = this.current?.guid;
      const spell = this.selectedSpell();
      if (guid && spell) {
        this.playUi('igCharacterBuy');
        const purchase = () => this.deps.buySpell(guid, spell.spellId);
        if (spell.primaryProfessionConfirm) this.deps.confirmPurchase?.(spell, purchase);
        else purchase();
      }
    }
  }
}
