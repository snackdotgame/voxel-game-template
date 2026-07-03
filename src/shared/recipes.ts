// Crafting recipes + the matcher shared by the client (result preview) and
// the server (authoritative craft). Items are placed into a square grid of
// cells (2x2 in the inventory screen, 3x3 at a crafting table); a recipe
// matches when the grid's filled cells form its pattern (shaped) or hold its
// exact ingredient multiset (shapeless).

import {
  ARROW,
  AXE,
  BOOTS,
  BOW,
  blockToItem,
  CHESTPLATE,
  DIAMOND_SWORD,
  FEATHER,
  HELMET,
  LEGGINGS,
  PICKAXE,
  PLANK,
  ROCK,
  SHOVEL,
  SNOWBALL,
  STICK,
  STRING,
  SWORD,
} from "./items.js";
import {
  CRAFTING_TABLE_ID,
  DIAMOND_ORE_ID,
  IRON_ORE_ID,
  LOG_ID,
  SNOW_ID,
  STONE_ID,
} from "./terrain.js";

// invMove slot indices: 0..35 are inventory, CRAFT_GRID_BASE..+8 are the
// (up to) nine crafting-grid cells. Keeps the two address spaces disjoint.
export const CRAFT_GRID_BASE = 100;
export const CRAFT_MAX_CELLS = 9;

export function isCraftSlot(index: number): boolean {
  return index >= CRAFT_GRID_BASE && index < CRAFT_GRID_BASE + CRAFT_MAX_CELLS;
}

export function craftCellOf(index: number): number {
  return index - CRAFT_GRID_BASE;
}

const LOG_ITEM = blockToItem(LOG_ID);
const STONE_ITEM = blockToItem(STONE_ID);
const SNOW_ITEM = blockToItem(SNOW_ID);
const TABLE_ITEM = blockToItem(CRAFTING_TABLE_ID);
const IRON_ITEM = blockToItem(IRON_ORE_ID);
const DIAMOND_ITEM = blockToItem(DIAMOND_ORE_ID);

// Shaped patterns are the recipe's bounding box (no empty border rows/cols);
// 0 marks an interior empty cell. Patterns match anywhere in the grid and are
// also tried horizontally mirrored, like Minecraft.
export type Recipe =
  | { kind: "shaped"; pattern: number[][]; out: number; count: number }
  | { kind: "shapeless"; ingredients: number[]; out: number; count: number };

