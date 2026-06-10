import type { CharState } from "./sim.js";

export const READY_MESSAGE = "ready";

// One player's authoritative state, carried in binary snapshot datagrams
// (see netCodec.ts). Names travel separately on the reliable channel.
export type PlayerSnapshot = {
  id: string;
  // last input sequence number the server has applied for this player;
  // clients use it to ack prediction history and reconcile
  lastSeq: number;
  heading: number;
  // equipped item id (see ITEMS in items.ts)
  item: number;
  state: CharState;
};

export type BlockEdit = {
  block: number;
  x: number;
  y: number;
  z: number;
};

// Client -> server, sent as a reliable stream message on hotbar change.
export type EquipMessage = {
  type: "equip";
  item: number;
};

export function parseEquipMessage(value: unknown): EquipMessage | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "equip" &&
    Number.isInteger((value as Record<string, unknown>).item)
  ) {
    return { type: "equip", item: (value as Record<string, unknown>).item as number };
  }
  return undefined;
}

// Client -> server: throw the equipped item along a view direction.
export type ThrowMessage = {
  type: "throw";
  dx: number;
  dy: number;
  dz: number;
};

export function parseThrowMessage(value: unknown): ThrowMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "throw" &&
    isFiniteNumber(value.dx) &&
    isFiniteNumber(value.dy) &&
    isFiniteNumber(value.dz)
  ) {
    return { type: "throw", dx: value.dx, dy: value.dy, dz: value.dz };
  }
  return undefined;
}

// Client -> server, sent as reliable stream messages.
export type EditMessage = {
  type: "edit";
  block: number;
  x: number;
  y: number;
  z: number;
};

// Server -> client stream messages.
export type RosterEntry = {
  id: string;
  name: string;
};

export type WelcomeMessage = {
  type: "welcome";
  you: string;
  // players already in the session, so names resolve before their first join
  players: RosterEntry[];
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

export function parseServerStreamMessage(value: unknown): ServerStreamMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === "welcome" && typeof value.you === "string") {
    const players: RosterEntry[] = [];
    if (Array.isArray(value.players)) {
      for (const entry of value.players) {
        if (isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string") {
          players.push({ id: entry.id, name: entry.name });
        }
      }
    }
    return { type: "welcome", you: value.you, players };
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
