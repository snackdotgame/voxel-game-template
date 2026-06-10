import { server, type Connection, type DatagramEvent, type StreamEvent } from "minion:server";
import { encodeSnapshots, decodeInput } from "./shared/netCodec.js";
import {
  type BlockEdit,
  type PlayerSnapshot,
  type RosterEntry,
  parseEditMessage,
} from "./shared/messages.js";
import {
  SIM_TICK_MS,
  type CharInput,
  type CharState,
  type Stepper,
  makeStepper,
  spawnState,
} from "./shared/sim.js";
import { encodeChunkState, maxRecordsForPayload } from "./shared/chunkCodec.js";
import { chunkCoord, chunkKey, editKey, makeIsSolid } from "./shared/terrain.js";

const MAX_EDITS = 200_000;
// Allow short input bursts (catch-up after client jank) but bound per-player CPU.
const MAX_STEPS_PER_TICK = 8;
const MAX_QUEUED_INPUTS = 32;
// Drop players whose input datagrams stop, without waiting for the
// transport-level disconnect timeout. They rejoin when datagrams resume.
const STALE_MS = 5_000;

// Edit-log sync windows, in chunk-column units (32 blocks). SYNC_RADIUS must
// cover the client's chunk load distance (2.5 chunks) with margin; the gap
// up to UNSYNC_RADIUS is hysteresis so walking along a border doesn't
// resubscribe every step.
const SYNC_RADIUS = 4;
const UNSYNC_RADIUS = 6;

type Player = {
  name: string;
  char: CharState;
  heading: number;
  lastSeq: number;
  stepsThisTick: number;
  // inputs beyond the per-tick step budget wait here instead of dropping,
  // so client catch-up bursts don't force prediction rollbacks
  inputQueue: CharInput[];
  syncedChunks: Set<string>;
  lastChunk: string;
};

type World = {
  players: Map<string, Player>;
  lastSeen: Map<string, number>;
  // edit log bucketed by chunk column, each bucket keyed by block coordinate
  edits: Map<string, Map<string, BlockEdit>>;
  editCount: number;
  step: Stepper;
};

export async function main() {
  const edits = new Map<string, Map<string, BlockEdit>>();
  const isSolid = makeIsSolid((x, y, z) =>
    edits.get(chunkKey(chunkCoord(x), chunkCoord(z)))?.get(editKey(x, y, z)),
  );
  const world: World = {
    players: new Map(),
    lastSeen: new Map(),
    edits,
    editCount: 0,
    step: makeStepper(isSolid),
  };

  // recv() rejects when the runtime is shutting down; the pumps ending is
  // the signal to unwind the tick loop and return from main().
  let stopped = false;
  const pumps = Promise.all([pumpInputs(world), pumpEdits(world)]).then(() => {
    stopped = true;
  });

  while (server.running && !stopped) {
    syncConnections(world);
    dropStalePlayers(world);

    if (world.players.size > 0) {
      const players: PlayerSnapshot[] = [];
      for (const [id, player] of world.players) {
        player.stepsThisTick = 0;
        drainInputQueue(world, player);
        syncChunkWindow(world, id, player);
        players.push({
          id,
          lastSeq: player.lastSeq,
          heading: player.heading,
          state: player.char,
        });
      }
      for (const packet of encodeSnapshots(players, server.datagrams.maxSize)) {
        server.datagrams.broadcast(packet);
      }
    }

    await Promise.race([server.sleep(SIM_TICK_MS), pumps]);
  }
}

/*
 *      Chunk-scoped edit sync
 */

function syncChunkWindow(world: World, id: string, player: Player) {
  const cx = chunkCoord(player.char.x);
  const cz = chunkCoord(player.char.z);
  const current = chunkKey(cx, cz);
  if (current === player.lastChunk) {
    return;
  }
  player.lastChunk = current;

  for (let dx = -SYNC_RADIUS; dx <= SYNC_RADIUS; dx++) {
    for (let dz = -SYNC_RADIUS; dz <= SYNC_RADIUS; dz++) {
      const key = chunkKey(cx + dx, cz + dz);
      if (player.syncedChunks.has(key)) {
        continue;
      }
      player.syncedChunks.add(key);
      const bucket = world.edits.get(key);
      if (bucket && bucket.size > 0) {
        sendChunkState(id, cx + dx, cz + dz, [...bucket.values()]);
      }
    }
  }

  for (const key of player.syncedChunks) {
    const [scx, scz] = key.split(",").map(Number);
    if (Math.max(Math.abs(scx - cx), Math.abs(scz - cz)) > UNSYNC_RADIUS) {
      player.syncedChunks.delete(key);
    }
  }
}

