import type { LootRollEvent } from '../world';
import { VanillaCanvas } from './vanilla-canvas';

type Roll = Extract<LootRollEvent, { kind: 'start' }> & { startedAt: number; decided?: 0 | 1 | 2 };

const BUTTONS = [
  { vote: 1 as const, label: 'Need', file: 'Dice' },
  { vote: 2 as const, label: 'Greed', file: 'Coin' },
  { vote: 0 as const, label: 'Pass', file: 'Pass' },
];

/** Vanilla GroupLootFrame1..4: four concurrent countdown rows with Need/Greed/Pass. */
export class LootRollCanvas {
  private readonly surface = new VanillaCanvas(320, 224, 'wow-loot-roll-canvas');
  private readonly rolls = new Map<string, Roll>();
  private frame = 0;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    itemIconUrl: (entry: number) => string;
    itemName: (entry: number) => string;
    vote: (lootGuid: string, itemSlot: number, vote: 0 | 1 | 2) => void;
    announce: (message: string) => void;
  }) {
    host.appendChild(this.surface.canvas);
    this.surface.onRender(() => this.paint());
    this.surface.canvas.addEventListener('pointerup', (event) => this.activate(event));
  }

  handle(event: LootRollEvent) {
    const key = `${event.lootGuid}:${event.itemSlot}`;
    if (event.kind === 'start') {
      this.rolls.set(key, { ...event, startedAt: performance.now() });
      this.host.classList.remove('is-hidden');
      this.ensureTicking();
    } else if (event.kind === 'won') {
      this.rolls.delete(key);
      this.deps.announce(`${this.deps.itemName(event.itemEntry)} won with ${event.rollNumber}.`);
    } else if (event.kind === 'allPassed') {
      this.rolls.delete(key);
      this.deps.announce(`Everyone passed on ${this.deps.itemName(event.itemEntry)}.`);
    }
    this.sync();
  }

  clear() {
    this.rolls.clear();
    this.sync();
  }

  private ensureTicking() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.tick());
  }

  private tick() {
    this.frame = 0;
    const now = performance.now();
    for (const [key, roll] of this.rolls) {
      if (now - roll.startedAt >= roll.countdownMs) this.rolls.delete(key);
    }
    this.sync();
    if (this.rolls.size) this.ensureTicking();
  }

  private sync() {
    this.host.classList.toggle('is-hidden', this.rolls.size === 0);
    this.surface.requestRender();
  }

  private activate(event: PointerEvent) {
    const rect = this.surface.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (320 / rect.width);
    const y = (event.clientY - rect.top) * (224 / rect.height);
    const row = Math.floor(y / 56);
    const roll = [...this.rolls.values()][row];
    if (!roll || roll.decided !== undefined) return;
    for (let button = 0; button < BUTTONS.length; button++) {
      const bx = 166 + button * 43;
      if (x >= bx && x <= bx + 32 && y - row * 56 >= 13 && y - row * 56 <= 45) {
        roll.decided = BUTTONS[button].vote;
        this.deps.vote(roll.lootGuid, roll.itemSlot, roll.decided);
        this.surface.requestRender();
        return;
      }
    }
  }

  private paint() {
    const s = this.surface;
    s.clear();
    const now = performance.now();
    [...this.rolls.values()].slice(0, 4).forEach((roll, index) => {
      const y = index * 56;
      const remaining = Math.max(0, 1 - (now - roll.startedAt) / Math.max(1, roll.countdownMs));
      const ctx = s.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.strokeStyle = '#c79c3b';
      ctx.lineWidth = 1;
      ctx.fillRect(0, y + 2, 316, 52);
      ctx.strokeRect(0.5, y + 2.5, 315, 51);
      ctx.fillStyle = '#202020';
      ctx.fillRect(48, y + 42, 110, 5);
      ctx.fillStyle = '#e0b000';
      ctx.fillRect(48, y + 42, 110 * remaining, 5);
      ctx.restore();
      s.image(this.deps.itemIconUrl(roll.itemEntry), 7, y + 9, 37, 37);
      s.text(this.deps.itemName(roll.itemEntry), 49, y + 20, { size: 11, color: '#ffd100', maxWidth: 112 });
      s.text(`${Math.ceil(Math.max(0, roll.countdownMs - (now - roll.startedAt)) / 1000)}s`, 49, y + 35, { size: 10, color: '#ffffff' });
      BUTTONS.forEach((button, buttonIndex) => {
        const x = 166 + buttonIndex * 43;
        const suffix = roll.decided === undefined ? 'Up' : roll.decided === button.vote ? 'Down' : 'Up';
        s.image(`/ui/Interface/Buttons/UI-GroupLoot-${button.file}-${suffix}.png`, x, y + 13, 32, 32);
      });
    });
  }
}
