import { WORLD_MAP_AREAS, type WorldMapAreaMeta } from '../data/world-map';
import { isBuiltInAddonEnabled } from './builtin-addons';
import type { CanvasRect, VanillaCanvas } from './vanilla-canvas';

const pointers = new WeakMap<VanillaCanvas, { x: number; y: number }>();
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const normalized = (area: WorldMapAreaMeta, worldX: number, worldY: number) => ({
  x: (worldY - area.left) / (area.right - area.left),
  y: (worldX - area.top) / (area.bottom - area.top),
});
const format = (point: { x: number; y: number }) => `${(point.x * 100).toFixed(1)}, ${(point.y * 100).toFixed(1)}`;

export function zoneCoordinateText(mapId: number, worldX: number, worldY: number) {
  const area = WORLD_MAP_AREAS.filter((candidate) => candidate.areaId !== 0 && candidate.mapId === mapId)
    .filter((candidate) => { const point = normalized(candidate, worldX, worldY); return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1; })
    .sort((a, b) => Math.abs((a.right - a.left) * (a.bottom - a.top)) - Math.abs((b.right - b.left) * (b.bottom - b.top)))[0];
  return area ? format(normalized(area, worldX, worldY)) : undefined;
}

export function installWorldMapCoordinateInput(surface: VanillaCanvas, detail: CanvasRect) {
  surface.canvas.addEventListener('pointermove', (event) => {
    const point = surface.point(event);
    if (point.x >= detail.x && point.x <= detail.x + detail.width && point.y >= detail.y && point.y <= detail.y + detail.height) pointers.set(surface, point);
    else pointers.delete(surface);
    if (isBuiltInAddonEnabled('mapCoordinates')) surface.requestRender();
  });
  surface.canvas.addEventListener('pointerleave', () => pointers.delete(surface));
}

export function drawWorldMapCoordinates(surface: VanillaCanvas, detail: CanvasRect, area: WorldMapAreaMeta | undefined,
  current: { mapId: number; x: number; y: number } | undefined) {
  if (!isBuiltInAddonEnabled('mapCoordinates') || !area) return;
  const player = current?.mapId === area.mapId ? normalized(area, current.x, current.y) : undefined;
  const pointer = pointers.get(surface);
  const cursor = pointer ? { x: clamp01((pointer.x - detail.x) / detail.width), y: clamp01((pointer.y - detail.y) / detail.height) } : undefined;
  const text = `${player ? `Player: ${format(player)}` : ''}${player && cursor ? '    ' : ''}${cursor ? `Cursor: ${format(cursor)}` : ''}`;
  if (text) surface.text(text, 512, 753, { family: 'sans', size: 11, color: '#ffd100', align: 'center' });
}
