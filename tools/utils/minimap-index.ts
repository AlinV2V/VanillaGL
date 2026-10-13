import { join } from 'node:path';
import { DATA_DIR } from './paths.ts';

export type MinimapIndex = {
  maps: Record<string, Record<string, string>>;
};

export const MINIMAP_TRS_ARCHIVE_PATH = 'Textures\\Minimap\\md5translate.trs';
export const MINIMAP_TRANSLATION_PATH = join(DATA_DIR, 'md5translate.trs');
export const MINIMAP_INDEX_PATH = join(DATA_DIR, 'minimap_tile_index.json');

function normalizedMapName(value: string): string {
  return value.replace(/\//g, '\\').split('\\').filter(Boolean).at(-1)?.trim() ?? '';
}

export function parseMinimapTranslation(content: string): MinimapIndex {
  const maps: Record<string, Record<string, string>> = {};
  let currentDir = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    if (/^dir:/i.test(line)) {
      currentDir = normalizedMapName(line.slice(line.indexOf(':') + 1));
      continue;
    }

    const columns = line.split(/\t+/);
    if (columns.length < 2) continue;

    const logical = columns[0].trim().replace(/\//g, '\\');
    const physical = columns[1].trim().replace(/\//g, '\\');
    if (!logical || !physical) continue;

    const logicalParts = logical.split('\\').filter(Boolean);
    const filename = logicalParts.at(-1) ?? '';
    const match = /^map(\d+)_(\d+)\.blp$/i.exec(filename);
    if (!match) continue;

    const mapName = logicalParts.length > 1
      ? normalizedMapName(logicalParts.at(-2) ?? '')
      : currentDir;
    if (!mapName) continue;

    maps[mapName] ??= {};
    maps[mapName][`${Number(match[1])}_${Number(match[2])}`] = physical;
  }

  return { maps };
}

export function minimapArchivePath(physicalName: string): string {
  const normalized = physicalName.trim().replace(/\//g, '\\').replace(/^\\+/, '');
  if (/^Textures\\Minimap\\/i.test(normalized)) return normalized;
  return `Textures\\Minimap\\${normalized}`;
}

export function findMinimapMap(
  maps: MinimapIndex['maps'],
  requestedName: string,
): { name: string; tiles: Record<string, string> } | null {
  const exact = maps[requestedName];
  if (exact) return { name: requestedName, tiles: exact };
  const key = Object.keys(maps).find((name) => name.toLowerCase() === requestedName.toLowerCase());
  return key ? { name: key, tiles: maps[key] } : null;
}
