// Canonical character-skin list, shared so the server can validate a client's
// pick and every client resolves the same index to the same texture. A skin
// travels on the wire as an index into this list, so entries must never be
// reordered or removed — only appended.
export const SKIN_IDS = [
  "builder",
  "casual-matt",
  "candy-girl",
  "farmer-survivor",
  "winter-girl",
] as const;

export function isValidSkin(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < SKIN_IDS.length;
}

// Deterministic fallback for players with no recorded pick (e.g. a client
// that never confirmed the join screen): everyone hashes the same id to the
// same skin, so all clients still agree on what such a player wears.
export function skinForId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % SKIN_IDS.length;
}
