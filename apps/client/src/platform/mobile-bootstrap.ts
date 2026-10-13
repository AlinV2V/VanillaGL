import { loadVideoCvars, loadGraphicsPreferences } from '../ui/vanilla-video-cvars';
import type * as THREE from 'three';
import { WorldTileLoader } from '../rendering/world-tile-loader';
import { configureKtx2Support } from '../rendering/optimized-texture-loader';
import { installMobileTouchControls } from '../ui/mobile/mobile-touch-controls';
import { installMobileSelectionGuard } from '../ui/mobile/mobile-selection-guard';
import { installMobileViewportLayout } from '../ui/mobile/mobile-viewport-layout';
import '../ui/mobile/mobile-hud.css';
import { AdaptiveQualityController } from './adaptive-quality';
import { installWebglContextRecovery } from './context-recovery';
import { getPerformanceProfile, refreshPerformanceProfile } from './performance-profile';
import { tileStreamRadius } from '../rendering/tile-neighborhood';

let adaptive: AdaptiveQualityController | null = null;
let touchCleanup: (() => void) | null = null;
let layoutCleanup: (() => void) | null = null;
let recoveryCleanup: (() => void) | null = null;
let tileBudgetPatched = false;
let selectionCleanup: (() => void) | null = null;

function installTileStreamingBudget() {
  if (tileBudgetPatched) return;
  tileBudgetPatched = true;
  const original = WorldTileLoader.prototype.pruneOutside;
  WorldTileLoader.prototype.pruneOutside = function patchedPruneOutside(center, _radius = 2) {
    return original.call(this, center, Math.max(tileStreamRadius(center), getPerformanceProfile().tileRadius));
  };
}

installTileStreamingBudget();


export async function bootstrapPlatformRenderer(
  renderer: THREE.WebGLRenderer,
  log: (message: string) => void = () => {},
): Promise<void> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const profile = refreshPerformanceProfile(gl);

  // Protect the login/loading screens before waiting for texture capability setup.
  selectionCleanup?.();
  selectionCleanup = profile.device.mobile ? installMobileSelectionGuard() : null;

  await configureKtx2Support(renderer, profile.ktxWorkerLimit);

  recoveryCleanup?.();
  recoveryCleanup = installWebglContextRecovery(renderer, log);

  adaptive?.stop();
  adaptive = new AdaptiveQualityController(renderer, profile, log);
  const video = loadVideoCvars();
  adaptive.configureDynamicResolution(loadGraphicsPreferences().dynamicResolution, video.renderScale);

  layoutCleanup?.();
  layoutCleanup = installMobileViewportLayout(profile);

  touchCleanup?.();
  touchCleanup = profile.device.mobile ? installMobileTouchControls(profile) : null;

  window.addEventListener('vanillagl-webgl-context-lost', () => adaptive?.stop(), { once: true });
  log(`platform: ${profile.id} (${profile.device.kind}, ${profile.device.tier})`);
}

export function getAdaptiveQualityController(): AdaptiveQualityController | null {
  return adaptive;
}
