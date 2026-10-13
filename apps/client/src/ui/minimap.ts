/** Asset conversion utility. */
import { CanvasPanel, type PanelHit } from './panel-kit';
import { containsPoint } from './vanilla-canvas';
import { minimapRepaintMode, onPerformanceControlChange } from '../rendering/performance-controls';
import { performanceAblations } from '../rendering/performance-detail-diagnostics';
import { recordMinimapPaint } from '../rendering/performance-subsystem-metrics';
import { minimapBackgroundNeedsPaint, minimapHeadingNeedsPaint } from './minimap-repaint-policy';
import { beginCpuScope, CpuScopeId, endCpuScope } from '../rendering/performance-cpu-scopes'; import { zoneCoordinateText } from './map-coordinates';
import { isBuiltInAddonEnabled, onBuiltInAddonSettings } from './builtin-addons';

const TILE_YARDS = 533.33333;
const MIN_YARDS = 110;
const MAX_YARDS = 760;
const DEFAULT_YARDS = 300;
const CLUSTER_WIDTH = 192;
const CLUSTER_HEIGHT = 208;
const MAP_CENTER = { x: 105, y: 92 } as const;
/** Minimap.xml:97-99 — the `<Minimap>` frame is 140x140, so the drawn circle is r=70, not 68. */
const MAP_RADIUS = 70;
const MINIMAP = '/ui/Interface/Minimap';

export type MinimapBlip = {
  guid: string;
  worldX: number;
  worldY: number;
  heading?: number;
  kind: 'party' | 'friendly' | 'hostile' | 'neutral' | 'quest' | 'corpse' | 'tracking';
  questKind?: 'available' | 'turnin' | 'turnin-incomplete' | 'objective';
  title?: string;
  detail?: string;
};

/** A group member's MSG_MINIMAP_PING, in world coordinates, with the time it arrived. */
export type MinimapPing = { guid: string; worldX: number; worldY: number; at: number };

/**
 * MiniMapPing (Minimap.xml:235) is a `Model` playing `Interface\MiniMap\Ping\MinimapPing.mdx` at
 * scale 0.4 — not a static texture, so it cannot be reproduced exactly on a 2D canvas. What we
 * have on disk is that model's own texture set (ping2/4/5/6.png); cycling those four frames over
 * the ping's lifetime reproduces the animation from the art it was authored with.
 */
const PING_FRAMES = ['ping2', 'ping4', 'ping5', 'ping6'] as const;
const PING_LIFETIME_MS = 5000;

const sameBlips = (a: readonly MinimapBlip[], b: readonly MinimapBlip[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x.guid !== y.guid || x.worldX !== y.worldX || x.worldY !== y.worldY || x.heading !== y.heading || x.kind !== y.kind
      || x.questKind !== y.questKind || x.title !== y.title || x.detail !== y.detail) return false;
  }
  return true;
};

export type Minimap = {
  element: HTMLElement;
  setMap(mapDir: string | null): void;
  update(worldX: number, worldY: number, headingRad: number, mapId?: number): void;
  setBlips(blips: readonly MinimapBlip[]): void;
  setTrackingActive(active: boolean): void;
  setPing(ping: MinimapPing): void;
  setZone(name: string): void;
  setTimeOfDay(halfMinutes: number): void;
  setPerf(fps: number, ms: number): void;
  show(): void;
  hide(): void;
};

class MinimapCanvasPanel extends CanvasPanel {
  private yardsAcross = DEFAULT_YARDS;
  private mapDir: string | null = null;
  private manifest: Set<string> | null = null;
  private last?: { x: number; y: number; heading: number; mapId?: number };
  private blips: readonly MinimapBlip[] = [];
  private trackingActive = false;
  private ping?: MinimapPing;
  private zone = '';
  private timeText = '12:00';
  private day = true;
  private perf = '';
  private readonly terrainCache = document.createElement('canvas');
  private readonly terrainCacheCtx = this.terrainCache.getContext('2d')!;
  private backgroundDirty = true;
  private backgroundX = Number.NaN; private backgroundY = Number.NaN; private paintedHeading = Number.NaN;

