/** Sidecar codec versions are independent of npm/API versions. */
export const MESHOPT_DECODER_VERSION = '0.23.0';
export type MeshoptCodecProvenance = { encoderVersion: string; vertexVersions: number[]; indexVersions: number[] };
export class MeshoptCodecError extends Error { readonly reason = 'unsupported-codec'; }
export function validateMeshoptCodec(mode: string, source: Uint8Array, declared?: number): void {
  const version = source[0] & 15;
  const signature = source[0] & 240;
  const expected = mode === 'ATTRIBUTES' ? 160 : mode === 'TRIANGLES' ? 224 : mode === 'INDICES' ? 208 : -1;
  if (!source.length || signature !== expected) throw new Error('Malformed Meshopt stream header');
  if (declared !== undefined && declared !== version) throw new MeshoptCodecError('Meshopt declared/header version mismatch');
  if (version > 1) throw new MeshoptCodecError(`Unsupported Meshopt ${mode} codec version ${version}`);
}
export function meshoptFallbackReason(error: unknown): string {
  if (error instanceof MeshoptCodecError) return error.reason;
  if (error instanceof SyntaxError) return 'invalid-metadata';
  const message = error instanceof Error ? error.message : '';
  if (/outside|malformed|Malformed/.test(message)) return 'invalid-stream';
  if (/unavailable|HTTP|fetch/i.test(message)) return 'sidecar-unavailable';
  return 'decode-or-hydration';
}
