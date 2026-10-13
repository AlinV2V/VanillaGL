import { Vector2, type WebGLRenderer } from 'three';

const logicalSize = new Vector2();

/** Three's viewport/scissor API takes CSS pixels and applies pixelRatio itself. */
export function restoreRendererViewport(renderer: WebGLRenderer): void {
  renderer.getSize(logicalSize);
  renderer.setScissorTest(false);
  renderer.setScissor(0, 0, logicalSize.x, logicalSize.y);
  renderer.setViewport(0, 0, logicalSize.x, logicalSize.y);
}

/** Safari can settle its browser bars after the window resize/orientation event. */
export function installViewportResize(resize: () => void): () => void {
  let pending = 0;
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; resize(); });
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('pageshow', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  schedule();
  return () => {
    cancelAnimationFrame(pending);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    window.removeEventListener('pageshow', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
  };
}
