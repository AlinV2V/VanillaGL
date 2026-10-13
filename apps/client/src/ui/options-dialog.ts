import { CanvasPanel, UI_GRAY, type PanelHit } from './panel-kit';
import { DIALOG_EDGE, drawEdgedBox } from './vanilla-canvas';
import { mobileOptionsLayout, paintMobileOptions, type MobileOptionsLayout } from './mobile/mobile-options-layout';

export type OptionRow =
  | { kind: 'section'; label: string; getLabel?: () => string }
  | { kind: 'check'; key: string; label: string; get: () => boolean; set: (value: boolean) => void; isDisabled?: () => boolean }
  | { kind: 'slider'; key: string; label: string; min: number; max: number; step: number; get: () => number; set: (value: number) => void; format: (value: number) => string; isDisabled?: () => boolean }
  | { kind: 'choice'; key: string; label: string; values: string[]; get: () => string; set: (value: string) => void };

type PlacedRow = { row: OptionRow; x: number; y: number };

const OPT = { width: 560, headerHeight: 46, rowHeight: 24, sectionGap: 8, footerHeight: 56, colX: [36, 300] as const };

export class OptionsDialog extends CanvasPanel {
  private rows: OptionRow[] = [];
  private title = '';
  private placed: PlacedRow[] = [];
  private contentBottom = 0;
  private mobileLayout?: MobileOptionsLayout;
  private page = 0;

  constructor(host: HTMLElement, private readonly callbacks: {
    onFooter: (action: 'ok' | 'cancel' | 'defaults') => void;
    onChanged: () => void;
  }, playUi?: (name: string) => boolean) {
    super(host, OPT.width, 640, 'wow-native-panel-canvas', { playUi });
    const resize = () => { if (this.title) { this.layout(); this.refresh(); } };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    this.onDrag = (hit, point) => {
      if (!hit.id.startsWith('slider:')) return;
      const row = hit.data as Extract<OptionRow, { kind: 'slider' }>;
      const track = this.trackRect(hit.rect);
      const ratio = Math.max(0, Math.min(1, (point.x - track.x) / track.width));
      const raw = row.min + ratio * (row.max - row.min);
      const snapped = Math.round(raw / row.step) * row.step;
      row.set(Number(snapped.toFixed(4)));
      this.callbacks.onChanged();
      this.surface.requestRender();
    };
  }

  open(title: string, rows: OptionRow[]) {
    this.title = title;
    this.rows = rows;
    this.page = 0;
    this.layout();
    this.surface.requestRender();
  }

  refresh() { this.surface.requestRender(); }

  private layout() {
    if (document.documentElement.classList.contains('vanillagl-mobile')) {
      this.mobileLayout = mobileOptionsLayout(this.rows, window.visualViewport?.width ?? window.innerWidth, window.visualViewport?.height ?? window.innerHeight);
      this.page = Math.min(this.page, this.mobileLayout.pages.length - 1);
      this.surface.resize(this.mobileLayout.width, this.mobileLayout.height);
      this.surface.canvas.parentElement?.style.removeProperty('transform');
      return;
    }
    this.mobileLayout = undefined;
    this.placed = [];
    let y = OPT.headerHeight + 14;
    let column = 0;
    const advance = () => { y += OPT.rowHeight; column = 0; };
    for (const row of this.rows) {
      if (row.kind === 'section') {
        if (column === 1) advance();
        y += OPT.sectionGap;
        this.placed.push({ row, x: 24, y });
        y += OPT.rowHeight;
        column = 0;
      } else if (row.kind === 'check') {
        this.placed.push({ row, x: OPT.colX[column], y });
        if (column === 0) column = 1;
        else advance();
      } else {
        if (column === 1) advance();
        this.placed.push({ row, x: OPT.colX[0], y });
        advance();
      }
    }
    if (column === 1) y += OPT.rowHeight;
    this.contentBottom = y;
    // Do not cap the backing canvas: the final Miscellaneous rows must remain
    // above the footer. CSS applies the same UI scale Vanilla used at low
    // resolutions, preserving all logical pixels without an HTML scrollbar.
    const height = this.contentBottom + OPT.footerHeight;
    this.surface.resize(OPT.width, height);
    if (this.title === 'Video Options' && this.surface.canvas.parentElement) {
      const scale = Math.min(1, Math.max(1, window.innerWidth - 24) / OPT.width, Math.max(1, window.innerHeight - 24) / height);
      this.surface.canvas.parentElement.style.transform = `scale(${scale})`;
    }
  }

