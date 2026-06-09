import { server, type Connection, type DatagramEvent, type StreamEvent } from "minion:server";
import {
  type BlockEdit,
  type PlayerState,
  parseEditMessage,
  parsePosMessage,
} from "./shared/messages.js";

const TICK_MS = 50;
const MAX_EDITS = 50_000;
// Drop players whose position updates stop, without waiting for the
// transport-level disconnect timeout. They rejoin when datagrams resume.
const STALE_MS = 5_000;

type World = {
  players: Map<string, PlayerState>;
  lastSeen: Map<string, number>;
  edits: Map<string, BlockEdit>;
};

export async function main() {
  const world: World = {
    players: new Map(),
    lastSeen: new Map(),
    edits: new Map(),
  };

  // recv() rejects when the runtime is shutting down; the pumps ending is
  // the signal to unwind the tick loop and return from main().
  let stopped = false;
  const pumps = Promise.all([pumpPositions(world), pumpEdits(world)]).then(() => {
    stopped = true;
  });

  while (server.running && !stopped) {
    syncConnections(world);
    dropStalePlayers(world);

    if (world.players.size > 0) {
      server.datagrams.broadcast({
        type: "players",
        players: [...world.players.values()],
      });
    }

    await Promise.race([server.sleep(TICK_MS), pumps]);
  }
}

async function pumpPositions(world: World) {
  try {
    while (true) {
      handlePosition(world, await server.datagrams.recv());
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

function handlePosition(world: World, event: DatagramEvent) {
  const message = parsePosMessage(safeJson(event));
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
  player.x = message.x;
  player.y = message.y;
  player.z = message.z;
  player.heading = message.heading;
}

function handleEdit(world: World, event: StreamEvent) {
  const message = parseEditMessage(safeJson(event));
  if (!message || world.edits.size >= MAX_EDITS) {
    return;
  }

  world.edits.set(`${message.x},${message.y},${message.z}`, {
    block: message.block,
    x: message.x,
    y: message.y,
    z: message.z,
  });
  server.streams.broadcast(message, { except: [event.connection.id] });
}

function addPlayer(world: World, connection: Connection) {
  world.players.set(connection.id, {
    id: connection.id,
    name: connection.userName,
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
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
      // Keep lastSeen so a resumed connection re-adds via handlePosition.
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
