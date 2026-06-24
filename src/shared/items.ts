// Equippable items. Ids are stable wire values (u8 in snapshots).
import {
  COAL_ORE_ID,
  CRAFTING_TABLE_ID,
  DIAMOND_ORE_ID,
  DIRT_ID,
  GOLD_ORE_ID,
  GRASS_ID,
  IRON_ORE_ID,
  LEAVES_ID,
  LOG_ID,
  SAND_ID,
  SNOW_ID,
  STONE_ID,
} from "./terrain.js";

export const ITEMS = [
  "Hand",
  "Pickaxe",
  "Axe",
  "Shovel",
  "Rock",
  "Snowball",
  "Plank",
  "Stick",
  "Bow",
  "Arrow",
  "Feather",
  "String",
] as const;

export const HAND = 0;
export const PICKAXE = 1;
export const AXE = 2;
export const SHOVEL = 3;
export const ROCK = 4;
export const SNOWBALL = 5;
// Crafting materials. Not throwable, not tools; stack to 64 by default.
export const PLANK = 6;
export const STICK = 7;
// Ranged weapon + ammo, and the materials that craft them.
export const BOW = 8;
export const ARROW = 9;
export const FEATHER = 10;
export const STRING = 11;

// Block items occupy ids 64+blockId so a u8 covers both kinds.
export const BLOCK_ITEM_BASE = 64;

export const BLOCK_NAMES: readonly string[] = [
  "",
  "Grass",
  "Dirt",
  "Stone",
  "Sand",
  "Snow",
  "Log",
  "Leaves",
  "Coal Ore",
  "Iron Ore",
  "Gold Ore",
  "Diamond Ore",
  "Water",
  "Crafting Table",
];

export function isValidItem(item: number): boolean {
  return (
    Number.isInteger(item) &&
    ((item >= 0 && item < ITEMS.length) ||
      (item > BLOCK_ITEM_BASE && item < BLOCK_ITEM_BASE + BLOCK_NAMES.length))
  );
}

export function isBlockItem(item: number): boolean {
  return item > BLOCK_ITEM_BASE;
}

export function blockToItem(block: number): number {
  return BLOCK_ITEM_BASE + block;
}

export function itemToBlock(item: number): number {
  return item - BLOCK_ITEM_BASE;
}

export function itemName(item: number): string {
  if (isBlockItem(item)) {
    return BLOCK_NAMES[itemToBlock(item)] ?? "Block";
  }
  return ITEMS[item] ?? "Item";
}

// Initial projectile speed in blocks/s. Throw distance follows from speed
// (ballistic, gravity 16): a rock flies far, a snowball decently, tools are
// heavy and land short. Block items lob like tools. Hand is not throwable.
const TOOL_THROW_SPEED: readonly number[] = [0, 9, 10, 9, 18, 13];

export function throwSpeed(item: number): number {
  if (isBlockItem(item)) {
    return 8;
  }
  return TOOL_THROW_SPEED[item] ?? 0;
}

export function isThrowable(item: number): boolean {
  return isValidItem(item) && throwSpeed(item) > 0;
}

// Knockback impulse applied to a player the projectile hits.
const TOOL_KNOCKBACK: readonly number[] = [0, 7, 7, 6, 5, 2.5];

export function knockback(item: number): number {
  if (isBlockItem(item)) {
    return 4;
  }
  return TOOL_KNOCKBACK[item] ?? 0;
}

// Snowballs poof on impact; everything else persists as a world drop.
export function dropsOnImpact(item: number): boolean {
  return item !== SNOWBALL;
}

/*
 *      Block durability
 */

export function blockHP(block: number): number {
  switch (block) {
    case LEAVES_ID:
      return 1;
    case SAND_ID:
    case SNOW_ID:
      return 2;
    case GRASS_ID:
    case DIRT_ID:
      return 3;
    case LOG_ID:
      return 6;
    case CRAFTING_TABLE_ID:
      return 4;
    case STONE_ID:
      return 8;
    case COAL_ORE_ID:
    case IRON_ORE_ID:
    case GOLD_ORE_ID:
    case DIAMOND_ORE_ID:
      return 12;
    default:
      return 0;
  }
}

export function requiresPickaxe(block: number): boolean {
  // stone + the four ores only; bound the range so later block ids (the
  // wooden crafting table at 13) aren't misclassified as pickaxe-only
  return block === STONE_ID || (block >= COAL_ORE_ID && block <= DIAMOND_ORE_ID);
}

