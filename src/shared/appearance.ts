// Character appearance model, shared by client and server. An appearance
// travels on the wire as one small packed integer (see packAppearance), so
// the server can validate and relay it without knowing how it's drawn — the
// client paints the actual 64x32 skin texture from these fields.

export const SKIN_TONES = ["#f6d7bd", "#eab98b", "#c98a54", "#8d5f3b", "#5c3f2a"] as const;
export const HAIR_COLORS = ["#26201b", "#5a3d28", "#c9a04c", "#96422a"] as const;
// outfit palettes deliberately stay far from every skin tone, so clothes
// never read as bare skin at voxel resolution
export const SHIRT_COLORS = [
  "#7d94a5",
  "#5f8f4e",
  "#a43b3b",
  "#7a5da8",
  "#3f8f8a",
  "#c9a83d",
] as const;
export const PANTS_COLORS = ["#46505e", "#3a5578", "#3f5a40", "#2e2f33"] as const;
// hair style indexes, drawn by the client painter
export const HAIR_BALD = 0;
export const HAIR_BUZZ = 1;
export const HAIR_SHORT = 2;
export const HAIR_LONG = 3;
export const HAIR_PONYTAIL = 4;
export const HAIR_STYLES = 5;

export type Appearance = {
  tone: number;
  hair: number;
  hairColor: number;
  shirt: number;
  pants: number;
};

export function packAppearance(a: Appearance): number {
  return (
    (a.tone & 7) |
    ((a.hair & 7) << 3) |
    ((a.hairColor & 3) << 6) |
    ((a.shirt & 7) << 8) |
    ((a.pants & 3) << 11)
  );
}

export function unpackAppearance(packed: number): Appearance {
  return {
    tone: packed & 7,
    hair: (packed >> 3) & 7,
    hairColor: (packed >> 6) & 3,
    shirt: (packed >> 8) & 7,
    pants: (packed >> 11) & 3,
  };
}

export function isValidAppearance(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0x1fff) {
    return false;
  }
  const a = unpackAppearance(value);
  return (
    a.tone < SKIN_TONES.length &&
    a.hair < HAIR_STYLES &&
    a.hairColor < HAIR_COLORS.length &&
    a.shirt < SHIRT_COLORS.length &&
    a.pants < PANTS_COLORS.length
  );
}

// Deterministic fallback for players with no recorded pick (e.g. a client
// that never confirmed the creator screen): everyone hashes the same id to
// the same appearance, so all clients still agree on such a player's look.
export function appearanceForId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return packAppearance({
    tone: hash % SKIN_TONES.length,
    hair: (hash >> 3) % HAIR_STYLES,
    hairColor: (hash >> 6) % HAIR_COLORS.length,
    shirt: (hash >> 8) % SHIRT_COLORS.length,
    pants: (hash >> 11) % PANTS_COLORS.length,
  });
}
