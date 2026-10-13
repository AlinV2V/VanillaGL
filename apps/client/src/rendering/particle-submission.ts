import * as THREE from 'three';
import { qaGlobals } from '../qa-globals';

// Reload with ?particleopt=off for an unchanged submission/material baseline.
export const particleSubmissionEnabled = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('particleopt') !== 'off';
type Entry = { key: string; material: THREE.ShaderMaterial; users: number; texture: THREE.Texture | null; textureDisposed: boolean; onTextureDispose: () => void };
const pool = new Map<string, Entry>();
const owners = new Map<THREE.ShaderMaterial, Entry>();
const idle = new Set<Entry>();
const MAX_IDLE_MATERIALS = 64;
let created = 0, reused = 0;

function discard(entry: Entry) {
  idle.delete(entry); pool.delete(entry.key); owners.delete(entry.material);
  entry.texture?.removeEventListener('dispose', entry.onTextureDispose);
  entry.material.dispose();
}

/** World teardown releases idle shader references as well as asset textures. */
export function clearIdleParticleMaterials() {
  for (const entry of idle) discard(entry);
}

/** Only for the fixed particle shader: its complete variable material state is this key. */
export function acquireParticleMaterial(texture: THREE.Texture | null, blend: number, cols: number, rows: number,
  create: () => THREE.ShaderMaterial): THREE.ShaderMaterial {
  if (!particleSubmissionEnabled) return create();
  const key = `${texture?.uuid ?? 'null'}:${blend}:${Math.max(1, cols)}:${Math.max(1, rows)}`;
  const found = pool.get(key);
  if (found) { idle.delete(found); found.users++; reused++; return found.material; }
  const entry: Entry = { key, material: create(), users: 1, texture, textureDisposed: false,
    onTextureDispose: () => { entry.textureDisposed = true; if (!entry.users) discard(entry); } };
  texture?.addEventListener('dispose', entry.onTextureDispose);
  pool.set(key, entry); owners.set(entry.material, entry); created++;
  return entry.material;
}

export function releaseParticleMaterial(material: THREE.ShaderMaterial): void {
  const entry = owners.get(material);
  if (!entry) { material.dispose(); return; }
  if (--entry.users) return;
  if (entry.textureDisposed) { discard(entry); return; }
  // Keep recently used programs alive across sequential casts. This is bounded and textures
  // evict their idle materials, so the pool cannot extend the texture cache's lifetime.
  idle.add(entry);
  while (idle.size > MAX_IDLE_MATERIALS) discard(idle.values().next().value!);
  // Textures belong to the existing asset cache; material disposal must never dispose them.
}

export function setParticleDrawRange(mesh: THREE.Mesh, indices: number): void {
  if (mesh.geometry instanceof THREE.InstancedBufferGeometry) {
    mesh.geometry.instanceCount = indices / 6;
    mesh.geometry.setDrawRange(0, indices > 0 ? 6 : 0);
  } else mesh.geometry.setDrawRange(0, indices);
  if (particleSubmissionEnabled) mesh.visible = indices > 0;
}

export function particleSubmissionDiagnostics() {
  let emitters = 0;
  for (const entry of pool.values()) emitters += entry.users;
  return { enabled: particleSubmissionEnabled, liveMaterials: pool.size, idleMaterials: idle.size, emitters, created, reused,
    note: 'Instanced billboards upload each particle once. Empty draws suppressed; identical materials shared; emitter and particle order preserved.' };
}
qaGlobals.__vanillaParticleOptimization = particleSubmissionDiagnostics;
