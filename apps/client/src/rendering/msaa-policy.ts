/**
 * Main world-renderer MSAA policy.
 *
 * WebGL context antialiasing is fixed at context creation and CANNOT be
 * toggled later, so this is a startup-only decision (see init-renderer.ts).
 * There is intentionally no CVar, no profile field, and no live switch: the
 * active render path (direct canvas vs offscreen gamma/glow target) can flip
 * at runtime via glow/gamma settings while the context stays fixed, so any
 * context-time prediction would go stale. Pure string parsing — Node-safe for
 * verifier import (no window/location/DOM access here; the caller passes
 * location.search in).
 */

/** Single-sample presentation is the sustainable default; explicit startup overrides remain available. */
export const DEFAULT_MSAA_ANTIALIAS = false;

/** True when the URL explicitly carries an `msaa` diagnostic value. */
export function hasMsaaOverride(search: string): boolean {
  return new URLSearchParams(search).has('msaa');
}

/**
 * Startup-only diagnostic override for controlled A/B:
 * `?msaa=0` forces antialias:false, `?msaa=1` forces antialias:true.
 * Anything else (absent, misspelled, garbage) resolves to the production
 * default so a bad link can never silently change rendering.
 */
export function resolveMsaaAntialias(search: string): boolean {
  const value = new URLSearchParams(search).get('msaa');
  if (value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  return DEFAULT_MSAA_ANTIALIAS;
}
