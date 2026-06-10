// Equippable items. Ids are stable wire values (u8 in snapshots).
export const ITEMS = ["Hand", "Pickaxe", "Axe", "Shovel"] as const;

export const HAND = 0;
export const PICKAXE = 1;
export const AXE = 2;
export const SHOVEL = 3;

export function isValidItem(item: number): boolean {
  return Number.isInteger(item) && item >= 0 && item < ITEMS.length;
}