  private trackRect(hitRect: PanelHit['rect']) {
    return this.mobileLayout ? { x: hitRect.x, y: hitRect.y + 16, width: hitRect.width, height: 12 }
      : { x: hitRect.x + 6, y: hitRect.y + 4, width: hitRect.width - 12, height: 12 };
  }

  protected paint() {
    if (this.mobileLayout) { paintMobileOptions(this, this.title, this.mobileLayout, this.page); return; }
    const s = this.surface;
    const height = this.surface.canvas.height;
    s.clear();
    drawEdgedBox(s, { x: 0, y: 0, width: OPT.width, height }, DIALOG_EDGE);
    s.image('/ui/Interface/DialogFrame/UI-DialogBox-Header.png', OPT.width / 2 - 128, -6, 256, 64);
    s.text(this.title, OPT.width / 2, 21, { size: 13, align: 'center', baseline: 'middle' });

    for (const { row, x, y } of this.placed) {
      if (row.kind === 'section') this.paintSection(row, x, y);
      else if (row.kind === 'check') this.paintCheck(row, x, y);
      else if (row.kind === 'slider') this.paintSlider(row, x, y);
      else this.paintChoice(row, x, y);
    }

    const footerY = height - 42;
    const defaultsRect = { x: 24, y: footerY, width: this.title === 'Video Options' ? 220 : 110, height: 22 };
    const okRect = { x: OPT.width - 200, y: footerY, width: 84, height: 22 };
    const cancelRect = { x: OPT.width - 110, y: footerY, width: 84, height: 22 };
    s.panelButton(this.title === 'Video Options' ? 'Use Recommended Settings' : 'Defaults', defaultsRect, this.buttonState('footer:defaults'));
    s.panelButton('Okay', okRect, this.buttonState('footer:ok'));
    s.panelButton('Cancel', cancelRect, this.buttonState('footer:cancel'));
    this.hit('footer:defaults', defaultsRect);
    this.hit('footer:ok', okRect);
    this.hit('footer:cancel', cancelRect);
  }

  private paintSection(row: Extract<OptionRow, { kind: 'section' }>, x: number, y: number) {
    const s = this.surface;
    s.text(row.getLabel?.() ?? row.label, x, y + 15, { size: 13, color: '#ffd100' });
    const width = OPT.width - x - 24;
    const lineY = y + 20;
    s.ctx.save();
    s.ctx.strokeStyle = 'rgba(255, 209, 0, 0.25)';
    s.ctx.beginPath();
    s.ctx.moveTo(x + s.measureText(row.label, { size: 13 }) + 10, lineY);
    s.ctx.lineTo(x + width, lineY);
    s.ctx.stroke();
    s.ctx.restore();
  }

  private paintCheck(row: Extract<OptionRow, { kind: 'check' }>, x: number, y: number) {
    const s = this.surface;
    const disabled = row.isDisabled?.() ?? false;
    const id = `check:${row.key}`;
    const boxY = y + 1;
    s.image(`/ui/Interface/Buttons/UI-CheckBox-${this.state(id) === 'down' && !disabled ? 'Down' : 'Up'}.png`, x, boxY, 22, 22);
    if (row.get()) s.image(`/ui/Interface/Buttons/UI-CheckBox-Check${disabled ? '-Disabled' : ''}.png`, x, boxY, 22, 22);
    if (this.state(id) === 'hover' && !disabled) s.addImage('/ui/Interface/Buttons/UI-CheckBox-Highlight.png', x, boxY, 22, 22, 0.7);
    s.text(row.label, x + 26, y + 16, { size: 11, color: disabled ? UI_GRAY : '#ffd100', maxWidth: 220 });
    this.hit(id, { x, y: boxY, width: 26 + s.measureText(row.label, { size: 11 }), height: 22 }, { data: row, disabled });
  }

