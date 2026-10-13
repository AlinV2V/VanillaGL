# Build 5875 protocol

The protocol implementation targets World of Warcraft 1.12.1 Build 5875 and vMaNGOS. Current client authority is `apps/client/src/auth.ts`, `world.ts`, `world-entities.ts`, and the focused modules under `combat/`; server behavior is checked against the vMaNGOS core source. Opcode values live in the `OPCODES` table in `world.ts`; `SMSG_UPDATE_OBJECT` is `0x00A9`.

## Transport and authentication

The browser opens `ws://127.0.0.1:9000/?target=auth|world`. `server/proxy/proxy.mjs` validates origins/connection limits, opens TCP 3724 or 8085, preserves binary byte order and message fragments, and implements bounded upstream/downstream backpressure. It does not translate world packets. During auth proof only, it patches the 20-byte login integrity hash to the configured Build 5875 client digest expected by vMaNGOS.

`auth.ts` implements SRP6 with the upper-cased `ACCOUNT:PASSWORD` identity, server `B`, generator `g`, modulus `N`, salt `s`, client private `a`, public `A`, scrambling value `u`, shared secret `S`, interleaved 40-byte session key `K`, client proof `M1`, and verified server proof `M2`. The logon challenge is opcode `0x00`; proof is `0x01`; realm list is `0x10`. The proof body is opcode + 32-byte A + 20-byte M1 + 20-byte integrity hash + two security bytes. Authentication packets are not world-header encrypted.

World authentication sends `CMSG_AUTH_SESSION` in clear. After `SMSG_AUTH_CHALLENGE`/session verification, `WorldSocket.enableEncryption()` enables the Vanilla add/XOR header stream keyed directly by the 40-byte SRP session key. Payloads remain clear; only headers are transformed, with independent send/receive `(i,j)` state.

## World headers and reassembly

Client→server wire header is 6 bytes: big-endian u16 size (`body + 4`), little-endian u32 opcode, then body. Server→client header is 4 bytes: big-endian u16 size (`body + 2`), little-endian u16 opcode, then body. Encryption covers exactly those 6 or 4 header bytes after activation.

WebSocket messages are not packet boundaries. `WorldSocket.push()` appends bytes, waits for a complete 4-byte inbound header, decrypts it once, records the pending body length/opcode, then waits across any number of WebSocket fragments. A malformed encrypted header closes the transport because the stateful cipher cannot safely resynchronize.

## `SMSG_UPDATE_OBJECT`

`parseWorldUpdatePacket()` consumes little-endian `u32 blockCount`, `u8 hasTransport`, then `blockCount` blocks:

| Update type | Value | Layout |
|---|---:|---|
| VALUES | 0 | packed GUID, update mask, values |
| MOVEMENT | 1 | raw 8-byte GUID, movement block |
| CREATE_OBJECT / CREATE_OBJECT2 | 2 / 3 | packed GUID, u8 TypeID, movement block, update mask/values |
| OUT_OF_RANGE / NEAR_OBJECTS | 4 / 5 | i32 count, packed GUID list |

Packed GUID is one mask byte followed by only the nonzero GUID bytes in low-byte order. A values block begins with `u8 maskBlockCount`, then that many little-endian u32 bit masks; one u32 value follows for each set bit in ascending field index (`block*32 + bit`). TypeID values 0–7 are object, item, container, unit, player, game object, dynamic object, and corpse. Field meanings come from vMaNGOS `UpdateFields_1_12_1.h`, with the reconciled player layout in `data/player-field-layout.ts`.

Movement update flags are `SELF 0x01`, `TRANSPORT 0x02`, `MELEE_ATTACKING 0x04`, `HIGHGUID 0x08`, `ALL 0x10`, `LIVING 0x20`, and `HAS_POSITION 0x40`. `0x80` is rejected as non-Vanilla. A living block carries MovementInfo, six speeds (walk/run/run-back/swim/swim-back/turn), and conditional spline data; a nonliving positioned block carries x/y/z/orientation. Trailer order is high-guid, all, attacking packed GUID, transport timer.

`SMSG_COMPRESSED_UPDATE_OBJECT` is zlib-inflated under a 900,000-byte cap before the same parser. Parse failures are contained and counted rather than terminating the read loop.

## Movement and heartbeat

Base MovementInfo is `u32 flags`, `u32 serverTime`, four f32 values x/y/z/orientation, then conditionals:

- `ONTRANSPORT 0x02000000`: raw u64 transport GUID + transport x/y/z/o.
- `SWIMMING 0x00200000`: f32 pitch.
- always: u32 fall time.
- `FALLING 0x00002000`: f32 vertical velocity, cos angle, sin angle, horizontal speed.
- `SPLINE_ELEVATION 0x04000000`: f32 elevation.

Heartbeat and observer movement packets prepend the appropriate packed/raw mover GUID as defined by their opcode. The sender preserves server-clock correction, controlled-mover state, transport offsets, root/swim/fall flags, and acknowledges forced speed/root/knockback with the vMaNGOS packet shape. `combat/movement-packets.ts`, `movement-state.ts`, `controlled-mover.ts`, and `compressed-moves.ts` isolate these conditional layouts.

## Duel completion

`SMSG_DUEL_COMPLETE` (`0x016A`) contains one serialized boolean byte. vMaNGOS sends `0` when a challenge/countdown is interrupted and `1` when an actually-started duel completes. Both duelists receive the packet. The client preserves this byte in `DuelNotice`: both cases close duel UI, but only `started=true` tears down combat presentation and forces one `CMSG_SETSHEATHED(0)` synchronization. Treating the packet as empty would either leave the challenger drawn after a real duel or incorrectly interrupt unrelated combat when an invitation is cancelled.

## Coverage

Coverage extends through login/character lifecycle, update objects, movement/splines/teleports, combat/spells/auras, inventory/economy, quests, social/guild/party, pets, death, taxis/transports, and service packets. It is not equivalent to every Build 5875 opcode. Unknown or deferred server opcodes must be classified against vMaNGOS before implementation; later-expansion packet layouts are not fallback authority.
