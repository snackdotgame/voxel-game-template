import { server, type Connection, type DatagramEvent, type StreamEvent } from "snack:server";
import {
  type ProjectileSnapshot,
  decodeInputs,
  encodeDrops,
  encodeNpcs,
  encodeProjectiles,
  encodeSnapshots,
} from "./shared/netCodec.js";
import {
  ARMOR_BASE,
  ARMOR_SLOTS,
  ARROW,
  BEEF,
  BLOCK_REACH,
  BOW,
  FEATHER,
  INV_SLOTS,
  MAX_HP,
  MELEE_RANGE,
  PORKCHOP,
  ROTTEN_FLESH,
  STRING,
  armorPiece,
  armorReduction,
  arrowLaunch,
  blockHP,
  blockToItem,
  bonusDrop,
  dropsOnImpact,
  foodHeal,
  hitDamage,
  isArmorIndex,
  isBlockItem,
  isThrowable,
  isValidItem,
  itemToBlock,
  knockback,
  meleeDamage,
  packArmor,
  projectileDamage,
  starterSlots,
  stackLimit,
  throwSpeed,
  type InvSlot,
} from "./shared/items.js";
import { NPC_KIND_COUNT, npcAttackerTag } from "./shared/npcs.js";
import {
  type BlockEdit,
  type CraftOpenMessage,
  type InvWireSlot,
  type FireArrowMessage,
  type PlaceMessage,
  type PlayerSnapshot,
  type ThrowMessage,
  type RosterEntry,
  parseAttackMessage,
  parseAttackNpcMessage,
  parseCraftCloseMessage,
  parseCraftOpenMessage,
  parseCraftTakeMessage,
  parseEatMessage,
  parseEditMessage,
  parseEquipMessage,
  parseFireArrowMessage,
  parseHitMessage,
  parseInvDropMessage,
  parseInvMoveMessage,
  parsePlaceMessage,
  parseSkinMessage,
  parseThrowMessage,
} from "./shared/messages.js";
import { appearanceForId } from "./shared/appearance.js";
import { craftCellOf, isCraftSlot, matchRecipe } from "./shared/recipes.js";
import {
  BREATH_MAX_MS,
  BREATH_REFILL_RATE,
  EYE_HEIGHT,
  SIM_TICK_MS,
  type CharInput,
  type CharState,
  type Stepper,
  makeStepper,
  onGround,
  spawnState,
} from "./shared/sim.js";
import { encodeChunkState, maxRecordsForPayload } from "./shared/chunkCodec.js";
import {
  type Biome,
  CRAFTING_TABLE_ID,
  LEAVES_ID,
  LOG_ID,
  WATER_ID,
  baseVoxelID,
  biomeAt,
  chunkCoord,
  chunkKey,
  editKey,
  getWorldSeed,
  makeIsFluid,
  makeIsSolid,
  noise2,
  setWorldSeed,
} from "./shared/terrain.js";

const MAX_EDITS = 200_000;
// Allow short input bursts (catch-up after client jank) but bound per-player CPU.
const MAX_STEPS_PER_TICK = 8;
const MAX_QUEUED_INPUTS = 32;
// Connection liveness is runtime-owned: the Snack runtime's QUIC
// keep-alives and app-level ping/pong force-disconnect a dead client
// within ~20s, and that flows through the normal disconnect path below
// (a vanished connection in syncConnections). The game only keeps
// parking: removed players' characters are stored by userId for this
// long, so reconnects and tab reloads resume where they left off.
const PARK_TTL_MS = 300_000;

// Edit-log sync windows, in chunk-column units (32 blocks). SYNC_RADIUS must
// cover the client's chunk load distance (2.5 chunks) with margin; the gap
// up to UNSYNC_RADIUS is hysteresis so walking along a border doesn't
// resubscribe every step.
const SYNC_RADIUS = 4;
const UNSYNC_RADIUS = 6;

const PROJECTILE_GRAVITY = -16;
const PROJECTILE_TTL_MS = 5_000;
const MAX_PROJECTILES = 256;

const ATTACK_COOLDOWN_MS = 400;
// validation ranges allow a block of slack over the client-side limits:
// the server's view of the attacker lags their client by a round trip
const ATTACK_RANGE = MELEE_RANGE + 1;
const BLOCK_RANGE = BLOCK_REACH + 1.5;
const MELEE_KNOCKBACK = 5;
const RESPAWN_PROTECTION_MS = 2_000;
// regen 1 hp/s once this long has passed without taking damage
const REGEN_AFTER_MS = 8_000;
// Per-session "no hostiles" switch from snack.json's serverConfigSchema.
const CREATOR_MODE = server.config.creatorMode === true;

const MAX_DROPS = 512;
const DROP_TTL_MS = 120_000;
const DROP_PICKUP_DELAY_MS = 700;
const DROP_PICKUP_RADIUS = 1.6;
// partial dig damage heals back if the block is left alone this long
const BLOCK_DAMAGE_RESET_MS = 10_000;

type Player = {
  name: string;
  userId: string;
  // packed appearance (see shared/appearance.ts), built in the creator screen
  skin: number;
  // packed wear slots (see packArmor), mirroring the inventory's armor slots;
  // kept on the player so join/roster/armor broadcasts don't rescan slots
  armor: number;
  char: CharState;
  heading: number;
  lastSeq: number;
  item: number;
  hp: number;
  // remaining breath in sim-time ms; drains underwater and goes negative
  // while drowning (each -DROWN_INTERVAL_MS costs a tick of damage)
  breathMs: number;
  lastDamageAt: number;
  lastAttackAt: number;
  protectedUntil: number;
  stepsThisTick: number;
  // whether the last NPC view packet this client got was non-empty, so an
  // emptied view window still gets one trailing clear packet
  sawNpcs: boolean;
  // inputs beyond the per-tick step budget wait here instead of dropping,
  // so client catch-up bursts don't force prediction rollbacks
  inputQueue: CharInput[];
  syncedChunks: Set<string>;
  lastChunk: string;
  // transient crafting grid while a crafting screen is open. craftSize is 0
  // (closed), 2 (inventory grid), or 3 (crafting table); craftGrid holds
  // craftSize*craftSize cells. Contents return to the inventory on close or
  // disconnect, so they are never parked across reconnects.
  craftSize: number;
  craftGrid: InvSlot[];
  // the crafting-table block this 3x3 session opened against (null for the
  // 2x2 inventory grid); re-checked on each craft so you can't keep using a
  // table after walking away or after it's destroyed
  craftTable: { x: number; y: number; z: number } | null;
};

type Projectile = {
  id: number;
  item: number;
  owner: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ttlMs: number;
  // arrows carry charge-scaled damage/knockback; thrown items fall back to the
  // per-item tables when these are undefined
  damage?: number;
  knock?: number;
};

type Drop = {
  id: number;
  item: number;
  x: number;
  y: number;
  z: number;
  ttlMs: number;
  noPickupMs: number;
};

// An NPC. Every kind reuses the shared character stepper (so it gets terrain
// collision, gravity, water buoyancy and auto-step for free) driven by
// AI-chosen inputs. `rng` is a per-NPC xorshift state so AI decisions need no
// ambient Math.random.
type Npc = {
  id: number;
  kind: number;
  char: CharState;
  // the body's current facing; movement follows it, and it goes on the wire
  heading: number;
  // where the AI wants to face — heading turns toward it at NPC_TURN_RATE
  wantHeading: number;
  hp: number;
  // idle/walk alternate on a timer (the wander); flee runs from a recent hit
  // until its timer expires; chase hunts targetId until it dies out of range
  mode: "idle" | "walk" | "flee" | "chase";
  modeMsLeft: number;
  targetId: string | null;
  lastAttackAt: number;
  rng: number;
};

// Per-kind stats. `count` is the deliberately thinned population cap the slow
// respawn tick refills to. `biomes`, `territory`, and `group` make the lower
// population appear as habitat patches and small herds/nests instead of a
// uniform sprinkle around players. Hostiles chase players inside aggroRange
// and melee inside attackReach; sprinters chase at sprint speed (5.6 — a
// sprinting player can't shake them), walkers at walk speed (4.3 — sprinting
// outruns them).
type NpcKindConfig = {
  hp: number;
  count: number;
  hostile: boolean;
  biomes: readonly Biome[];
  territory: number;
  group: number;
  damage: number;
  aggroRange: number;
  attackReach: number;
  // ground speed in blocks/s (players walk 4.3, sprint 5.6). Passives run at
  // NPC_FLEE_SPEED_MULT times this when fleeing; hostiles chase at it flat,
  // so every mob is outrunnable.
  speed: number;
  drops: readonly { item: number; min: number; max: number }[];
};

// Caps are intentionally low; habitat, territory, and group settings make
// those fewer NPCs read as regional herds/nests instead of evenly spread mobs.
const NPC_CONFIG: readonly NpcKindConfig[] = [
  // chicken — the classic feather source, one arrow volley fells it
  {
    hp: 4,
    count: 4,
    hostile: false,
    biomes: ["plains", "forest"],
    territory: 0.55,
    group: 3,
    damage: 0,
    aggroRange: 0,
    attackReach: 0,
    speed: 2.5,
    drops: [{ item: FEATHER, min: 1, max: 2 }],
  },
  // pig
  {
    hp: 10,
    count: 3,
    hostile: false,
    biomes: ["plains", "forest"],
    territory: 0.55,
    group: 2,
    damage: 0,
    aggroRange: 0,
    attackReach: 0,
    speed: 3.0,
    drops: [{ item: PORKCHOP, min: 1, max: 2 }],
  },
  // cow
  {
    hp: 12,
    count: 3,
    hostile: false,
    biomes: ["plains"],
    territory: 0.55,
    group: 2,
    damage: 0,
    aggroRange: 0,
    attackReach: 0,
    speed: 2.8,
    drops: [{ item: BEEF, min: 1, max: 2 }],
  },
  // zombie — tanky but shambles: even walking away works
  {
    hp: 20,
    count: 3,
    hostile: true,
    biomes: ["forest", "mountains"],
    territory: 0.6,
    group: 1,
    damage: 2,
    aggroRange: 14,
    attackReach: 1.8,
    speed: 2.2,
    drops: [{ item: ROTTEN_FLESH, min: 1, max: 2 }],
  },
  // spider — quicker than a zombie but fragile; its string feeds the bow/arrow economy
  {
    hp: 12,
    count: 2,
    hostile: true,
    biomes: ["forest", "mountains", "desert"],
    territory: 0.6,
    group: 1,
    damage: 2,
    aggroRange: 12,
    attackReach: 1.7,
    speed: 3.2,
    drops: [{ item: STRING, min: 1, max: 2 }],
  },
];

