/** Asset conversion utility. */
import { ZoneTextCanvas } from './zone-text';

export interface WorldMapCoordsEntry {
  worldMapAreaId: number;
  mapId: number;
  areaTableId: number;
  zoneName: string;
  bounds: {
    y1_west: number;
    y2_east: number;
    x1_north: number;
    x2_south: number;
  };
}

export class ZoneTracker {
  private azerothZmp: Uint8Array | null = null;
  private kalimdorZmp: Uint8Array | null = null;
  private areaParents: Record<number, number> = {};
  private worldMapCoords: WorldMapCoordsEntry[] = [];

  private readonly zoneText: ZoneTextCanvas;

  constructor(host: HTMLElement) {
    this.zoneText = new ZoneTextCanvas(host);
  }

  async init() {
    const [az, kal, parents, coords] = await Promise.all([
      fetch('/terrain/azeroth_zmp.bin').then((r) => r.arrayBuffer()).then((ab) => new Uint8Array(ab)),
      fetch('/terrain/kalimdor_zmp.bin').then((r) => r.arrayBuffer()).then((ab) => new Uint8Array(ab)),
      fetch('/terrain/area_parents.json').then((r) => r.json()),
      fetch('/terrain/world_map_coords.json').then((r) => r.json())
    ]);

    this.azerothZmp = az;
    this.kalimdorZmp = kal;
    this.areaParents = parents;
    this.worldMapCoords = coords.areas;
  }

  /**
   * Projects player coordinates to the 128x128 ZMP grid to find the AreaTable ID.
   */
  getAreaId(mapId: number, wx: number, wy: number): number {
    const zmp = mapId === 0 ? this.azerothZmp : mapId === 1 ? this.kalimdorZmp : null;
    if (!zmp) return 0;

    const ftx = 32 - wy / 533.33333;
    const fty = 32 - wx / 533.33333;
    if (ftx < 0 || ftx >= 64 || fty < 0 || fty >= 64) return 0;

    const zx = Math.floor(ftx * 2);
    const zy = Math.floor(fty * 2);
    const idx = (zy * 128 + zx) * 4;
    
    if (idx < 0 || idx >= zmp.length) return 0;

    // Read 32-bit little-endian integer
    return zmp[idx] | (zmp[idx + 1] << 8) | (zmp[idx + 2] << 16) | (zmp[idx + 3] << 24);
  }

  /**
   * Resolve an Area ID to its corresponding WorldMapArea entry.
   * If the specific subzone is not mapped, climbs the parent hierarchy.
   */
  resolveZone(mapId: number, areaId: number): WorldMapCoordsEntry | null {
    let currentId = areaId;
    while (currentId > 0) {
      const match = this.worldMapCoords.find((a) => a.mapId === mapId && a.areaTableId === currentId);
      if (match) return match;
      currentId = this.areaParents[currentId] || 0;
    }
    return null;
  }

  updateBanner(mapId: number, areaId: number, areaName: string | undefined, playerRace: number | undefined) {
    const zone = this.resolveZone(mapId, areaId);
    const zoneId = zone?.areaTableId ?? areaId;
    const zoneName = zone?.zoneName ?? areaName;
    if (!zoneName) return;
    this.zoneText.update({
      mapId,
      zoneId,
      areaId,
      zoneName,
      subZoneName: areaId !== zoneId ? areaName : undefined,
      playerRace,
    });
  }
}
