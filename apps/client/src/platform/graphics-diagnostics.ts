import * as THREE from 'three';
import { getPerformanceProfile } from './performance-profile';
import { adaptiveQualityDiagnostics } from './adaptive-quality';
import { loadGraphicsPreferences, loadVideoCvars, type BrowserVideoCvars } from '../ui/vanilla-video-cvars';
import { worldPixelBudget } from './world-pixel-budget';

let readCurrentScale: (() => number) | null = null;
export function currentGraphicsRenderScale(): number | null { return readCurrentScale?.() ?? null; }

export function installGraphicsDiagnostics(renderer: THREE.WebGLRenderer, effective: () => BrowserVideoCvars): void {
  readCurrentScale = () => renderer.getPixelRatio() / (window.devicePixelRatio || 1);
  Object.assign(window, { __wowGraphicsState: () => {
    const requested = loadVideoCvars(), applied = effective();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const gl = renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      profile: getPerformanceProfile().id,
      gpu: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
      preferences: loadGraphicsPreferences(),
      css: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio,
      requestedRenderScale: requested.renderScale,
      currentRenderScale: renderer.getPixelRatio() / (window.devicePixelRatio || 1),
      pixelRatio: renderer.getPixelRatio(), framebuffer: [size.x, size.y],
      worldPixelBudget,
      farclip: { requested: requested.farclip, effective: applied.farclip },
      WorldDetail: { requested: requested.WorldDetail, effective: applied.WorldDetail },
      anisotropy: { requested: requested.anisotropic, effective: applied.anisotropic },
      dynamicResolution: adaptiveQualityDiagnostics(),
    };
  } });
}
