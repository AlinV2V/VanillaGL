import { getPerformanceProfile } from '../platform/performance-profile';
import { mobileHudViewModelSignature } from './mobile-hud-signature';

/** Asset conversion utility. */
export const HUD_COOLDOWN_INTERVAL_MS = 1000 / 30;
export const HUD_AURA_INTERVAL_MS = 100;
// ActionButton.lua uses TOOLTIP_UPDATE_TIME for range checks; UIParent.lua defines it as 0.2 sec.
export const HUD_ACTION_STATE_INTERVAL_MS = 200;

export type HudFrameTicks = {
  cooldowns: boolean;
  auras: boolean;
  actionStates: boolean;
};

/** Stable for the plain-data main-menu view model; equal semantic frames produce equal signatures. */
export const hudViewModelSignature = (model: unknown) => getPerformanceProfile().device.mobile
  ? mobileHudViewModelSignature(model)
  : JSON.stringify(model);

export class HudFrameCadence {
  private lastCooldownAt = Number.NEGATIVE_INFINITY;
  private lastAuraAt = Number.NEGATIVE_INFINITY;
  private lastActionStateAt = Number.NEGATIVE_INFINITY;

  take(now: number): HudFrameTicks {
    const at = Number.isFinite(now) ? now : 0;
    // The rAF timestamp is fractional. Permit a sub-microsecond epsilon so exact 2-frame/6-frame
    // intervals do not alternate between two and three frames because of IEEE-754 rounding.
    const epsilon = 1e-6;
    const cooldowns = at - this.lastCooldownAt + epsilon >= HUD_COOLDOWN_INTERVAL_MS;
    const auras = at - this.lastAuraAt + epsilon >= HUD_AURA_INTERVAL_MS;
    const actionStates = at - this.lastActionStateAt + epsilon >= HUD_ACTION_STATE_INTERVAL_MS;
    if (cooldowns) this.lastCooldownAt = at;
    if (auras) this.lastAuraAt = at;
    if (actionStates) this.lastActionStateAt = at;
    return { cooldowns, auras, actionStates };
  }
}