function kindCap(kind: number): number {
  const cfg = NPC_CONFIG[kind];
  return CREATOR_MODE && cfg.hostile ? 0 : cfg.count;
}

type Parked = {
  char: CharState;
  heading: number;
  item: number;
  hp: number;
  skin: number;
  at: number;
};

type World = {
  players: Map<string, Player>;
  // connections that have been sent their welcome/roster
  greeted: Set<string>;
  // skin picks that arrived before the player's body materialized (the join
  // screen confirms before the first input), consumed by addPlayer
  pendingSkins: Map<string, number>;
  // inventories are keyed by userId so they survive reconnects
  inventories: Map<string, InvSlot[]>;
  // characters of removed players, keyed by userId, for seamless resume
  parked: Map<string, Parked>;
  drops: Map<number, Drop>;
  nextDropId: number;
  dropsDirty: boolean;
  hadDrops: boolean;
  dropTick: number;
  blockDamage: Map<string, { block: number; hp: number; at: number }>;
  lookupEdit: (x: number, y: number, z: number) => BlockEdit | undefined;
  // edit log bucketed by chunk column, each bucket keyed by block coordinate
  edits: Map<string, Map<string, BlockEdit>>;
  editCount: number;
  step: Stepper;
  isSolid: (x: number, y: number, z: number) => boolean;
  isFluid: (x: number, y: number, z: number) => boolean;
  projectiles: Map<number, Projectile>;
  nextProjectileId: number;
  hadProjectiles: boolean;
  npcs: Map<number, Npc>;
  nextNpcId: number;
  // world-level xorshift for spawn placement (per-NPC decisions use npc.rng)
  spawnRng: number;
};

// NPCs only simulate/broadcast when within the "loaded chunk" window (chunks
// within SYNC_RADIUS of a player) — matching the edit-sync radius, so an NPC
// is live exactly when the terrain it stands on is streamed to someone.
const NPC_IDLE_CHANCE = 0.35;
const NPC_WANDER_MIN_MS = 900;
const NPC_WANDER_MAX_MS = 3200;
const NPC_FLEE_MIN_MS = 2400;
const NPC_FLEE_MAX_MS = 3600;
// passives spawn around the map origin; hostiles keep their distance from
// players both at initial placement and on respawn
const PASSIVE_SPAWN_RADIUS = 28;
const HOSTILE_SPAWN_MIN = 26;
const HOSTILE_SPAWN_MAX = 48;
const HOSTILE_MIN_PLAYER_GAP = 16;
// Per-client NPC view window, in chunk columns (Chebyshev). Slightly past the
// client's ~2.5-chunk terrain render distance so mobs appear a touch before
// the terrain edge, but well inside the SYNC_RADIUS sim window — an NPC that
// is only "loaded" by some faraway player stays out of your packets instead
// of rendering on terrain your client hasn't generated.
const NPC_VIEW_RADIUS = 3;
// refill each kind toward its population cap this often
const NPC_RESPAWN_INTERVAL_MS = 10_000;
const NPC_ATTACK_COOLDOWN_MS = 1_000;
const NPC_MELEE_KNOCKBACK = 4;
// give up a chase beyond aggroRange times this (hysteresis so a target on the
// edge doesn't flicker aggro on and off)
const DEAGGRO_FACTOR = 1.6;
// How fast a mob can rotate its body (radians/second), and the remaining-turn
// angle beyond which it pivots in place instead of walking. Bounding the turn
// makes direction changes read as "turn, then walk" — an instant heading snap
// under a slowly-turning mesh reads as strafing sideways.
const NPC_TURN_RATE = 7;
const NPC_PIVOT_RAD = 1.1;
// fleeing passives bolt at this multiple of their kind's base speed
const NPC_FLEE_SPEED_MULT = 1.5;

export async function main() {
  // every session generates a fresh world: one random seed, picked before
  // anything touches the terrain, drives all noise on both sides (clients
  // receive it in their welcome message and hold worldgen until then)
  setWorldSeed((Math.random() * 0x100000000) >>> 0);
  console.log(`world seed: ${getWorldSeed()}`);

  const edits = new Map<string, Map<string, BlockEdit>>();
  const lookupEdit = (x: number, y: number, z: number) =>
    edits.get(chunkKey(chunkCoord(x), chunkCoord(z)))?.get(editKey(x, y, z));
  const isSolid = makeIsSolid(lookupEdit);
  const isFluid = makeIsFluid(lookupEdit);
  const world: World = {
    players: new Map(),
    greeted: new Set(),
    pendingSkins: new Map(),
    inventories: new Map(),
    parked: new Map(),
    drops: new Map(),
    nextDropId: 1,
    dropsDirty: false,
    hadDrops: false,
    dropTick: 0,
    blockDamage: new Map(),
    lookupEdit,
    edits,
    editCount: 0,
    step: makeStepper(isSolid, isFluid),
    isSolid,
    isFluid,
    projectiles: new Map(),
    nextProjectileId: 1,
    hadProjectiles: false,
    npcs: new Map(),
    nextNpcId: 1,
    spawnRng: (getWorldSeed() ^ 0x5eed) >>> 0 || 1,
  };
  spawnInitialNpcs(world);

  // recv() rejects when the runtime is shutting down; the pumps ending is
  // the signal to unwind the tick loop and return from main().
  let stopped = false;
  const pumps = Promise.all([pumpInputs(world), pumpStreams(world)]).then(() => {
    stopped = true;
  });

  while (server.running && !stopped) {
    syncConnections(world);
    pruneParked(world);
    stepProjectiles(world);
    tickDrops(world);
    tickRegen(world);

    if (world.players.size > 0) {
      const players: PlayerSnapshot[] = [];
      for (const [id, player] of world.players) {
        player.stepsThisTick = 0;
        drainInputQueue(world, id, player);
        syncChunkWindow(world, id, player);
        players.push({
          id,
          lastSeq: player.lastSeq,
          heading: player.heading,
          item: player.item,
          hp: player.hp,
          breath: Math.round((Math.max(0, player.breathMs) / BREATH_MAX_MS) * 255),
          state: player.char,
        });
      }
      for (const packet of encodeSnapshots(players, server.datagrams.maxSize)) {
        server.datagrams.broadcast(packet);
      }
    }

    // broadcast projectile positions; one trailing empty packet clears
    // them client-side after the last projectile despawns
    if (world.projectiles.size > 0 || world.hadProjectiles) {
      const snapshots: ProjectileSnapshot[] = [];
      for (const proj of world.projectiles.values()) {
        snapshots.push({ id: proj.id, item: proj.item, x: proj.x, y: proj.y, z: proj.z });
      }
      for (const packet of encodeProjectiles(snapshots, server.datagrams.maxSize)) {
        server.datagrams.broadcast(packet);
      }
      world.hadProjectiles = world.projectiles.size > 0;
    }

    // drops change rarely: broadcast on change, on a slow heartbeat, and
    // one trailing empty packet after the last drop disappears
    world.dropTick += 1;
    if (
      world.dropsDirty ||
      (world.drops.size > 0 && world.dropTick % 10 === 0) ||
      (world.hadDrops && world.drops.size === 0)
    ) {
      const snapshots: ProjectileSnapshot[] = [];
      for (const drop of world.drops.values()) {
        snapshots.push({ id: drop.id, item: drop.item, x: drop.x, y: drop.y, z: drop.z });
      }
      for (const packet of encodeDrops(snapshots, server.datagrams.maxSize)) {
        server.datagrams.broadcast(packet);
      }
      world.dropsDirty = false;
      world.hadDrops = world.drops.size > 0;
    }

    // NPCs: only simulate the ones whose chunk is "loaded" (within
    // SYNC_RADIUS of a player); NPCs elsewhere stay frozen. Each client
    // then gets only the NPCs inside its own view window, so mobs kept
    // alive by a distant player never render on unloaded terrain. The view
    // layer drops anything not in the latest packet, and a trailing empty
    // packet clears the last ones for clients whose window just emptied.
    tickNpcRespawns(world);
    const loadedChunks = computeLoadedChunks(world);
    const activeNpcs = stepNpcs(world, loadedChunks);
    for (const [id, player] of world.players) {
      const pcx = chunkCoord(player.char.x);
      const pcz = chunkCoord(player.char.z);
      const visible: ProjectileSnapshot[] = [];
      for (const npc of activeNpcs) {
        const dist = Math.max(
          Math.abs(chunkCoord(npc.char.x) - pcx),
          Math.abs(chunkCoord(npc.char.z) - pcz),
        );
        if (dist <= NPC_VIEW_RADIUS) {
          visible.push({
            id: npc.id,
            item: npc.kind,
            x: npc.char.x,
            y: npc.char.y,
            z: npc.char.z,
            heading: npc.heading,
          });
        }
      }
      if (visible.length === 0 && !player.sawNpcs) {
        continue;
      }
      for (const packet of encodeNpcs(visible, server.datagrams.maxSize)) {
        server.datagrams.send(id, packet);
      }
      player.sawNpcs = visible.length > 0;
    }

    await Promise.race([server.sleep(SIM_TICK_MS), pumps]);
  }
}

/*
 *      Chunk-scoped edit sync
 */

function syncChunkWindow(world: World, id: string, player: Player) {
  const cx = chunkCoord(player.char.x);
  const cz = chunkCoord(player.char.z);
  const current = chunkKey(cx, cz);
  if (current === player.lastChunk) {
    return;
  }
  player.lastChunk = current;

  for (let dx = -SYNC_RADIUS; dx <= SYNC_RADIUS; dx++) {
    for (let dz = -SYNC_RADIUS; dz <= SYNC_RADIUS; dz++) {
      const key = chunkKey(cx + dx, cz + dz);
      if (player.syncedChunks.has(key)) {
        continue;
      }
      player.syncedChunks.add(key);
      const bucket = world.edits.get(key);
      if (bucket && bucket.size > 0) {
        sendChunkState(id, cx + dx, cz + dz, [...bucket.values()]);
      }
    }
  }

  for (const key of player.syncedChunks) {
    const [scx, scz] = key.split(",").map(Number);
    if (Math.max(Math.abs(scx - cx), Math.abs(scz - cz)) > UNSYNC_RADIUS) {
      player.syncedChunks.delete(key);
    }
  }
}

