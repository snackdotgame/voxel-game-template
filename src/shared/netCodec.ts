// Binary encodings for the high-frequency datagram traffic: client inputs
// and server player-state snapshots. Both are little-endian DataView
// layouts with a 2-byte magic so receivers can distinguish them from the
// JSON stream messages.
//
// Input packet 'VI' (4 + 13 bytes per record):
//   0  u8   0x56 'V'
//   1  u8   0x49 'I'
//   2  u8   version
//   3  u8   record count
//   then per input, oldest first:
//     u32  input seq
//     f32  heading (radians)
//     f32  pitch (radians, positive looking down; drives swim direction)
//     u8   buttons: fwd 1, back 2, left 4, right 8, jump 16, sprint 32
//   Datagrams are fire-and-forget, so every packet carries the tail of the
//   sender's unacked inputs (the snapshot lastSeq is the ack that trims
//   them): a lost packet is healed by the next one instead of forcing a
//   rollback for the permanently skipped sim step.
//
// Snapshot packet 'VS':
//   0  u8   0x56 'V'
//   1  u8   0x53 'S'
//   2  u8   version (NET_CODEC_VERSION)
//   3  u8   record count
//   then per player:
//     u8   id length, followed by that many bytes of UTF-8 connection id
//     u32  lastSeq          (last input seq applied by the server)
//     f32  heading
//     f64  x, y, z          (f64: these restore the prediction sim on ack)
//     f32  vx, vy, vz
//     f32  jumpMsLeft
//     u8   flags: resting x/y/z as 2-bit values (-1 -> 0, 0 -> 1, 1 -> 2)
//          in bits 0-5, jumping in bit 6
//     u8   sleep frame count
//     u8   jump count
//     u8   equipped item id
//     u8   hp
//     u8   breath (255 = full lungs, 0 = drowning)
//   Names travel on the reliable channel (welcome roster / join), not here.

import type { PlayerSnapshot } from "./messages.js";
import type { CharInput, CharState } from "./sim.js";

export type ProjectileSnapshot = {
  id: number;
  item: number;
  x: number;
  y: number;
  z: number;
};

const MAGIC_V = 0x56;
const MAGIC_I = 0x49;
const MAGIC_S = 0x53;
const MAGIC_P = 0x50;
const MAGIC_D = 0x44;
const MAGIC_N = 0x4e;
export const NET_CODEC_VERSION = 5;

const INPUT_HEADER_BYTES = 4;
const INPUT_RECORD_BYTES = 13;
const SNAPSHOT_HEADER_BYTES = 4;
const RECORD_FIXED_BYTES = 54;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/*
 *      Inputs
 */

export function encodeInputs(inputs: readonly CharInput[]): Uint8Array {
  const count = Math.min(inputs.length, 255);
  const bytes = new Uint8Array(INPUT_HEADER_BYTES + count * INPUT_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  bytes[0] = MAGIC_V;
  bytes[1] = MAGIC_I;
  bytes[2] = NET_CODEC_VERSION;
  bytes[3] = count;
  let offset = INPUT_HEADER_BYTES;
  for (let i = inputs.length - count; i < inputs.length; i++) {
    const input = inputs[i];
    view.setUint32(offset, input.seq, true);
    view.setFloat32(offset + 4, input.heading, true);
    view.setFloat32(offset + 8, input.pitch, true);
    bytes[offset + 12] =
      (input.fwd ? 1 : 0) |
      (input.back ? 2 : 0) |
      (input.left ? 4 : 0) |
      (input.right ? 8 : 0) |
      (input.jump ? 16 : 0) |
      (input.sprint ? 32 : 0);
    offset += INPUT_RECORD_BYTES;
  }
  return bytes;
}

export function decodeInputs(bytes: Uint8Array): CharInput[] | undefined {
  if (bytes.length < INPUT_HEADER_BYTES || bytes[0] !== MAGIC_V || bytes[1] !== MAGIC_I) {
    return undefined;
  }
  if (bytes[2] !== NET_CODEC_VERSION) {
    return undefined;
  }
  const count = bytes[3];
  if (bytes.length !== INPUT_HEADER_BYTES + count * INPUT_RECORD_BYTES) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inputs: CharInput[] = [];
  let offset = INPUT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const heading = view.getFloat32(offset + 4, true);
    const pitch = view.getFloat32(offset + 8, true);
    if (!Number.isFinite(heading) || !Number.isFinite(pitch)) {
      return undefined;
    }
    const buttons = bytes[offset + 12];
    inputs.push({
      seq: view.getUint32(offset, true),
      heading,
      // half-pi bound like a real look pitch, so a hostile client can't
      // request outsized dive speeds
      pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)),
      fwd: (buttons & 1) !== 0,
      back: (buttons & 2) !== 0,
      left: (buttons & 4) !== 0,
      right: (buttons & 8) !== 0,
      jump: (buttons & 16) !== 0,
      sprint: (buttons & 32) !== 0,
    });
    offset += INPUT_RECORD_BYTES;
  }
  return inputs;
}