// Send a chunk's current edited-voxel values as binary packets, split so
// each packet stays under the stream message size limit. The first packet
// replaces the client's state for the chunk; continuations append.
function sendChunkState(id: string, cx: number, cz: number, edits: BlockEdit[]) {
  const perPacket = maxRecordsForPayload(server.streams.maxSize);
  for (let start = 0; start < edits.length; start += perPacket) {
    const slice = edits.slice(start, start + perPacket);
    server.streams.send(id, encodeChunkState(cx, cz, slice, start > 0));
  }
}

function handleEdit(world: World, event: StreamEvent) {
  const message = parseEditMessage(safeJson(event));
  if (!message || world.editCount >= MAX_EDITS) {
    return;
  }

  const cKey = chunkKey(chunkCoord(message.x), chunkCoord(message.z));
  let bucket = world.edits.get(cKey);
  if (!bucket) {
    bucket = new Map();
    world.edits.set(cKey, bucket);
  }
  const bKey = editKey(message.x, message.y, message.z);
  if (!bucket.has(bKey)) {
    world.editCount += 1;
  }
  bucket.set(bKey, { block: message.block, x: message.x, y: message.y, z: message.z });

  // live edits go only to players who currently have this chunk synced
  const recipients: string[] = [];
  for (const [id, player] of world.players) {
    if (id !== event.connection.id && player.syncedChunks.has(cKey)) {
      recipients.push(id);
    }
  }
  if (recipients.length > 0) {
    server.streams.broadcast(message, { only: recipients });
  }
}

/*
 *      Input handling and player lifecycle
 */

async function pumpInputs(world: World) {
  try {
    while (true) {
      handleInput(world, await server.datagrams.recv());
    }
  } catch {
    // runtime is shutting down
  }
}

async function pumpEdits(world: World) {
  try {
    while (true) {
      handleEdit(world, await server.streams.recv());
    }
  } catch {
    // runtime is shutting down
  }
}

function handleInput(world: World, event: DatagramEvent) {
  const message = decodeInput(event.bytes);
  if (!message) {
    return;
  }
  world.lastSeen.set(event.connection.id, server.elapsedMs());
  let player = world.players.get(event.connection.id);
  if (!player) {
    // Player was dropped as stale (e.g. backgrounded tab) and is active again.
    addPlayer(world, event.connection);
    player = world.players.get(event.connection.id);
  }
  if (!player) {
    return;
  }
  // Old or duplicated datagrams are ignored; gaps from lost datagrams are
  // fine — the client detects the resulting divergence and rolls back.
  if (message.seq <= player.lastSeq) {
    return;
  }
  if (player.stepsThisTick >= MAX_STEPS_PER_TICK) {
    if (player.inputQueue.length < MAX_QUEUED_INPUTS) {
      player.inputQueue.push(message);
    }
    return;
  }
  applyInput(world, player, message);
}

function applyInput(world: World, player: Player, message: CharInput) {
  player.char = world.step(player.char, message);
  player.heading = message.heading;
  player.lastSeq = message.seq;
  player.stepsThisTick += 1;
}

function drainInputQueue(world: World, player: Player) {
  while (player.inputQueue.length > 0 && player.stepsThisTick < MAX_STEPS_PER_TICK) {
    const message = player.inputQueue.shift();
    if (message && message.seq > player.lastSeq) {
      applyInput(world, player, message);
    }
  }
}

function addPlayer(world: World, connection: Connection) {
  world.players.set(connection.id, {
    name: connection.userName,
    char: spawnState(),
    heading: 0,
    lastSeq: 0,
    stepsThisTick: 0,
    inputQueue: [],
    syncedChunks: new Set(),
    lastChunk: "none",
  });
  world.lastSeen.set(connection.id, server.elapsedMs());
  server.streams.broadcast(
    { type: "join", id: connection.id, name: connection.userName },
    { except: [connection.id] },
  );
}

function removePlayer(world: World, id: string) {
  world.players.delete(id);
  world.lastSeen.delete(id);
  server.streams.broadcast({ type: "leave", id });
}

function syncConnections(world: World) {
  const connected = new Set<string>();

  for (const connection of server.connections) {
    connected.add(connection.id);
    if (world.lastSeen.has(connection.id)) {
      continue;
    }

    const roster: RosterEntry[] = [];
    for (const [id, player] of world.players) {
      roster.push({ id, name: player.name });
    }
    addPlayer(world, connection);
    connection.streams.send({ type: "welcome", you: connection.id, players: roster });
  }

  for (const id of world.lastSeen.keys()) {
    if (!connected.has(id)) {
      removePlayer(world, id);
    }
  }
}

function dropStalePlayers(world: World) {
  const now = server.elapsedMs();
  for (const [id, seenAt] of world.lastSeen) {
    if (world.players.has(id) && now - seenAt > STALE_MS) {
      // Keep lastSeen so a resumed connection re-adds via handleInput.
      world.players.delete(id);
      server.streams.broadcast({ type: "leave", id });
    }
  }
}

function safeJson(event: { json<T = unknown>(): T }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
}
