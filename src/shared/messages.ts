import type { CharState } from "./sim.js";
import { appearanceForId, isValidAppearance } from "./appearance.js";
import { isValidArmorPack } from "./items.js";
import { isValidWorldSeed } from "./terrain.js";

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
  // remaining breath, 255 = full lungs, 0 = drowning (see BREATH_MAX_MS)
  breath: number;
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

// Client -> server: the appearance built in the character creator (packed,
// see shared/appearance.ts). Usually sent before the first input, i.e.
// before the player's body materializes server-side.
export type SkinMessage = {
  type: "skin";
  skin: number;
};

export function parseSkinMessage(value: unknown): SkinMessage | undefined {
  if (isRecord(value) && value.type === "skin" && isValidAppearance(value.skin)) {
    return { type: "skin", skin: value.skin };
  }
  return undefined;
}

// Server -> clients: a player picked (or changed) their appearance after
// their join was already broadcast.
export type SkinChangeMessage = {
  type: "skin";
  id: string;
  skin: number;
};

// Server -> clients: a player's equipped armor changed (packed wear slots,
// see packArmor in items.ts), so their character can be redrawn.
export type ArmorChangeMessage = {
  type: "armor";
  id: string;
  armor: number;
};

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

// Client -> server: melee attack on an NPC (id from the NPC entity packets).
export type AttackNpcMessage = {
  type: "attackNpc";
  id: number;
};

export function parseAttackNpcMessage(value: unknown): AttackNpcMessage | undefined {
  if (isRecord(value) && value.type === "attackNpc" && Number.isInteger(value.id)) {
    return { type: "attackNpc", id: value.id as number };
  }
  return undefined;
}

// Client -> server: eat the food held in an inventory slot. Carries the item
// like place/throw do, so a racing equip can't get the wrong stack consumed.
export type EatMessage = {
  type: "eat";
  item: number;
  slot: number;
};

export function parseEatMessage(value: unknown): EatMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "eat" &&
    Number.isInteger(value.item) &&
    Number.isInteger(value.slot)
  ) {
    return { type: "eat", item: value.item as number, slot: value.slot as number };
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

// Server -> clients: a player died and respawned. Victim === attacker means
// the world did it; `cause` distinguishes drowning from the default fall.
export type DeathMessage = {
  type: "death";
  victim: string;
  attacker: string;
  cause?: "drown";
};

// Server -> clients: an NPC took a hit (flash + sound; hp stays server-side).
export type NpcHurtMessage = {
  type: "npcHurt";
  id: number;
};

// Server -> clients: a hostile NPC swung at its target (animation only).
export type NpcSwingMessage = {
  type: "npcSwing";
  id: number;
};

// Server -> clients: an NPC died. Position lets clients play an effect where
// it fell (the entity itself just vanishes from the next NPC packet).
export type NpcDeathMessage = {
  type: "npcDeath";
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
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
// (drag and drop in the inventory screen). `one` moves a single item instead
// of the whole stack (right-click drag), so the same item can be spread across
// crafting-grid cells.
export type InvMoveMessage = {
  type: "invMove";
  from: number;
  to: number;
  one: boolean;
};

export function parseInvMoveMessage(value: unknown): InvMoveMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "invMove" &&
    Number.isInteger(value.from) &&
    Number.isInteger(value.to)
  ) {
    return {
      type: "invMove",
      from: value.from as number,
      to: value.to as number,
      one: value.one === true,
    };
  }
  return undefined;
}

// Client -> server: toss the contents of a slot out into the world (dragging
// a stack out of the inventory screen). `one` drops a single item (right-
// button drag); otherwise the whole stack goes.
export type InvDropMessage = {
  type: "invDrop";
  from: number;
  one: boolean;
};

export function parseInvDropMessage(value: unknown): InvDropMessage | undefined {
  if (isRecord(value) && value.type === "invDrop" && Number.isInteger(value.from)) {
    return { type: "invDrop", from: value.from as number, one: value.one === true };
  }
  return undefined;
}

// Client -> server: open the crafting grid. size 2 is the inventory grid
// (always allowed); size 3 is a crafting table, so x/y/z carry the table
// block the player opened (validated for proximity server-side).
export type CraftOpenMessage = {
  type: "craftOpen";
  size: number;
  x?: number;
  y?: number;
  z?: number;
};

export function parseCraftOpenMessage(value: unknown): CraftOpenMessage | undefined {
  if (!isRecord(value) || value.type !== "craftOpen" || !Number.isInteger(value.size)) {
    return undefined;
  }
  const msg: CraftOpenMessage = { type: "craftOpen", size: value.size as number };
  if (Number.isInteger(value.x) && Number.isInteger(value.y) && Number.isInteger(value.z)) {
    msg.x = value.x as number;
    msg.y = value.y as number;
    msg.z = value.z as number;
  }
  return msg;
}

// Client -> server: close the crafting grid (returns grid items to inventory).
export type CraftCloseMessage = { type: "craftClose" };

export function parseCraftCloseMessage(value: unknown): CraftCloseMessage | undefined {
  if (isRecord(value) && value.type === "craftClose") {
    return { type: "craftClose" };
  }
  return undefined;
}

// Client -> server: take the crafted result (consumes one of each grid cell).
// all=true crafts repeatedly until the grid can no longer satisfy the recipe.
export type CraftTakeMessage = { type: "craftTake"; all: boolean };

