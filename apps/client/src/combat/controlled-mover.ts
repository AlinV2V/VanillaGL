/** Asset conversion utility. */
export type ControlledMoverState = {
  playerGuid: string;
  moverGuid: string;
  allowMove: boolean;
  revision: number;
  worldGeneration: number;
};

export type ClientControlUpdate = {
  moverGuid: string;
  allowMove: boolean;
};

export function decodeClientControlUpdateBody(body: Uint8Array): ClientControlUpdate {
  if (body.length < 2) throw new Error('CLIENT_CONTROL_UPDATE is truncated');
  const mask = body[0];
  const guidBytes = new Uint8Array(8);
  let offset = 1;
  for (let i = 0; i < 8; i++) {
    if ((mask & (1 << i)) === 0) continue;
    if (offset >= body.length) throw new Error('CLIENT_CONTROL_UPDATE packed GUID is truncated');
    guidBytes[i] = body[offset++];
  }
  if (offset >= body.length) throw new Error('CLIENT_CONTROL_UPDATE allowMove byte is truncated');
  const allowMove = body[offset++] !== 0;
  if (offset !== body.length) {
    throw new Error(`CLIENT_CONTROL_UPDATE left ${body.length - offset} trailing bytes`);
  }
  const moverGuid = Array.from(guidBytes)
    .reverse()
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return { moverGuid, allowMove };
}

export function initialControlledMoverState(
  playerGuid: string,
  worldGeneration = 0,
): ControlledMoverState {
  return {
    playerGuid,
    moverGuid: playerGuid,
    allowMove: true,
    revision: 0,
    worldGeneration,
  };
}

export function applyClientControlUpdate(
  state: ControlledMoverState,
  update: ClientControlUpdate,
): ControlledMoverState {
  if (!update.moverGuid) throw new Error('client-control update has an empty mover GUID');
  // Revoking a previous subject is commonly sent *after* control has already returned to the
  // player (UnsummonPossessedMinion/HandleModPossess). That packet must not switch the mover back
  // to the old unit; it only disables input when it names the current subject.
  if (!update.allowMove && update.moverGuid !== state.moverGuid) {
    return { ...state, revision: state.revision + 1 };
  }
  return {
    ...state,
    moverGuid: update.moverGuid,
    allowMove: update.allowMove,
    revision: state.revision + 1,
  };
}

export function restorePlayerControl(
  state: ControlledMoverState,
  worldGeneration = state.worldGeneration,
): ControlledMoverState {
  return {
    ...state,
    moverGuid: state.playerGuid,
    allowMove: true,
    revision: state.revision + 1,
    worldGeneration,
  };
}

/** True only for controller-directed packets belonging to the current, movable subject. */
export function acceptsControlledMoverPacket(
  state: ControlledMoverState | undefined,
  moverGuid: string,
): boolean {
  return !!state && state.allowMove && state.moverGuid === moverGuid;
}

/** Controller acknowledgements remain valid while movement input is temporarily disabled. */
export function isCurrentControlledMover(
  state: ControlledMoverState | undefined,
  moverGuid: string,
): boolean {
  return !!state && state.moverGuid === moverGuid;
}