// Send a chunk's current edited-voxel values as binary packets, split so
// each packet stays under the stream message size limit. The first packet
// replaces the client's state for the chunk; continuations append.
function sendChunkState(id: string, cx: number, cz: number, edits: BlockEdit[]) {
  const perPacket = maxRecordsForPayload(server.streams.maxSize);
  for (let start = 0; start < edits.length; start += perPacket) {
    const slice = edits.slice(start, start + perPacket);
    server.streams.send(id, encodeChunkState(cx, cz, slice, start > 0));
  }
}

// dev/test backdoor: raw edits, applied verbatim. Echoed to the sender too,
// so every client applies conflicting writes in the same server order.
function handleEdit(world: World, event: StreamEvent, value: unknown) {
  const message = parseEditMessage(value);
  if (!message) {
    return;
  }
  emitEdit(world, { block: message.block, x: message.x, y: message.y, z: message.z }, null);
}

function emitEdit(world: World, edit: BlockEdit, exceptId: string | null) {
  if (world.editCount >= MAX_EDITS) {
    return;
  }
  const cKey = chunkKey(chunkCoord(edit.x), chunkCoord(edit.z));
  let bucket = world.edits.get(cKey);
  if (!bucket) {
    bucket = new Map();
    world.edits.set(cKey, bucket);
  }
  const bKey = editKey(edit.x, edit.y, edit.z);
  if (!bucket.has(bKey)) {
    world.editCount += 1;
  }
  bucket.set(bKey, edit);

  // live edits go only to players who currently have this chunk synced
  const recipients: string[] = [];
  for (const [id, player] of world.players) {
    if (id !== exceptId && player.syncedChunks.has(cKey)) {
      recipients.push(id);
    }
  }
  if (recipients.length > 0) {
    server.streams.broadcast({ type: "edit", ...edit }, { only: recipients });
  }
}

/*
 *      Input handling and player lifecycle
 */

async function pumpInputs(world: World) {
  try {
    while (true) {
      handleInput(world, await server.datagrams.recv());
    }
  } catch {
    // runtime is shutting down
  }
}

async function pumpStreams(world: World) {
  try {
    while (true) {
      handleStream(world, await server.streams.recv());
    }
  } catch {
    // runtime is shutting down
  }
}

function broadcastSwing(world: World, actorId: string) {
  if (world.players.has(actorId)) {
    server.streams.broadcast({ type: "swing", id: actorId }, { except: [actorId] });
  }
}

function handleStream(world: World, event: StreamEvent) {
  const value = safeJson(event);
  const equip = parseEquipMessage(value);
  if (equip) {
    const player = world.players.get(event.connection.id);
    if (
      player &&
      isValidItem(equip.item) &&
      (equip.item === 0 || holdsItem(world, event.connection.id, equip.item))
    ) {
      player.item = equip.item;
    }
    return;
  }
  const skinMsg = parseSkinMessage(value);
  if (skinMsg) {
    const player = world.players.get(event.connection.id);
    if (!player) {
      // normal case: the join screen confirms before the first input, so
      // the body doesn't exist yet; addPlayer consumes the pending pick
      world.pendingSkins.set(event.connection.id, skinMsg.skin);
    } else if (player.skin !== skinMsg.skin) {
      player.skin = skinMsg.skin;
      server.streams.broadcast(
        { type: "skin", id: event.connection.id, skin: skinMsg.skin },
        { except: [event.connection.id] },
      );
    }
    return;
  }
  const throwMsg = parseThrowMessage(value);
  if (throwMsg) {
    broadcastSwing(world, event.connection.id);
    handleThrow(world, event.connection.id, throwMsg);
    return;
  }
  const fireArrow = parseFireArrowMessage(value);
  if (fireArrow) {
    broadcastSwing(world, event.connection.id);
    handleFireArrow(world, event.connection.id, fireArrow);
    return;
  }
  const hit = parseHitMessage(value);
  if (hit) {
    broadcastSwing(world, event.connection.id);
    handleHit(world, event.connection.id, hit.x, hit.y, hit.z);
    return;
  }
  const attack = parseAttackMessage(value);
  if (attack) {
    broadcastSwing(world, event.connection.id);
    handleAttack(world, event.connection.id, attack.target);
    return;
  }
  const attackNpc = parseAttackNpcMessage(value);
  if (attackNpc) {
    broadcastSwing(world, event.connection.id);
    handleAttackNpc(world, event.connection.id, attackNpc.id);
    return;
  }
  const eat = parseEatMessage(value);
  if (eat) {
    handleEat(world, event.connection.id, eat.slot, eat.item);
    return;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "debug"
  ) {
    const players = [];
    for (const [id, player] of world.players) {
      players.push({
        id,
        userId: player.userId,
        name: player.name,
        x: Math.round(player.char.x * 10) / 10,
        y: Math.round(player.char.y * 10) / 10,
        z: Math.round(player.char.z * 10) / 10,
      });
    }
    const counts = npcKindCounts(world);
    server.streams.send(event.connection.id, {
      type: "debugState",
      creatorMode: CREATOR_MODE,
      players,
      connections: server.connections.length,
      drops: world.drops.size,
      npcs: counts,
      projectiles: world.projectiles.size,
    });
    return;
  }
  const place = parsePlaceMessage(value);
  if (place) {
    broadcastSwing(world, event.connection.id);
    handlePlace(world, event.connection.id, place);
    return;
  }
  const move = parseInvMoveMessage(value);
  if (move) {
    // require a materialized player: resolving the inventory through a
    // playerless connection would mint an orphan keyed by connection id
    if (world.players.has(event.connection.id)) {
      handleInvMove(world, event.connection.id, move.from, move.to, move.one);
    }
    return;
  }
  const invDrop = parseInvDropMessage(value);
  if (invDrop) {
    handleInvDrop(world, event.connection.id, invDrop.from, invDrop.one);
    return;
  }
  const craftOpen = parseCraftOpenMessage(value);
  if (craftOpen) {
    handleCraftOpen(world, event.connection.id, craftOpen);
    return;
  }
  const craftClose = parseCraftCloseMessage(value);
  if (craftClose) {
    handleCraftClose(world, event.connection.id);
    return;
  }
  const craftTake = parseCraftTakeMessage(value);
  if (craftTake) {
    handleCraftTake(world, event.connection.id, craftTake.all);
    return;
  }
  handleEdit(world, event, value);
}

/*
 *      Combat
 */

let regenCounter = 0;

function tickRegen(world: World) {
  regenCounter += 1;
  if (regenCounter % 20 !== 0) {
    return;
  }
  const now = server.elapsedMs();
  for (const player of world.players.values()) {
    if (player.hp > 0 && player.hp < MAX_HP && now - player.lastDamageAt > REGEN_AFTER_MS) {
      player.hp += 1;
    }
  }
}

function handleAttack(world: World, attackerId: string, targetId: string) {
  const attacker = world.players.get(attackerId);
  const victim = world.players.get(targetId);
  if (!attacker || !victim || attackerId === targetId) {
    return;
  }
  const now = server.elapsedMs();
  if (now - attacker.lastAttackAt < ATTACK_COOLDOWN_MS) {
    return;
  }
  const dx = victim.char.x - attacker.char.x;
  const dy = victim.char.y - attacker.char.y;
  const dz = victim.char.z - attacker.char.z;
  if (Math.hypot(dx, dy, dz) > ATTACK_RANGE) {
    return;
  }
  attacker.lastAttackAt = now;
  damagePlayer(world, targetId, attackerId, meleeDamage(attacker.item), dx, dz, MELEE_KNOCKBACK);
}

// Melee swing landing on an NPC: same cooldown and (slack-padded) reach as
// player-vs-player melee, then the shared NPC damage path.
function handleAttackNpc(world: World, attackerId: string, npcId: number) {
  const attacker = world.players.get(attackerId);
  const npc = world.npcs.get(npcId);
  if (!attacker || !npc) {
    return;
  }
  const now = server.elapsedMs();
  if (now - attacker.lastAttackAt < ATTACK_COOLDOWN_MS) {
    return;
  }
  const dx = npc.char.x - attacker.char.x;
  const dy = npc.char.y - attacker.char.y;
  const dz = npc.char.z - attacker.char.z;
  if (Math.hypot(dx, dy, dz) > ATTACK_RANGE) {
    return;
  }
  attacker.lastAttackAt = now;
  damageNpc(world, npc, meleeDamage(attacker.item), dx, dz, MELEE_KNOCKBACK, attackerId);
}

// Eat the food in a slot: heals immediately, no hunger system. Ignored at
// full health so a click can't waste a porkchop.
function handleEat(world: World, id: string, slot: number, item: number) {
  const player = world.players.get(id);
  const heal = foodHeal(item);
  if (!player || heal <= 0 || player.hp >= MAX_HP || player.hp <= 0) {
    return;
  }
  if (!tryConsume(world, id, slot, item)) {
    return;
  }
  player.hp = Math.min(MAX_HP, player.hp + heal);
}

// Damage + knockback land in the victim's authoritative state, so their own
// client receives them as a prediction rollback — same as any correction.
function damagePlayer(
  world: World,
  victimId: string,
  attackerId: string,
  amount: number,
  kbx: number,
  kbz: number,
  kbScale: number,
) {
  const victim = world.players.get(victimId);
  if (!victim) {
    return;
  }
  const now = server.elapsedMs();
  if (now < victim.protectedUntil) {
    return;
  }
  // equipped armor absorbs a fraction of the hit; a landed hit always
  // costs at least 1 hp so a full set doesn't make a player invulnerable
  const inv = world.inventories.get(victim.userId);
  amount = Math.max(1, Math.round(amount * (1 - (inv ? armorReduction(inv) : 0))));
  victim.hp -= amount;
  victim.lastDamageAt = now;
  const h = Math.hypot(kbx, kbz) || 1;
  victim.char.vx += (kbx / h) * kbScale;
  victim.char.vz += (kbz / h) * kbScale;
  victim.char.vy += kbScale * 0.5;
  victim.char.ry = 0;
  victim.char.sleep = 10;
  server.streams.broadcast({ type: "hurt", id: victimId, by: attackerId, amount });
  if (victim.hp <= 0) {
    victim.char = spawnFor(world, victimId);
    victim.hp = MAX_HP;
    victim.breathMs = BREATH_MAX_MS;
    victim.protectedUntil = now + RESPAWN_PROTECTION_MS;
    server.streams.broadcast({ type: "death", victim: victimId, attacker: attackerId });
  }
}

