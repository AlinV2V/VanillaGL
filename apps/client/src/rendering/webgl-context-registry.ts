import type * as THREE from 'three';

type ContextRegistration = {
  label: string;
  renderer: THREE.WebGLRenderer;
  createdAt: number;
};

const active = new Map<THREE.WebGLRenderer, ContextRegistration>();
let created = 0;

/** Register a renderer once and return an idempotent release hook for finite-lived previews. */
export function registerWebglRenderer(label: string, renderer: THREE.WebGLRenderer): () => void {
  let registration = active.get(renderer);
  if (!registration) {
    registration = { label, renderer, createdAt: typeof performance === 'undefined' ? 0 : performance.now() };
    active.set(renderer, registration);
    created++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.delete(renderer);
  };
}

export function webglContextDiagnostics() {
  return {
    active: active.size,
    created,
    contexts: [...active.values()].map(({ label, renderer, createdAt }) => {
      let attributes: WebGLContextAttributes | null = null;
      try { attributes = renderer.getContext().getContextAttributes(); } catch { /* lost/unavailable */ }
      return {
        label,
        createdAt,
        drawingBuffer: [renderer.domElement.width, renderer.domElement.height],
        alpha: attributes?.alpha ?? null,
        antialias: attributes?.antialias ?? null,
        preserveDrawingBuffer: attributes?.preserveDrawingBuffer ?? null,
      };
    }),
  };
}
