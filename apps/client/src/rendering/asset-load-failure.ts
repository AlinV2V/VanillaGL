export type AssetLoadFailure = {
  kind: 'transient' | 'unbaked';
  attempts: number;
  retryAt: number;
  message: string;
};

export class UnbakedGameObjectDisplayError extends Error {}
export class UnbakedCreatureDisplayError extends Error {}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Bounded retry schedule for dynamically admitted world assets. */
export const assetLoadRetryDelay = (attempts: number) => Math.min(
  RETRY_MAX_MS,
  RETRY_BASE_MS * (2 ** Math.min(5, Math.max(0, attempts - 1))),
);

export function recordAssetLoadFailure(
  failures: Map<number, AssetLoadFailure>,
  displayId: number,
  error: unknown,
  unbaked: boolean,
): AssetLoadFailure {
  const attempts = (failures.get(displayId)?.attempts ?? 0) + 1;
  const failure: AssetLoadFailure = {
    kind: unbaked ? 'unbaked' : 'transient',
    attempts,
    retryAt: unbaked ? 0 : performance.now() + assetLoadRetryDelay(attempts),
    message: error instanceof Error ? error.message : String(error),
  };
  failures.set(displayId, failure);
  return failure;
}
