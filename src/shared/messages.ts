export const READY_MESSAGE = "ready";

export type PlayerState = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  heading: number;
};

export type BlockEdit = {
  block: number;
  x: number;
  y: number;
  z: number;
};

// Client -> server, sent as datagrams (frequent, loss-tolerant).
export type PosMessage = {
  type: "pos";
  x: number;
  y: number;
  z: number;
  heading: number;
};

// Client -> server, sent as reliable stream messages.
export type EditMessage = {
  type: "edit";
  block: number;
  x: number;
  y: number;
  z: number;
};

// Server -> client, datagram snapshot of all player states.
export type PlayersMessage = {
  type: "players";
  players: PlayerState[];
};

// Server -> client stream messages.
export type WelcomeMessage = {
  type: "welcome";
  you: string;
  edits: BlockEdit[];
};

export type JoinMessage = {
  type: "join";
  id: string;
  name: string;
};

export type LeaveMessage = {
  type: "leave";
  id: string;
};

export type ServerStreamMessage = WelcomeMessage | EditMessage | JoinMessage | LeaveMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parsePosMessage(value: unknown): PosMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "pos" &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z) &&
    isFiniteNumber(value.heading)
  ) {
    return { type: "pos", x: value.x, y: value.y, z: value.z, heading: value.heading };
  }
  return undefined;
}

export function parseEditMessage(value: unknown): EditMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "edit" &&
    isFiniteNumber(value.block) &&
    Number.isInteger(value.x) &&
    Number.isInteger(value.y) &&
    Number.isInteger(value.z)
  ) {
    return {
      type: "edit",
      block: value.block,
      x: value.x as number,
      y: value.y as number,
      z: value.z as number,
    };
  }
  return undefined;
}

export function parsePlayerState(value: unknown): PlayerState | undefined {
  if (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z) &&
    isFiniteNumber(value.heading)
  ) {
    return {
      id: value.id,
      name: value.name,
      x: value.x,
      y: value.y,
      z: value.z,
      heading: value.heading,
    };
  }
  return undefined;
}

export function parsePlayersMessage(value: unknown): PlayersMessage | undefined {
  if (!isRecord(value) || value.type !== "players" || !Array.isArray(value.players)) {
    return undefined;
  }
  const players: PlayerState[] = [];
  for (const entry of value.players) {
    const player = parsePlayerState(entry);
    if (player) {
      players.push(player);
    }
  }
  return { type: "players", players };
}

export function parseServerStreamMessage(value: unknown): ServerStreamMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === "welcome" && typeof value.you === "string" && Array.isArray(value.edits)) {
    const edits: BlockEdit[] = [];
    for (const entry of value.edits) {
      const edit = parseEditMessage(isRecord(entry) ? { ...entry, type: "edit" } : entry);
      if (edit) {
        edits.push({ block: edit.block, x: edit.x, y: edit.y, z: edit.z });
      }
    }
    return { type: "welcome", you: value.you, edits };
  }
  if (value.type === "edit") {
    return parseEditMessage(value);
  }
  if (value.type === "join" && typeof value.id === "string" && typeof value.name === "string") {
    return { type: "join", id: value.id, name: value.name };
  }
  if (value.type === "leave" && typeof value.id === "string") {
    return { type: "leave", id: value.id };
  }
  return undefined;
}
