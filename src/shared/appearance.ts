// Character appearance model, shared by client and server. An appearance
// travels on the wire as one small packed integer (see packAppearance), so
// the server can validate and relay it without knowing how it's drawn — the
// client paints the actual 64x32 skin texture from these fields.

export const SKIN_TONES = ["#f6d7bd", "#eab98b", "#c98a54", "#8d5f3b", "#5c3f2a"] as const;
export const HAIR_COLORS = ["#26201b", "#5a3d28", "#c9a04c", "#96422a"] as const;
// hair style indexes, drawn by the client painter
export const HAIR_BALD = 0;
export const HAIR_BUZZ = 1;
export const HAIR_SHORT = 2;
export const HAIR_LONG = 3;
export const HAIR_PONYTAIL = 4;
export const HAIR_STYLES = 5;
// 0 broad (4px arms), 1 slim (3px arms)
export const BODY_TYPES = 2;

export type Appearance = {
  body: number;
  tone: number;
  hair: number;
  hairColor: number;
};

export function packAppearance(a: Appearance): number {
  return (a.body & 1) | ((a.tone & 7) << 1) | ((a.hair & 7) << 4) | ((a.hairColor & 3) << 7);
}

export function unpackAppearance(packed: number): Appearance {
  return {
    body: packed & 1,
    tone: (packed >> 1) & 7,
    hair: (packed >> 4) & 7,
    hairColor: (packed >> 7) & 3,
  };
}

export function isValidAppearance(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0x1ff) {
    return false;
  }
  const a = unpackAppearance(value);
  return (
    a.body < BODY_TYPES &&
    a.tone < SKIN_TONES.length &&
    a.hair < HAIR_STYLES &&
    a.hairColor < HAIR_COLORS.length
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
    body: hash & 1,
    tone: (hash >> 1) % SKIN_TONES.length,
    hair: (hash >> 4) % HAIR_STYLES,
    hairColor: (hash >> 7) % HAIR_COLORS.length,
  });
}
