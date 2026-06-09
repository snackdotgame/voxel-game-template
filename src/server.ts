import { server, type Connection, type DatagramEvent, type StreamEvent } from "minion:server";
import {
  type BlockEdit,
  type PlayerSnapshot,
  parseEditMessage,
  parseInputMessage,
} from "./shared/messages.js";
import {
  SIM_TICK_MS,
  type CharState,
  spawnState,
  stepCharacter,
  type IsSolid,
} from "./shared/sim.js";
import { editKey, makeIsSolid } from "./shared/terrain.js";

const MAX_EDITS = 50_000;
// Allow short input bursts (catch-up after jitter) but bound per-player CPU.
const MAX_STEPS_PER_TICK = 8;
// Drop players whose input datagrams stop, without waiting for the
// transport-level disconnect timeout. They rejoin when datagrams resume.
const STALE_MS = 5_000;

type Player = {
  name: string;
  char: CharState;
  heading: number;
  lastSeq: number;
  stepsThisTick: number;
};

type World = {
  players: Map<string, Player>;
  lastSeen: Map<string, number>;
  edits: Map<string, BlockEdit>;
  isSolid: IsSolid;
};

export async function main() {
  const edits = new Map<string, BlockEdit>();
  const world: World = {
    players: new Map(),
    lastSeen: new Map(),
    edits,
    isSolid: makeIsSolid(edits),
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
        players.push({
          id,
          name: player.name,
          lastSeq: player.lastSeq,
          heading: player.heading,
          state: player.char,
        });
      }
      server.datagrams.broadcast({ type: "players", players });
    }

    await Promise.race([server.sleep(SIM_TICK_MS), pumps]);
  }
}

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
  const message = parseInputMessage(safeJson(event));
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
  if (message.seq <= player.lastSeq || player.stepsThisTick >= MAX_STEPS_PER_TICK) {
    return;
  }
  player.char = stepCharacter(player.char, message, world.isSolid);
  player.heading = message.heading;
  player.lastSeq = message.seq;
  player.stepsThisTick += 1;
}

function handleEdit(world: World, event: StreamEvent) {
  const message = parseEditMessage(safeJson(event));
  if (!message || world.edits.size >= MAX_EDITS) {
    return;
  }

  world.edits.set(editKey(message.x, message.y, message.z), {
    block: message.block,
    x: message.x,
    y: message.y,
    z: message.z,
  });
  server.streams.broadcast(message, { except: [event.connection.id] });
}

function addPlayer(world: World, connection: Connection) {
  world.players.set(connection.id, {
    name: connection.userName,
    char: spawnState(),
    heading: 0,
    lastSeq: 0,
    stepsThisTick: 0,
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

    addPlayer(world, connection);
    connection.streams.send({
      type: "welcome",
      you: connection.id,
      edits: [...world.edits.values()],
    });
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