  constructor(readonly host: HTMLElement) {
    super(host, CLUSTER_WIDTH, CLUSTER_HEIGHT, 'wow-minimap-canvas');
    this.terrainCache.width = CLUSTER_WIDTH; this.terrainCache.height = CLUSTER_HEIGHT;
    onPerformanceControlChange(() => { this.backgroundDirty = true; this.surface.requestRender(); }); onBuiltInAddonSettings(() => this.surface.requestRender());
    this.onWheel = (direction, point) => {
      if (!containsPoint({ x: MAP_CENTER.x - MAP_RADIUS, y: MAP_CENTER.y - MAP_RADIUS, width: MAP_RADIUS * 2, height: MAP_RADIUS * 2 }, point)) return;
      this.zoom(direction > 0 ? 1.2 : 1 / 1.2);
    };
  }

  setMap(dir: string | null) {
    if (dir === this.mapDir) return;
    this.mapDir = dir;
    this.manifest = null;
    this.backgroundDirty = true;
    this.surface.requestRender();
    if (!dir) return;
    void fetch(`/minimap/${dir}/manifest.json`, { cache: 'no-cache' })
      .then((response) => response.ok ? response.json() : null)
      .then((manifest: { tiles?: string[] } | null) => {
        if (this.mapDir !== dir) return;
        this.manifest = new Set(manifest?.tiles ?? []);
        this.backgroundDirty = true;
        this.surface.requestRender();
      })
      .catch(() => {
        if (this.mapDir === dir) { this.manifest = new Set(); this.backgroundDirty = true; this.surface.requestRender(); }
      });
  }

  update(x: number, y: number, heading: number, mapId?: number) {
    if (!this.last) this.last = { x, y, heading, mapId };
    else { this.last.x = x; this.last.y = y; this.last.heading = heading; this.last.mapId = mapId; }
    if (minimapRepaintMode() === 'off') { recordMinimapPaint('skipped'); return; }
    const pixelsPerYard = (MAP_RADIUS * 2) / this.yardsAcross;
    if (minimapBackgroundNeedsPaint(x, y, this.backgroundX, this.backgroundY, pixelsPerYard)) this.backgroundDirty = true;
    if (this.backgroundDirty || minimapHeadingNeedsPaint(heading, this.paintedHeading)) this.surface.requestRender();
  }

  setBlips(blips: readonly MinimapBlip[]) {
    if (sameBlips(this.blips, blips)) return;
    this.blips = blips;
    this.surface.requestRender();
  }

  setTrackingActive(active: boolean) {
    if (active === this.trackingActive) return;
    this.trackingActive = active;
    this.surface.requestRender();
  }

  setPing(ping: MinimapPing) {
    if (this.ping?.guid === ping.guid && this.ping.at === ping.at && this.ping.worldX === ping.worldX && this.ping.worldY === ping.worldY) return;
    this.ping = ping;
    this.surface.requestRender();
  }

  setZone(name: string) {
    if (name === this.zone) return;
    this.zone = name;
    this.surface.requestRender();
  }

