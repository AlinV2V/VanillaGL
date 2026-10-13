import {
  AREA_META,
  WORLD_MAP_AREAS,
  WORLD_MAP_CONTINENTS,
  WORLD_MAP_OVERLAYS,
  WORLD_MAP_POIS,
  type WorldMapAreaMeta,
  type WorldMapOverlayMeta,
} from '../data/world-map';
import type { GossipPoi } from '../world/player-services';
import { CanvasPanel, type PanelHit } from './panel-kit';
import { drawEdgedBox, DIALOG_EDGE, type CanvasRect } from './vanilla-canvas';
import { isWorldMapOverlayExplored } from './world-map-exploration';
import { questieLite } from './questie-lite'; import { drawWorldMapCoordinates, installWorldMapCoordinateInput } from './map-coordinates'; import { onBuiltInAddonSettings } from './builtin-addons';
import './world-map.css';

type WorldMapContinentMeta = {
  id: number;
  mapId: number;
  name: string;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
  centerX: number;
  centerY: number;
  scale: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type AreaLookupMeta = { parentAreaId: number };
type DropdownKind = 'continent' | 'zone';

const DETAIL = { x: 11, y: 69, width: 1002, height: 668 } as const;
const TILE_SIZE = 256;
const MAP_SCALE_W = 1024;
const MAP_SCALE_H = 768;
const WORLD_MAP = '/ui/Interface/WorldMap';
const MAP_AREAS = WORLD_MAP_AREAS as readonly WorldMapAreaMeta[];
const CONTINENTS = WORLD_MAP_CONTINENTS as readonly WorldMapContinentMeta[];
const AREA_LOOKUP = AREA_META as Record<number, AreaLookupMeta | undefined>;
const areasById = new Map<number, WorldMapAreaMeta>(MAP_AREAS.map((area) => [area.id, area]));
const continentById = new Map(CONTINENTS.map((continent) => [continent.id, continent]));
const continentByMap = new Map(CONTINENTS.map((continent) => [continent.mapId, continent]));
const continentAreaByMap = new Map(MAP_AREAS.filter((area) => area.areaId === 0).map((area) => [area.mapId, area]));
const zonesByContinent = new Map<number, WorldMapAreaMeta[]>();
const overlaysByAreaId = new Map<number, WorldMapOverlayMeta[]>();

for (const continent of CONTINENTS) {
  zonesByContinent.set(
    continent.id,
    MAP_AREAS.filter((area) => area.mapId === continent.mapId && area.areaId !== 0).sort((a, b) => a.name.localeCompare(b.name)),
  );
}
for (const overlay of WORLD_MAP_OVERLAYS) {
  const list = overlaysByAreaId.get(overlay.worldMapAreaId) ?? [];
  list.push(overlay);
  overlaysByAreaId.set(overlay.worldMapAreaId, list);
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const mapCoord = (area: WorldMapAreaMeta, worldX: number, worldY: number) => ({
  x: (worldY - area.left) / (area.right - area.left),
  y: (worldX - area.top) / (area.bottom - area.top),
});
const containsWorld = (area: WorldMapAreaMeta, mapId: number, worldX: number, worldY: number) => {
  if (area.mapId !== mapId) return false;
  const point = mapCoord(area, worldX, worldY);
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
};
const areaChain = (areaId: number | undefined) => {
  const chain: number[] = [];
  const seen = new Set<number>();
  let id = areaId ?? 0;
  while (id > 0 && !seen.has(id)) {
    seen.add(id);
    chain.push(id);
    id = AREA_LOOKUP[id]?.parentAreaId ?? 0;
  }
  return chain;
};
const findMapAreaForWorld = (state: WorldMapRuntimeState) => {
  for (const id of areaChain(state.areaId)) {
    const exact = MAP_AREAS.find((area) => area.mapId === state.mapId && area.areaId === id);
    if (exact) return exact;
  }
  const containing = MAP_AREAS
    .filter((area) => area.areaId !== 0 && containsWorld(area, state.mapId, state.x, state.y))
    .sort((a, b) => Math.abs((a.right - a.left) * (a.bottom - a.top)) - Math.abs((b.right - b.left) * (b.bottom - b.top)));
  return containing[0] ?? continentAreaByMap.get(state.mapId);
};
const nextPowerOfTwo = (value: number) => {
  let result = 16;
  while (result < value) result *= 2;
  return result;
};
const textureUrl = (...parts: string[]) =>
  `/ui/${parts.map((part) => part.split('/').map(encodeURIComponent).join('/')).join('/')}.png`;

export type WorldMapRuntimeState = {
  mapId: number;
  x: number;
  y: number;
  heading: number;
  areaId?: number;
};

export type WorldMapGossipPoi = GossipPoi & { mapId: number };

export type WorldMapFrame = {
  element: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  setCurrentWorld(state: WorldMapRuntimeState): void;
  setExploredZones(bits: readonly number[]): void;
  setGossipPoi(poi: WorldMapGossipPoi): void;
};

class WorldMapCanvasPanel extends CanvasPanel {
  private opened = false;
  private current?: WorldMapRuntimeState;
  private gossipPoi?: WorldMapGossipPoi;
  private exploredZoneBits: readonly number[] = [];
  private currentArea?: WorldMapAreaMeta;
  private activeContinentId = CONTINENTS[0]?.id ?? 1;
  private dropdown?: DropdownKind;
  private dropdownOffset = 0;

  constructor(readonly host: HTMLElement) {
    super(host, 1024, 768, 'wow-world-map-canvas');
    questieLite.subscribe(() => this.surface.requestRender());
    onBuiltInAddonSettings(() => this.surface.requestRender());
    installWorldMapCoordinateInput(this.surface, DETAIL);
    this.onWheel = (direction) => {
      if (!this.dropdown) return;
      const options = this.dropdownOptions();
      const maxOffset = Math.max(0, options.length - 18);
      this.dropdownOffset = Math.max(0, Math.min(maxOffset, this.dropdownOffset + direction));
      this.surface.requestRender();
    };
    this.setArea(continentAreaByMap.get(0) ?? continentAreaByMap.values().next().value);
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    this.host.classList.remove('is-hidden');
    this.fit();
    this.setArea((this.current && findMapAreaForWorld(this.current)) || this.currentArea || continentAreaByMap.get(0));
    this.host.dispatchEvent(new CustomEvent('wow-world-map-toggle', { detail: { open: true } }));
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    this.dropdown = undefined;
    this.host.classList.add('is-hidden');
    this.host.dispatchEvent(new CustomEvent('wow-world-map-toggle', { detail: { open: false } }));
  }

  isOpen() { return this.opened; }

  setCurrentWorld(state: WorldMapRuntimeState) {
    this.current = state;
    if (this.opened) this.surface.requestRender();
  }

  setExploredZones(bits: readonly number[]) {
    this.exploredZoneBits = bits;
    if (this.opened) this.surface.requestRender();
  }

  setGossipPoi(poi: WorldMapGossipPoi) {
    this.gossipPoi = poi;
    if (this.opened) this.surface.requestRender();
  }

  fit() {
    // The parchment is authored at exactly 1024x768: WorldMapFrame.xml anchors twelve 256px
    // tiles ±512/±384 from CENTER. Shrink to fit a viewport smaller than that, never upscale —
    // enlarging it pushes the zoom/continent chrome off the top of the screen.
    //
    // `ToggleWorldMap` does call a `SetupWorldMapScale()` native before `ShowUIPanel`

    // so what it actually computes is unresolved. Do not "fix" this to scale up on that name
    // alone — it was tried and it clipped the chrome.
    const scale = Math.min(window.innerWidth / MAP_SCALE_W, window.innerHeight / MAP_SCALE_H, 1);
    this.host.style.setProperty('--world-map-scale', scale.toFixed(4));
  }

  protected paint() {
    const s = this.surface;
    const ctx = s.ctx;
    s.clear();
    // No opaque base under the parchment. Build 5875 ships exactly twelve UI-WorldMap-* tiles and
    // no background/border/backdrop art of any kind (enumerated from interface.MPQ), and
    // WorldMapFrame declares no Backdrop — its only two are on the child GameTooltip. The tiles
    // have torn alpha edges, so filling black behind them painted a hard black rectangle where the
    // client shows the world through the tear.
    ['Top', 'Middle', 'Bottom'].forEach((row, rowIndex) => {
      for (let col = 0; col < 4; col++) {
        s.image(`${WORLD_MAP}/UI-WorldMap-${row}${col + 1}.png`, col * 256, rowIndex * 256, 256, 256);
      }
    });

    if (this.currentArea) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(DETAIL.x, DETAIL.y, DETAIL.width, DETAIL.height);
      ctx.clip();
      ctx.fillStyle = '#080604';
      ctx.fillRect(DETAIL.x, DETAIL.y, DETAIL.width, DETAIL.height);
      this.drawMapTiles(this.currentArea);
      this.drawOverlays(this.currentArea);
      this.drawAreaHits(this.currentArea);
      this.drawPois(this.currentArea);
      this.drawQuestMarkers(this.currentArea);
      this.drawPlayer(this.currentArea);
      ctx.restore();
      ctx.strokeStyle = 'rgba(216,171,75,0.46)';
      ctx.strokeRect(DETAIL.x + 0.5, DETAIL.y + 0.5, DETAIL.width - 1, DETAIL.height - 1);
    }

    this.drawControls();
    drawWorldMapCoordinates(this.surface, DETAIL, this.currentArea, this.current);
    if (this.dropdown) this.drawDropdown();
  }

  private drawMapTiles(area: WorldMapAreaMeta) {
    for (let index = 0; index < 12; index++) {
      const col = index % 4;
      const row = Math.floor(index / 4);
      const url = textureUrl('Interface', 'WorldMap', area.mapFileName, `${area.mapFileName}${index + 1}`);
      this.surface.image(url, DETAIL.x + col * TILE_SIZE, DETAIL.y + row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }

  private drawOverlays(area: WorldMapAreaMeta) {
    const s = this.surface;
    const ctx = s.ctx;
    for (const overlay of overlaysByAreaId.get(area.id) ?? []) {
      if (!isWorldMapOverlayExplored(overlay.areaIds, AREA_META, this.exploredZoneBits)) continue;
      const cols = Math.ceil(overlay.width / TILE_SIZE);
      const rows = Math.ceil(overlay.height / TILE_SIZE);
      for (let row = 0; row < rows; row++) {
        const pixelH = row < rows - 1 ? TILE_SIZE : overlay.height % TILE_SIZE || TILE_SIZE;
        const fileH = nextPowerOfTwo(pixelH);
        for (let col = 0; col < cols; col++) {
          const pixelW = col < cols - 1 ? TILE_SIZE : overlay.width % TILE_SIZE || TILE_SIZE;
          const fileW = nextPowerOfTwo(pixelW);
          const x = DETAIL.x + overlay.offsetX + col * TILE_SIZE;
          const y = DETAIL.y + overlay.offsetY + row * TILE_SIZE;
          const url = textureUrl('Interface', 'WorldMap', area.mapFileName, `${overlay.textureName}${row * cols + col + 1}`);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, pixelW, pixelH);
          ctx.clip();
          s.image(url, x, y, fileW, fileH);
          ctx.restore();
        }
      }
    }
  }

  private drawAreaHits(area: WorldMapAreaMeta) {
    if (area.areaId !== 0) return;
    for (const zone of zonesByContinent.get(this.activeContinentId) ?? []) {
      const a = mapCoord(area, zone.top, zone.left);
      const b = mapCoord(area, zone.bottom, zone.right);
      const rect = {
        x: DETAIL.x + Math.min(a.x, b.x) * DETAIL.width,
        y: DETAIL.y + Math.min(a.y, b.y) * DETAIL.height,
        width: Math.abs(b.x - a.x) * DETAIL.width,
        height: Math.abs(b.y - a.y) * DETAIL.height,
      };
      if (rect.width > 3 && rect.height > 3) this.hit(`area:${zone.id}`, rect, { tooltip: [{ text: zone.name, color: '#ffd100' }], silent: true });
    }
  }

  private drawPois(area: WorldMapAreaMeta) {
    for (const poi of WORLD_MAP_POIS) {
      if (!containsWorld(area, poi.mapId, poi.worldX, poi.worldY)) continue;
      const point = mapCoord(area, poi.worldX, poi.worldY);
      if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) continue;
      const x = DETAIL.x + point.x * DETAIL.width;
      const y = DETAIL.y + point.y * DETAIL.height;
      const icon = Math.max(0, poi.iconIndex);
      this.surface.sprite('/ui/Interface/Minimap/POIICONS.png', (icon % 8) * 16, Math.floor(icon / 8) * 16, 16, 16, x - 8, y - 8, 16, 16);
      this.hit(`poi:${poi.id}`, { x: x - 8, y: y - 8, width: 16, height: 16 }, {
        silent: true,
        tooltip: [
          { text: poi.name, color: '#ffffff' },
          ...(poi.description ? [{ text: poi.description, color: '#ffd100' }] : []),
        ],
      });
    }
    const poi = this.gossipPoi;
    if (!poi || !containsWorld(area, poi.mapId, poi.x, poi.y)) return;
    const point = mapCoord(area, poi.x, poi.y);
    const x = DETAIL.x + point.x * DETAIL.width;
    const y = DETAIL.y + point.y * DETAIL.height;
    const icon = Math.max(0, poi.icon);
    this.surface.sprite('/ui/Interface/Minimap/POIICONS.png', (icon % 8) * 16, Math.floor(icon / 8) * 16, 16, 16, x - 8, y - 8, 16, 16);
    this.hit(`gossip-poi:${poi.data}`, { x: x - 16, y: y - 16, width: 32, height: 32 }, {
      silent: true,
      tooltip: [{ text: poi.name || 'Point of Interest', color: '#ffffff' }],
    });
  }

  private drawQuestMarkers(area: WorldMapAreaMeta) {
    if (area.areaId === 0) return;
    questieLite.ensureArea(area.id);
    const markers = questieLite.markersForArea(area.id);
    markers.sort((a, b) => Number(a.kind !== 'objective') - Number(b.kind !== 'objective'));
    for (const marker of markers) {
      const point = mapCoord(area, marker.worldX, marker.worldY);
      if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) continue;
      const x = DETAIL.x + point.x * DETAIL.width;
      const y = DETAIL.y + point.y * DETAIL.height;
      const objective = marker.kind === 'objective';
      const color = marker.kind === 'turnin-incomplete' ? '#9d9d9d' : '#ffd100';
      const radius = objective ? 5 : 9;
      const ctx = this.surface.ctx;
      ctx.save();
      ctx.fillStyle = objective ? 'rgba(255,209,0,.78)' : 'rgba(12,10,5,.92)';
      ctx.strokeStyle = '#161008';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
      if (!objective) this.surface.text(marker.kind === 'available' ? '!' : '?', x, y + 1, {
        size: 16, color, align: 'center', baseline: 'middle', family: 'sans', font: 'number',
      });
      const status = marker.kind === 'available' ? 'Available Quest'
        : marker.kind === 'turnin' ? 'Quest Complete'
          : marker.kind === 'turnin-incomplete' ? 'Quest Turn-in' : 'Quest Objective';
      this.hit(`questie:${marker.kind}:${marker.questId}:${marker.objective}:${x.toFixed(0)}:${y.toFixed(0)}`,
        { x: x - radius - 3, y: y - radius - 3, width: radius * 2 + 6, height: radius * 2 + 6 }, {
          silent: true,
          tooltip: [{ text: marker.title, color: '#ffd100' }, { text: marker.detail ?? status, color: '#ffffff' }],
        });
    }
  }

  private drawPlayer(area: WorldMapAreaMeta) {
    if (!this.current || this.current.mapId !== area.mapId) return;
    const point = mapCoord(area, this.current.x, this.current.y);
    if (point.x < -0.05 || point.x > 1.05 || point.y < -0.05 || point.y > 1.05) return;
    const x = DETAIL.x + clamp01(point.x) * DETAIL.width;
    const y = DETAIL.y + clamp01(point.y) * DETAIL.height;
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-this.current.heading);
    this.surface.image(`${WORLD_MAP}/WorldMapPlayerIcon.png`, -8, -8, 16, 16);
    ctx.restore();
  }

  private drawControls() {
    const s = this.surface;
    const area = this.currentArea;
    const continent = continentById.get(this.activeContinentId);
    const zoneLabel = area?.areaId === 0 ? 'Continent' : area?.name ?? 'Zone';
    s.panelButton('Zoom Out', { x: 113, y: 28, width: 110, height: 22 }, area?.areaId === 0 ? 'disabled' : this.state('zoom-out'));
    this.hit('zoom-out', { x: 113, y: 28, width: 110, height: 22 }, { disabled: area?.areaId === 0 });
    this.drawSelector('zone', zoneLabel, { x: 242, y: 28, width: 150, height: 22 });
    this.drawSelector('continent', continent?.name ?? 'Continent', { x: 414, y: 28, width: 150, height: 22 });
    s.closeButton(988, 2, this.state('close') === 'down' ? 'down' : this.state('close') === 'hover' ? 'hover' : 'normal');
    this.hit('close', { x: 988, y: 2, width: 32, height: 32 });
    if (area) s.text(area.name, 512, 749, { size: 14, color: '#ffd100', align: 'center', baseline: 'middle', maxWidth: 520 });
  }

  private drawSelector(kind: DropdownKind, label: string, rect: CanvasRect) {
    const ctx = this.surface.ctx;
    ctx.fillStyle = this.dropdown === kind ? '#2b1b09' : '#120c05';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = this.dropdown === kind ? '#d8a637' : '#8a6b2f';
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
    this.surface.text(label, rect.x + 8, rect.y + 12, { size: 11, color: '#ffd100', baseline: 'middle', maxWidth: rect.width - 28 });
    ctx.fillStyle = '#ffd100';
    ctx.beginPath();
    ctx.moveTo(rect.x + rect.width - 17, rect.y + 8);
    ctx.lineTo(rect.x + rect.width - 9, rect.y + 8);
    ctx.lineTo(rect.x + rect.width - 13, rect.y + 14);
    ctx.closePath();
    ctx.fill();
    this.hit(`selector:${kind}`, rect);
  }

  private dropdownOptions(): Array<{ id: number; label: string }> {
    return this.dropdown === 'continent'
      ? CONTINENTS.map((continent) => ({ id: continent.id, label: continent.name }))
      : [{ id: 0, label: 'Continent' }, ...(zonesByContinent.get(this.activeContinentId) ?? []).map((area) => ({ id: area.id, label: area.name }))];
  }

  private drawDropdown() {
    const kind = this.dropdown!;
    const anchor = kind === 'continent' ? { x: 414, y: 50, width: 180 } : { x: 242, y: 50, width: 210 };
    const options = this.dropdownOptions();
    const visible = options.slice(this.dropdownOffset, this.dropdownOffset + 18);
    const rect = { x: anchor.x, y: anchor.y, width: anchor.width, height: visible.length * 18 + 12 };
    drawEdgedBox(this.surface, rect, DIALOG_EDGE);
    visible.forEach((option, index) => {
      const y = rect.y + 6 + index * 18;
      const selected = kind === 'continent' ? option.id === this.activeContinentId : option.id === (this.currentArea?.areaId ?? 0);
      if (selected || this.isHover(`option:${kind}:${option.id}`)) {
        this.surface.ctx.fillStyle = selected ? 'rgba(196,138,28,0.45)' : 'rgba(255,209,0,0.18)';
        this.surface.ctx.fillRect(rect.x + 7, y, rect.width - 14, 17);
      }
      this.surface.text(option.label, rect.x + 11, y + 9, { size: 11, color: selected ? '#ffffff' : '#ffd100', baseline: 'middle', maxWidth: rect.width - 22 });
      this.hit(`option:${kind}:${option.id}`, { x: rect.x + 7, y, width: rect.width - 14, height: 18 }, { data: option.id });
    });
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') return this.close();
    if (hit.id === 'zoom-out') {
      const continent = continentById.get(this.activeContinentId);
      this.setArea(continent ? continentAreaByMap.get(continent.mapId) : undefined);
      return;
    }
    if (hit.id.startsWith('selector:')) {
      const kind = hit.id.slice('selector:'.length) as DropdownKind;
      this.dropdown = this.dropdown === kind ? undefined : kind;
      this.dropdownOffset = 0;
      return;
    }
    if (hit.id.startsWith('option:')) {
      const [, kind, rawId] = hit.id.split(':');
      const id = Number(rawId);
      this.dropdown = undefined;
      if (kind === 'continent') {
        this.activeContinentId = id;
        const continent = continentById.get(id);
        this.setArea(continent ? continentAreaByMap.get(continent.mapId) : undefined);
      } else if (id === 0) {
        const continent = continentById.get(this.activeContinentId);
        this.setArea(continent ? continentAreaByMap.get(continent.mapId) : undefined);
      } else this.setArea(areasById.get(id));
      return;
    }
    if (hit.id.startsWith('area:')) this.setArea(areasById.get(Number(hit.id.slice(5))));
  }

  private setArea(area: WorldMapAreaMeta | undefined) {
    if (!area) return;
    this.currentArea = area;
    this.activeContinentId = continentByMap.get(area.mapId)?.id ?? this.activeContinentId;
    this.dropdown = undefined;
    this.surface.requestRender();
  }
}

export function createWorldMapFrame(): WorldMapFrame {
  const element = document.createElement('div');
  element.id = 'wow-world-map-frame';
  element.className = 'wow-world-map-frame is-hidden';
  const panel = new WorldMapCanvasPanel(element);
  const fit = () => panel.fit();
  window.addEventListener('resize', fit);
  return {
    element,
    open: () => panel.open(),
    close: () => panel.close(),
    toggle: () => panel.isOpen() ? panel.close() : panel.open(),
    isOpen: () => panel.isOpen(),
    setCurrentWorld: (state) => panel.setCurrentWorld(state),
    setExploredZones: (bits) => panel.setExploredZones(bits),
    setGossipPoi: (poi) => panel.setGossipPoi(poi),
  };
}
