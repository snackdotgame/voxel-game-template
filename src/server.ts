import { server, type Connection, type DatagramEvent, type StreamEvent } from "minion:server";
import {
  type ProjectileSnapshot,
  decodeInput,
  encodeProjectiles,
  encodeSnapshots,
} from "./shared/netCodec.js";
import { KNOCKBACK, THROW_SPEED, isThrowable, isValidItem } from "./shared/items.js";
import {
  type BlockEdit,
  type PlayerSnapshot,
  type RosterEntry,
  parseEditMessage,
  parseEquipMessage,
  parseThrowMessage,
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

const PROJECTILE_GRAVITY = -16;
const PROJECTILE_TTL_MS = 5_000;
const MAX_PROJECTILES = 256;

type Player = {
  name: string;
  char: CharState;
  heading: number;
  lastSeq: number;
  item: number;
  stepsThisTick: number;
  // inputs beyond the per-tick step budget wait here instead of dropping,
  // so client catch-up bursts don't force prediction rollbacks
  inputQueue: CharInput[];
  syncedChunks: Set<string>;
  lastChunk: string;
};

type Projectile = {
  id: number;
  item: number;
  owner: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ttlMs: number;
};

type World = {
  players: Map<string, Player>;
  lastSeen: Map<string, number>;
  // edit log bucketed by chunk column, each bucket keyed by block coordinate
  edits: Map<string, Map<string, BlockEdit>>;
  editCount: number;
  step: Stepper;
  isSolid: (x: number, y: number, z: number) => boolean;
  projectiles: Map<number, Projectile>;
  nextProjectileId: number;
  hadProjectiles: boolean;
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
    isSolid,
    projectiles: new Map(),
    nextProjectileId: 1,
    hadProjectiles: false,
  };

  // recv() rejects when the runtime is shutting down; the pumps ending is
  // the signal to unwind the tick loop and return from main().
  let stopped = false;
  const pumps = Promise.all([pumpInputs(world), pumpStreams(world)]).then(() => {
    stopped = true;
  });

  while (server.running && !stopped) {
    syncConnections(world);
    dropStalePlayers(world);
    stepProjectiles(world);

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
          item: player.item,
          state: player.char,
        });
      }
      for (const packet of encodeSnapshots(players, server.datagrams.maxSize)) {
        server.datagrams.broadcast(packet);
      }
    }

    // broadcast projectile positions; one trailing empty packet clears
    // them client-side after the last projectile despawns
    if (world.projectiles.size > 0 || world.hadProjectiles) {
      const snapshots: ProjectileSnapshot[] = [];
      for (const proj of world.projectiles.values()) {
        snapshots.push({ id: proj.id, item: proj.item, x: proj.x, y: proj.y, z: proj.z });
      }
      for (const packet of encodeProjectiles(snapshots, server.datagrams.maxSize)) {
        server.datagrams.broadcast(packet);
      }
      world.hadProjectiles = world.projectiles.size > 0;
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

function handleEdit(world: World, event: StreamEvent, value: unknown) {
  const message = parseEditMessage(value);
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

async function pumpStreams(world: World) {
  try {
    while (true) {
      handleStream(world, await server.streams.recv());
    }
  } catch {
    // runtime is shutting down
  }
}

function handleStream(world: World, event: StreamEvent) {
  const value = safeJson(event);
  const equip = parseEquipMessage(value);
  if (equip) {
    const player = world.players.get(event.connection.id);
    if (player && isValidItem(equip.item)) {
      player.item = equip.item;
    }
    return;
  }
  const throwMsg = parseThrowMessage(value);
  if (throwMsg) {
    handleThrow(world, event.connection.id, throwMsg.dx, throwMsg.dy, throwMsg.dz);
    return;
  }
  handleEdit(world, event, value);
}

/*
 *      Projectiles: server-authoritative ballistics
 */

function handleThrow(world: World, ownerId: string, dx: number, dy: number, dz: number) {
  const player = world.players.get(ownerId);
  if (!player || !isThrowable(player.item) || world.projectiles.size >= MAX_PROJECTILES) {
    return;
  }
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    return;
  }
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  const speed = THROW_SPEED[player.item];
  const id = world.nextProjectileId;
  world.nextProjectileId = (world.nextProjectileId + 1) % 65536 || 1;
  world.projectiles.set(id, {
    id,
    item: player.item,
    owner: ownerId,
    // spawn at eye height, pushed forward clear of the thrower's AABB
    x: player.char.x + nx * 0.9,
    y: player.char.y + 1.5 + ny * 0.9,
    z: player.char.z + nz * 0.9,
    vx: nx * speed,
    vy: ny * speed,
    vz: nz * speed,
    ttlMs: PROJECTILE_TTL_MS,
  });
}

function stepProjectiles(world: World) {
  const dt = SIM_TICK_MS / 1000;
  for (const proj of world.projectiles.values()) {
    proj.ttlMs -= SIM_TICK_MS;
    if (proj.ttlMs <= 0) {
      world.projectiles.delete(proj.id);
      continue;
    }
    proj.vy += PROJECTILE_GRAVITY * dt;

    // substep so fast projectiles don't tunnel through blocks or players
    const steps = 3;
    let alive = true;
    for (let s = 0; s < steps && alive; s++) {
      proj.x += (proj.vx * dt) / steps;
      proj.y += (proj.vy * dt) / steps;
      proj.z += (proj.vz * dt) / steps;
      if (world.isSolid(Math.floor(proj.x), Math.floor(proj.y), Math.floor(proj.z))) {
        alive = false;
        break;
      }
      for (const [id, player] of world.players) {
        if (id === proj.owner) {
          continue;
        }
        const c = player.char;
        if (
          Math.abs(proj.x - c.x) <= 0.45 &&
          proj.y >= c.y - 0.1 &&
          proj.y <= c.y + 1.9 &&
          Math.abs(proj.z - c.z) <= 0.45
        ) {
          // knockback: server-side velocity change that reaches the hit
          // player's own client as a prediction rollback
          const kb = KNOCKBACK[proj.item];
          const hlen = Math.hypot(proj.vx, proj.vz) || 1;
          c.vx += (proj.vx / hlen) * kb;
          c.vz += (proj.vz / hlen) * kb;
          c.vy += kb * 0.5;
          c.ry = 0;
          c.sleep = 10;
          alive = false;
          break;
        }
      }
    }
    if (!alive) {
      world.projectiles.delete(proj.id);
    }
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
    item: 0,
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
