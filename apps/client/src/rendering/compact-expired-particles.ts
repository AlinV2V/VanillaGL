/** Linear, stable compaction preserves blend ordering and the existing elapsed-time policy. */
export function compactExpiredParticles<T extends { age: number; life: number }>(parts: T[], previousCount: number, elapsedDt: number, dt: number): number {
  let survivors = 0;
  for (let i = 0; i < parts.length; i++) {
    const particle = parts[i];
    particle.age += i < previousCount ? elapsedDt : dt;
    if (particle.age < particle.life) parts[survivors++] = particle;
  }
  const expired = parts.length - survivors;
  parts.length = survivors;
  return expired;
}