/*
 *      Player-state snapshots
 */

function packResting(state: CharState): number {
  const two = (v: number) => (v < 0 ? 0 : v > 0 ? 2 : 1);
  return two(state.rx) | (two(state.ry) << 2) | (two(state.rz) << 4) | (state.jumping ? 64 : 0);
}

function unpackResting(flags: number, shift: number): number {
  return ((flags >> shift) & 3) - 1;
}

function recordSize(idBytes: number): number {
  return 1 + idBytes + RECORD_FIXED_BYTES;
}

// Encodes snapshots into one or more packets, each at most maxBytes long.
export function encodeSnapshots(
  players: readonly PlayerSnapshot[],
  maxBytes: number,
): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let group: { snap: PlayerSnapshot; idBytes: Uint8Array }[] = [];
  let groupSize = SNAPSHOT_HEADER_BYTES;

  const flush = () => {
    if (group.length === 0) {
      return;
    }
    const bytes = new Uint8Array(groupSize);
    const view = new DataView(bytes.buffer);
    bytes[0] = MAGIC_V;
    bytes[1] = MAGIC_S;
    bytes[2] = NET_CODEC_VERSION;
    bytes[3] = group.length;
    let offset = SNAPSHOT_HEADER_BYTES;
    for (const { snap, idBytes } of group) {
      bytes[offset++] = idBytes.length;
      bytes.set(idBytes, offset);
      offset += idBytes.length;
      view.setUint32(offset, snap.lastSeq, true);
      view.setFloat32(offset + 4, snap.heading, true);
      view.setFloat64(offset + 8, snap.state.x, true);
      view.setFloat64(offset + 16, snap.state.y, true);
      view.setFloat64(offset + 24, snap.state.z, true);
      view.setFloat32(offset + 32, snap.state.vx, true);
      view.setFloat32(offset + 36, snap.state.vy, true);
      view.setFloat32(offset + 40, snap.state.vz, true);
      view.setFloat32(offset + 44, snap.state.jumpMsLeft, true);
      bytes[offset + 48] = packResting(snap.state);
      bytes[offset + 49] = Math.max(0, Math.min(255, snap.state.sleep));
      bytes[offset + 50] = Math.max(0, Math.min(255, snap.state.jumpCount));
      bytes[offset + 51] = Math.max(0, Math.min(255, snap.item));
      bytes[offset + 52] = Math.max(0, Math.min(255, snap.hp));
      bytes[offset + 53] = Math.max(0, Math.min(255, snap.breath));
      offset += RECORD_FIXED_BYTES;
    }
    packets.push(bytes);
    group = [];
    groupSize = SNAPSHOT_HEADER_BYTES;
  };

  for (const snap of players) {
    const idBytes = textEncoder.encode(snap.id);
    const size = recordSize(idBytes.length);
    if (group.length > 0 && (groupSize + size > maxBytes || group.length >= 255)) {
      flush();
    }
    group.push({ snap, idBytes });
    groupSize += size;
  }
  flush();
  return packets;
}

/*
 *      Projectiles
 *
 *  Packet 'VP': header (4 bytes: magic, version, count u8), then 15-byte
 *  records: id u16, item u8, x/y/z f32. Render-only, so f32 is plenty.
 */

const PROJ_RECORD_BYTES = 15;

export function encodeProjectiles(
  projectiles: readonly ProjectileSnapshot[],
  maxBytes: number,
): Uint8Array[] {
  return encodeEntityPackets(MAGIC_P, projectiles, maxBytes);
}

export function decodeProjectiles(bytes: Uint8Array): ProjectileSnapshot[] | undefined {
  return decodeEntityPackets(MAGIC_P, bytes);
}

// World item drops use the identical record shape under a different magic.
export function encodeDrops(drops: readonly ProjectileSnapshot[], maxBytes: number): Uint8Array[] {
  return encodeEntityPackets(MAGIC_D, drops, maxBytes);
}

