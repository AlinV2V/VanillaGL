import type { WebGLRenderer } from 'three';
import { browserRenderPixelRatio } from '../ui/vanilla-video-cvars';
import { worldPixelBudget, worldPixelBudgetRatio } from './world-pixel-budget';

const limits = new WeakMap<WebGLRenderer, readonly [number, number]>();
/** Honor the requested scale, optional explicit pixel budget, and actual GL allocation limits. */
export function rendererPixelRatio(renderer: WebGLRenderer, dpr: number, scale: number, width: number, height: number): number {
  let maximum = limits.get(renderer);
  if (!maximum) {
    const gl = renderer.getContext?.();
    if (gl) {
      const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
      const side = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
      maximum = [Math.min(side, viewport[0]), Math.min(side, viewport[1])];
    } else maximum = [Infinity, Infinity];
    limits.set(renderer, maximum);
  }
  return Math.min(worldPixelBudgetRatio(browserRenderPixelRatio(dpr, scale), width, height, worldPixelBudget),
    maximum[0] / Math.max(1, width), maximum[1] / Math.max(1, height));
}