// Damage one hit deals: 0 if the block can't be dug with that item,
// 2 with the matching tool, 1 otherwise.
export function hitDamage(item: number, block: number): number {
  if (blockHP(block) === 0) {
    return 0;
  }
  if (requiresPickaxe(block)) {
    return item === PICKAXE ? 2 : 0;
  }
  const matching =
    (item === AXE && (block === LOG_ID || block === LEAVES_ID || block === CRAFTING_TABLE_ID)) ||
    (item === SHOVEL &&
      (block === DIRT_ID || block === GRASS_ID || block === SAND_ID || block === SNOW_ID));
  return matching ? 2 : 1;
}

// Extra drops beyond the block itself (ammo loop: stone yields a rock,
// snow yields a snowball, leaves yield the string a bow is strung with).
export function bonusDrop(block: number): number | null {
  if (block === STONE_ID) {
    return ROCK;
  }
  if (block === SNOW_ID) {
    return SNOWBALL;
  }
  if (block === LEAVES_ID) {
    return STRING;
  }
  return null;
}

/*
 *      Combat
 */

export const MAX_HP = 20;

// Damage a melee swing deals with this item in hand.
const MELEE_DAMAGE: readonly number[] = [2, 4, 5, 3, 2, 1];

export function meleeDamage(item: number): number {
  if (isBlockItem(item)) {
    return 2;
  }
  return MELEE_DAMAGE[item] ?? 1;
}

// Damage a projectile of this item deals on a direct hit.
const PROJECTILE_DAMAGE: readonly number[] = [0, 5, 5, 5, 4, 1];

export function projectileDamage(item: number): number {
  if (isBlockItem(item)) {
    return 2;
  }
  return PROJECTILE_DAMAGE[item] ?? 1;
}

/*
 *      Bow & arrow
 *
 *  A drawn bow looses an arrow whose speed, damage, and knockback all scale
 *  with how long it was drawn, mirroring Minecraft: a full draw (~1s) flies
 *  fast and flat and hits hard; a quick release lobs a weak arrow. The client
 *  reports the raw draw fraction (0..1); the server applies the curve below so
 *  power is server-authoritative.
 */

// time, in ms, a bow must be held to reach a full-power draw
export const BOW_DRAW_MS = 1000;
// below this draw fraction the bow won't loose (a barely-pulled string)
export const BOW_MIN_CHARGE = 0.05;

const ARROW_MIN_SPEED = 12;
const ARROW_MAX_SPEED = 34;
const ARROW_MAX_DAMAGE = 9;
const ARROW_MIN_KNOCKBACK = 2;
const ARROW_MAX_KNOCKBACK = 7;

// Minecraft's draw curve: power ramps up faster than linearly and saturates at
// a full draw. `charge` is the fraction of a full draw, clamped to 0..1.
export function bowPower(charge: number): number {
  const c = Math.max(0, Math.min(1, charge));
  return (c * c + 2 * c) / 3;
}

export type ArrowLaunch = { speed: number; damage: number; knockback: number };

// Speed/damage/knockback for an arrow loosed at the given draw fraction.
export function arrowLaunch(charge: number): ArrowLaunch {
  const p = bowPower(charge);
  return {
    speed: ARROW_MIN_SPEED + p * (ARROW_MAX_SPEED - ARROW_MIN_SPEED),
    damage: Math.max(1, Math.round(p * ARROW_MAX_DAMAGE)),
    knockback: ARROW_MIN_KNOCKBACK + p * (ARROW_MAX_KNOCKBACK - ARROW_MIN_KNOCKBACK),
  };
}

/*
 *      Slot inventory
 *
 *  Minecraft-style storage: a fixed array of slots, each empty or holding a
 *  stack of one item. Slots 0-8 are the hotbar (number keys); 9-35 are the
 *  larger storage behind the inventory screen. The server owns the slots
 *  and echoes the full array after every change.
 */

export const HOTBAR_SLOTS = 9;
export const INV_SLOTS = 36;

export type InvSlot = { item: number; count: number } | null;

// tools don't stack; everything else stacks like Minecraft
export function stackLimit(item: number): number {
  return item === PICKAXE || item === AXE || item === SHOVEL || item === BOW ? 1 : 64;
}

// slot 0 stays empty so the 1 key is the bare hand, matching the
// pre-slot hotbar layout (2 pickaxe, 3 axe, 4 shovel, 5 rock, 6 snowball)
export function starterSlots(): InvSlot[] {
  const slots: InvSlot[] = Array.from({ length: INV_SLOTS }, () => null);
  slots[1] = { item: PICKAXE, count: 1 };
  slots[2] = { item: AXE, count: 1 };
  slots[3] = { item: SHOVEL, count: 1 };
  slots[4] = { item: ROCK, count: 6 };
  slots[5] = { item: SNOWBALL, count: 6 };
  slots[6] = { item: BOW, count: 1 };
  slots[7] = { item: ARROW, count: 16 };
  return slots;
}
