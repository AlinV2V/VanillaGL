import type { MoveIntent } from '../../simulation/commands';
import { VanillaCanvas, type CanvasPoint } from '../vanilla-canvas';

const BUTTONS = '/ui/Interface/Buttons';
const MAIN_MENU = '/ui/Interface/MainMenuBar';
const QUICK_SLOT = `${BUTTONS}/UI-Quickslot.png`;
const QUICK_SLOT_FILLED = `${BUTTONS}/UI-Quickslot2.png`;
const QUICK_SLOT_DOWN = `${BUTTONS}/UI-Quickslot-Depress.png`;
const QUICK_SLOT_HIGHLIGHT = `${BUTTONS}/ButtonHilight-SquareQuickslot.png`;

export const MOBILE_MOVE_SIZE = 148;
export const MOBILE_ACTION_WIDTH = 252;
export const MOBILE_ACTION_HEIGHT = 170;
export const MOBILE_UTILITY_WIDTH = 176;
export const MOBILE_UTILITY_HEIGHT = 64;

export type MobileActionTarget =
  | { kind: 'action'; slot: number }
  | { kind: 'jump' }
  | { kind: 'target' };

export type MobileUtilityTarget = { code: 'KeyB' | 'KeyM' | 'KeyP' | 'Escape'; label: string };

type ActionHit = MobileActionTarget & { x: number; y: number; label: string };
type UtilityHit = MobileUtilityTarget & { x: number; art: string; bag?: boolean };

const ACTION_HITS: readonly ActionHit[] = [
  { kind: 'action', slot: 1, x: 155, y: 34, label: '1' },
  { kind: 'action', slot: 2, x: 96, y: 64, label: '2' },
  { kind: 'action', slot: 3, x: 214, y: 64, label: '3' },
  { kind: 'action', slot: 4, x: 96, y: 122, label: '4' },
  { kind: 'action', slot: 5, x: 214, y: 122, label: '5' },
  { kind: 'action', slot: 6, x: 155, y: 93, label: '6' },
  { kind: 'jump', x: 31, y: 131, label: 'JUMP' },
  { kind: 'target', x: 31, y: 65, label: 'TARGET' },
];

const UTILITY_HITS: readonly UtilityHit[] = [
  { code: 'KeyB', label: 'Backpack', x: 34, art: `${BUTTONS}/Button-Backpack-Up.png`, bag: true },
  { code: 'KeyM', label: 'World map', x: 70, art: `${BUTTONS}/UI-MicroButton-World` },
  { code: 'KeyP', label: 'Spellbook', x: 106, art: `${BUTTONS}/UI-MicroButton-Spellbook` },
  { code: 'Escape', label: 'Game menu', x: 142, art: `${BUTTONS}/UI-MicroButton-MainMenu` },
];

const targetKey = (target: MobileActionTarget) =>
  target.kind === 'action' ? `action:${target.slot}` : target.kind;

const utilityKey = (target: MobileUtilityTarget) => target.code;

const insideCircle = (point: CanvasPoint, x: number, y: number, radius: number) =>
  Math.hypot(point.x - x, point.y - y) <= radius;

export function mobileActionTargetAt(point: CanvasPoint, order?: readonly number[]): MobileActionTarget | undefined {
  const hit = ACTION_HITS.find((candidate) => insideCircle(point, candidate.x, candidate.y, 29));
  if (!hit) return undefined;
  return hit.kind === 'action' ? { kind: 'action', slot: order?.[hit.slot - 1] ?? hit.slot } : { kind: hit.kind };
}

export function mobileUtilityTargetAt(point: CanvasPoint): MobileUtilityTarget | undefined {
  const hit = UTILITY_HITS.find((candidate) => Math.abs(point.x - candidate.x) <= 18 && point.y >= 0 && point.y <= 64);
  return hit ? { code: hit.code, label: hit.label } : undefined;
}

export function mobileMoveIntentAt(point: CanvasPoint): MoveIntent {
  const center = MOBILE_MOVE_SIZE / 2;
  const radius = 52;
  const dx = point.x - center;
  const dy = point.y - center;
  const length = Math.hypot(dx, dy);
  const scale = length > radius ? radius / Math.max(length, 0.001) : 1;
  return {
    forward: Math.max(-1, Math.min(1, -(dy * scale) / radius)),
    strafe: Math.max(-1, Math.min(1, (dx * scale) / radius)),
    turn: 0,
  };
}