export function parseCraftTakeMessage(value: unknown): CraftTakeMessage | undefined {
  if (isRecord(value) && value.type === "craftTake") {
    return { type: "craftTake", all: value.all === true };
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
// (empty) or { i: item id, n: count }. `craft` mirrors the open crafting grid
// (size 0 when closed) so the client can render cells + preview the result.
export type InvWireSlot = { i: number; n: number } | null;
export type InventoryMessage = {
  type: "inventory";
  slots: InvWireSlot[];
  craft: { size: number; grid: InvWireSlot[] };
};

// Client -> server: throw an item from an inventory slot along a view
// direction. Carries the item (like place) because stream messages ride
// separate uni streams with no cross-message ordering: a throw racing
// ahead of its equip must not be validated against the stale held item.
export type ThrowMessage = {
  type: "throw";
  item: number;
  slot: number;
  dx: number;
  dy: number;
  dz: number;
};

export function parseThrowMessage(value: unknown): ThrowMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "throw" &&
    Number.isInteger(value.item) &&
    Number.isInteger(value.slot) &&
    isFiniteNumber(value.dx) &&
    isFiniteNumber(value.dy) &&
    isFiniteNumber(value.dz)
  ) {
    return {
      type: "throw",
      item: value.item as number,
      slot: value.slot as number,
      dx: value.dx,
      dy: value.dy,
      dz: value.dz,
    };
  }
  return undefined;
}

// Client -> server: loose an arrow from a drawn bow along a view direction.
// `charge` is the raw draw fraction (0..1); the server applies the power curve
// and resolves which arrow stack to consume, so the client can't pick speed.
export type FireArrowMessage = {
  type: "fireArrow";
  charge: number;
  dx: number;
  dy: number;
  dz: number;
};

export function parseFireArrowMessage(value: unknown): FireArrowMessage | undefined {
  if (
    isRecord(value) &&
    value.type === "fireArrow" &&
    isFiniteNumber(value.charge) &&
    isFiniteNumber(value.dx) &&
    isFiniteNumber(value.dy) &&
    isFiniteNumber(value.dz)
  ) {
    return {
      type: "fireArrow",
      charge: value.charge,
      dx: value.dx,
      dy: value.dy,
      dz: value.dz,
    };
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
  skin: number;
  armor: number;
};

export type WelcomeMessage = {
  type: "welcome";
  you: string;
  // players already in the session, so names resolve before their first join
  players: RosterEntry[];
  // the session's world seed; the client holds worldgen until it arrives
  seed: number;
};

export type JoinMessage = {
  type: "join";
  id: string;
  name: string;
  skin: number;
  armor: number;
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
  | SwingMessage
  | SkinChangeMessage
  | ArmorChangeMessage
  | NpcHurtMessage
  | NpcSwingMessage
  | NpcDeathMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWireSlots(arr: unknown[]): InvWireSlot[] {
  return arr.map((entry) => {
    if (isRecord(entry) && Number.isInteger(entry.i) && Number.isInteger(entry.n)) {
      return { i: entry.i as number, n: entry.n as number };
    }
    return null;
  });
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
          players.push({
            id: entry.id,
            name: entry.name,
            skin: isValidAppearance(entry.skin) ? entry.skin : appearanceForId(entry.id),
            armor: isValidArmorPack(entry.armor) ? entry.armor : 0,
          });
        }
      }
    }
    return {
      type: "welcome",
      you: value.you,
      players,
      seed: isValidWorldSeed(value.seed) ? value.seed : 0,
    };
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
    return {
      type: "death",
      victim: value.victim,
      attacker: value.attacker,
      cause: value.cause === "drown" ? "drown" : undefined,
    };
  }
  if (value.type === "inventory" && Array.isArray(value.slots)) {
    const slots = parseWireSlots(value.slots);
    let craft = { size: 0, grid: [] as InvWireSlot[] };
    if (
      isRecord(value.craft) &&
      Number.isInteger(value.craft.size) &&
      Array.isArray(value.craft.grid)
    ) {
      craft = { size: value.craft.size as number, grid: parseWireSlots(value.craft.grid) };
    }
    return { type: "inventory", slots, craft };
  }
  if (value.type === "join" && typeof value.id === "string" && typeof value.name === "string") {
    return {
      type: "join",
      id: value.id,
      name: value.name,
      skin: isValidAppearance(value.skin) ? value.skin : appearanceForId(value.id),
      armor: isValidArmorPack(value.armor) ? value.armor : 0,
    };
  }
  if (value.type === "skin" && typeof value.id === "string" && isValidAppearance(value.skin)) {
    return { type: "skin", id: value.id, skin: value.skin };
  }
  if (value.type === "armor" && typeof value.id === "string" && isValidArmorPack(value.armor)) {
    return { type: "armor", id: value.id, armor: value.armor };
  }
  if (value.type === "leave" && typeof value.id === "string") {
    return { type: "leave", id: value.id };
  }
  if (value.type === "npcHurt" && Number.isInteger(value.id)) {
    return { type: "npcHurt", id: value.id as number };
  }
  if (value.type === "npcSwing" && Number.isInteger(value.id)) {
    return { type: "npcSwing", id: value.id as number };
  }
  if (
    value.type === "npcDeath" &&
    Number.isInteger(value.id) &&
    Number.isInteger(value.kind) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z)
  ) {
    return {
      type: "npcDeath",
      id: value.id as number,
      kind: value.kind as number,
      x: value.x,
      y: value.y,
      z: value.z,
    };
  }
  return undefined;
}
