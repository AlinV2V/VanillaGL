/** Asset conversion utility. */
import type { VanillaCanvas } from './vanilla-canvas';

const MONEY_ICONS = '/ui/Interface/MoneyFrame/UI-MoneyIcons.png';
const COIN_CELL = { gold: 0, silver: 16, copper: 32 } as const;

/** MoneyFrame.lua:3 `MONEY_ICON_WIDTH_SMALL = 13` — fixed, independent of the text size. */
export const MONEY_ICON_WIDTH_SMALL = 13;
/** MoneyFrame.lua:4 `MONEY_BUTTON_SPACING_SMALL = -4` — a 4px gap between denominations. */
export const MONEY_BUTTON_GAP_SMALL = 4;
/** SmallMoneyFrameTemplate text inherits NumberFontNormal, 14pt (Fonts.xml:148-152). */
export const MONEY_TEXT_SIZE = 14;

export const splitMoney = (copper: number) => ({
  gold: Math.floor(copper / 10000),
  silver: Math.floor((copper % 10000) / 100),
  copper: copper % 100,
});

export const formatMoneyText = (copper: number) => {
  const parts = splitMoney(Math.max(0, copper));
  const chunks: string[] = [];
  if (parts.gold) chunks.push(`${parts.gold}g`);
  if (parts.gold || parts.silver) chunks.push(`${parts.silver}s`);
  chunks.push(`${parts.copper}c`);
  return chunks.join(' ');
};

export type MoneyOptions = {
  align?: 'left' | 'right';
  size?: number;
  color?: string;
  disabled?: boolean;
};

/**
 * Coin-icon money amount, vertically centered on y. 'right' aligned amounts
 * grow leftward from x like the native SmallMoneyFrame. Returns drawn width.
 */
export const drawMoney = (s: VanillaCanvas, x: number, y: number, amount: number, options: MoneyOptions = {}) => {
  // SmallMoneyFrameTemplate (MoneyFrame.xml:148) is 128x13 and its text inherits NumberFontNormal,
  // which Fonts.xml:148-152 defines as 14pt. The coin icon is a fixed 13x13
  // (MONEY_ICON_WIDTH_SMALL, MoneyFrame.lua:3) — it is NOT a function of the text size, so the old
  // `size + 1` never paired a 13px coin with 14pt text. Denominations are spaced by
  // MONEY_BUTTON_SPACING_SMALL = -4 (MoneyFrame.lua:4), i.e. a 4px gap.
  const { align = 'right', size = MONEY_TEXT_SIZE, color = '#ffffff' } = options;
  const coin = MONEY_ICON_WIDTH_SMALL;
  const parts = splitMoney(Math.max(0, amount));
  const denominations: Array<{ value: number; cell: number }> = [];
  if (parts.gold > 0) denominations.push({ value: parts.gold, cell: COIN_CELL.gold });
  if (parts.gold > 0 || parts.silver > 0) denominations.push({ value: parts.silver, cell: COIN_CELL.silver });
  denominations.push({ value: parts.copper, cell: COIN_CELL.copper });

  const textColor = options.disabled ? '#77736b' : color;
  const widths = denominations.map((denom) => s.measureText(String(denom.value), { size, font: 'number' }) + coin + 1);
  const total = widths.reduce((a, b) => a + b, 0) + (denominations.length - 1) * MONEY_BUTTON_GAP_SMALL;
  let cursor = align === 'right' ? x - total : x;
  for (const [index, denom] of denominations.entries()) {
    const numberWidth = widths[index] - coin - 1;
    s.text(String(denom.value), cursor, y, { size, font: 'number', color: textColor, baseline: 'middle' });
    s.sprite(MONEY_ICONS, denom.cell, 0, 16, 16, cursor + numberWidth + 1, y - coin / 2, coin, coin);
    cursor += widths[index] + MONEY_BUTTON_GAP_SMALL;
  }
  return total;
};