// gravity (10 blocks/s^2) times the character body's gravityMultiplier (2)
const FALL_GRAVITY = 20;
// falls up to ~3 real blocks land safely; beyond that it costs ~1 hp per
// block, like Minecraft. The margin is 2 rather than 3 because air drag makes
// the v^2/2g estimate read about a block under the true drop height.
const FALL_SAFE_BLOCKS = 2;

// Landing hard hurts, like Minecraft: ~1 hp per block fallen beyond a safe
// three, with water (feet in a fluid cell) breaking the fall entirely. Armor
// doesn't help — the hurt/death messages carry the victim as their own
// attacker, which clients render as a fall death.
function applyFallDamage(world: World, victimId: string, impactVy: number) {
  const victim = world.players.get(victimId);
  if (!victim) {
    return;
  }
  const blocks = (impactVy * impactVy) / (2 * FALL_GRAVITY);
  const amount = Math.floor(blocks - FALL_SAFE_BLOCKS);
  if (amount < 1) {
    return;
  }
  const feet = blockAt(
    world,
    Math.floor(victim.char.x),
    Math.floor(victim.char.y),
    Math.floor(victim.char.z),
  );
  if (feet === WATER_ID) {
    return;
  }
  const now = server.elapsedMs();
  if (now < victim.protectedUntil) {
    return;
  }
  victim.hp -= amount;
  victim.lastDamageAt = now;
  server.streams.broadcast({ type: "hurt", id: victimId, by: victimId, amount });
  if (victim.hp <= 0) {
    victim.char = spawnFor(world, victimId);
    victim.hp = MAX_HP;
    victim.breathMs = BREATH_MAX_MS;
    victim.protectedUntil = now + RESPAWN_PROTECTION_MS;
    server.streams.broadcast({ type: "death", victim: victimId, attacker: victimId });
  }
}

// Drowning: once breath runs out, staying under costs a heart each second
// until the player surfaces or dies. Armor doesn't absorb it, and like fall
// damage the victim is their own attacker — the death message carries
// cause: "drown" so clients word it right.
const DROWN_DAMAGE = 2;
const DROWN_INTERVAL_MS = 1_000;

function applyDrownDamage(world: World, victimId: string) {
  const victim = world.players.get(victimId);
  if (!victim) {
    return;
  }
  const now = server.elapsedMs();
  if (now < victim.protectedUntil) {
    return;
  }
  victim.hp -= DROWN_DAMAGE;
  victim.lastDamageAt = now;
  server.streams.broadcast({ type: "hurt", id: victimId, by: victimId, amount: DROWN_DAMAGE });
  if (victim.hp <= 0) {
    victim.char = spawnFor(world, victimId);
    victim.hp = MAX_HP;
    victim.breathMs = BREATH_MAX_MS;
    victim.protectedUntil = now + RESPAWN_PROTECTION_MS;
    server.streams.broadcast({
      type: "death",
      victim: victimId,
      attacker: victimId,
      cause: "drown",
    });
  }
}

/*
 *      Inventory
 */

// inventories are keyed by userId (stable across reconnects); helpers take
// the connection id and resolve through the player entry
function userIdOf(world: World, connectionId: string): string {
  return world.players.get(connectionId)?.userId ?? connectionId;
}

function inventoryOf(world: World, connectionId: string): InvSlot[] {
  const key = userIdOf(world, connectionId);
  let inv = world.inventories.get(key);
  if (!inv) {
    inv = starterSlots();
    world.inventories.set(key, inv);
  }
  // pad arrays saved before the armor slots existed
  while (inv.length < INV_SLOTS + ARMOR_SLOTS) {
    inv.push(null);
  }
  return inv;
}

function wireSlots(slots: readonly InvSlot[]): InvWireSlot[] {
  return slots.map((slot) => (slot ? { i: slot.item, n: slot.count } : null));
}

function sendInventory(world: World, connectionId: string) {
  const player = world.players.get(connectionId);
  const inv = inventoryOf(world, connectionId);
  server.streams.send(connectionId, {
    type: "inventory",
    slots: wireSlots(inv),
    craft: {
      size: player?.craftSize ?? 0,
      grid: wireSlots(player?.craftGrid ?? []),
    },
  });
  // every inventory change funnels through here, so this is where a change
  // to the wear slots becomes visible to everyone else
  if (player) {
    const packed = packArmor(inv);
    if (packed !== player.armor) {
      player.armor = packed;
      server.streams.broadcast(
        { type: "armor", id: connectionId, armor: packed },
        { except: [connectionId] },
      );
    }
  }
}

// Stacks into existing piles (hotbar first by array order), then the first
// empty slots. Returns how many didn't fit — the caller leaves those in the
// world.
function grantItem(world: World, connectionId: string, item: number, count: number): number {
  const inv = inventoryOf(world, connectionId);
  const limit = stackLimit(item);
  let remaining = count;
  // both passes stop before the wear slots: pickups never auto-equip
  for (let i = 0; i < INV_SLOTS && remaining > 0; i++) {
    const slot = inv[i];
    if (slot && slot.item === item && slot.count < limit) {
      const take = Math.min(limit - slot.count, remaining);
      slot.count += take;
      remaining -= take;
    }
  }
  for (let i = 0; i < INV_SLOTS && remaining > 0; i++) {
    if (!inv[i]) {
      const take = Math.min(limit, remaining);
      inv[i] = { item, count: take };
      remaining -= take;
    }
  }
  if (remaining < count) {
    sendInventory(world, connectionId);
  }
  return remaining;
}

// Decrements one item from the given slot; the slot must actually hold the
// claimed item (the client says which stack it is consuming from).
function tryConsume(world: World, connectionId: string, slot: number, item: number): boolean {
  const inv = inventoryOf(world, connectionId);
  const stack = inv[slot];
  if (!stack || stack.item !== item || stack.count < 1) {
    return false;
  }
  stack.count -= 1;
  if (stack.count === 0) {
    inv[slot] = null;
  }
  sendInventory(world, connectionId);
  return true;
}

function holdsItem(world: World, connectionId: string, item: number): boolean {
  return inventoryOf(world, connectionId).some((slot) => slot !== null && slot.item === item);
}

type SlotRef = { get(): InvSlot; set(v: InvSlot): void };

// Resolves an invMove slot index to its backing cell: 0..len-1 is the
// inventory; CRAFT_GRID_BASE.. addresses the open crafting grid (only cells
// that exist for the current craftSize). Returns null for out-of-range moves.
function slotRef(
  world: World,
  connectionId: string,
  player: Player,
  index: number,
): SlotRef | null {
  if (!Number.isInteger(index)) {
    return null;
  }
  const inv = inventoryOf(world, connectionId);
  if (index >= 0 && index < inv.length) {
    return { get: () => inv[index], set: (v) => void (inv[index] = v) };
  }
  if (isCraftSlot(index)) {
    const cell = craftCellOf(index);
    if (cell >= 0 && cell < player.craftSize * player.craftSize) {
      return {
        get: () => player.craftGrid[cell],
        set: (v) => void (player.craftGrid[cell] = v),
      };
    }
  }
  return null;
}

// Drag-and-drop between two slots (inventory or crafting grid): `one` moves a
// single item onto an empty cell or matching stack; otherwise merge same-item
// stacks up to the stack limit, or swap the contents.
function handleInvMove(world: World, connectionId: string, from: number, to: number, one: boolean) {
  const player = world.players.get(connectionId);
  if (!player || from === to) {
    return;
  }
  const src = slotRef(world, connectionId, player, from);
  const dst = slotRef(world, connectionId, player, to);
  if (!src || !dst) {
    // a move the server can't resolve (e.g. into a grid cell the client
    // thinks is open but the server doesn't): echo so the client reconciles
    sendInventory(world, connectionId);
    return;
  }
  const source = src.get();
  if (!source) {
    return;
  }
  // wear slots only accept their matching armor piece; echo so a client
  // whose optimistic move disagreed reconciles
  if (isArmorIndex(to) && armorPiece(source.item) !== to - ARMOR_BASE) {
    sendInventory(world, connectionId);
    return;
  }
  const target = dst.get();
  if (one) {
    // a single item only goes onto an empty cell or a matching stack with room
    if (target && (target.item !== source.item || target.count >= stackLimit(source.item))) {
      return;
    }
    if (target) {
      target.count += 1;
    } else {
      dst.set({ item: source.item, count: 1 });
    }
    source.count -= 1;
    if (source.count === 0) {
      src.set(null);
    }
  } else if (target && target.item === source.item) {
    const take = Math.min(stackLimit(source.item) - target.count, source.count);
    target.count += take;
    source.count -= take;
    if (source.count === 0) {
      src.set(null);
    }
  } else {
    src.set(target);
    dst.set(source);
  }
  sendInventory(world, connectionId);
}

// How far in front of the player a dragged-out stack lands, and how long it
// stays un-collectable. The toss must clear the auto-pickup box (1.6 blocks,
// per-axis) even on a diagonal heading, or the drop bounces straight back
// into the inventory of a player standing still.
const DROP_TOSS_DIST = 2.6;
const DROP_TOSS_NO_PICKUP_MS = 1_500;

// Toss a slot's contents out into the world (dragging a stack out of the
// inventory screen). Works for any invMove-addressable slot: inventory,
// hotbar, wear slots (drops unequip), and open crafting-grid cells.
function handleInvDrop(world: World, connectionId: string, from: number, one: boolean) {
  const player = world.players.get(connectionId);
  if (!player) {
    return;
  }
  const ref = slotRef(world, connectionId, player, from);
  const stack = ref?.get();
  if (!ref || !stack) {
    // a drop the server can't resolve: echo so the optimistic client reverts
    sendInventory(world, connectionId);
    return;
  }
  const item = stack.item;
  const count = one ? 1 : stack.count;
  stack.count -= count;
  if (stack.count <= 0) {
    ref.set(null);
  }
  // land ahead of the player at chest height; against a wall, at the feet
  const fx = player.char.x + Math.sin(player.heading) * DROP_TOSS_DIST;
  const fz = player.char.z + Math.cos(player.heading) * DROP_TOSS_DIST;
  const fy = player.char.y + 1;
  const clear = !world.isSolid(Math.floor(fx), Math.floor(fy), Math.floor(fz));
  for (let i = 0; i < count; i++) {
    // fan multi-item drops into a small spiral so they don't render as one
    const angle = i * 2.4;
    const radius = 0.18 * Math.sqrt(i);
    const dx = Math.cos(angle) * radius;
    const dz = Math.sin(angle) * radius;
    if (clear) {
      spawnDrop(world, item, fx + dx, fy, fz + dz, DROP_TOSS_NO_PICKUP_MS);
    } else {
      spawnDrop(
        world,
        item,
        player.char.x + dx,
        player.char.y + 0.5,
        player.char.z + dz,
        DROP_TOSS_NO_PICKUP_MS,
      );
    }
  }
  sendInventory(world, connectionId);
}

