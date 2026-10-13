import { AREA_META } from '../data/world-map';
import { ensureVanillaFonts, VanillaCanvas } from './vanilla-canvas';

type Territory = 'friendly' | 'hostile' | 'contested' | 'normal';

export type ZoneTextState = {
  mapId: number;
  zoneId: number;
  areaId: number;
  zoneName: string;
  subZoneName?: string;
  playerRace?: number;
};

type Banner = {
  kind: 'zone' | 'subzone';
  zoneName: string;
  subZoneName?: string;
  territory: Territory;
  factionName?: 'Alliance' | 'Horde';
  startedAt: number;
};

const FADE_IN_MS = 500;
const HOLD_MS = 1_000;
const FADE_OUT_MS = 2_000;
const TOTAL_MS = FADE_IN_MS + HOLD_MS + FADE_OUT_MS;
const ALLIANCE_RACES = new Set([1, 3, 4, 7]);
const HORDE_RACES = new Set([2, 5, 6, 8]);
const COLORS: Record<Territory, string> = {
  friendly: '#1aff1a', hostile: '#ff1a1a', contested: '#ffb300', normal: '#ffedc2',
};

export function zoneTerritory(mapId: number, zoneId: number, playerRace?: number): Territory {
  // Global-WMO/dungeon maps do not present a faction-controlled outdoor territory.
  if (mapId !== 0 && mapId !== 1) return 'normal';
  const factionMask = Number(AREA_META[zoneId]?.factionGroupMask ?? 0);
  if (!factionMask) return 'contested';
  const playerMask = ALLIANCE_RACES.has(playerRace ?? 0) ? 2 : HORDE_RACES.has(playerRace ?? 0) ? 4 : 0;
  if (!playerMask) return 'normal';
  return (factionMask & playerMask) !== 0 ? 'friendly' : 'hostile';
}

function zoneFactionName(zoneId: number): 'Alliance' | 'Horde' | undefined {
  const factionMask = Number(AREA_META[zoneId]?.factionGroupMask ?? 0);
  if (factionMask === 2) return 'Alliance';
  if (factionMask === 4) return 'Horde';
  return undefined;
}

/** Canvas transcription of FrameXML/ZoneText.xml from Build 5875. */
export class ZoneTextCanvas {
  private readonly surface = new VanillaCanvas(640, 180, 'wow-zone-text-canvas');
  private previous?: Pick<ZoneTextState, 'mapId' | 'zoneId' | 'areaId'>;
  private banner?: Banner;
  private animationFrame?: number;

  constructor(host: HTMLElement) {
    const canvas = this.surface.canvas;
    Object.assign(canvas.style, {
      position: 'absolute', left: '50%', top: '18%', transform: 'translateX(-50%)',
      width: '640px', height: '180px', zIndex: '18', pointerEvents: 'none',
    });
    host.append(canvas);
    this.surface.onRender(() => this.paint(performance.now()));
    void ensureVanillaFonts().then(() => this.surface.requestRender());
  }

  update(state: ZoneTextState) {
    const previous = this.previous;
    this.previous = { mapId: state.mapId, zoneId: state.zoneId, areaId: state.areaId };
    const zoneChanged = !previous || previous.mapId !== state.mapId || previous.zoneId !== state.zoneId;
    const areaChanged = zoneChanged || previous.areaId !== state.areaId;
    if (!areaChanged) return;
    const subZoneName = state.subZoneName?.trim();
    if (!zoneChanged && !subZoneName) return;
    this.banner = {
      kind: zoneChanged ? 'zone' : 'subzone',
      zoneName: state.zoneName,
      subZoneName,
      territory: zoneTerritory(state.mapId, state.zoneId, state.playerRace),
      factionName: zoneFactionName(state.zoneId),
      startedAt: performance.now(),
    };
    if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
    this.tick();
  }

  private readonly tick = () => {
    this.surface.requestRender();
    if (!this.banner || performance.now() - this.banner.startedAt >= TOTAL_MS) {
      this.banner = undefined;
      this.animationFrame = undefined;
      this.surface.requestRender();
      return;
    }
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private paint(now: number) {
    const ctx = this.surface.ctx;
    this.surface.clear();
    if (!this.banner) return;
    const elapsed = now - this.banner.startedAt;
    const alpha = elapsed < FADE_IN_MS ? elapsed / FADE_IN_MS
      : elapsed < FADE_IN_MS + HOLD_MS ? 1
        : Math.max(0, 1 - (elapsed - FADE_IN_MS - HOLD_MS) / FADE_OUT_MS);
    const color = COLORS[this.banner.territory];
    ctx.save();
    ctx.globalAlpha = alpha;
    if (this.banner.kind === 'zone') {
      this.outlinedText(this.banner.zoneName, 320, 61, 42, color);
      const territory = this.territoryLabel(this.banner.territory, this.banner.factionName);
      if (territory) this.outlinedText(territory, 320, 100, 18, color);
      if (this.banner.subZoneName) this.outlinedText(this.banner.subZoneName, 320, 130, 20, color);
    } else if (this.banner.subZoneName) {
      this.outlinedText(this.banner.subZoneName, 320, 82, 24, color);
    }
    ctx.restore();
  }

  private outlinedText(text: string, x: number, y: number, size: number, color: string) {
    const ctx = this.surface.ctx;
    ctx.font = `${size}px "Friz Quadrata", "Times New Roman", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size * 0.1);
    ctx.strokeStyle = 'rgba(0,0,0,.95)';
    ctx.strokeText(text, x, y, 610);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y, 610);
  }

  private territoryLabel(territory: Territory, factionName?: 'Alliance' | 'Horde') {
    if ((territory === 'friendly' || territory === 'hostile') && factionName) return `${factionName} Territory`;
    if (territory === 'contested') return 'Contested Territory';
    return '';
  }
}
