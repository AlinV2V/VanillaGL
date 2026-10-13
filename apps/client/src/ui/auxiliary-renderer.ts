import * as THREE from 'three';
import { registerWebglRenderer } from '../rendering/webgl-context-registry';

let renderer: THREE.WebGLRenderer | null = null;
let release: (() => void) | undefined;
let unavailable = false;
let width = 0, height = 0;

/** One app-owned context for portraits, paper doll and inspect. Targets own only 2D pixels. */
export function renderAuxiliaryCanvas(target: HTMLCanvasElement, requestedWidth: number, requestedHeight: number,
  clearColor: number, clearAlpha: number, draw: (renderer: THREE.WebGLRenderer, width: number, height: number) => void): boolean {
  const context = target.getContext('2d');
  if (!context || unavailable) return false;
  try {
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true, antialias: false });
      renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
      release = registerWebglRenderer('ui-previews-shared', renderer);
    }
  } catch { unavailable = true; return false; }
  const w = Math.max(1, Math.min(2048, Math.round(requestedWidth)));
  const h = Math.max(1, Math.min(2048, Math.round(requestedHeight)));
  // Grow the shared backing store only when necessary; alternating small portraits and
  // larger dolls must not reallocate it on every draw.
  if (w > width || h > height) {
    width = Math.max(width, w); height = Math.max(height, h); renderer.setSize(width, height, false);
  }
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;
  renderer.setRenderTarget(null); renderer.setScissorTest(false); renderer.setViewport(0, 0, w, h);
  renderer.setClearColor(clearColor, clearAlpha); renderer.clear();
  draw(renderer, w, h);
  context.clearRect(0, 0, w, h);
  // WebGL viewport coordinates start at the bottom; Canvas2D source coordinates start at the top.
  context.drawImage(renderer.domElement, 0, height - h, w, h, 0, 0, w, h);
  return true;
}

export function disposeAuxiliaryRenderer(): void {
  renderer?.dispose(); renderer?.forceContextLoss(); release?.();
  renderer = null; release = undefined; unavailable = false; width = height = 0;
}
export const auxiliaryRendererDiagnostics = () => ({ contextCount: renderer ? 1 : 0, unavailable, width, height });
