// Binary encoding for chunk-state sync packets: the *current values* of
// edited voxels in one chunk column, run-length encoded along +x. Sent
// server -> client over reliable streams when a chunk enters the player's
// sync window. Much denser than JSON, and idempotent: a packet carries
// state, not history.
//
// Layout (little-endian):
//   Header (16 bytes)
//     0   u8   0x56 'V' (magic)
//     1   u8   0x43 'C'
//     2   u8   version = 1
//     3   u8   flags: bit 0 = append (continuation packet for this chunk)
//     4   i32  chunk x
//     8   i32  chunk z
//     12  u32  record count
//   Records (7 bytes each)
//     +0  u8   local x (0..31)
//     +1  u8   local z (0..31)
//     +2  i16  world y
//     +4  u16  block id
//     +6  u8   run length along +x (1..32)

import type { BlockEdit } from "./messages.js";
import { CHUNK_SIZE } from "./terrain.js";

export const CHUNK_STATE_VERSION = 1;
const MAGIC_0 = 0x56;
const MAGIC_1 = 0x43;
const HEADER_BYTES = 16;
const RECORD_BYTES = 7;
const FLAG_APPEND = 1;

export type ChunkState = {
  cx: number;
  cz: number;
  append: boolean;
  edits: BlockEdit[];
};

type Run = {
  lx: number;
  lz: number;
  y: number;
  block: number;
  len: number;
};

export function encodeChunkState(
  cx: number,
  cz: number,
  edits: readonly BlockEdit[],
  append = false,
): Uint8Array {
  const baseX = cx * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;

  const sorted = [...edits].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const runs: Run[] = [];
  for (const edit of sorted) {
    const lx = edit.x - baseX;
    const lz = edit.z - baseZ;
    const last = runs[runs.length - 1];
    if (
      last &&
      last.y === edit.y &&
      last.lz === lz &&
      last.block === edit.block &&
      last.lx + last.len === lx
    ) {
      last.len += 1;
    } else {
      runs.push({ lx, lz, y: edit.y, block: edit.block, len: 1 });
    }
  }

  const bytes = new Uint8Array(HEADER_BYTES + runs.length * RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  bytes[0] = MAGIC_0;
  bytes[1] = MAGIC_1;
  bytes[2] = CHUNK_STATE_VERSION;
  bytes[3] = append ? FLAG_APPEND : 0;
  view.setInt32(4, cx, true);
  view.setInt32(8, cz, true);
  view.setUint32(12, runs.length, true);

  let offset = HEADER_BYTES;
  for (const run of runs) {
    bytes[offset] = run.lx;
    bytes[offset + 1] = run.lz;
    view.setInt16(offset + 2, run.y, true);
    view.setUint16(offset + 4, run.block, true);
    bytes[offset + 6] = run.len;
    offset += RECORD_BYTES;
  }
  return bytes;
}

export function decodeChunkState(bytes: Uint8Array): ChunkState | undefined {
  if (bytes.length < HEADER_BYTES || bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) {
    return undefined;
  }
  if (bytes[2] !== CHUNK_STATE_VERSION) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cx = view.getInt32(4, true);
  const cz = view.getInt32(8, true);
  const count = view.getUint32(12, true);
  if (bytes.length < HEADER_BYTES + count * RECORD_BYTES) {
    return undefined;
  }

  const baseX = cx * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;
  const edits: BlockEdit[] = [];
  let offset = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const lx = bytes[offset];
    const lz = bytes[offset + 1];
    const y = view.getInt16(offset + 2, true);
    const block = view.getUint16(offset + 4, true);
    const len = bytes[offset + 6];
    for (let r = 0; r < len; r++) {
      edits.push({ block, x: baseX + lx + r, y, z: baseZ + lz });
    }
    offset += RECORD_BYTES;
  }
  return { cx, cz, append: (bytes[3] & FLAG_APPEND) !== 0, edits };
}

// Records per packet so a fully-edited region still fits under the stream
// message size limit.
export function maxRecordsForPayload(maxBytes: number): number {
  return Math.max(64, Math.floor((maxBytes - HEADER_BYTES) / RECORD_BYTES));
}
