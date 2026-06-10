// Equippable items. Ids are stable wire values (u8 in snapshots).
export const ITEMS = ["Hand", "Pickaxe", "Axe", "Shovel", "Rock", "Snowball"] as const;

export const HAND = 0;
export const PICKAXE = 1;
export const AXE = 2;
export const SHOVEL = 3;
export const ROCK = 4;
export const SNOWBALL = 5;

export function isValidItem(item: number): boolean {
  return Number.isInteger(item) && item >= 0 && item < ITEMS.length;
}

// Initial projectile speed in blocks/s. Throw distance follows from speed
// (ballistic, gravity 16): a rock flies far, a snowball decently, tools are
// heavy and land short. Hand (0) is not throwable.
export const THROW_SPEED: readonly number[] = [0, 9, 10, 9, 18, 13];

// Knockback impulse applied to a player the projectile hits.
export const KNOCKBACK: readonly number[] = [0, 7, 7, 6, 5, 2.5];

export function isThrowable(item: number): boolean {
  return isValidItem(item) && THROW_SPEED[item] > 0;
}
