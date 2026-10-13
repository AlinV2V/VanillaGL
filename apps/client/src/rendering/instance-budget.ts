/** Retire oldest presentation effects before admitting one more allocation. */
export function makeRoomForInstance<T>(active: T[], maxActive: number, dispose: (instance: T) => void): number {
  const overflow = Math.max(0, active.length - Math.max(1, maxActive) + 1);
  if (!overflow) return 0;
  for (const instance of active.splice(0, overflow)) dispose(instance);
  return overflow;
}
