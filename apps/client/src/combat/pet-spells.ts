export type PetSpellLayout = 'removal' | 'permanentPet' | 'charm' | 'possession' | 'ambiguousControl';

export type DecodedPetActionButton = {
  slot: number;
  packed: number;
  action: number;
  activeState: number;
};

export type DecodedPetSpellCooldown = {
  spellId: number;
  category: number;
  spellCooldownMs: number;
  categoryCooldownMs: number;
  categoryCooldownRaw: number;
  permanentCategoryCooldown: boolean;
};

export type DecodedPetSpellState = {
  layout: PetSpellLayout;
  guid: string;
  durationMs: number;
  /** Absent for possession: its wire field is one zero u32, not four authored stance bytes. */
  reactState?: number;
  commandState?: number;
  flag1?: number;
  enabledFlags?: number;
  possessionControlWord?: number;
  actions: DecodedPetActionButton[];
  spells: DecodedPetActionButton[];
  cooldowns: DecodedPetSpellCooldown[];
  /**
   * The raw wire header, retained so the layout can be re-derived when late control state lands.
   * SMSG_PET_SPELLS is a direct send while UNIT_FLAG_POSSESSED is an update field batched to the
   * end of the world tick, so the packet arrives BEFORE the flag that describes it.
   */
  headerWord: number;
};