  private paintSlider(row: Extract<OptionRow, { kind: 'slider' }>, x: number, y: number) {
    const s = this.surface;
    const disabled = row.isDisabled?.() ?? false;
    const id = `slider:${row.key}`;
    s.text(row.label, x, y + 16, { size: 11, color: disabled ? UI_GRAY : '#ffd100' });
    const track = { x: x + 214, y: y + 4, width: 200, height: 12 };
    s.image('/ui/Interface/Buttons/UI-SliderBar-Background.png', track.x, track.y, track.width, track.height);
    drawEdgedBox(s, { x: track.x - 4, y: track.y - 4, width: track.width + 8, height: track.height + 8 }, {
      edgeFile: '/ui/Interface/Buttons/UI-SliderBar-Border.png',
      edgeSize: 8,
    });
    const ratio = (row.get() - row.min) / (row.max - row.min);
    const knobX = track.x + Math.max(0, Math.min(1, ratio)) * track.width - 10;
    s.image('/ui/Interface/Buttons/UI-SliderBar-Button-Horizontal.png', knobX, track.y - 10, 20, 32, disabled ? 0.4 : 1);
    s.text(row.format(row.get()), track.x + track.width + 14, y + 16, { size: 11, color: disabled ? UI_GRAY : '#ffffff' });
    this.hit(id, { x: track.x - 6, y, width: track.width + 12, height: 22 }, { data: row, disabled });
  }

  private paintChoice(row: Extract<OptionRow, { kind: 'choice' }>, x: number, y: number) {
    const s = this.surface;
    s.text(row.label, x, y + 16, { size: 11, color: '#ffd100' });
    const current = row.get();
    const index = Math.max(0, row.values.indexOf(current));
    const prevRect = { x: x + 214, y: y - 2, width: 26, height: 26 };
    const nextRect = { x: x + 386, y: y - 2, width: 26, height: 26 };
    s.image(`/ui/Interface/Buttons/UI-SpellbookIcon-PrevPage-${index <= 0 ? 'Disabled' : this.state(`choice-prev:${row.key}`) === 'down' ? 'Down' : 'Up'}.png`, prevRect.x, prevRect.y, 26, 26);
    s.image(`/ui/Interface/Buttons/UI-SpellbookIcon-NextPage-${index >= row.values.length - 1 ? 'Disabled' : this.state(`choice-next:${row.key}`) === 'down' ? 'Down' : 'Up'}.png`, nextRect.x, nextRect.y, 26, 26);
    s.text(current, x + 313, y + 16, { size: 12, align: 'center', color: '#ffffff' });
    this.hit(`choice-prev:${row.key}`, prevRect, { data: row, disabled: index <= 0 });
    this.hit(`choice-next:${row.key}`, nextRect, { data: row, disabled: index >= row.values.length - 1 });
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id.startsWith('page:') && this.mobileLayout) {
      this.page = Math.max(0, Math.min(this.mobileLayout.pages.length - 1, this.page + (hit.id === 'page:next' ? 1 : -1)));
      this.hover = this.pressed = undefined;
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('footer:')) {
      this.playUi('igMainMenuOptionClick');
      this.callbacks.onFooter(hit.id.slice(7) as 'ok' | 'cancel' | 'defaults');
      return;
    }
    if (hit.id.startsWith('check:')) {
      const row = hit.data as Extract<OptionRow, { kind: 'check' }>;
      row.set(!row.get());
      this.playUi(row.get() ? 'igMainMenuOptionCheckBoxOn' : 'igMainMenuOptionCheckBoxOff');
      this.callbacks.onChanged();
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('choice-prev:') || hit.id.startsWith('choice-next:')) {
      const row = hit.data as Extract<OptionRow, { kind: 'choice' }>;
      const index = Math.max(0, row.values.indexOf(row.get()));
      const next = hit.id.startsWith('choice-prev:') ? index - 1 : index + 1;
      row.set(row.values[Math.max(0, Math.min(row.values.length - 1, next))]);
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.callbacks.onChanged();
      this.surface.requestRender();
    }
  }
}

