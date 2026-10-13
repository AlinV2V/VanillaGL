type SpatialEntry<T> = { value: T; cellX: number; cellY: number };

const cellKey = (x: number, y: number) => `${x}:${y}`;

/** Mutable, allocation-stable 2D broad phase shared by world state and presentation. */
export class SpatialIndex2D<T> {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, SpatialEntry<T>>();
  private readonly seen = new Set<string>();

  constructor(private readonly cellSize = 32) {}

  update(id: string, value: T, x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const cellX = Math.floor(x / this.cellSize), cellY = Math.floor(y / this.cellSize);
    const previous = this.entries.get(id);
    if (previous?.cellX === cellX && previous.cellY === cellY) { previous.value = value; return; }
    if (previous) this.removeFromCell(id, previous.cellX, previous.cellY);
    const key = cellKey(cellX, cellY);
    let bucket = this.cells.get(key);
    if (!bucket) { bucket = new Set(); this.cells.set(key, bucket); }
    bucket.add(id);
    this.entries.set(id, { value, cellX, cellY });
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.removeFromCell(id, entry.cellX, entry.cellY);
    this.entries.delete(id);
  }

  clear(): void { this.cells.clear(); this.entries.clear(); this.seen.clear(); }

  queryBounds(minX: number, minY: number, maxX: number, maxY: number, target: T[]): T[] {
    target.length = 0;
    const firstX = Math.floor(minX / this.cellSize), lastX = Math.floor(maxX / this.cellSize);
    const firstY = Math.floor(minY / this.cellSize), lastY = Math.floor(maxY / this.cellSize);
    for (let cellX = firstX; cellX <= lastX; cellX++) for (let cellY = firstY; cellY <= lastY; cellY++) {
      this.appendCell(cellX, cellY, target);
    }
    return target;
  }

  queryCircle(x: number, y: number, radius: number, target: T[]): T[] {
    return this.queryBounds(x - radius, y - radius, x + radius, y + radius, target);
  }

  /** Sample a screen-pick ray plus two neighbor cells to retain large gameobject hit boxes. */
  queryRay(originX: number, originY: number, directionX: number, directionY: number, distance: number, target: T[]): T[] {
    target.length = 0; this.seen.clear();
    const planarLength = Math.hypot(directionX, directionY) * distance;
    const steps = Math.max(1, Math.ceil(planarLength / (this.cellSize * 0.5)));
    for (let step = 0; step <= steps; step++) {
      const along = distance * step / steps;
      const cellX = Math.floor((originX + directionX * along) / this.cellSize);
      const cellY = Math.floor((originY + directionY * along) / this.cellSize);
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) this.appendCell(cellX + dx, cellY + dy, target, true);
    }
    this.seen.clear();
    return target;
  }

  diagnostics(): { entries: number; cells: number } { return { entries: this.entries.size, cells: this.cells.size }; }

  private appendCell(cellX: number, cellY: number, target: T[], dedupe = false): void {
    const bucket = this.cells.get(cellKey(cellX, cellY));
    if (!bucket) return;
    for (const id of bucket) {
      if (dedupe && this.seen.has(id)) continue;
      if (dedupe) this.seen.add(id);
      const entry = this.entries.get(id);
      if (entry) target.push(entry.value);
    }
  }

  private removeFromCell(id: string, cellX: number, cellY: number): void {
    const key = cellKey(cellX, cellY), bucket = this.cells.get(key);
    if (!bucket) return;
    bucket.delete(id);
    if (!bucket.size) this.cells.delete(key);
  }
}

type BoundsEntry<T> = { value: T; cells: string[] };

/** Grid broad phase for objects whose bounds may span several cells. */
export class SpatialBoundsIndex2D<T> {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, BoundsEntry<T>>();
  private readonly seen = new Set<string>();

  constructor(private readonly cellSize = 64) {}

  update(id: string, value: T, minX: number, minY: number, maxX: number, maxY: number): void {
    this.remove(id);
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return;
    const keys: string[] = [];
    for (let x = Math.floor(minX / this.cellSize); x <= Math.floor(maxX / this.cellSize); x++) {
      for (let y = Math.floor(minY / this.cellSize); y <= Math.floor(maxY / this.cellSize); y++) {
        const key = cellKey(x, y);
        let bucket = this.cells.get(key);
        if (!bucket) { bucket = new Set(); this.cells.set(key, bucket); }
        bucket.add(id); keys.push(key);
      }
    }
    this.entries.set(id, { value, cells: keys });
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const key of entry.cells) {
      const bucket = this.cells.get(key);
      bucket?.delete(id);
      if (bucket && !bucket.size) this.cells.delete(key);
    }
    this.entries.delete(id);
  }

  queryPoint(x: number, y: number, target: T[]): T[] {
    target.length = 0; this.seen.clear();
    const bucket = this.cells.get(cellKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)));
    if (bucket) for (const id of bucket) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      const entry = this.entries.get(id);
      if (entry) target.push(entry.value);
    }
    this.seen.clear();
    return target;
  }

  clear(): void { this.cells.clear(); this.entries.clear(); this.seen.clear(); }
  diagnostics(): { entries: number; cells: number } { return { entries: this.entries.size, cells: this.cells.size }; }
}
