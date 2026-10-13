/** Fixed-capacity chronological history; incoming lines never shift the backing array. */
export class CombatLogHistory<T> {
  private readonly values: T[] = [];
  private head = 0;
  constructor(private readonly capacity: number) {}
  get length(): number { return this.values.length; }
  push(value: T): void {
    if (this.values.length < this.capacity) this.values.push(value);
    else { this.values[this.head] = value; this.head = (this.head + 1) % this.capacity; }
  }
  at(index: number): T { return this.values[(this.head + index) % this.values.length]; }
  toArray(): T[] { return Array.from({ length: this.length }, (_, i) => this.at(i)); }
}
