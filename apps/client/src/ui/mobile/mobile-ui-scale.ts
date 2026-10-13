import { vanillaUiScale, type BrowserVideoCvars } from '../vanilla-video-cvars';

export function applyBrowserUiScale(cvars: BrowserVideoCvars): void {
  const root = document.documentElement;
  // The phone layout fits the HUD to its viewport, then applies the user's scale multiplier.
  const scale = root.classList.contains('vanillagl-phone')
    ? (cvars.useUiScale ? cvars.uiscale : 1.25)
    : vanillaUiScale(cvars, window.innerWidth, window.innerHeight);
  root.style.setProperty('--wow-ui-scale', String(scale));
  window.dispatchEvent(new Event('vanillagl-ui-scale'));
}
