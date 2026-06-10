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
  hp: number;
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

// Client -> server: melee attack on another player.
export type AttackMessage = {
  type: "attack";
  target: string;
};

export function parseAttackMessage(value: unknown): AttackMessage | undefined {
  if (isRecord(value) && value.type === "attack" && typeof value.target === "string") {
    return { type: "attack", target: value.target };
  }
  return undefined;
}

// Server -> clients: a player swung their item (animation only).
export type SwingMessage = {
  type: "swing";
  id: string;
};

// Server -> clients: a player took damage.
export type HurtMessage = {
  type: "hurt";
  id: string;
  by: string;
  amount: number;
};

// Server -> clients: a player died and respawned.
export type DeathMessage = {
  type: "death";
  victim: string;
  attacker: string;
};

// Client -> server: one dig hit on a block (blocks have HP).
export type HitMessage = {
  type: "hit";
  x: number;
  y: number;
  z: number;
};

export function parseHitMessage(value: unknown): HitMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "hit" &&
    Number.isInteger(value.x) &&
    Number.isInteger(value.y) &&
    Number.isInteger(value.z)
  ) {
    return { type: "hit", x: value.x as number, y: value.y as number, z: value.z as number };
  }
  return undefined;
}

// Client -> server: place a block item held in an inventory slot.
export type PlaceMessage = {
  type: "place";
  item: number;
  slot: number;
  x: number;
  y: number;
  z: number;
};

export function parsePlaceMessage(value: unknown): PlaceMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "place" &&
    Number.isInteger(value.item) &&
    Number.isInteger(value.slot) &&
    Number.isInteger(value.x) &&
    Number.isInteger(value.y) &&
    Number.isInteger(value.z)
  ) {
    return {
      type: "place",
      item: value.item as number,
      slot: value.slot as number,
      x: value.x as number,
      y: value.y as number,
      z: value.z as number,
    };
  }
  return undefined;
}

// Client -> server: move/merge/swap the contents of two inventory slots
// (drag and drop in the inventory screen).
export type InvMoveMessage = {
  type: "invMove";
  from: number;
  to: number;
};

export function parseInvMoveMessage(value: unknown): InvMoveMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "invMove" &&
    Number.isInteger(value.from) &&
    Number.isInteger(value.to)
  ) {
    return { type: "invMove", from: value.from as number, to: value.to as number };
  }
  return undefined;
}

// Server -> hitter: dig progress on a block.
export type DamageMessage = {
  type: "damage";
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
};

// Server -> owner: full slot array after any change. Each entry is null
// (empty) or { i: item id, n: count }.
export type InventoryMessage = {
  type: "inventory";
  slots: ({ i: number; n: number } | null)[];
};

// Client -> server: throw the item held in an inventory slot along a view
// direction.
export type ThrowMessage = {
  type: "throw";
  slot: number;
  dx: number;
  dy: number;
  dz: number;
};

export function parseThrowMessage(value: unknown): ThrowMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "throw" &&
    Number.isInteger(value.slot) &&
    isFiniteNumber(value.dx) &&
    isFiniteNumber(value.dy) &&
    isFiniteNumber(value.dz)
  ) {
    return { type: "throw", slot: value.slot as number, dx: value.dx, dy: value.dy, dz: value.dz };
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

export type ServerStreamMessage =
  | WelcomeMessage
  | EditMessage
  | JoinMessage
  | LeaveMessage
  | DamageMessage
  | InventoryMessage
  | HurtMessage
  | DeathMessage
  | SwingMessage;

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
  if (
    value.type === "damage" &&
    Number.isInteger(value.x) &&
    Number.isInteger(value.y) &&
    Number.isInteger(value.z) &&
    isFiniteNumber(value.hp) &&
    isFiniteNumber(value.maxHp)
  ) {
    return {
      type: "damage",
      x: value.x as number,
      y: value.y as number,
      z: value.z as number,
      hp: value.hp,
      maxHp: value.maxHp,
    };
  }
  if (value.type === "swing" && typeof value.id === "string") {
    return { type: "swing", id: value.id };
  }
  if (
    value.type === "hurt" &&
    typeof value.id === "string" &&
    typeof value.by === "string" &&
    isFiniteNumber(value.amount)
  ) {
    return { type: "hurt", id: value.id, by: value.by, amount: value.amount };
  }
  if (
    value.type === "death" &&
    typeof value.victim === "string" &&
    typeof value.attacker === "string"
  ) {
    return { type: "death", victim: value.victim, attacker: value.attacker };
  }
  if (value.type === "inventory" && Array.isArray(value.slots)) {
    const slots: ({ i: number; n: number } | null)[] = value.slots.map((entry) => {
      if (isRecord(entry) && Number.isInteger(entry.i) && Number.isInteger(entry.n)) {
        return { i: entry.i as number, n: entry.n as number };
      }
      return null;
    });
    return { type: "inventory", slots };
  }
  if (value.type === "join" && typeof value.id === "string" && typeof value.name === "string") {
    return { type: "join", id: value.id, name: value.name };
  }
  if (value.type === "leave" && typeof value.id === "string") {
    return { type: "leave", id: value.id };
  }
  return undefined;
}