/*
 *      Crafting
 *
 *  A transient grid (2x2 inventory screen / 3x3 crafting table) whose cells
 *  are addressed by invMove just like inventory slots. The result is matched
 *  from the grid contents; taking it consumes one item from each filled cell.
 *  The grid drains back into the inventory on close or disconnect.
 */

const CRAFT_TABLE_RANGE = 5;

// is the player still standing next to the crafting table at `pos`?
function atCraftTable(
  world: World,
  player: Player,
  pos: { x: number; y: number; z: number },
): boolean {
  if (blockAt(world, pos.x, pos.y, pos.z) !== CRAFTING_TABLE_ID) {
    return false;
  }
  const dx = pos.x + 0.5 - player.char.x;
  const dy = pos.y + 0.5 - player.char.y;
  const dz = pos.z + 0.5 - player.char.z;
  return Math.hypot(dx, dy, dz) <= CRAFT_TABLE_RANGE;
}

function returnCraftGrid(world: World, connectionId: string, player: Player) {
  for (const cell of player.craftGrid) {
    if (!cell) {
      continue;
    }
    // fill the inventory first; anything that doesn't fit drops in the world
    // (grantItem's contract — never silently destroy the leftover)
    const overflow = grantItem(world, connectionId, cell.item, cell.count);
    for (let n = 0; n < overflow; n++) {
      spawnDrop(world, cell.item, player.char.x + 0.5, player.char.y + 0.4, player.char.z + 0.5);
    }
  }
  player.craftGrid = [];
  player.craftSize = 0;
  player.craftTable = null;
}

function handleCraftOpen(world: World, connectionId: string, msg: CraftOpenMessage) {
  const player = world.players.get(connectionId);
  if (!player) {
    return;
  }
  const size = msg.size === 3 ? 3 : 2;
  let table: { x: number; y: number; z: number } | null = null;
  if (size === 3) {
    // a 3x3 grid requires standing next to the crafting table the client
    // claims to have opened (don't trust client UI gating alone)
    if (
      msg.x === undefined ||
      msg.y === undefined ||
      msg.z === undefined ||
      !atCraftTable(world, player, { x: msg.x, y: msg.y, z: msg.z })
    ) {
      // echo so the client's optimistically-opened grid snaps back to closed
      sendInventory(world, connectionId);
      return;
    }
    table = { x: msg.x, y: msg.y, z: msg.z };
  }
  // reopening drains any leftover grid back to the inventory first
  returnCraftGrid(world, connectionId, player);
  player.craftSize = size;
  player.craftGrid = Array.from({ length: size * size }, () => null);
  player.craftTable = table;
  sendInventory(world, connectionId);
}

function handleCraftClose(world: World, connectionId: string) {
  const player = world.players.get(connectionId);
  if (!player) {
    return;
  }
  returnCraftGrid(world, connectionId, player);
  sendInventory(world, connectionId);
}

// Does the inventory have room for `count` more of `item` (existing stacks
// with headroom plus empty slots)?
function hasRoomFor(world: World, connectionId: string, item: number, count: number): boolean {
  const inv = inventoryOf(world, connectionId);
  const limit = stackLimit(item);
  let room = 0;
  for (const slot of inv) {
    if (!slot) {
      room += limit;
    } else if (slot.item === item && slot.count < limit) {
      room += limit - slot.count;
    }
    if (room >= count) {
      return true;
    }
  }
  return room >= count;
}

function handleCraftTake(world: World, connectionId: string, all: boolean) {
  const player = world.players.get(connectionId);
  if (!player || player.craftSize === 0) {
    return;
  }
  // a 3x3 craft must still be at its table; if it's gone/out of range, drain
  // the grid and refuse (can't keep crafting tools after leaving the table)
  if (
    player.craftSize === 3 &&
    (!player.craftTable || !atCraftTable(world, player, player.craftTable))
  ) {
    returnCraftGrid(world, connectionId, player);
    sendInventory(world, connectionId);
    return;
  }
  let crafted = 0;
  // craft once, or repeatedly for shift-take, until the grid no longer
  // satisfies a recipe or the output no longer fits
  for (let guard = 0; guard < 1000; guard++) {
    const cells = player.craftGrid.map((cell) => (cell ? cell.item : 0));
    const recipe = matchRecipe(cells, player.craftSize);
    if (!recipe || !hasRoomFor(world, connectionId, recipe.out, recipe.count)) {
      break;
    }
    // consume one from every filled cell (equals the matched recipe's needs)
    for (let i = 0; i < player.craftGrid.length; i++) {
      const cell = player.craftGrid[i];
      if (cell) {
        cell.count -= 1;
        if (cell.count <= 0) {
          player.craftGrid[i] = null;
        }
      }
    }
    grantItem(world, connectionId, recipe.out, recipe.count);
    crafted++;
    if (!all) {
      break;
    }
  }
  if (crafted > 0) {
    sendInventory(world, connectionId);
  }
}

/*
 *      Block digging: blocks have HP and drop themselves when broken
 */

function blockAt(world: World, x: number, y: number, z: number): number {
  const edit = world.lookupEdit(x, y, z);
  return edit ? edit.block : baseVoxelID(x, y, z);
}

// block center within the player's (slack-padded) reach of their eye line
function blockInRange(player: Player, x: number, y: number, z: number): boolean {
  return (
    Math.hypot(x + 0.5 - player.char.x, y + 0.5 - (player.char.y + 1.5), z + 0.5 - player.char.z) <=
    BLOCK_RANGE
  );
}

function handleHit(world: World, id: string, x: number, y: number, z: number) {
  const player = world.players.get(id);
  if (!player || !blockInRange(player, x, y, z)) {
    return;
  }
  const block = blockAt(world, x, y, z);
  const damage = hitDamage(player.item, block);
  if (damage <= 0) {
    return;
  }
  const key = editKey(x, y, z);
  const now = server.elapsedMs();
  let entry = world.blockDamage.get(key);
  if (!entry || entry.block !== block || now - entry.at > BLOCK_DAMAGE_RESET_MS) {
    entry = { block, hp: blockHP(block), at: now };
  }
  entry.hp -= damage;
  entry.at = now;
  if (entry.hp > 0) {
    world.blockDamage.set(key, entry);
    server.streams.send(id, { type: "damage", x, y, z, hp: entry.hp, maxHp: blockHP(block) });
    return;
  }

  world.blockDamage.delete(key);
  emitEdit(world, { block: 0, x, y, z }, null);
  spawnDrop(world, blockToItem(block), x + 0.5, y + 0.4, z + 0.5);
  const bonus = bonusDrop(block);
  if (bonus !== null) {
    spawnDrop(world, bonus, x + 0.5, y + 0.7, z + 0.5);
  }
}

function handlePlace(world: World, id: string, place: PlaceMessage) {
  const { item, slot, x, y, z } = place;
  const player = world.players.get(id);
  if (!player || !isValidItem(item) || !isBlockItem(item)) {
    return;
  }
  if (!blockInRange(player, x, y, z)) {
    return;
  }
  const target = blockAt(world, x, y, z);
  if (target !== 0 && target !== WATER_ID) {
    return;
  }
  if (!tryConsume(world, id, slot, item)) {
    return;
  }
  emitEdit(world, { block: itemToBlock(item), x, y, z }, null);
}

/*
 *      World drops: broken blocks and landed projectiles float in place
 *      until someone walks over them
 */

function spawnDrop(
  world: World,
  item: number,
  x: number,
  y: number,
  z: number,
  noPickupMs = DROP_PICKUP_DELAY_MS,
) {
  if (world.drops.size >= MAX_DROPS) {
    return;
  }
  const id = world.nextDropId;
  world.nextDropId = (world.nextDropId + 1) % 65536 || 1;
  world.drops.set(id, { id, item, x, y, z, ttlMs: DROP_TTL_MS, noPickupMs });
  world.dropsDirty = true;
}

function tickDrops(world: World) {
  for (const drop of world.drops.values()) {
    drop.ttlMs -= SIM_TICK_MS;
    if (drop.ttlMs <= 0) {
      world.drops.delete(drop.id);
      world.dropsDirty = true;
      continue;
    }
    if (drop.noPickupMs > 0) {
      drop.noPickupMs -= SIM_TICK_MS;
      continue;
    }
    for (const [id, player] of world.players) {
      const c = player.char;
      if (
        Math.abs(drop.x - c.x) <= DROP_PICKUP_RADIUS &&
        drop.y >= c.y - 1 &&
        drop.y <= c.y + 2.2 &&
        Math.abs(drop.z - c.z) <= DROP_PICKUP_RADIUS
      ) {
        if (grantItem(world, id, drop.item, 1) === 0) {
          world.drops.delete(drop.id);
          world.dropsDirty = true;
        }
        break;
      }
    }
  }
}

/*
 *      Projectiles: server-authoritative ballistics
 */

function handleThrow(world: World, ownerId: string, msg: ThrowMessage) {
  const { item, slot, dx, dy, dz } = msg;
  const player = world.players.get(ownerId);
  if (!player || !isThrowable(item) || world.projectiles.size >= MAX_PROJECTILES) {
    return;
  }
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    return;
  }
  if (!tryConsume(world, ownerId, slot, item)) {
    return;
  }
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  const speed = throwSpeed(item);
  const id = world.nextProjectileId;
  world.nextProjectileId = (world.nextProjectileId + 1) % 65536 || 1;
  world.projectiles.set(id, {
    id,
    item,
    owner: ownerId,
    // spawn at eye height, pushed forward clear of the thrower's AABB
    x: player.char.x + nx * 0.9,
    y: player.char.y + 1.5 + ny * 0.9,
    z: player.char.z + nz * 0.9,
    vx: nx * speed,
    vy: ny * speed,
    vz: nz * speed,
    ttlMs: PROJECTILE_TTL_MS,
  });
}