export function decodeDrops(bytes: Uint8Array): ProjectileSnapshot[] | undefined {
  return decodeEntityPackets(MAGIC_D, bytes);
}

// NPCs (e.g. wandering chickens) are render-only positional entities, so they
// reuse the same 15-byte record as projectiles/drops under their own magic;
// `item` carries the NPC kind. The server only broadcasts NPCs in chunks near
// a player, and a trailing empty packet clears the rest client-side.
export function encodeNpcs(npcs: readonly ProjectileSnapshot[], maxBytes: number): Uint8Array[] {
  return encodeEntityPackets(MAGIC_N, npcs, maxBytes);
}

export function decodeNpcs(bytes: Uint8Array): ProjectileSnapshot[] | undefined {
  return decodeEntityPackets(MAGIC_N, bytes);
}

function encodeEntityPackets(
  magic: number,
  projectiles: readonly ProjectileSnapshot[],
  maxBytes: number,
): Uint8Array[] {
  const perPacket = Math.max(1, Math.min(255, Math.floor((maxBytes - 4) / PROJ_RECORD_BYTES)));
  const packets: Uint8Array[] = [];
  for (let start = 0; start === 0 || start < projectiles.length; start += perPacket) {
    const group = projectiles.slice(start, start + perPacket);
    const bytes = new Uint8Array(4 + group.length * PROJ_RECORD_BYTES);
    const view = new DataView(bytes.buffer);
    bytes[0] = MAGIC_V;
    bytes[1] = magic;
    bytes[2] = NET_CODEC_VERSION;
    bytes[3] = group.length;
    let offset = 4;
    for (const proj of group) {
      view.setUint16(offset, proj.id, true);
      bytes[offset + 2] = proj.item;
      view.setFloat32(offset + 3, proj.x, true);
      view.setFloat32(offset + 7, proj.y, true);
      view.setFloat32(offset + 11, proj.z, true);
      offset += PROJ_RECORD_BYTES;
    }
    packets.push(bytes);
  }
  return packets;
}

function decodeEntityPackets(magic: number, bytes: Uint8Array): ProjectileSnapshot[] | undefined {
  if (bytes.length < 4 || bytes[0] !== MAGIC_V || bytes[1] !== magic) {
    return undefined;
  }
  if (bytes[2] !== NET_CODEC_VERSION) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes[3];
  if (bytes.length < 4 + count * PROJ_RECORD_BYTES) {
    return undefined;
  }
  const projectiles: ProjectileSnapshot[] = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    projectiles.push({
      id: view.getUint16(offset, true),
      item: bytes[offset + 2],
      x: view.getFloat32(offset + 3, true),
      y: view.getFloat32(offset + 7, true),
      z: view.getFloat32(offset + 11, true),
    });
    offset += PROJ_RECORD_BYTES;
  }
  return projectiles;
}

export function decodeSnapshots(bytes: Uint8Array): PlayerSnapshot[] | undefined {
  if (bytes.length < SNAPSHOT_HEADER_BYTES || bytes[0] !== MAGIC_V || bytes[1] !== MAGIC_S) {
    return undefined;
  }
  if (bytes[2] !== NET_CODEC_VERSION) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes[3];
  const players: PlayerSnapshot[] = [];
  let offset = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (offset + 1 > bytes.length) {
      return undefined;
    }
    const idLength = bytes[offset++];
    if (offset + idLength + RECORD_FIXED_BYTES > bytes.length) {
      return undefined;
    }
    const id = textDecoder.decode(bytes.subarray(offset, offset + idLength));
    offset += idLength;
    const flags = bytes[offset + 48];
    players.push({
      id,
      lastSeq: view.getUint32(offset, true),
      heading: view.getFloat32(offset + 4, true),
      item: bytes[offset + 51],
      hp: bytes[offset + 52],
      breath: bytes[offset + 53],
      state: {
        x: view.getFloat64(offset + 8, true),
        y: view.getFloat64(offset + 16, true),
        z: view.getFloat64(offset + 24, true),
        vx: view.getFloat32(offset + 32, true),
        vy: view.getFloat32(offset + 36, true),
        vz: view.getFloat32(offset + 40, true),
        jumpMsLeft: view.getFloat32(offset + 44, true),
        rx: unpackResting(flags, 0),
        ry: unpackResting(flags, 2),
        rz: unpackResting(flags, 4),
        jumping: (flags & 64) !== 0,
        sleep: bytes[offset + 49],
        jumpCount: bytes[offset + 50],
      },
    });
    offset += RECORD_FIXED_BYTES;
  }
  return players;
}
