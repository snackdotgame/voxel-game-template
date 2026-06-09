import type { CharInput, CharState } from "./sim.js";

export const READY_MESSAGE = "ready";

export type PlayerSnapshot = {
  id: string;
  name: string;
  // last input sequence number the server has applied for this player;
  // clients use it to ack prediction history and reconcile
  lastSeq: number;
  heading: number;
  state: CharState;
};

export type BlockEdit = {
  block: number;
  x: number;
  y: number;
  z: number;
};

// Client -> server, sent as datagrams every sim tick (frequent, loss-tolerant;
// a lost input shows up as a prediction mismatch and gets rolled back).
export type InputMessage = { type: "input" } & CharInput;

// Client -> server, sent as reliable stream messages.
export type EditMessage = {
  type: "edit";
  block: number;
  x: number;
  y: number;
  z: number;
};

// Server -> client, datagram snapshot of authoritative player states.
export type PlayersMessage = {
  type: "players";
  players: PlayerSnapshot[];
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

export function parseInputMessage(value: unknown): InputMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "input" &&
    Number.isInteger(value.seq) &&
    isFiniteNumber(value.heading)
  ) {
    return {
      type: "input",
      seq: value.seq as number,
      heading: value.heading,
      fwd: value.fwd === true,
      back: value.back === true,
      left: value.left === true,
      right: value.right === true,
      jump: value.jump === true,
      sprint: value.sprint === true,
    };
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

function parseCharState(value: unknown): CharState | undefined {
  if (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z) &&
    isFiniteNumber(value.vx) &&
    isFiniteNumber(value.vy) &&
    isFiniteNumber(value.vz)
  ) {
    return {
      x: value.x,
      y: value.y,
      z: value.z,
      vx: value.vx,
      vy: value.vy,
      vz: value.vz,
      onGround: value.onGround === true,
    };
  }
  return undefined;
}

export function parsePlayerSnapshot(value: unknown): PlayerSnapshot | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.lastSeq) ||
    !isFiniteNumber(value.heading)
  ) {
    return undefined;
  }
  const state = parseCharState(value.state);
  if (!state) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    lastSeq: value.lastSeq as number,
    heading: value.heading,
    state,
  };
}

export function parsePlayersMessage(value: unknown): PlayersMessage | undefined {
  if (!isRecord(value) || value.type !== "players" || !Array.isArray(value.players)) {
    return undefined;
  }
  const players: PlayerSnapshot[] = [];
  for (const entry of value.players) {
    const player = parsePlayerSnapshot(entry);
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
