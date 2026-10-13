import type { CanvasRect, VanillaCanvas } from './vanilla-canvas';

export type AuctionCategorySelection = {
  expandedClass?: number;
  itemClass?: number;
  itemSubClass?: number;
  scroll: number;
};

type Category = { id: number; name: string; sub: Array<readonly [number, string]> };

/** GetAuctionItemClasses/GetAuctionItemSubClasses, measured from Build-5875 Item*.dbc. */
export const AUCTION_CATEGORIES: readonly Category[] = [
  { id: 2, name: 'Weapons', sub: [
    [0, 'One-Handed Axes'], [1, 'Two-Handed Axes'], [2, 'Bows'], [3, 'Guns'],
    [4, 'One-Handed Maces'], [5, 'Two-Handed Maces'], [6, 'Polearms'],
    [7, 'One-Handed Swords'], [8, 'Two-Handed Swords'], [10, 'Staves'],
    [13, 'Fist Weapons'], [14, 'Miscellaneous'], [15, 'Daggers'], [16, 'Thrown'],
    [18, 'Crossbows'], [19, 'Wands'], [20, 'Fishing Poles'],
  ] },
  { id: 4, name: 'Armor', sub: [
    [0, 'Miscellaneous'], [1, 'Cloth'], [2, 'Leather'], [3, 'Mail'], [4, 'Plate'],
    [6, 'Shields'], [7, 'Librams'], [8, 'Idols'], [9, 'Totems'],
  ] },
  { id: 1, name: 'Containers', sub: [[0, 'Bags'], [1, 'Soul Bags'], [2, 'Herb Bags'], [3, 'Enchanting Bags'], [4, 'Engineering Bags']] },
  { id: 0, name: 'Consumables', sub: [[0, 'Consumables']] },
  { id: 7, name: 'Trade Goods', sub: [[0, 'Trade Goods'], [1, 'Parts'], [2, 'Explosives'], [3, 'Devices']] },
  { id: 6, name: 'Projectiles', sub: [[2, 'Arrows'], [3, 'Bullets']] },
  { id: 11, name: 'Quivers', sub: [[2, 'Quivers'], [3, 'Ammo Pouches']] },
  { id: 9, name: 'Recipes', sub: [
    [0, 'Books'], [1, 'Leatherworking'], [2, 'Tailoring'], [3, 'Engineering'], [4, 'Blacksmithing'],
    [5, 'Cooking'], [6, 'Alchemy'], [7, 'First Aid'], [8, 'Enchanting'], [9, 'Fishing'],
  ] },
  { id: 5, name: 'Reagents', sub: [[0, 'Reagents']] },
  { id: 15, name: 'Miscellaneous', sub: [[0, 'Junk']] },
];

type Row = { id: string; name: string; depth: 0 | 1; selected: boolean };
const rowsFor = (state: AuctionCategorySelection): Row[] => AUCTION_CATEGORIES.flatMap((category) => [
  { id: `category:class:${category.id}`, name: category.name, depth: 0 as const, selected: state.itemClass === category.id && state.itemSubClass === undefined },
  ...(state.expandedClass === category.id ? category.sub.map(([id, name]) => ({
    id: `category:sub:${category.id}:${id}`, name, depth: 1 as const,
    selected: state.itemClass === category.id && state.itemSubClass === id,
  })) : []),
]);

export function clampAuctionCategoryScroll(state: AuctionCategorySelection) {
  return Math.max(0, Math.min(Math.max(0, rowsFor(state).length - 15), state.scroll));
}

export function paintAuctionCategories(
  surface: VanillaCanvas,
  state: AuctionCategorySelection,
  hit: (id: string, rect: CanvasRect) => void,
  hovered: (id: string) => boolean,
) {
  const rows = rowsFor(state);
  state.scroll = clampAuctionCategoryScroll(state);
  for (const [slot, row] of rows.slice(state.scroll, state.scroll + 15).entries()) {
    const y = 105 + slot * 20;
    if (row.selected || hovered(row.id)) surface.image('/ui/Interface/QuestFrame/UI-QuestTitleHighlight.png', 23, y, 136, 20, row.selected ? 0.55 : 0.25);
    const category = row.depth === 0 ? AUCTION_CATEGORIES.find((value) => row.id === `category:class:${value.id}`) : undefined;
    if (category) surface.text(state.expandedClass === category.id ? '−' : '+', 27, y + 14, { size: 12, color: '#ffd100' });
    surface.text(row.name, row.depth ? 35 : 42, y + 14, { size: 11, color: row.depth ? '#ffffff' : '#ffd100', maxWidth: row.depth ? 120 : 112 });
    hit(row.id, { x: 23, y, width: 136, height: 20 });
  }
  if (rows.length > 15) {
    const max = rows.length - 15;
    const thumbY = 108 + (state.scroll / max) * 270;
    surface.image('/ui/Interface/Buttons/UI-ScrollBar-Knob.png', 154, thumbY, 18, 32);
  }
}

export function activateAuctionCategory(state: AuctionCategorySelection, id: string): AuctionCategorySelection {
  const parts = id.split(':');
  const itemClass = Number(parts[2]);
  if (parts[1] === 'class') {
    const closing = state.expandedClass === itemClass;
    return { expandedClass: closing ? undefined : itemClass, itemClass: closing ? undefined : itemClass, scroll: state.scroll };
  }
  return { expandedClass: itemClass, itemClass, itemSubClass: Number(parts[3]), scroll: state.scroll };
}
