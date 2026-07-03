// NPC kinds, shared by the server (sim + combat) and the client (meshes,
// kill-feed names). The kind travels on the wire in the entity record's
// `item` byte (see encodeNpcs in netCodec.ts), so kinds must fit a u8 and
// stay stable once shipped.

export const NPC_CHICKEN = 0;
export const NPC_PIG = 1;
export const NPC_COW = 2;
export const NPC_ZOMBIE = 3;
export const NPC_SPIDER = 4;
export const NPC_KIND_COUNT = 5;

// Indexed by kind. Names are lowercase so they read naturally mid-sentence
// ("slain by a zombie").
export const NPC_NAMES: readonly string[] = ["chicken", "pig", "cow", "zombie", "spider"];

export function isValidNpcKind(kind: number): boolean {
  return Number.isInteger(kind) && kind >= 0 && kind < NPC_KIND_COUNT;
}

/*
 *      Attacker tags
 *
 *  hurt/death broadcasts carry attacker ids as strings (player connection
 *  ids). Mob attackers use a reserved "npc:<kind>" tag in the same field;
 *  connection ids never contain ":", so the namespaces can't collide.
 */

export function npcAttackerTag(kind: number): string {
  return `npc:${kind}`;
}

// The kind encoded in an attacker tag, or null if the tag isn't an NPC's.
export function npcKindFromTag(tag: string): number | null {
  if (!tag.startsWith("npc:")) {
    return null;
  }
  const kind = Number(tag.slice(4));
  return isValidNpcKind(kind) ? kind : null;
}
