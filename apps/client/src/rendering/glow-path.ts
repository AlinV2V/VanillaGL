/**
 * Glow/gamma post-process path selection (FIX 6).
 *
 * Startup-only diagnostic switch, same convention as `?msaa=0/1` and
 * `?doodadbatch=whole`: `?glowpath=legacy` restores the pre-optimization
 * behavior (driver clears before every post pass) for controlled A/B.
 * Default is the optimized path, which is pixel-identical (it only skips
 * clears that a proven fullscreen overwrite makes redundant).
 * Pure string parsing — Node-safe for verifier import.
 */

/** Production default: optimized (redundant post-pass clears skipped). */
export const DEFAULT_GLOW_PATH = 'optimized' as const;

export type GlowPath = 'legacy' | 'optimized';

/**
 * Resolve `?glowpath=legacy|optimized`. Anything unrecognized (absent,
 * misspelled, garbage) falls back to the production default so a bad link
 * can never silently change rendering.
 */
export function resolveGlowPath(search: string): GlowPath {
  const value = new URLSearchParams(search).get('glowpath');
  if (value === 'legacy' || value === 'optimized') return value;
  return DEFAULT_GLOW_PATH;
}
