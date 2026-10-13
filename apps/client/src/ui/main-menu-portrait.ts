import type { VanillaCanvas } from './vanilla-canvas';

const BUTTON_WIDTH = 32;
const BUTTON_HEIGHT = 64;
const PORTRAIT_WIDTH = Math.round(18 * (BUTTON_WIDTH / 29));
const PORTRAIT_HEIGHT = Math.round(25 * (BUTTON_HEIGHT / 58));
const PORTRAIT_TOP = Math.round(28 * (BUTTON_HEIGHT / 58));

/**
 * Draw MainMenuBarMicroButtons.xml's MicroButtonPortrait from SetPortraitTexture("player").
 * The normal and pushed crops are transcribed from CharacterMicroButton_SetNormal/SetPushed.
 */
export function drawCharacterMicroPortrait(
  surface: VanillaCanvas,
  source: HTMLCanvasElement | undefined,
  fallbackUrl: string | undefined,
  buttonX: number,
  buttonY: number,
  pressed: boolean,
  disabled: boolean,
) {
  if (!source && !fallbackUrl) return;
  const [left, right, top, bottom] = pressed
    ? [0.2666, 0.8666, 0, 0.8333]
    : [0.2, 0.8, 0.0666, 0.9];
  const x = buttonX + (BUTTON_WIDTH - PORTRAIT_WIDTH) / 2;
  const y = buttonY + PORTRAIT_TOP;
  const alpha = disabled ? 0.35 : pressed ? 0.5 : 1;
  if (!source) {
    surface.spriteFraction(fallbackUrl!, left, top, right, bottom, x, y,
      PORTRAIT_WIDTH, PORTRAIT_HEIGHT, { alpha });
    return;
  }
  const ctx = surface.ctx;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(source, left * source.width, top * source.height,
    (right - left) * source.width, (bottom - top) * source.height,
    x, y, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
  ctx.restore();
}
