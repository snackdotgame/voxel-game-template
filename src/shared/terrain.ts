import type { BlockEdit } from "./messages.js";

// Block ids registered on the client in this order.
export const GRASS_ID = 1;
export const DIRT_ID = 2;
export const STONE_ID = 3;

export function terrainHeight(x: number, z: number): number {
  return Math.floor(2 * Math.sin(x / 10) + 3 * Math.cos(z / 14));
}

export function baseVoxelID(x: number, y: number, z: number): number {
  const height = terrainHeight(x, z);
  if (y < height - 3) {
    return STONE_ID;
  }
  if (y < height) {
    return DIRT_ID;
  }
  if (y === height) {
    return GRASS_ID;
  }
  return 0;
}

export function editKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

// Voxel lookup combining deterministic base terrain with the shared edit log.
// Client and server both build their collision world through this, so the
// prediction sim and the authoritative sim see the same geometry.
export function makeIsSolid(
  edits: Map<string, BlockEdit>,
): (x: number, y: number, z: number) => boolean {
  return (x, y, z) => {
    const edit = edits.get(editKey(x, y, z));
    const block = edit ? edit.block : baseVoxelID(x, y, z);
    return block !== 0;
  };
}
