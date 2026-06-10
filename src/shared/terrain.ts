import type { BlockEdit } from "./messages.js";

// Block ids registered on the client in this order.
export const GRASS_ID = 1;
export const DIRT_ID = 2;
export const STONE_ID = 3;
export const SAND_ID = 4;
export const SNOW_ID = 5;
export const LOG_ID = 6;
export const LEAVES_ID = 7;
export const COAL_ORE_ID = 8;
export const IRON_ORE_ID = 9;
export const GOLD_ORE_ID = 10;
export const DIAMOND_ORE_ID = 11;
export const WATER_ID = 12;

// Basins below this height fill with water; shores near it turn to sand.
export const SEA_LEVEL = 0;

/*
 *      Deterministic noise
 *
 *  Integer-hash value noise so the client worldgen, client prediction
 *  sim, and server authoritative sim all see the same world. No
 *  Math.random anywhere.
 */

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function hash2(x: number, z: number, seed: number): number {
  return hash3(x, z, seed);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

// value noise sampled at (x/scale, z/scale), output 0..1
function noise2(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = smooth(fx - x0);
  const tz = smooth(fz - z0);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

/*
 *      Columns: height, biome, trees
 */

export type Biome = "plains" | "forest" | "desert" | "mountains";

type NearTree = {
  dx: number;
  dz: number;
  base: number;
  top: number;
};

type Column = {
  height: number;
  biome: Biome;
  snowy: boolean;
  // 0 = no tree here, otherwise trunk height in blocks
  tree: number;
  // trees whose trunk or canopy can reach this column; computed lazily
  // once per column instead of per voxel
  treesNear: NearTree[] | null;
};

const SPAWN_FLAT_RADIUS = 36;
const TREE_FREE_RADIUS = 10;
const TREE_CANOPY_RADIUS = 2;
const SNOW_HEIGHT = 14;
const MOUNTAIN_HEIGHT = 9;

const columnCache = new Map<string, Column>();

function computeColumn(x: number, z: number): Column {
  const continent = noise2(x, z, 130, 1001);
  const rough = noise2(x, z, 47, 1002);
  const detail = noise2(x, z, 14, 1003);
  let height = (continent - 0.42) * 36 + (rough - 0.5) * 12 + (detail - 0.5) * 4;

  const temperature = noise2(x, z, 110, 1004);
  const moisture = noise2(x, z, 90, 1005);

  // keep the spawn area gentle and walkable
  const spawnDist = Math.hypot(x, z);
  const spawnBlend = spawnDist >= SPAWN_FLAT_RADIUS ? 1 : smooth(spawnDist / SPAWN_FLAT_RADIUS);
  height = 2 + (height - 2) * spawnBlend;

  // a small pond in the spawn meadow so water is in sight from the start
  const pondDist = Math.hypot(x - 20, z - 16);
  if (pondDist < 8) {
    const bowl = -3 + 5 * smooth(pondDist / 8);
    height = Math.min(height, bowl);
  }

  const h = Math.round(height);
  let biome: Biome;
  if (h >= MOUNTAIN_HEIGHT) {
    biome = "mountains";
  } else if (temperature > 0.6 && moisture < 0.45 && spawnBlend >= 1) {
    biome = "desert";
  } else if (moisture > 0.52) {
    biome = "forest";
  } else {
    biome = "plains";
  }

  let tree = 0;
  if (
    h > SEA_LEVEL + 1 &&
    spawnDist > TREE_FREE_RADIUS &&
    (biome === "forest" || biome === "plains")
  ) {
    const chance = biome === "forest" ? 0.04 : 0.005;
    const roll = hash2(x, z, 1006);
    if (roll < chance) {
      tree = 4 + Math.floor(hash2(x, z, 1007) * 3);
    }
  }

  return { height: h, biome, snowy: h >= SNOW_HEIGHT, tree, treesNear: null };
}

function column(x: number, z: number): Column {
  const key = `${x},${z}`;
  let col = columnCache.get(key);
  if (!col) {
    if (columnCache.size > 80_000) {
      columnCache.clear();
    }
    col = computeColumn(x, z);
    columnCache.set(key, col);
  }
  return col;
}

export function terrainHeight(x: number, z: number): number {
  return column(x, z).height;
}

/*
 *      Trees (may reach into neighboring columns)
 */

function treesNear(col: Column, x: number, z: number): NearTree[] {
  if (col.treesNear) {
    return col.treesNear;
  }
  const trees: NearTree[] = [];
  for (let dx = -TREE_CANOPY_RADIUS; dx <= TREE_CANOPY_RADIUS; dx++) {
    for (let dz = -TREE_CANOPY_RADIUS; dz <= TREE_CANOPY_RADIUS; dz++) {
      const other = dx === 0 && dz === 0 ? col : column(x + dx, z + dz);
      if (other.tree) {
        trees.push({ dx, dz, base: other.height, top: other.height + other.tree });
      }
    }
  }
  col.treesNear = trees;
  return trees;
}

function treeVoxel(col: Column, x: number, y: number, z: number): number {
  for (const tree of treesNear(col, x, z)) {
    if (tree.dx === 0 && tree.dz === 0 && y > tree.base && y <= tree.top) {
      return LOG_ID;
    }
    const dy = y - tree.top;
    if (dy < -2 || dy > 2) {
      continue;
    }
    const r2 = tree.dx * tree.dx + tree.dz * tree.dz + dy * dy * 1.6;
    if (r2 > 5.4) {
      continue;
    }
    // thin the canopy edges deterministically so trees aren't perfect spheres
    if (r2 > 3.6 && hash3(x + tree.dx * 31, y, z + tree.dz * 57) < 0.35) {
      continue;
    }
    return LEAVES_ID;
  }
  return 0;
}

/*
 *      Ore deposits: pocket clusters in stone, gated by depth
 */

function oreVoxel(x: number, y: number, z: number): number {
  const cx = Math.floor(x / 4);
  const cy = Math.floor(y / 4);
  const cz = Math.floor(z / 4);
  const cluster = hash3(cx, cy, cz);
  if (cluster >= 0.16) {
    return STONE_ID;
  }

  let ore = COAL_ORE_ID;
  if (cluster < 0.02 && y < -14) {
    ore = DIAMOND_ORE_ID;
  } else if (cluster < 0.05 && y < -8) {
    ore = GOLD_ORE_ID;
  } else if (cluster < 0.1 && y < 2) {
    ore = IRON_ORE_ID;
  }
  // sparse voxels within the pocket
  return hash3(x, y, z) < 0.45 ? ore : STONE_ID;
}

/*
 *      Voxel lookup
 */

export function baseVoxelID(x: number, y: number, z: number): number {
  const col = column(x, z);

  if (y > col.height) {
    // canopies top out 8 blocks above the tallest nearby trunk
    if (y <= col.height + 12) {
      const tree = treeVoxel(col, x, y, z);
      if (tree !== 0) {
        return tree;
      }
    }
    return y <= SEA_LEVEL ? WATER_ID : 0;
  }

  if (y === col.height) {
    if (col.snowy) {
      return SNOW_ID;
    }
    if (col.height <= SEA_LEVEL + 1) {
      return SAND_ID; // beaches and sea floor
    }
    switch (col.biome) {
      case "desert":
        return SAND_ID;
      case "mountains":
        return STONE_ID;
      default:
        return GRASS_ID;
    }
  }

  if (y > col.height - 4) {
    switch (col.biome) {
      case "desert":
        return SAND_ID;
      case "mountains":
        return STONE_ID;
      default:
        return DIRT_ID;
    }
  }

  return oreVoxel(x, y, z);
}

export function editKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

// Chunk columns used for edit-log sync; matches the client chunk size.
export const CHUNK_SIZE = 32;

export function chunkCoord(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export type EditLookup = (x: number, y: number, z: number) => BlockEdit | undefined;

// Voxel lookup combining deterministic base terrain with the shared edit log.
// Client and server both build their collision world through this, so the
// prediction sim and the authoritative sim see the same geometry.
export function makeIsSolid(lookup: EditLookup): (x: number, y: number, z: number) => boolean {
  return (x, y, z) => {
    const edit = lookup(x, y, z);
    const block = edit ? edit.block : baseVoxelID(x, y, z);
    return block !== 0 && block !== WATER_ID;
  };
}

export function makeIsFluid(lookup: EditLookup): (x: number, y: number, z: number) => boolean {
  return (x, y, z) => {
    const edit = lookup(x, y, z);
    const block = edit ? edit.block : baseVoxelID(x, y, z);
    return block === WATER_ID;
  };
}
