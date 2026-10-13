import * as THREE from 'three';
import { qaGlobals } from '../qa-globals';
import { renderAuxiliaryCanvas, auxiliaryRendererDiagnostics } from './auxiliary-renderer';

let renderCount = 0;

/**
 * Unit portraits are frozen 64x64 captures. Render them serially through one detached WebGL canvas
 * and retain the result in each visible 2D canvas, rather than allocating one GL context per unit.
 */
export function renderUnitPortrait(
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: HTMLCanvasElement,
): boolean {
  if (!renderAuxiliaryCanvas(target, 64, 64, 0x05070a, 1, shared => shared.render(scene, camera))) return false;
  renderCount++;
  return true;
}

export const unitPortraitRendererDiagnostics = () => ({
  contextCount: auxiliaryRendererDiagnostics().contextCount,
  renderCount,
  unavailable: auxiliaryRendererDiagnostics().unavailable,
  preserveDrawingBuffer: false,
});

qaGlobals.__wowUnitPortraitRenderer = unitPortraitRendererDiagnostics;
