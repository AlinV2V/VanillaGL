import type * as THREE from 'three';

export function installWebglContextRecovery(
  renderer: THREE.WebGLRenderer,
  log: (message: string) => void = () => {},
): () => void {
  const canvas = renderer.domElement;
  let overlay: HTMLDivElement | null = null;
  let restoring = false;

  const show = (message: string) => {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'vanillagl-context-recovery';
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647', 'display:flex', 'align-items:center',
        'justify-content:center', 'background:rgba(0,0,0,.82)', 'color:#fff', 'font:600 16px system-ui,sans-serif',
        'text-align:center', 'padding:24px', 'pointer-events:all',
      ].join(';');
      document.body.appendChild(overlay);
    }
    overlay.textContent = message;
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    restoring = true;
    show('Graphics context was interrupted. Restoring VanillaGL…');
    window.dispatchEvent(new CustomEvent('vanillagl-webgl-context-lost'));
    log('webgl: context lost; waiting for browser restoration');
  };

  const onRestored = () => {
    if (!restoring) return;
    show('Graphics context restored. Rebuilding world resources…');
    window.dispatchEvent(new CustomEvent('vanillagl-webgl-context-restored'));
    log('webgl: context restored; reloading to rebuild GPU resources');
    // A full page rebuild is intentionally conservative. WebGL invalidates textures, programs,
    // buffers, render targets and VAOs after context loss; reloading guarantees every VanillaGL
    // cache is reconstructed from local baked assets instead of risking a partially stale scene.
    window.setTimeout(() => window.location.reload(), 250);
  };

  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  return () => {
    canvas.removeEventListener('webglcontextlost', onLost, false);
    canvas.removeEventListener('webglcontextrestored', onRestored, false);
    overlay?.remove();
  };
}
