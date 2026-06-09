import { server } from "minion:server";
import {
  type BlockEdit,
  type PlayerState,
  parseEditMessage,
  parsePosMessage,
} from "./shared/messages.js";

const TICK_MS = 50;
const MAX_EDITS = 50_000;

export async function main() {
  const players = new Map<string, PlayerState>();
  const edits = new Map<string, BlockEdit>();

  while (server.running) {
    syncConnections(players, edits);
    drainPositions(players);
    drainEdits(players, edits);

    if (players.size > 0) {
      server.datagrams.broadcast({
        type: "players",
        players: [...players.values()],
      });
    }

    await server.sleep(TICK_MS);
  }
}

function syncConnections(players: Map<string, PlayerState>, edits: Map<string, BlockEdit>) {
  const connected = new Set<string>();

  for (const connection of server.connections) {
    connected.add(connection.id);
    if (players.has(connection.id)) {
      continue;
    }

    players.set(connection.id, {
      id: connection.id,
      name: connection.userName,
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
    });
    connection.streams.send({
      type: "welcome",
      you: connection.id,
      edits: [...edits.values()],
    });
    server.streams.broadcast(
      { type: "join", id: connection.id, name: connection.userName },
      { except: [connection.id] },
    );
  }

  for (const id of players.keys()) {
    if (!connected.has(id)) {
      players.delete(id);
      server.streams.broadcast({ type: "leave", id });
    }
  }
}

function drainPositions(players: Map<string, PlayerState>) {
  for (const event of server.datagrams.drain()) {
    const message = parsePosMessage(safeJson(event));
    const player = players.get(event.connection.id);
    if (!message || !player) {
      continue;
    }
    player.x = message.x;
    player.y = message.y;
    player.z = message.z;
    player.heading = message.heading;
  }
}

function drainEdits(players: Map<string, PlayerState>, edits: Map<string, BlockEdit>) {
  for (const event of server.streams.drain()) {
    const message = parseEditMessage(safeJson(event));
    if (!message || !players.has(event.connection.id)) {
      continue;
    }
    if (edits.size >= MAX_EDITS) {
      continue;
    }

    edits.set(`${message.x},${message.y},${message.z}`, {
      block: message.block,
      x: message.x,
      y: message.y,
      z: message.z,
    });
    server.streams.broadcast(message, { except: [event.connection.id] });
  }
}

function safeJson(event: { json<T = unknown>(): T }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
}
