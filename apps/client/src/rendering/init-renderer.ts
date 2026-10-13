import * as THREE from 'three';
import { bootstrapPlatformRenderer } from '../platform/mobile-bootstrap';
import { installPerformanceRuntime } from './performance-runtime';
import { DEFAULT_MSAA_ANTIALIAS, hasMsaaOverride, resolveMsaaAntialias } from './msaa-policy';
import { registerWebglRenderer } from './webgl-context-registry';

/** Vanilla materials currently target WebGL2's GLSL ShaderMaterial path. */
export const initRenderer = async (log: (message: string) => void): Promise<{ renderer: any; api: string }> => {
  if (new URLSearchParams(location.search).has('gpu')) {
    log('WebGPU is disabled: the Vanilla character materials require the WebGL2 GLSL path.');
  }
  // Startup-only: context antialias is fixed at creation and cannot be toggled
  // afterwards, so the diagnostic override MUST resolve here, before the
  // context exists. Production defaults to single-sample presentation (see msaa-policy.ts).
  const antialias = resolveMsaaAntialias(location.search);
  const renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance' });
  registerWebglRenderer('world', renderer);
  // Requested !== obtained: browsers may silently ignore antialias (weak GPU,
  // headless flags, context limits). Report the ACTUAL state for honest A/B.
  const actualAntialias = (() => {
    try {
      const gl = renderer.getContext() as WebGL2RenderingContext | null;
      return gl?.getContextAttributes()?.antialias ?? null;
    } catch {
      return null;
    }
  })();
  const actual = actualAntialias === null ? 'unknown' : actualAntialias ? '1' : '0';
  log(`render MSAA: requested antialias=${antialias ? '1' : '0'}${hasMsaaOverride(location.search) ? ' (?msaa override)' : ''}, actual context antialias=${actual}`);
  if (antialias !== DEFAULT_MSAA_ANTIALIAS) {
    log(`render MSAA diagnostic override active: antialias=${antialias ? '1' : '0'} (not a graphics preference, not persisted)`);
  }
  await bootstrapPlatformRenderer(renderer, log);
  installPerformanceRuntime(renderer, log);
  return { renderer, api: 'WebGL2' };
};
