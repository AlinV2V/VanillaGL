import type { OptionRow } from '../options-dialog';
import type { CanvasPanel } from '../panel-kit';
import { DIALOG_EDGE, drawEdgedBox, type CanvasRect } from '../vanilla-canvas';

export type MobileOptionsPage = Array<{ row: OptionRow; y: number }>;
export function mobileOptionsLayout(rows: OptionRow[], width: number, height: number) {
  width = Math.max(240, Math.min(560, width - 24));
  height = Math.max(240, Math.min(720, height - 24));
  const stacked = width < 480;
  const pages: MobileOptionsPage[] = [[]];
  const top = 84, bottom = height - 62;
  let y = top;
  const rowHeight = (row: OptionRow) => row.kind === 'section' ? 26 : stacked && row.kind !== 'check' ? 64 : 44;
  rows.forEach((row, index) => {
    const needed = rowHeight(row) + (row.kind === 'section' && rows[index + 1] ? rowHeight(rows[index + 1]) : 0);
    if (y + needed > bottom && pages[pages.length - 1].length) { pages.push([]); y = top; }
    pages[pages.length - 1].push({ row, y });
    y += rowHeight(row);
  });
  return { width, height, stacked, pages };
}

export type MobileOptionsLayout = ReturnType<typeof mobileOptionsLayout>;

/** Original canvas art with phone-sized rows, paged instead of shrinking the entire settings sheet. */
export function paintMobileOptions(panel: Pick<CanvasPanel, 'surface' | 'hit' | 'state'>,
  title: string, layout: MobileOptionsLayout, page: number) {
  const s = panel.surface, { width, height, stacked, pages } = layout;
  s.clear();
  s.ctx.fillStyle = 'rgba(8, 9, 12, .94)'; s.ctx.fillRect(4, 4, width - 8, height - 8);
  drawEdgedBox(s, { x: 0, y: 0, width, height }, DIALOG_EDGE);
  s.image('/ui/Interface/DialogFrame/UI-DialogBox-Header.png', width / 2 - 128, -10, 256, 64);
  s.text(title, width / 2, 21, { size: 15, align: 'center', baseline: 'middle' });
  const button = (id: string, label: string, rect: CanvasRect, disabled = false, data?: unknown) => {
    s.panelButton(label, rect, disabled ? 'disabled' : panel.state(id));
    panel.hit(id, rect, { disabled, data });
  };
  button('page:prev', 'Previous', { x: 16, y: 40, width: 96, height: 38 }, page === 0);
  s.text(`${page + 1} / ${pages.length}`, width / 2, 64, { size: 14, align: 'center' });
  button('page:next', 'Next', { x: width - 112, y: 40, width: 96, height: 38 }, page === pages.length - 1);
  for (const { row, y } of pages[page]) {
    const disabled = 'isDisabled' in row && !!row.isDisabled?.();
    const color = disabled ? '#808080' : '#ffd100';
    if (row.kind === 'section') {
      s.text(row.getLabel?.() ?? row.label, 20, y + 18, { size: 13, color, maxWidth: width - 40 });
    } else if (row.kind === 'check') {
      const id = `check:${row.key}`;
      s.image('/ui/Interface/Buttons/UI-CheckBox-Up.png', 18, y + 6, 32, 32);
      if (row.get()) s.image('/ui/Interface/Buttons/UI-CheckBox-Check.png', 18, y + 6, 32, 32, disabled ? .4 : 1);
      s.text(row.label, 56, y + 27, { size: 14, color, maxWidth: width - 76 });
      panel.hit(id, { x: 16, y, width: width - 32, height: 44 }, { data: row, disabled });
    } else {
      const x = stacked ? 26 : 244;
      const controlY = stacked ? y + 24 : y;
      const controlWidth = width - x - 26;
      s.text(row.label, 22, y + (stacked ? 18 : 27), { size: 13, color, maxWidth: stacked ? width - 44 : 214 });
      if (row.kind === 'slider') {
        const trackWidth = controlWidth - 64;
        s.image('/ui/Interface/Buttons/UI-SliderBar-Background.png', x, controlY + 16, trackWidth, 12);
        drawEdgedBox(s, { x: x - 4, y: controlY + 12, width: trackWidth + 8, height: 20 }, {
          edgeFile: '/ui/Interface/Buttons/UI-SliderBar-Border.png', edgeSize: 8,
        });
        const ratio = Math.max(0, Math.min(1, (row.get() - row.min) / (row.max - row.min)));
        s.image('/ui/Interface/Buttons/UI-SliderBar-Button-Horizontal.png', x + ratio * trackWidth - 12, controlY + 2, 24, 40, disabled ? .4 : 1);
        s.text(row.format(row.get()), width - 20, controlY + 28, { size: 13, align: 'right', color: disabled ? '#808080' : '#fff' });
        panel.hit(`slider:${row.key}`, { x, y: controlY, width: trackWidth, height: 44 }, { data: row, disabled });
      } else {
        const index = Math.max(0, row.values.indexOf(row.get()));
        button(`choice-prev:${row.key}`, '<', { x, y: controlY + 2, width: 40, height: 40 }, index === 0, row);
        button(`choice-next:${row.key}`, '>', { x: x + controlWidth - 40, y: controlY + 2, width: 40, height: 40 }, index === row.values.length - 1, row);
        s.text(row.get(), x + controlWidth / 2, controlY + 27, { size: 13, align: 'center', color: '#fff', maxWidth: controlWidth - 84 });
      }
    }
  }
  const footerY = height - 52;
  const gap = 8, buttonWidth = (width - 40 - gap * 2) / 3;
  button('footer:defaults', title === 'Video Options' ? 'Recommended' : 'Defaults', { x: 20, y: footerY, width: buttonWidth, height: 40 });
  button('footer:ok', 'Okay', { x: 20 + buttonWidth + gap, y: footerY, width: buttonWidth, height: 40 });
  button('footer:cancel', 'Cancel', { x: 20 + (buttonWidth + gap) * 2, y: footerY, width: buttonWidth, height: 40 });
}