// first inventory slot holding the given item, or -1
function findItemSlot(world: World, connectionId: string, item: number): number {
  const inv = inventoryOf(world, connectionId);
  for (let i = 0; i < inv.length; i++) {
    const slot = inv[i];
    if (slot && slot.item === item && slot.count > 0) {
      return i;
    }
  }
  return -1;
}

// Loose an arrow from a drawn bow. Authoritative: requires the bow to be the
// held item, finds an arrow to spend, and derives speed/damage/knockback from
// the draw fraction so the client only supplies aim and how long it pulled.
function handleFireArrow(world: World, ownerId: string, msg: FireArrowMessage) {
  const { charge, dx, dy, dz } = msg;
  const player = world.players.get(ownerId);
  if (!player || player.item !== BOW || world.projectiles.size >= MAX_PROJECTILES) {
    return;
  }
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    return;
  }
  const slot = findItemSlot(world, ownerId, ARROW);
  if (slot < 0 || !tryConsume(world, ownerId, slot, ARROW)) {
    return;
  }
  const { speed, damage, knockback: knock } = arrowLaunch(charge);
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  const id = world.nextProjectileId;
  world.nextProjectileId = (world.nextProjectileId + 1) % 65536 || 1;
  world.projectiles.set(id, {
    id,
    item: ARROW,
    owner: ownerId,
    x: player.char.x + nx * 0.9,
    y: player.char.y + 1.5 + ny * 0.9,
    z: player.char.z + nz * 0.9,
    vx: nx * speed,
    vy: ny * speed,
    vz: nz * speed,
    ttlMs: PROJECTILE_TTL_MS,
    damage,
    knock,
  });
}

function stepProjectiles(world: World) {
  const dt = SIM_TICK_MS / 1000;
  for (const proj of world.projectiles.values()) {
    proj.ttlMs -= SIM_TICK_MS;
    if (proj.ttlMs <= 0) {
      world.projectiles.delete(proj.id);
      continue;
    }
    proj.vy += PROJECTILE_GRAVITY * dt;

    // substep so fast projectiles don't tunnel through blocks or players
    const steps = 3;
    let alive = true;
    for (let s = 0; s < steps && alive; s++) {
      const prevX = proj.x;
      const prevY = proj.y;
      const prevZ = proj.z;
      proj.x += (proj.vx * dt) / steps;
      proj.y += (proj.vy * dt) / steps;
      proj.z += (proj.vz * dt) / steps;
      if (world.isSolid(Math.floor(proj.x), Math.floor(proj.y), Math.floor(proj.z))) {
        // landed: persist as a world drop just shy of the surface it hit
        if (dropsOnImpact(proj.item)) {
          spawnDrop(world, proj.item, prevX, prevY, prevZ);
        }
        alive = false;
        break;
      }
      for (const [id, player] of world.players) {
        if (id === proj.owner) {
          continue;
        }
        const c = player.char;
        if (
          Math.abs(proj.x - c.x) <= 0.45 &&
          proj.y >= c.y - 0.1 &&
          proj.y <= c.y + 1.9 &&
          Math.abs(proj.z - c.z) <= 0.45
        ) {
          damagePlayer(
            world,
            id,
            proj.owner,
            proj.damage ?? projectileDamage(proj.item),
            proj.vx,
            proj.vz,
            proj.knock ?? knockback(proj.item),
          );
          if (dropsOnImpact(proj.item)) {
            spawnDrop(world, proj.item, proj.x, proj.y, proj.z);
          }
          alive = false;
          break;
        }
      }
      // NPCs share the projectile damage tables with players (arrows carry
      // their charge-scaled damage), so a full-draw arrow one-shots a chicken
      // but a zombie takes a few
      if (alive) {
        for (const npc of world.npcs.values()) {
          const c = npc.char;
          if (
            Math.abs(proj.x - c.x) <= 0.5 &&
            proj.y >= c.y - 0.1 &&
            proj.y <= c.y + 1.6 &&
            Math.abs(proj.z - c.z) <= 0.5
          ) {
            damageNpc(
              world,
              npc,
              proj.damage ?? projectileDamage(proj.item),
              proj.vx,
              proj.vz,
              proj.knock ?? knockback(proj.item),
              proj.owner,
            );
            if (dropsOnImpact(proj.item)) {
              spawnDrop(world, proj.item, proj.x, proj.y, proj.z);
            }
            alive = false;
            break;
          }
        }
      }
    }
    if (!alive) {
      world.projectiles.delete(proj.id);
    }
  }
}

function handleInput(world: World, event: DatagramEvent) {
  const messages = decodeInputs(event.bytes);
  if (!messages || messages.length === 0) {
    return;
  }
  let player = world.players.get(event.connection.id);
  if (!player) {
    // First input from this connection: materialize the body now (never
    // on connect), so connections that never send anything can't leave a
    // phantom at spawn while the runtime reaps them.
    addPlayer(world, event.connection);
    player = world.players.get(event.connection.id);
  }
  if (!player) {
    return;
  }
  // Each packet redundantly carries the sender's recent unacked inputs;
  // anything at or below lastSeq was already applied (or arrived too late
  // to matter) and is skipped, so duplicates and reordering are free.
  for (const message of messages) {
    if (message.seq <= player.lastSeq) {
      continue;
    }
    if (player.stepsThisTick >= MAX_STEPS_PER_TICK) {
      // redundant packets re-carry seqs that are already queued; only
      // queue past the tail or duplicates crowd out genuinely new inputs
      const tail = player.inputQueue[player.inputQueue.length - 1];
      if ((!tail || message.seq > tail.seq) && player.inputQueue.length < MAX_QUEUED_INPUTS) {
        player.inputQueue.push(message);
      }
      continue;
    }
    applyInput(world, event.connection.id, player, message);
  }
}

function applyInput(world: World, id: string, player: Player, message: CharInput) {
  const wasAirborne = !onGround(player.char);
  const fallVy = player.char.vy;
  player.char = world.step(player.char, message);
  player.heading = message.heading;
  player.lastSeq = message.seq;
  player.stepsThisTick += 1;
  // an airborne body touching down this step just landed at fallVy
  if (wasAirborne && fallVy < 0 && onGround(player.char)) {
    applyFallDamage(world, id, fallVy);
  }
  // breath: eyes below the water surface drain the lungs in sim time; once
  // they're empty, every further DROWN_INTERVAL_MS underwater costs a tick
  // of drowning damage. Surfacing refills several times faster.
  const eyes = blockAt(
    world,
    Math.floor(player.char.x),
    Math.floor(player.char.y + EYE_HEIGHT),
    Math.floor(player.char.z),
  );
  if (eyes === WATER_ID) {
    player.breathMs -= SIM_TICK_MS;
    if (player.breathMs <= -DROWN_INTERVAL_MS) {
      player.breathMs = 0;
      applyDrownDamage(world, id);
    }
  } else if (player.breathMs < BREATH_MAX_MS) {
    player.breathMs = Math.min(
      BREATH_MAX_MS,
      Math.max(0, player.breathMs) + SIM_TICK_MS * BREATH_REFILL_RATE,
    );
  }
}

function drainInputQueue(world: World, id: string, player: Player) {
  while (player.inputQueue.length > 0 && player.stepsThisTick < MAX_STEPS_PER_TICK) {
    const message = player.inputQueue.shift();
    if (message && message.seq > player.lastSeq) {
      applyInput(world, id, player, message);
    }
  }
}

function addPlayer(world: World, connection: Connection) {
  console.log(`player materialized: ${connection.id} (${connection.userName})`);
  // a reconnect (tab reload) is the same user on a new connection: evict
  // the old body immediately instead of leaving an "echo" until timeout
  for (const [otherId, other] of world.players) {
    if (other.userId === connection.userId && otherId !== connection.id) {
      removePlayer(world, otherId);
    }
  }

  // resume a recently parked character (reconnect or tab reload)
  const parked = world.parked.get(connection.userId);
  const fresh = parked && server.elapsedMs() - parked.at < PARK_TTL_MS ? parked : undefined;
  world.parked.delete(connection.userId);

  // a pick made in this connection's creator screen wins over a parked
  // appearance (the player may have re-picked on reload)
  const pendingSkin = world.pendingSkins.get(connection.id);
  world.pendingSkins.delete(connection.id);
  const skin = pendingSkin ?? fresh?.skin ?? appearanceForId(connection.id);

  const player: Player = {
    name: connection.userName,
    userId: connection.userId,
    skin,
    armor: 0,
    char: fresh ? fresh.char : spawnFor(world, connection.id),
    heading: fresh ? fresh.heading : 0,
    lastSeq: 0,
    item: fresh ? fresh.item : 0,
    hp: fresh ? fresh.hp : MAX_HP,
    breathMs: BREATH_MAX_MS,
    lastDamageAt: -100000,
    lastAttackAt: -100000,
    protectedUntil: 0,
    stepsThisTick: 0,
    sawNpcs: false,
    inputQueue: [],
    syncedChunks: new Set(),
    lastChunk: "none",
    craftSize: 0,
    craftGrid: [],
    craftTable: null,
  };
  world.players.set(connection.id, player);
  // armor rides the inventory, which is keyed by userId — resolvable only
  // now that the player entry exists
  player.armor = packArmor(inventoryOf(world, connection.id));
  server.streams.broadcast(
    { type: "join", id: connection.id, name: connection.userName, skin, armor: player.armor },
    { except: [connection.id] },
  );
  sendInventory(world, connection.id);
}

function removePlayer(world: World, id: string) {
  const player = world.players.get(id);
  if (player) {
    // don't lose items left in an open crafting grid (parking saves only
    // char/heading/item/hp, so the grid must drain back into the inventory)
    returnCraftGrid(world, id, player);
    world.parked.set(player.userId, {
      char: player.char,
      heading: player.heading,
      item: player.item,
      hp: player.hp,
      skin: player.skin,
      at: server.elapsedMs(),
    });
  }
  world.players.delete(id);
  server.streams.broadcast({ type: "leave", id });
}

/*
 *      NPCs
 *
 *  Passive mobs (chicken, pig, cow) wander, avoid water and cliffs, and
 *  flee when hurt. Hostile mobs (zombie, spider) additionally hunt: they
 *  aggro on a visible player in range, chase with the same hazard steering,
 *  and melee on a cooldown through the ordinary damagePlayer path.
 */

function nextRng(state: number): number {
  let s = state >>> 0;
  s ^= s << 13;
  s >>>= 0;
  s ^= s >> 17;
  s ^= s << 5;
  return s >>> 0;
}

