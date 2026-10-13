import type { Reader, WireCodec } from './wire';

/** Build-5875 Opcodes_1_12_1.h: query pairs 94/95 and 96/97. */
export const NAME_QUERY_OPCODES = {
  CMSG_GAMEOBJECT_QUERY: 0x005e,
  SMSG_GAMEOBJECT_QUERY_RESPONSE: 0x005f,
  CMSG_CREATURE_QUERY: 0x0060,
  SMSG_CREATURE_QUERY_RESPONSE: 0x0061,
} as const;

export type CreatureQueryInfo = {
  entry: number;
  name: string;
  subname: string;
  displayId: number;
  rank: number;
  type: number;
  petFamily: number;
};

export type GameObjectQueryInfo = {
  entry: number;
  name: string;
  type: number;
  displayId: number;
  icon: string;
  /** The 24 int32 values vMaNGOS serializes for Build 5875. */
  rawData: number[];
};

type NameQueryDeps<R extends Reader> = {
  reader: (body: Uint8Array) => R;
  codec: WireCodec;
  send: (opcode: number, body: Uint8Array) => void;
  progress: (message: string) => void;
  onCreature: (info: CreatureQueryInfo) => void;
  onGameObject: (info: GameObjectQueryInfo) => void;
};

/** Static creature/gameobject metadata cache plus the complete query/response wire lifecycle. */
export class NameQueryProtocol<R extends Reader> {
  private readonly creatures = new Map<number, CreatureQueryInfo>();
  private readonly gameObjects = new Map<number, GameObjectQueryInfo>();
  private readonly pendingCreatures = new Set<number>();
  private readonly pendingGameObjects = new Set<number>();
  private readonly missingCreatures = new Set<number>();
  private readonly missingGameObjects = new Set<number>();

  constructor(private readonly deps: NameQueryDeps<R>) {}

  getCreature(entry: number) { return this.creatures.get(entry); }
  getGameObject(entry: number) { return this.gameObjects.get(entry); }

  queryCreature(entry: number, guid?: string) {
    this.query('creature', NAME_QUERY_OPCODES.CMSG_CREATURE_QUERY, entry, guid);
  }

  queryGameObject(entry: number, guid?: string) {
    this.query('gameobject', NAME_QUERY_OPCODES.CMSG_GAMEOBJECT_QUERY, entry, guid);
  }

  resetPending() {
    this.pendingCreatures.clear();
    this.pendingGameObjects.clear();
  }

  /** Returns true only for a packet this domain owns. */
  handle(opcode: number, body: Uint8Array): boolean {
    if (opcode === NAME_QUERY_OPCODES.SMSG_CREATURE_QUERY_RESPONSE) {
      this.guard('creature', body, () => this.readCreature(body));
      return true;
    }
    if (opcode === NAME_QUERY_OPCODES.SMSG_GAMEOBJECT_QUERY_RESPONSE) {
      this.guard('gameobject', body, () => this.readGameObject(body));
      return true;
    }
    return false;
  }

  private query(kind: 'creature' | 'gameobject', opcode: number, entry: number, guid?: string) {
    const cache = kind === 'creature' ? this.creatures : this.gameObjects;
    const pending = kind === 'creature' ? this.pendingCreatures : this.pendingGameObjects;
    const missing = kind === 'creature' ? this.missingCreatures : this.missingGameObjects;
    if (!Number.isInteger(entry) || entry <= 0 || cache.has(entry) || pending.has(entry) || missing.has(entry)) return;
    pending.add(entry);
    const guidBody = guid ? this.deps.codec.guid(guid) : new Uint8Array(8);
    this.deps.send(opcode, this.deps.codec.concat(this.deps.codec.u32(entry), guidBody));
  }

  private guard(kind: 'creature' | 'gameobject', body: Uint8Array, read: () => void) {
    try {
      read();
    } catch (error) {
      // If the entry word itself arrived, release it so one malformed response cannot suppress all
      // future retries for that template for the remainder of the session.
      if (body.byteLength >= 4) {
        const entry = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true) & 0x7fffffff;
        (kind === 'creature' ? this.pendingCreatures : this.pendingGameObjects).delete(entry);
      }
      this.deps.progress(`world: ${kind} query parse skipped (${(error as Error).message})`);
    }
  }

  private readCreature(body: Uint8Array) {
    const r = this.deps.reader(body);
    const wireEntry = r.u32();
    const entry = wireEntry & 0x7fffffff;
    this.pendingCreatures.delete(entry);
    if ((wireEntry & 0x80000000) !== 0) { this.missingCreatures.add(entry); return; }
    const name = r.cstring();
    r.cstring(); r.cstring(); r.cstring();
    const subname = r.cstring();
    r.u32();
    const type = r.u32();
    const petFamily = r.u32();
    const rank = r.u32();
    r.u32(); r.u32();
    const displayId = r.u32();
    if (r.remaining >= 1) r.u8();
    if (r.remaining >= 1) r.u8();
    const info = { entry, name, subname, displayId, rank, type, petFamily };
    this.creatures.set(entry, info);
    this.deps.onCreature(info);
  }

  private readGameObject(body: Uint8Array) {
    const r = this.deps.reader(body);
    const wireEntry = r.u32();
    const entry = wireEntry & 0x7fffffff;
    this.pendingGameObjects.delete(entry);
    if ((wireEntry & 0x80000000) !== 0) { this.missingGameObjects.add(entry); return; }
    const type = r.u32();
    const displayId = r.u32();
    const name = r.cstring();
    r.cstring(); r.cstring(); r.cstring();
    const icon = r.cstring();
    // GameObjectInfo::raw.data is an int32[24] in the Build-5875 serializer. Preserve the
    // signed shape even though current name consumers only need the leading strings.
    const rawData = Array.from({ length: 24 }, () => r.i32());
    if (r.remaining !== 0) throw new Error(`gameobject query left ${r.remaining} unread bytes`);
    const info = { entry, name, type, displayId, icon, rawData };
    this.gameObjects.set(entry, info);
    this.deps.onGameObject(info);
  }
}
