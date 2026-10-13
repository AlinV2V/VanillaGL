import type { CharacterSubpageView } from './character-frame-canvas';
import type { VanillaCanvas } from './vanilla-canvas';

/** HonorFrame.xml anchors converted from top-left / negative-Y coordinates. */
const SECTIONS = [
  { title: 'This Session', titleY: 112, rows: [[2, 130, 'Honorable Kills'], [3, 145, 'Dishonorable Kills']] },
  { title: 'Yesterday', titleY: 165, rows: [[4, 183, 'Honorable Kills'], [5, 198, 'Honor']] },
  { title: 'This Week', titleY: 219, rows: [[6, 237, 'Honorable Kills'], [7, 252, 'Honor']] },
  { title: 'Last Week', titleY: 273, rows: [[8, 291, 'Honorable Kills'], [9, 306, 'Honor'], [10, 321, 'Standing']] },
  { title: 'Lifetime', titleY: 349, rows: [[11, 367, 'Honorable Kills'], [12, 383, 'Dishonorable Kills'], [0, 399, 'Highest Rank']] },
] as const;

export function paintHonorPage(surface: VanillaCanvas, page: CharacterSubpageView | undefined): boolean {
  const rows = page?.sections?.[0]?.rows;
  if (!rows?.length) return false;
  const rank = rows[0];
  const progress = rows[1];
  surface.text(String(rank.value ?? 'No Rank'), 184, 87, { size: 13, color: '#ffd100', align: 'center', baseline: 'middle', maxWidth: 210 });
  if (progress) surface.text(`Rank Progress: ${progress.value}`, 184, 102, { size: 10, color: '#fff1bd', align: 'center', baseline: 'middle' });
  for (const section of SECTIONS) {
    surface.text(section.title, 36, section.titleY, { size: 12, color: '#ffd100', baseline: 'top' });
    for (const [index, y, label] of section.rows) {
      const value = rows[index]?.value ?? '-';
      surface.text(label, 46, y, { size: 10, color: '#fff1bd', baseline: 'middle', maxWidth: 180 });
      surface.text(String(value), 324, y, { size: 10, color: label === 'Dishonorable Kills' ? '#ff4040' : '#ffffff', align: 'right', baseline: 'middle', maxWidth: 90 });
    }
  }
  return true;
}
