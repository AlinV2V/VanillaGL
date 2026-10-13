export const PLAYER_EXPLORED_ZONE_WORDS = 64;

export type WorldMapAreaExplorationMeta = {
  exploreFlag: number;
};

/**
 * Build 5875's map-state rebuild (WoW.exe FUN_004a67a0) walks the four
 * WorldMapOverlay area IDs and keeps the overlay as soon as one AreaTable
 * exploreFlag is present in PLAYER_EXPLORED_ZONES_1..64.
 */
export function isWorldMapOverlayExplored(
  areaIds: readonly number[],
  areaMeta: Readonly<Record<number, WorldMapAreaExplorationMeta | undefined>>,
  exploredZoneBits: readonly number[],
): boolean {
  for (let index = 0; index < Math.min(4, areaIds.length); index++) {
    const area = areaMeta[areaIds[index]];
    if (!area || !Number.isInteger(area.exploreFlag) || area.exploreFlag < 0) continue;
    const wordIndex = Math.floor(area.exploreFlag / 32);
    if (wordIndex >= PLAYER_EXPLORED_ZONE_WORDS || wordIndex >= exploredZoneBits.length) continue;
    const mask = (1 << (area.exploreFlag & 31)) >>> 0;
    if (((exploredZoneBits[wordIndex] ?? 0) >>> 0 & mask) !== 0) return true;
  }
  return false;
}