const backgroundUrl = (element: HTMLElement | null) => {
  if (!element) return undefined;
  const value = element.style.backgroundImage || getComputedStyle(element).backgroundImage;
  const match = /^url\(["']?(.*?)["']?\)$/.exec(value.trim());
  return match?.[1];
};

function actionVisual(slot: number) {
  const cell = document.querySelector<HTMLElement>(`.wow-action-button[data-action-slot="${slot - 1}"]`);
  const icon = backgroundUrl(cell?.querySelector<HTMLElement>('.wow-action-icon') ?? null);
  const cooldown = cell?.querySelector<HTMLElement>('.wow-action-cd-text');
  return {
    icon,
    enabled: !!cell?.title || !!icon,
    unusable: cell?.classList.contains('is-aura-unusable') ?? false,
    outOfRange: cell?.classList.contains('is-out-of-range') ?? false,
    highlighted: !!cell && ['is-queued', 'is-active-attack', 'is-aura-reactive'].some((name) => cell.classList.contains(name)),
    cooldown: cooldown && !cooldown.classList.contains('is-hidden') ? cooldown.textContent?.trim() : undefined,
  };
}

function drawActionButton(surface: VanillaCanvas, hit: ActionHit, pressed: boolean) {
  const visual = hit.kind === 'action' ? actionVisual(hit.slot) : undefined;
  const enabled = visual?.enabled ?? true;
  const x = hit.x - 18;
  const y = hit.y - 18;
  if (visual?.icon) surface.image(visual.icon, x, y, 36, 36, visual.unusable ? 0.4 : 1);
  surface.image(pressed ? QUICK_SLOT_DOWN : enabled ? QUICK_SLOT_FILLED : QUICK_SLOT, hit.x - 33, hit.y - 34, 66, 66);
  if (visual?.outOfRange) {
    surface.ctx.save();
    surface.ctx.fillStyle = 'rgba(190, 25, 25, .42)';
    surface.ctx.fillRect(x + 2, y + 2, 32, 32);
    surface.ctx.restore();
  }
  if (visual?.highlighted) surface.addImage(QUICK_SLOT_HIGHLIGHT, hit.x - 33, hit.y - 34, 66, 66, 0.9);
  if (hit.kind === 'action') {
    surface.text(hit.label, hit.x + 15, hit.y - 12, { size: 11, color: '#ffffff', align: 'right', family: 'sans' });
  } else {
    surface.text(hit.label, hit.x, hit.y + 3, { size: 9, color: '#ffd100', align: 'center', baseline: 'middle' });
  }
  if (visual?.cooldown) {
    surface.text(visual.cooldown, hit.x, hit.y + 5, { size: 14, color: '#ffffff', align: 'center', baseline: 'middle', family: 'sans', font: 'number' });
  }
}

export function drawMobileActions(surface: VanillaCanvas, pressed: ReadonlySet<string>, order?: readonly number[]) {
  surface.clear();
  ACTION_HITS.forEach((position) => {
    const slot = position.kind === 'action' ? order?.[position.slot - 1] ?? position.slot : 0;
    const hit = position.kind === 'action' ? { ...position, slot, label: String(slot) } : position;
    drawActionButton(surface, hit, pressed.has(targetKey(hit)));
  });
}

export function drawMobileActionDrag(surface: VanillaCanvas, slot: number, point: CanvasPoint) {
  surface.ctx.save();
  surface.ctx.strokeStyle = '#ffd100'; surface.ctx.lineWidth = 2;
  surface.ctx.strokeRect(point.x - 23, point.y - 27, 46, 46);
  drawActionButton(surface, { kind: 'action', slot, label: String(slot), x: point.x, y: point.y - 4 }, true);
  surface.text('Drag to swap', 126, 165, { size: 11, color: '#ffd100', align: 'center' });
  surface.ctx.restore();
}

export function drawMobileMovement(surface: VanillaCanvas, intent: MoveIntent) {
  surface.clear();
  const center = MOBILE_MOVE_SIZE / 2;
  const ctx = surface.ctx;
  ctx.save();
  const gradient = ctx.createRadialGradient(center, center, 8, center, center, 64);
  gradient.addColorStop(0, 'rgba(24, 17, 9, .45)');
  gradient.addColorStop(1, 'rgba(3, 3, 3, .18)');
  ctx.fillStyle = gradient;
  ctx.strokeStyle = 'rgba(181, 135, 56, .55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(center, center, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  const arrow = (path: string, x: number, y: number, active: boolean) => {
    surface.image(path.replace('{state}', active ? 'Down' : 'Up'), x, y, 32, 32);
    if (active) surface.addImage(QUICK_SLOT_HIGHLIGHT, x - 16, y - 16, 64, 64, 0.52);
  };
  arrow(`${MAIN_MENU}/UI-MainMenu-ScrollUpButton-{state}.png`, 58, 0, intent.forward > 0.2);
  arrow(`${MAIN_MENU}/UI-MainMenu-ScrollDownButton-{state}.png`, 58, 116, intent.forward < -0.2);
  arrow(`${BUTTONS}/UI-RotationLeft-Button-{state}.png`, 0, 58, intent.strafe < -0.2);
  arrow(`${BUTTONS}/UI-RotationRight-Button-{state}.png`, 116, 58, intent.strafe > 0.2);

  const knobX = center + intent.strafe * 18;
  const knobY = center - intent.forward * 18;
  const moving = Math.abs(intent.forward) > 0.2 || Math.abs(intent.strafe) > 0.2;
  surface.image(moving ? QUICK_SLOT_DOWN : QUICK_SLOT_FILLED, knobX - 32, knobY - 33, 64, 64, 0.92);
  surface.text('MOVE', knobX, knobY + 2, { size: 9, color: '#ffd100', align: 'center', baseline: 'middle' });
}

export function drawMobileUtilities(surface: VanillaCanvas, pressed: ReadonlySet<string>) {
  surface.clear();
  UTILITY_HITS.forEach((hit) => {
    const down = pressed.has(utilityKey(hit));
    if (hit.bag) {
      surface.image(hit.art, hit.x - 18, 26, 37, 37);
      surface.image(down ? QUICK_SLOT_DOWN : QUICK_SLOT_FILLED, hit.x - 32, 12, 64, 64);
      return;
    }
    surface.image(`${hit.art}-${down ? 'Down' : 'Up'}.png`, hit.x - 16, 0, 32, 64);
  });
}