// First empty cell above the terrain column at (x, z): the chicken's feet rest
// on the highest solid block.
function groundY(world: World, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  for (let y = 96; y > 0; y--) {
    if (world.isSolid(ix, y - 1, iz)) {
      return y;
    }
  }
  return 16;
}

// Players spawn scattered on a ring around the map origin: close enough to
// find each other, spread out enough that nobody materializes inside anyone
// else, and always standing on the ground. Water and treetop columns are
// retried (the last attempt is taken as-is so this always terminates).
const SPAWN_RING_MIN = 3;
const SPAWN_RING_MAX = 10;

function spawnFor(world: World, seed: string): CharState {
  let rng = 1;
  for (let i = 0; i < seed.length; i++) {
    rng = (rng * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const char = spawnState();
  // extra scramble rounds: sequential connection ids hash to adjacent
  // seeds, and a single xorshift round leaves their angles clumped
  rng = nextRng(nextRng(rng || 1));
  for (let attempt = 0; attempt < 8; attempt++) {
    rng = nextRng(rng || 1);
    const angle = (rng / 0x100000000) * Math.PI * 2;
    rng = nextRng(rng);
    const dist = SPAWN_RING_MIN + (rng / 0x100000000) * (SPAWN_RING_MAX - SPAWN_RING_MIN);
    const x = Math.cos(angle) * dist + 0.5;
    const z = Math.sin(angle) * dist + 0.5;
    const y = groundY(world, x, z);
    const feet = blockAt(world, Math.floor(x), y, Math.floor(z));
    const under = blockAt(world, Math.floor(x), y - 1, Math.floor(z));
    if ((feet === WATER_ID || under === LEAVES_ID || under === LOG_ID) && attempt < 7) {
      continue;
    }
    char.x = x;
    char.z = z;
    char.y = y;
    break;
  }
  return char;
}

function worldRand(world: World): number {
  world.spawnRng = nextRng(world.spawnRng);
  return world.spawnRng / 0x100000000;
}

// The surface y an NPC can stand on at (x, z), or null for a bad column:
// water (the old chicken spawner dropped birds on lake beds) or a treetop.
function landingAt(world: World, x: number, z: number): number | null {
  const y = groundY(world, x, z);
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  if (blockAt(world, ix, y, iz) === WATER_ID) {
    return null;
  }
  const under = blockAt(world, ix, y - 1, iz);
  if (under === LEAVES_ID || under === LOG_ID) {
    return null;
  }
  return y;
}

function spawnNpc(world: World, kind: number, x: number, z: number): boolean {
  const y = landingAt(world, x, z);
  if (y === null) {
    return false;
  }
  const id = world.nextNpcId;
  world.nextNpcId = (world.nextNpcId + 1) % 65536 || 1;
  const char = spawnState();
  char.x = x;
  char.y = y;
  char.z = z;
  const heading = worldRand(world) * Math.PI * 2;
  world.npcs.set(id, {
    id,
    kind,
    char,
    heading,
    wantHeading: heading,
    hp: NPC_CONFIG[kind].hp,
    mode: "idle",
    modeMsLeft: 0,
    targetId: null,
    lastAttackAt: -100_000,
    rng: ((id * 0x9e3779b1) ^ getWorldSeed()) >>> 0 || 1,
  });
  return true;
}

// Per-kind low-frequency "territory" noise carves patches of the map where
// that kind can spawn, so herds/nests have home regions instead of a uniform
// sprinkle around players. The biome list keeps zombies out of open plains:
// the spawn meadow is plains, so fresh players meet hostiles only after
// crossing into forest/mountains.
function suitsNpcHabitat(kind: number, x: number, z: number): boolean {
  const cfg = NPC_CONFIG[kind];
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  return cfg.biomes.includes(biomeAt(ix, iz)) && noise2(ix, iz, 96, 1100 + kind) >= cfg.territory;
}

// One placement attempt set for a kind. Passives cluster around an anchor
// (a random player, or the origin before anyone joins); hostiles spawn on a
// ring that keeps a minimum gap from every player, so nothing materializes
// in someone's face.
function trySpawnKind(world: World, kind: number, budget: number): number {
  if (budget <= 0) {
    return 0;
  }
  const cfg = NPC_CONFIG[kind];
  const players = [...world.players.values()];
  for (let attempt = 0; attempt < 16; attempt++) {
    const anchor =
      players.length > 0
        ? players[Math.floor(worldRand(world) * players.length)].char
        : { x: 0.5, z: 0.5 };
    const angle = worldRand(world) * Math.PI * 2;
    const dist = cfg.hostile
      ? HOSTILE_SPAWN_MIN + worldRand(world) * (HOSTILE_SPAWN_MAX - HOSTILE_SPAWN_MIN)
      : 8 + worldRand(world) * (PASSIVE_SPAWN_RADIUS - 8);
    const x = anchor.x + Math.cos(angle) * dist;
    const z = anchor.z + Math.sin(angle) * dist;
    if (
      cfg.hostile &&
      players.some((p) => Math.hypot(p.char.x - x, p.char.z - z) < HOSTILE_MIN_PLAYER_GAP)
    ) {
      continue;
    }
    if (!suitsNpcHabitat(kind, x, z)) {
      continue;
    }
    if (spawnNpc(world, kind, x, z)) {
      let spawned = 1;
      const companions = Math.min(cfg.group, budget) - 1;
      for (let i = 0; i < companions; i++) {
        const companionAngle = worldRand(world) * Math.PI * 2;
        const companionDist = 2 + worldRand(world) * 5;
        if (
          spawnNpc(
            world,
            kind,
            x + Math.cos(companionAngle) * companionDist,
            z + Math.sin(companionAngle) * companionDist,
          )
        ) {
          spawned += 1;
        }
      }
      return spawned;
    }
  }
  return 0;
}

function spawnInitialNpcs(world: World) {
  for (let kind = 0; kind < NPC_KIND_COUNT; kind++) {
    const cap = kindCap(kind);
    let spawned = 0;
    for (let calls = 0; spawned < cap && calls < cap; calls++) {
      spawned += trySpawnKind(world, kind, cap - spawned);
    }
  }
}

// Slow refill toward each kind's population cap (one attempt per kind per
// cycle), so hunted animals and slain zombies return over time. Skipped on an
// empty server — populations only matter while someone is playing.
let npcRespawnMs = 0;

function npcKindCounts(world: World): number[] {
  const counts = Array.from({ length: NPC_KIND_COUNT }, () => 0);
  for (const npc of world.npcs.values()) {
    counts[npc.kind] += 1;
  }
  return counts;
}

function tickNpcRespawns(world: World) {
  npcRespawnMs += SIM_TICK_MS;
  if (npcRespawnMs < NPC_RESPAWN_INTERVAL_MS) {
    return;
  }
  npcRespawnMs = 0;
  if (world.players.size === 0) {
    return;
  }
  const counts = npcKindCounts(world);
  for (let kind = 0; kind < NPC_KIND_COUNT; kind++) {
    const budget = kindCap(kind) - counts[kind];
    if (budget > 0) {
      trySpawnKind(world, kind, budget);
    }
  }
}

// The set of chunk columns within SYNC_RADIUS of any player — i.e. the chunks
// currently streamed to someone. Mirrors syncChunkWindow's per-player box.
function computeLoadedChunks(world: World): Set<string> {
  const loaded = new Set<string>();
  for (const player of world.players.values()) {
    const cx = chunkCoord(player.char.x);
    const cz = chunkCoord(player.char.z);
    for (let dx = -SYNC_RADIUS; dx <= SYNC_RADIUS; dx++) {
      for (let dz = -SYNC_RADIUS; dz <= SYNC_RADIUS; dz++) {
        loaded.add(chunkKey(cx + dx, cz + dz));
      }
    }
  }
  return loaded;
}

// Probe one block ahead of the feet along `heading` (movement convention:
// dx = sin, dz = cos): true if that step leads into water or off a tall drop.
function headingHazard(world: World, char: CharState, heading: number): boolean {
  // probe two step lengths ahead so a moving mob can't cut a corner into
  // water between one tick's check and the next
  for (const dist of [0.9, 1.7]) {
    const ix = Math.floor(char.x + Math.sin(heading) * dist);
    const iz = Math.floor(char.z + Math.cos(heading) * dist);
    const iy = Math.floor(char.y + 0.01);
    // stepping into water, or onto a water surface
    if (world.isFluid(ix, iy, iz) || world.isFluid(ix, iy - 1, iz)) {
      return true;
    }
    // walking off a drop: hazardous unless SOLID ground lies within ~4
    // below — water on the way down is a hazard, not a floor (counting it
    // as one is what let mobs plunge off banks into lakes)
    if (!world.isSolid(ix, iy - 1, iz)) {
      let hasFloor = false;
      for (let d = 2; d <= 4; d++) {
        if (world.isFluid(ix, iy - d, iz)) {
          return true;
        }
        if (world.isSolid(ix, iy - d, iz)) {
          hasFloor = true;
          break;
        }
      }
      if (!hasFloor) {
        return true;
      }
    }
  }
  return false;
}

// A hazard-free heading near `desired`: the desired one, then increasingly
// wide deflections to either side, then a full reverse; null when everything
// is bad (boxed in). The first deflection side is randomized per call so a
// blocked herd doesn't peel in lockstep.
function safeHeading(world: World, npc: Npc, desired: number): number | null {
  npc.rng = nextRng(npc.rng);
  const flip = npc.rng / 0x100000000 < 0.5 ? -1 : 1;
  for (const off of [0, 0.7, -0.7, 1.4, -1.4, 2.2, -2.2, Math.PI]) {
    const heading = desired + off * flip;
    if (!headingHazard(world, npc.char, heading)) {
      return heading;
    }
  }
  return null;
}

// Coarse eye-line visibility, sampled once per block. Good enough to stop
// zombies aggroing through hills; chases re-steer around obstacles anyway.
function canSee(world: World, from: CharState, to: CharState): boolean {
  const x0 = from.x;
  const y0 = from.y + 1.4;
  const z0 = from.z;
  const dx = to.x - x0;
  const dy = to.y + 1.2 - y0;
  const dz = to.z - z0;
  const steps = Math.ceil(Math.hypot(dx, dy, dz));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (world.isSolid(Math.floor(x0 + dx * t), Math.floor(y0 + dy * t), Math.floor(z0 + dz * t))) {
      return false;
    }
  }
  return true;
}

// Keep a still-valid chase target (with de-aggro hysteresis), else acquire the
// nearest visible living player in aggro range.
function updateAggro(world: World, npc: Npc, cfg: NpcKindConfig) {
  if (npc.mode === "chase" && npc.targetId) {
    const target = world.players.get(npc.targetId);
    if (
      target &&
      target.hp > 0 &&
      server.elapsedMs() >= target.protectedUntil &&
      Math.hypot(target.char.x - npc.char.x, target.char.z - npc.char.z) <=
        cfg.aggroRange * DEAGGRO_FACTOR
    ) {
      return;
    }
    npc.mode = "idle";
    npc.targetId = null;
    npc.modeMsLeft = 300;
  }
  let best: string | null = null;
  let bestDist = cfg.aggroRange;
  const now = server.elapsedMs();
  for (const [id, player] of world.players) {
    // respawn-protected players are invisible to hostiles, so a fresh spawn
    // gets a head start instead of the zombie that just killed them waiting
    // out the protection timer
    if (player.hp <= 0 || now < player.protectedUntil) {
      continue;
    }
    const dist = Math.hypot(player.char.x - npc.char.x, player.char.z - npc.char.z);
    if (dist <= bestDist && canSee(world, npc.char, player.char)) {
      best = id;
      bestDist = dist;
    }
  }
  if (best) {
    npc.mode = "chase";
    npc.targetId = best;
  }
}

// Step every NPC in a loaded chunk through the shared character sim. NPCs
// outside loaded chunks are skipped entirely (frozen, zero CPU). Returns the
// NPCs simulated this tick — the ones to broadcast.
function stepNpcs(world: World, loadedChunks: Set<string>): Npc[] {
  const active: Npc[] = [];
  const now = server.elapsedMs();
  for (const npc of world.npcs.values()) {
    const key = chunkKey(chunkCoord(npc.char.x), chunkCoord(npc.char.z));
    if (!loadedChunks.has(key)) {
      continue;
    }
    const cfg = NPC_CONFIG[npc.kind];
    if (cfg.hostile) {
      updateAggro(world, npc, cfg);
    }

    // wander timer: only drives the idle/walk alternation — flee expiry is
    // handled below, and chasing ignores it entirely
    npc.modeMsLeft -= SIM_TICK_MS;
    if (npc.mode === "flee" && npc.modeMsLeft <= 0) {
      npc.mode = "idle";
      npc.modeMsLeft = 400;
    }
    if ((npc.mode === "idle" || npc.mode === "walk") && npc.modeMsLeft <= 0) {
      npc.rng = nextRng(npc.rng);
      if (npc.rng / 0x100000000 < NPC_IDLE_CHANCE) {
        npc.mode = "idle";
        npc.wantHeading = npc.heading;
      } else {
        npc.mode = "walk";
        npc.rng = nextRng(npc.rng);
        npc.wantHeading = (npc.rng / 0x100000000) * Math.PI * 2;
      }
      npc.rng = nextRng(npc.rng);
      npc.modeMsLeft =
        NPC_WANDER_MIN_MS + (npc.rng / 0x100000000) * (NPC_WANDER_MAX_MS - NPC_WANDER_MIN_MS);
    }

    let moving = npc.mode !== "idle";
    let desired = npc.wantHeading;

    if (npc.mode === "chase") {
      const target = npc.targetId ? world.players.get(npc.targetId) : undefined;
      if (!target) {
        npc.mode = "idle";
        npc.targetId = null;
        npc.modeMsLeft = 300;
        moving = false;
      } else {
        const dx = target.char.x - npc.char.x;
        const dy = target.char.y - npc.char.y;
        const dz = target.char.z - npc.char.z;
        desired = Math.atan2(dx, dz);
        npc.wantHeading = desired;
        // in reach: stand and swing on a cooldown instead of shoving through.
        // Standing still doesn't stop the turn below, so it keeps facing a
        // target that circles it.
        if (Math.hypot(dx, dz) <= cfg.attackReach && Math.abs(dy) < 2) {
          moving = false;
          if (now - npc.lastAttackAt >= NPC_ATTACK_COOLDOWN_MS && npc.targetId) {
            npc.lastAttackAt = now;
            server.streams.broadcast({ type: "npcSwing", id: npc.id });
            damagePlayer(
              world,
              npc.targetId,
              npcAttackerTag(npc.kind),
              cfg.damage,
              dx,
              dz,
              NPC_MELEE_KNOCKBACK,
            );
          }
        }
      }
    }

    const inWater = world.isFluid(
      Math.floor(npc.char.x),
      Math.floor(npc.char.y + 0.3),
      Math.floor(npc.char.z),
    );
    let jump = false;
    if (inWater) {
      // paddle up and steer for the nearest bank (a shoreline heading reads
      // as hazard-free); mobs that end up swimming climb back out
      jump = true;
      moving = true;
      desired = safeHeading(world, npc, desired) ?? desired;
    } else if (moving) {
      const safe = safeHeading(world, npc, desired);
      if (safe === null) {
        // boxed in by water/cliffs on all sides: stand still a moment
        moving = false;
        if (npc.mode === "walk") {
          npc.mode = "idle";
          npc.modeMsLeft = 500;
        }
      } else {
        desired = safe;
        // hunting into a wall autoStep can't clear: hop (wander doesn't hop —
        // a chicken pacing at a fence is fine, a stalled zombie is not)
        if (
          (npc.mode === "chase" || npc.mode === "flee") &&
          onGround(npc.char) &&
          Math.hypot(npc.char.vx, npc.char.vz) < 0.5
        ) {
          jump = true;
        }
      }
    }
    // turn the body toward the desired direction at a bounded rate; movement
    // follows the body, so direction changes arc instead of strafing. Big
    // turns pivot in place first, and a body still pointed at a hazard
    // mid-turn waits for the turn instead of walking into it.
    const delta = angleDeltaRad(npc.heading, desired);
    const maxTurn = (NPC_TURN_RATE * SIM_TICK_MS) / 1000;
    npc.heading += Math.abs(delta) <= maxTurn ? delta : Math.sign(delta) * maxTurn;
    if (
      moving &&
      !inWater &&
      (Math.abs(delta) > NPC_PIVOT_RAD || headingHazard(world, npc.char, npc.heading))
    ) {
      moving = false;
    }

    const input: CharInput = {
      seq: 0,
      heading: npc.heading,
      pitch: 0,
      fwd: moving,
      back: false,
      left: false,
      right: false,
      jump,
      sprint: false,
      maxSpeed: cfg.speed * (npc.mode === "flee" ? NPC_FLEE_SPEED_MULT : 1),
    };
    npc.char = world.step(npc.char, input);
    active.push(npc);
  }
  return active;
}

// shortest signed angle from `from` to `to`, in [-PI, PI]
function angleDeltaRad(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

// Shared damage path for melee and projectiles vs NPCs: knockback, hurt
// flash, drops + death broadcast, and the behavioral response (passives bolt
// away along the knockback direction; hostiles turn on their attacker).
function damageNpc(
  world: World,
  npc: Npc,
  amount: number,
  kbx: number,
  kbz: number,
  kbScale: number,
  attackerId: string,
) {
  npc.hp -= amount;
  const h = Math.hypot(kbx, kbz) || 1;
  npc.char.vx += (kbx / h) * kbScale;
  npc.char.vz += (kbz / h) * kbScale;
  npc.char.vy += kbScale * 0.5;
  npc.char.ry = 0;
  npc.char.sleep = 10;

  if (npc.hp <= 0) {
    world.npcs.delete(npc.id);
    for (const drop of NPC_CONFIG[npc.kind].drops) {
      npc.rng = nextRng(npc.rng);
      const count = drop.min + Math.floor((npc.rng / 0x100000000) * (drop.max - drop.min + 1));
      for (let i = 0; i < count; i++) {
        spawnDrop(world, drop.item, npc.char.x, npc.char.y + 0.4, npc.char.z);
      }
    }
    server.streams.broadcast({
      type: "npcDeath",
      id: npc.id,
      kind: npc.kind,
      x: npc.char.x,
      y: npc.char.y,
      z: npc.char.z,
    });
    return;
  }

  server.streams.broadcast({ type: "npcHurt", id: npc.id });
  if (NPC_CONFIG[npc.kind].hostile) {
    if (world.players.has(attackerId)) {
      npc.mode = "chase";
      npc.targetId = attackerId;
    }
  } else {
    // the knockback direction already points away from the attacker
    npc.mode = "flee";
    npc.targetId = null;
    npc.wantHeading = Math.atan2(kbx / h, kbz / h);
    npc.rng = nextRng(npc.rng);
    npc.modeMsLeft =
      NPC_FLEE_MIN_MS + (npc.rng / 0x100000000) * (NPC_FLEE_MAX_MS - NPC_FLEE_MIN_MS);
  }
}

function syncConnections(world: World) {
  const connected = new Set<string>();

  for (const connection of server.connections) {
    connected.add(connection.id);
    if (world.greeted.has(connection.id)) {
      continue;
    }

    // greet the connection, but do NOT create a player yet: bodies only
    // materialize on the first input (handleInput), so connections that
    // never send anything (mid-load reloads, dead sessions) never leave a
    // phantom floating at spawn
    world.greeted.add(connection.id);
    const roster: RosterEntry[] = [];
    for (const [id, player] of world.players) {
      roster.push({ id, name: player.name, skin: player.skin, armor: player.armor });
    }
    connection.streams.send({
      type: "welcome",
      you: connection.id,
      players: roster,
      seed: getWorldSeed(),
    });
  }

  // a connection the runtime no longer reports is gone: park its player
  // (removePlayer) and forget the greeting
  for (const id of world.players.keys()) {
    if (!connected.has(id)) {
      removePlayer(world, id);
    }
  }
  for (const id of world.greeted) {
    if (!connected.has(id)) {
      world.greeted.delete(id);
    }
  }
  for (const id of world.pendingSkins.keys()) {
    if (!connected.has(id)) {
      world.pendingSkins.delete(id);
    }
  }
}

function pruneParked(world: World) {
  const now = server.elapsedMs();
  for (const [userId, parked] of world.parked) {
    if (now - parked.at > PARK_TTL_MS) {
      world.parked.delete(userId);
    }
  }
}

function safeJson(event: { json<T = unknown>(): T }): unknown {
  try {
    return event.json();
  } catch {
    return undefined;
  }
}
