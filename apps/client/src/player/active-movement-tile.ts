import { tileForCharacter, type TileEntry } from '../tile-utils';
import type { LoadedTile } from '../wow-app-types';

type Deps = {
  localToWorld(x: number, y: number): { x: number; y: number } | null;
  tileIndex: TileEntry[];
  getCurrentMap(): number;
  loadedTiles: Map<string, LoadedTile>;
  loadingTiles: Map<string, Promise<LoadedTile>>;
  getCurrentTile(): LoadedTile | null;
  setCurrentTile(tile: LoadedTile): void;
  ensureTileNeighborhood(entry: TileEntry): Promise<LoadedTile>;
  log(message: string): void;
};

export function updateActiveMovementTile(deps: Deps, position: { x: number; y: number; z: number }): void {
  const world = deps.localToWorld(position.x, position.y);
  if (!world) return;
  const entry = tileForCharacter(deps.tileIndex, { map: deps.getCurrentMap(), x: world.x, y: world.y, z: position.z });
  if (!entry) return;
  const loaded = deps.loadedTiles.get(entry.key);
  if (loaded && deps.getCurrentTile()?.key !== entry.key) {
    deps.setCurrentTile(loaded);
    void deps.ensureTileNeighborhood(entry).catch(error => deps.log(`streaming: ${String(error)}`));
    deps.log(`streaming: active tile ${entry.key}`);
  } else if (!loaded && !deps.loadingTiles.has(entry.key)) {
    void deps.ensureTileNeighborhood(entry).catch(error => deps.log(`streaming: ${String(error)}`));
  }
}