export const RECIPES: readonly Recipe[] = [
  // Wood line — all fit a 2x2 grid
  { kind: "shapeless", ingredients: [LOG_ITEM], out: PLANK, count: 4 },
  { kind: "shaped", pattern: [[PLANK], [PLANK]], out: STICK, count: 4 },
  {
    kind: "shaped",
    pattern: [
      [PLANK, PLANK],
      [PLANK, PLANK],
    ],
    out: TABLE_ITEM,
    count: 1,
  },
  // Block conversions — 2x2
  {
    kind: "shaped",
    pattern: [
      [ROCK, ROCK],
      [ROCK, ROCK],
    ],
    out: STONE_ITEM,
    count: 1,
  },
  {
    kind: "shaped",
    pattern: [
      [SNOWBALL, SNOWBALL],
      [SNOWBALL, SNOWBALL],
    ],
    out: SNOW_ITEM,
    count: 1,
  },
  // Tools — need the 3x3 crafting table
  {
    kind: "shaped",
    pattern: [
      [PLANK, PLANK, PLANK],
      [0, STICK, 0],
      [0, STICK, 0],
    ],
    out: PICKAXE,
    count: 1,
  },
  {
    kind: "shaped",
    pattern: [
      [PLANK, PLANK],
      [PLANK, STICK],
      [0, STICK],
    ],
    out: AXE,
    count: 1,
  },
  {
    kind: "shaped",
    pattern: [[PLANK], [STICK], [STICK]],
    out: SHOVEL,
    count: 1,
  },
  // Swords — blade over a stick grip, like Minecraft's shape (three tall, so
  // both need the 3x3 table). Stone for the early fight, diamond for endgame.
  {
    kind: "shaped",
    pattern: [[ROCK], [ROCK], [STICK]],
    out: SWORD,
    count: 1,
  },
  {
    kind: "shaped",
    pattern: [[DIAMOND_ITEM], [DIAMOND_ITEM], [STICK]],
    out: DIAMOND_SWORD,
    count: 1,
  },
  // Bow — three sticks bent into the limbs, three string for the bowstring
  // (Minecraft's shape). Needs the 3x3 table.
  {
    kind: "shaped",
    pattern: [
      [0, STICK, STRING],
      [STICK, 0, STRING],
      [0, STICK, STRING],
    ],
    out: BOW,
    count: 1,
  },
  // Arrow — a rock arrowhead (our flint), a stick shaft, a feather fletching;
  // yields four, like Minecraft. Needs the 3x3 table (three tall).
  {
    kind: "shaped",
    pattern: [[ROCK], [STICK], [FEATHER]],
    out: ARROW,
    count: 4,
  },
  // Armor — forged straight from mined iron ore at the 3x3 table, in
  // Minecraft's classic piece shapes.
  {
    kind: "shaped",
    pattern: [
      [IRON_ITEM, IRON_ITEM, IRON_ITEM],
      [IRON_ITEM, 0, IRON_ITEM],
    ],
    out: HELMET,
    count: 1,
  },
  {
    kind: "shaped",
    pattern: [
      [IRON_ITEM, 0, IRON_ITEM],
      [IRON_ITEM, IRON_ITEM, IRON_ITEM],
      [IRON_ITEM, IRON_ITEM, IRON_ITEM],
    ],
    out: CHESTPLATE,
    count: 1,
  },
  {
    kind: "shaped",
    pattern: [
      [IRON_ITEM, IRON_ITEM, IRON_ITEM],
      [IRON_ITEM, 0, IRON_ITEM],
      [IRON_ITEM, 0, IRON_ITEM],
    ],
    out: LEGGINGS,
    count: 1,
  },
  {
    kind: "shaped",
    pattern: [
      [IRON_ITEM, 0, IRON_ITEM],
      [IRON_ITEM, 0, IRON_ITEM],
    ],
    out: BOOTS,
    count: 1,
  },
];

function gridEquals(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) {
      return false;
    }
    for (let j = 0; j < a[i].length; j++) {
      if ((a[i][j] || 0) !== (b[i][j] || 0)) {
        return false;
      }
    }
  }
  return true;
}

function mirrored(pattern: number[][]): number[][] {
  return pattern.map((row) => [...row].reverse());
}

// cells: row-major item ids (0 = empty), length width*width. Returns the
// recipe whose pattern/ingredients the grid forms, or null.
export function matchRecipe(cells: readonly number[], width: number): Recipe | null {
  const present: number[] = [];
  for (const c of cells) {
    if (c) {
      present.push(c);
    }
  }
  if (present.length === 0) {
    return null;
  }

  // shapeless: exact ingredient multiset, position irrelevant
  const sortedPresent = [...present].sort((a, b) => a - b);
  for (const r of RECIPES) {
    if (r.kind !== "shapeless" || r.ingredients.length !== sortedPresent.length) {
      continue;
    }
    const sortedIng = [...r.ingredients].sort((a, b) => a - b);
    if (sortedIng.every((v, i) => v === sortedPresent[i])) {
      return r;
    }
  }

  // shaped: compare the grid's bounding box to each pattern (and its mirror)
  let minR = width;
  let maxR = -1;
  let minC = width;
  let maxC = -1;
  for (let row = 0; row < width; row++) {
    for (let col = 0; col < width; col++) {
      if (cells[row * width + col]) {
        minR = Math.min(minR, row);
        maxR = Math.max(maxR, row);
        minC = Math.min(minC, col);
        maxC = Math.max(maxC, col);
      }
    }
  }
  const sub: number[][] = [];
  for (let row = minR; row <= maxR; row++) {
    const out: number[] = [];
    for (let col = minC; col <= maxC; col++) {
      out.push(cells[row * width + col] || 0);
    }
    sub.push(out);
  }
  for (const r of RECIPES) {
    if (r.kind !== "shaped") {
      continue;
    }
    if (gridEquals(sub, r.pattern) || gridEquals(sub, mirrored(r.pattern))) {
      return r;
    }
  }
  return null;
}