  setTimeOfDay(halfMinutes: number) {
    const totalMinutes = Math.floor((((halfMinutes / 2) % 1440) + 1440) % 1440);
    const hour = Math.floor(totalMinutes / 60);
    const nextDay = hour >= 6 && hour < 20;
    const nextText = `${String(hour).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
    if (nextDay === this.day && nextText === this.timeText) return;
    this.day = nextDay;
    this.timeText = nextText;
    this.surface.requestRender();
  }

  setPerf(fps: number, ms: number) {
    const next = `${Math.round(fps)} fps  ${ms.toFixed(1)} ms`;
    if (next === this.perf) return;
    this.perf = next;
    this.surface.requestRender();
  }

  protected paint() {
    const s = this.surface;
    const ctx = s.ctx;
    const mode = minimapRepaintMode();
    if (mode === 'off') { recordMinimapPaint('skipped'); return; }
    s.clear();
    if (mode === 'baseline' || this.backgroundDirty) {
      const cpuScope = beginCpuScope(CpuScopeId.MinimapBackground);
      try {
      const started = performanceAblations.detail ? performance.now() : 0;
      ctx.save(); ctx.beginPath(); ctx.arc(MAP_CENTER.x, MAP_CENTER.y, MAP_RADIUS, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#080b08'; ctx.fillRect(MAP_CENTER.x - MAP_RADIUS, MAP_CENTER.y - MAP_RADIUS, MAP_RADIUS * 2, MAP_RADIUS * 2);
      const ready = this.last ? this.drawTerrain(this.last) : true; ctx.restore();
      this.terrainCacheCtx.clearRect(0, 0, CLUSTER_WIDTH, CLUSTER_HEIGHT); this.terrainCacheCtx.drawImage(s.canvas, 0, 0);
      this.backgroundDirty = !ready; this.backgroundX = this.last?.x ?? Number.NaN; this.backgroundY = this.last?.y ?? Number.NaN;
      recordMinimapPaint('background', performanceAblations.detail ? performance.now() - started : 0);
      } finally { endCpuScope(cpuScope); }
    } else {
      ctx.drawImage(this.terrainCache, 0, 0); recordMinimapPaint('skipped');
    }
    const overlayCpuScope = beginCpuScope(CpuScopeId.MinimapOverlays);
    try {
    const overlayStarted = performanceAblations.detail ? performance.now() : 0;
    ctx.save(); ctx.beginPath(); ctx.arc(MAP_CENTER.x, MAP_CENTER.y, MAP_RADIUS, 0, Math.PI * 2); ctx.clip();
    if (this.last) this.drawBlips(this.last);
    if (this.last) this.drawPing(this.last);
    if (this.last) this.drawPlayer(this.last.heading);
    ctx.restore();

    // Minimap.xml: top strip is atlas x=.25..1/y=0...125; backdrop is
    // x=.25..1/y=.125...875 and is centered 20 px below the cluster.
    s.sprite(`${MINIMAP}/UI-Minimap-Border.png`, 64, 32, 192, 192, 0, 20, 192, 192);
    s.sprite(`${MINIMAP}/UI-Minimap-Border.png`, 64, 0, 192, 32, 0, 0, 192, 32);
    // MinimapZoneText inherits GameFontNormal (Minimap.xml:41), which Fonts.xml:74-78 defines as
    // 12pt. The colour is NOT the font's — Minimap_Update (Minimap.lua:24-35) overrides it per
    // GetZonePVPInfo: friendly (0.1,1.0,0.1), contested (1.0,0.7,0), hostile/arena (1.0,0.1,0.1),
    // otherwise NORMAL_FONT_COLOR. We have no zone PvP state yet, so this stays on the friendly
    // branch — but it is now Blizzard's exact green rather than an invented one. Wire the other
    // three branches when zone PvP info exists; do not "correct" this to yellow.
    s.text(this.zone || 'Unknown', 93, 13, { size: 12, color: '#1aff1a', align: 'center', baseline: 'middle', maxWidth: 128 });

    // GameTime.xml: 50x50 clock anchored over the backdrop's top-right edge.
    s.sprite(`${MINIMAP}/UI-TOD-Indicator.png`, this.day ? 0 : 64, 0, 64, 64, 146, 39, 50, 50);
    this.hit('clock', { x: 146, y: 39, width: 50, height: 50 }, { silent: true, tooltip: [{ text: this.timeText, color: '#ffffff' }] });

    this.drawMinimizeButton();
    if (this.trackingActive) this.drawTrackingButton();
    this.drawZoomButton('zoom-in', 157, 113, 'ZoomIn');
    this.drawZoomButton('zoom-out', 131, 141, 'ZoomOut');
    if (this.perf) s.text(this.perf, 188, 190, { family: 'sans', size: 9, color: '#e9d7a0', align: 'right', maxWidth: 145 });
    if (isBuiltInAddonEnabled('mapCoordinates') && this.last?.mapId !== undefined) {
      const coords = zoneCoordinateText(this.last.mapId, this.last.x, this.last.y);
      if (coords) s.text(coords, 105, 202, { family: 'sans', size: 10, color: '#ffd100', align: 'center' });
    }
    this.paintedHeading = this.last?.heading ?? Number.NaN;
    recordMinimapPaint('overlay', performanceAblations.detail ? performance.now() - overlayStarted : 0);
    } finally { endCpuScope(overlayCpuScope); }
  }

  private drawTerrain(state: { x: number; y: number }): boolean {
    if (!this.mapDir) return true;
    if (!this.manifest) return false;
    const s = this.surface;
    let ready = true;
    const pixelsPerYard = (MAP_RADIUS * 2) / this.yardsAcross;
    const tileXFloat = 32 - state.y / TILE_YARDS;
    const tileYFloat = 32 - state.x / TILE_YARDS;
    const playerTileX = Math.floor(tileXFloat);
    const playerTileY = Math.floor(tileYFloat);
    const size = TILE_YARDS * pixelsPerYard;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tileX = playerTileX + dx;
        const tileY = playerTileY + dy;
        if (!this.manifest.has(`${tileX}_${tileY}`)) continue;
        const worldNorth = (32 - tileY) * TILE_YARDS;
        const worldWest = (32 - tileX) * TILE_YARDS;
        const x = MAP_CENTER.x + (state.y - worldWest) * pixelsPerYard;
        const y = MAP_CENTER.y - (worldNorth - state.x) * pixelsPerYard;
        ready = s.image(`/minimap/${this.mapDir}/${tileX}_${tileY}.png`, x - 0.5, y - 0.5, size + 1, size + 1) && ready;
      }
    }
    return ready;
  }

  private drawPing(state: { x: number; y: number }) {
    const ping = this.ping;
    if (!ping) return;
    const age = performance.now() - ping.at;
    if (age > PING_LIFETIME_MS) {
      this.ping = undefined;
      return;
    }
    const pixelsPerYard = (MAP_RADIUS * 2) / this.yardsAcross;
    const x = MAP_CENTER.x + (state.y - ping.worldY) * pixelsPerYard;
    const y = MAP_CENTER.y + (state.x - ping.worldX) * pixelsPerYard;
    // Clamp to the rim so a ping outside the current zoom still points somewhere useful.
    const dx = x - MAP_CENTER.x;
    const dy = y - MAP_CENTER.y;
    const dist = Math.hypot(dx, dy);
    const edge = MAP_RADIUS - 6;
    const clamp = dist > edge ? edge / dist : 1;
    const frame = PING_FRAMES[Math.floor((age / 140) % PING_FRAMES.length)];
    const fade = 1 - age / PING_LIFETIME_MS;
    this.surface.addImage(
      `${MINIMAP}/Ping/${frame}.png`,
      MAP_CENTER.x + dx * clamp - 16, MAP_CENTER.y + dy * clamp - 16, 32, 32, fade,
    );
    this.surface.requestRender();
  }

  private drawBlips(state: { x: number; y: number }) {
    const pixelsPerYard = (MAP_RADIUS * 2) / this.yardsAcross;
    for (const blip of this.blips) {
      const x = MAP_CENTER.x + (state.y - blip.worldY) * pixelsPerYard;
      const y = MAP_CENTER.y + (state.x - blip.worldX) * pixelsPerYard;
      const dx = x - MAP_CENTER.x;
      const dy = y - MAP_CENTER.y;
      const dist = Math.hypot(dx, dy);
      const edge = MAP_RADIUS - 8;
      // The corpse arrow is a direction finder, not a plain dot: when your body is off the minimap it
      // clamps to the rim and points toward it (Vanilla ROTATING-MINIMAPCORPSEARROW). Everything else
      // is culled once it leaves the minimap disc.
      if (dist > edge && blip.kind !== 'corpse') continue;
      const ctx = this.surface.ctx;
      if (blip.kind === 'corpse') {
        const clamp = dist > edge ? edge / dist : 1;
        ctx.save();
        ctx.translate(MAP_CENTER.x + dx * clamp, MAP_CENTER.y + dy * clamp);
        // Arrow art points "up" (-Y); rotate so it aims from the player toward the corpse bearing.
        ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2);
        this.surface.image(`${MINIMAP}/ROTATING-MINIMAPCORPSEARROW.png`, -8, -8, 16, 16);
        ctx.restore();
      } else if (blip.kind === 'party') {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-(blip.heading ?? 0));
        this.surface.image(`${MINIMAP}/Rotating-MinimapGroupArrow.png`, -8, -8, 16, 16);
        ctx.restore();
      } else if (blip.kind === 'quest') {
        const objective = blip.questKind === 'objective';
        const color = blip.questKind === 'turnin-incomplete' ? '#9d9d9d' : '#ffd100';
        const radius = objective ? 4 : 7;
        ctx.save();
        ctx.fillStyle = objective ? 'rgba(255,209,0,.86)' : 'rgba(12,10,5,.94)';
        ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.restore();
        if (!objective) this.surface.text(blip.questKind === 'available' ? '!' : '?', x, y + 1, {
          size: 13, color, align: 'center', baseline: 'middle', family: 'sans', font: 'number',
        });
        this.hit(`quest:${blip.guid}`, { x: x - radius - 3, y: y - radius - 3, width: radius * 2 + 6, height: radius * 2 + 6 }, {
          silent: true,
          tooltip: [{ text: blip.title ?? 'Quest', color: '#ffd100' }, { text: blip.detail ?? 'Quest location', color: '#ffffff' }],
        });
      } else {
        // Tracking dots (Track Humanoids/Beasts/...) are the vanilla yellow blip.
        const colors = { friendly: '#20ff38', hostile: '#ff2020', neutral: '#ffe020', tracking: '#ffe020' } as const;
        ctx.save();
        ctx.fillStyle = colors[blip.kind];
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawPlayer(heading: number) {
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.translate(MAP_CENTER.x, MAP_CENTER.y);
    ctx.rotate(-heading);
    this.surface.image(`${MINIMAP}/ROTATING-MINIMAPARROW.png`, -10, -10, 20, 20);
    ctx.restore();
  }

  private drawZoomButton(id: string, x: number, y: number, kind: 'ZoomIn' | 'ZoomOut') {
    const state = this.state(id);
    const suffix = state === 'down' ? 'Down' : 'Up';
    this.surface.image(`${MINIMAP}/UI-Minimap-${kind}Button-${suffix}.png`, x, y, 32, 32);
    if (state === 'hover') this.surface.addImage(`${MINIMAP}/UI-Minimap-ZoomButton-Highlight.png`, x, y, 32, 32);
    this.hit(id, { x, y, width: 32, height: 32 });
  }

  private drawMinimizeButton() {
    const id = 'minimize';
    const state = this.state(id);
    const suffix = state === 'down' ? 'Down' : 'Up';
    this.surface.image(`/ui/Interface/Buttons/UI-Panel-MinimizeButton-${suffix}.png`, 160, -3, 32, 32);
    if (state === 'hover') this.surface.addImage('/ui/Interface/Buttons/UI-Panel-MinimizeButton-Highlight.png', 160, -3, 32, 32);
    this.hit(id, { x: 160, y: 0, width: 32, height: 29 }, { tooltip: [{ text: 'Toggle Minimap', color: '#ffffff' }] });
  }

  private drawTrackingButton() {
    const id = 'tracking';
    // Minimap.xml:109-143 — the 33x33 frame is anchored at Minimap TOPLEFT (-15, 0), but its
    // authored border deliberately overflows at 64x64 and the aura icon remains 26x26.
    this.surface.image('/ui/Interface/Icons/Ability_Tracking.png', 27, 28, 26, 26);
    this.surface.image(`${MINIMAP}/MiniMap-TrackingBorder.png`, 20, 22, 64, 64);
    this.hit(id, { x: 20, y: 22, width: 33, height: 33 }, { tooltip: [{ text: 'Tracking', color: '#ffffff' }] });
  }

  private zoom(factor: number) {
    this.yardsAcross = Math.max(MIN_YARDS, Math.min(MAX_YARDS, this.yardsAcross * factor));
    this.backgroundDirty = true;
    this.surface.requestRender();
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'zoom-in') this.zoom(1 / 1.25);
    if (hit.id === 'zoom-out') this.zoom(1.25);
    if (hit.id === 'minimize') this.host.classList.toggle('is-minimized');
  }
}

export function createMinimap(): Minimap {
  const element = document.createElement('div');
  element.id = 'wow-minimap';
  element.className = 'wow-minimap has-canvas-ui is-hidden';
  const panel = new MinimapCanvasPanel(element);
  return {
    element,
    setMap: (dir) => panel.setMap(dir),
    update: (x, y, heading, mapId) => panel.update(x, y, heading, mapId),
    setBlips: (blips) => panel.setBlips(blips),
    setTrackingActive: (active) => panel.setTrackingActive(active),
    setPing: (ping) => panel.setPing(ping),
    setZone: (name) => panel.setZone(name),
    setTimeOfDay: (time) => panel.setTimeOfDay(time),
    setPerf: (fps, ms) => panel.setPerf(fps, ms),
    show: () => element.classList.remove('is-hidden'),
    hide: () => element.classList.add('is-hidden'),
  };
}
