/** Hold a one-shot for the longest authored variation, including randomized attack sequences. */
export function playerAnimationDuration(sequences: readonly { duration: number }[], indices: readonly number[]): number | undefined {
  const duration = Math.max(0, ...indices.map(index => index >= 0 ? sequences[index]?.duration ?? 0 : 0));
  return duration > 0 ? duration : undefined;
}
