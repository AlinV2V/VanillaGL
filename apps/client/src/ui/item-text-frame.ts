/** Canvas reproduction of Vanilla ItemTextFrame.xml (384x512, one server page at a time). */
import type { ReadableItemState } from '../world/quest-items';
import { CanvasPanel, type PanelHit } from './panel-kit';

const BODY = { x: 38, y: 91, width: 270, height: 326 };
const TEXT_COLORS = {
  Parchment: '#2e1f0f', Stone: '#ffffff', Marble: '#000000', Silver: '#1f1f1f', Bronze: '#2e1f0f',
} as const;

export class ItemTextCanvasPanel extends CanvasPanel {
  private current?: ReadableItemState;
  private page = 0;
  private scroll = 0;
  private contentHeight = 0;

  constructor(private readonly host: HTMLElement, private readonly deps: { playUi: (name: string) => void }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    this.onWheel = (direction) => {
      this.scroll = Math.max(0, Math.min(Math.max(0, this.contentHeight - BODY.height), this.scroll + direction * 36));
      this.surface.requestRender();
    };
  }

  show(state: ReadableItemState) {
    const sameItem = this.current?.itemGuid === state.itemGuid;
    this.current = state;
    if (!sameItem) { this.page = 0; this.scroll = 0; }
    this.page = Math.min(this.page, Math.max(0, state.pages.length - 1));
    if (this.host.classList.contains('is-hidden')) this.deps.playUi('igMainMenuOpen');
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  hide() {
    if (!this.host.classList.contains('is-hidden')) this.deps.playUi('igMainMenuClose');
    this.host.classList.add('is-hidden');
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.image('/ui/Interface/ItemTextFrame/UI-ItemText-TopLeft.png', 0, 0, 256, 256);
    s.image('/ui/Interface/Spellbook/UI-SpellbookPanel-TopRight.png', 256, 0, 128, 256);
    s.image('/ui/Interface/ItemTextFrame/UI-ItemText-BotLeft.png', 0, 256, 256, 256);
    s.image('/ui/Interface/Spellbook/UI-SpellbookPanel-BotRight.png', 256, 256, 128, 256);
    s.image('/ui/Interface/Spellbook/Spellbook-Icon.png', 10, 8, 58, 58);
    const state = this.current;
    if (!state) return;
    if (state.material !== 'Parchment') {
      const base = `/ui/Interface/ItemTextFrame/ItemText-${state.material}`;
      s.image(`${base}-TopLeft.png`, 21, 75, 256, 256);
      s.image(`${base}-TopRight.png`, 277, 75, 64, 256);
      s.image(`${base}-BotLeft.png`, 21, 331, 256, 128);
      s.image(`${base}-BotRight.png`, 277, 331, 64, 128);
    }
    s.text(state.title, 198, 26, { size: 13, color: '#ffd100', align: 'center', baseline: 'middle', maxWidth: 224 });
    s.closeButton(323, 10, this.buttonState('close'));
    this.hit('close', { x: 323, y: 10, width: 32, height: 32 });

    const currentPage = state.pages[this.page];
    if (!currentPage) {
      s.text('Loading...', 192, 245, { size: 15, family: 'morpheus', color: TEXT_COLORS[state.material], align: 'center' });
      return;
    }
    if (state.pages.length > 1 || currentPage.nextPageId) {
      s.text(`Page ${this.page + 1}`, 202, 50, { size: 13, color: '#ffd100', align: 'center' });
      this.paintPageButton('prev', 74, 40, 'Prev', this.page === 0);
      this.paintPageButton('next', 313, 40, 'Next', this.page >= state.pages.length - 1);
    }

    const ctx = s.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(BODY.x, BODY.y, BODY.width, BODY.height);
    ctx.clip();
    const lines = s.wrapText(currentPage.text, BODY.width, { size: 15, family: 'morpheus' });
    let y = BODY.y - this.scroll;
    for (const line of lines) {
      y += 19;
      s.text(line, BODY.x, y, { size: 15, family: 'morpheus', color: TEXT_COLORS[state.material], shadow: false });
    }
    this.contentHeight = Math.max(BODY.height, lines.length * 19 + 20);
    ctx.restore();
  }

  private paintPageButton(id: 'prev' | 'next', x: number, y: number, label: string, disabled: boolean) {
    const direction = id === 'prev' ? 'PrevPage' : 'NextPage';
    const state = disabled ? 'Disabled' : this.buttonState(id) === 'down' ? 'Down' : 'Up';
    this.surface.image(`/ui/Interface/Buttons/UI-SpellbookIcon-${direction}-${state}.png`, x, y, 32, 32);
    if (!disabled && this.state(id) === 'hover') {
      this.surface.addImage('/ui/Interface/Buttons/UI-Common-MouseHilight.png', x, y, 32, 32);
    }
    this.surface.text(label, id === 'prev' ? x + 36 : x - 4, y + 18, {
      size: 12, color: '#ffd100', align: id === 'prev' ? 'left' : 'right', baseline: 'middle',
    });
    this.hit(id, { x, y, width: 32, height: 32 }, { disabled });
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') { this.hide(); return; }
    if (hit.id === 'prev' && this.page > 0) {
      this.page--; this.scroll = 0; this.playUi('igMainMenuOptionCheckBoxOn'); this.surface.requestRender();
    } else if (hit.id === 'next' && this.current && this.page < this.current.pages.length - 1) {
      this.page++; this.scroll = 0; this.playUi('igMainMenuOptionCheckBoxOn'); this.surface.requestRender();
    }
  }
}
