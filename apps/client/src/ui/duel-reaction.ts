/** Minimal entity state needed for Vanilla's duel reaction override. */
export type DuelReactionEntity = {
  typeId?: number;
  duelArbiterGuid?: string;
  duelTeam?: number;
};

/** TYPEID_PLAYER in Build 5875's object type enum. */
const PLAYER_TYPE_ID = 4;

/**
 * Build 5875 CGUnit reaction logic (reversed FUN_006061e0): player units are duel opponents only
 * when they share a non-zero PLAYER_DUEL_ARBITER and have non-zero, different duel teams.
 *
 * The supported vMaNGOS tree writes PLAYER_DUEL_TEAM at its compiled +6 index (0x0c4), but its
 * generated visibility table still marks stock 0x0be public and 0x0c4 private. Each client therefore
 * receives its own team but not the opponent's. In that one missing-field case, a matching arbiter
 * plus the local server-published team is sufficient for a 1v1 duel and activates at the same tick
 * as server-side attack validation. No timer or packet-guessed combat state is involved.
 */
export function isDuelOpponent(
  player: DuelReactionEntity | undefined,
  target: DuelReactionEntity | undefined,
): boolean {
  if (
    player?.typeId !== PLAYER_TYPE_ID
    || target?.typeId !== PLAYER_TYPE_ID
    || !player.duelTeam
    || !player.duelArbiterGuid
    || player.duelArbiterGuid !== target.duelArbiterGuid
  ) return false;

  if (target.duelTeam === undefined) return true;
  return !!target.duelTeam && player.duelTeam !== target.duelTeam;
}

export function withDuelReaction<T extends string>(
  player: DuelReactionEntity | undefined,
  target: DuelReactionEntity | undefined,
  factionReaction: T,
): T | 'hostile' {
  return isDuelOpponent(player, target) ? 'hostile' : factionReaction;
}