class PetReader {
  offset = 0;
  private readonly body: Uint8Array;
  constructor(body: Uint8Array) {
    this.body = body;
  }
  get remaining() { return this.body.length - this.offset; }
  private need(size: number) {
    if (this.remaining < size) throw new Error(`pet spells truncated at ${this.offset}, need ${size}, have ${this.remaining}`);
  }
  u8() { this.need(1); return this.body[this.offset++]; }
  u16() { const value = this.u8() | (this.u8() << 8); return value >>> 0; }
  u32() {
    this.need(4);
    const value = new DataView(this.body.buffer, this.body.byteOffset + this.offset, 4).getUint32(0, true);
    this.offset += 4;
    return value;
  }
  i32() {
    const value = this.u32();
    return value > 0x7fffffff ? value - 0x100000000 : value;
  }
  guid() {
    this.need(8);
    const bytes = this.body.slice(this.offset, this.offset + 8);
    this.offset += 8;
    return Array.from(bytes).reverse().map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}

function action(slot: number, packed: number): DecodedPetActionButton {
  return { slot, packed, action: packed & 0x00ffffff, activeState: packed >>> 24 };
}

export type PetControlHint = 'pet' | 'charm' | 'possession' | undefined;

/**
 * Pick the layout from the WIRE first, using only what the three senders actually guarantee, and
 * fall back to the caller's control hint solely where the bytes are genuinely ambiguous.
 *
 * vMaNGOS Player.cpp:
 *   - PetSpellInitialize (:17530)     writes `uint32(0)` for duration, then four stance bytes.
 *   - PossessSpellInitialize (:17591) writes the possess aura duration, then `uint32(0)`.
 *   - CharmSpellInitialize (:17645)   writes the charm aura duration, then four stance bytes.
 *
 * So a non-zero header word rules possession out, and a non-zero duration rules a pet out. Those
 * two facts hold regardless of when UNIT_FLAG_POSSESSED reaches us — which matters, because the
 * flag is an update field flushed at the end of the tick while SMSG_PET_SPELLS is sent immediately
 * (SummonPossessedMinion sets the flag at Player.cpp:17725 and sends at :17744; HandleModPossess
 * likewise at SpellAuras.cpp:2968 / :2993). The previous code took the layout straight from
 * `entity.possessed`, which is still false — or the entity still absent — at that moment.
 */
export function resolvePetSpellLayout(
  headerWord: number,
  durationMs: number,
  hint: PetControlHint,
): PetSpellLayout {
  if (headerWord !== 0) {
    // Stance bytes are present, so this is not possession. Only a controlled unit carries a
    // duration; a pet's duration slot is a literal zero.
    return durationMs !== 0 ? 'charm' : 'permanentPet';
  }
  if (durationMs !== 0) {
    // Timed control with an all-zero header: possession always looks like this, and a charm whose
    // target sits at REACT_PASSIVE/COMMAND_STAY does too. Only the hint can separate them, and
    // getting it wrong costs a label rather than a misread byte.
    return hint === 'charm' ? 'charm' : 'possession';
  }
  // Duration 0 and header 0: a pet parked on Passive/Stay, or a permanent charm in the same stance.
  return hint === 'charm' ? 'charm' : hint === 'possession' ? 'ambiguousControl' : 'permanentPet';
}

export function decodePetSpellsBody(
  body: Uint8Array,
  hint: PetControlHint,
  actionBarSlots = 10,
): DecodedPetSpellState | undefined {
  const reader = new PetReader(body);
  const guid = reader.guid();
  if (guid === '0000000000000000') {
    if (reader.remaining !== 0) throw new Error(`pet removal left ${reader.remaining} unread bytes`);
    return undefined;
  }
  const durationMs = reader.i32();
  const headerWord = reader.u32();
  const headerBytes = [
    headerWord & 0xff,
    (headerWord >>> 8) & 0xff,
    (headerWord >>> 16) & 0xff,
    (headerWord >>> 24) & 0xff,
  ];
  const layout = resolvePetSpellLayout(headerWord, durationMs, hint);

  if (layout === 'possession' && headerWord !== 0) {
    throw new Error(`possession control word must be zero, got 0x${headerWord.toString(16)}`);
  }

  const actions: DecodedPetActionButton[] = [];
  for (let slot = 0; slot < actionBarSlots; slot++) actions.push(action(slot, reader.u32()));
  const spellCount = reader.u8();
  const spells: DecodedPetActionButton[] = [];
  for (let slot = 0; slot < spellCount; slot++) spells.push(action(slot, reader.u32()));
  const cooldownCount = reader.u16();
  const cooldowns: DecodedPetSpellCooldown[] = [];
  for (let index = 0; index < cooldownCount; index++) {
    const spellId = reader.u32();
    const category = reader.u16();
    const spellCooldownMs = reader.u32();
    const categoryCooldownRaw = reader.u32();
    cooldowns.push({
      spellId,
      category,
      spellCooldownMs,
      categoryCooldownRaw,
      // Unit::WritePetSpellsCooldown uses 0x08000000. Player spell cooldown packets use a
      // different 0x80000000 marker and must not be folded into this layout.
      permanentCategoryCooldown: (categoryCooldownRaw & 0x08000000) !== 0,
      categoryCooldownMs: categoryCooldownRaw & ~0x08000000,
    });
  }
  if (reader.remaining !== 0) throw new Error(`pet spells left ${reader.remaining} unread bytes`);

  return withLayout(
    {
      layout,
      guid,
      durationMs,
      headerWord,
      actions,
      spells,
      cooldowns,
    },
    layout,
    headerBytes,
  );
}

function withLayout(
  base: Omit<DecodedPetSpellState, 'reactState' | 'commandState' | 'flag1' | 'enabledFlags' | 'possessionControlWord'>,
  layout: PetSpellLayout,
  headerBytes: readonly number[],
): DecodedPetSpellState {
  return {
    ...base,
    layout,
    reactState: layout === 'possession' ? undefined : headerBytes[0],
    commandState: layout === 'possession' ? undefined : headerBytes[1],
    flag1: layout === 'possession' ? undefined : headerBytes[2],
    enabledFlags: layout === 'possession' ? undefined : headerBytes[3],
    possessionControlWord: layout === 'possession' ? base.headerWord : undefined,
  };
}

/**
 * Re-derive the layout of an already-decoded state once the control flags that describe it finally
 * arrive. Returns the same object when nothing changes so callers can skip a redundant emit.
 */
export function repriseWithControlHint(
  state: DecodedPetSpellState,
  hint: PetControlHint,
): DecodedPetSpellState {
  const layout = resolvePetSpellLayout(state.headerWord, state.durationMs, hint);
  if (layout === state.layout) return state;
  const headerBytes = [
    state.headerWord & 0xff,
    (state.headerWord >>> 8) & 0xff,
    (state.headerWord >>> 16) & 0xff,
    (state.headerWord >>> 24) & 0xff,
  ];
  return withLayout(state, layout, headerBytes);
}
