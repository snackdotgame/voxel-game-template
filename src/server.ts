import { server, type Connection, type DatagramEvent, type StreamEvent } from "minion:server";
import {
  type ProjectileSnapshot,
  decodeInput,
  encodeDrops,
  encodeProjectiles,
  encodeSnapshots,
} from "./shared/netCodec.js";
import {
  MAX_HP,
  blockHP,
  blockToItem,
  bonusDrop,
  dropsOnImpact,
  hitDamage,
  isBlockItem,
  isThrowable,
  isValidItem,
  itemToBlock,
  knockback,
  meleeDamage,
  projectileDamage,
  starterKit,
  throwSpeed,
} from "./shared/items.js";
import {
  type BlockEdit,
  type PlayerSnapshot,
  type RosterEntry,
  parseAttackMessage,
  parseEditMessage,
  parseEquipMessage,
  parseHitMessage,
  parsePlaceMessage,
  parseThrowMessage,
} from "./shared/messages.js";
import {
  SIM_TICK_MS,
  type CharInput,
  type CharState,
  type Stepper,
  makeStepper,
  spawnState,
} from "./shared/sim.js";
import { encodeChunkState, maxRecordsForPayload } from "./shared/chunkCodec.js";
import {
  WATER_ID,
  baseVoxelID,
  chunkCoord,
  chunkKey,
  editKey,
  makeIsFluid,
  makeIsSolid,
} from "./shared/terrain.js";

const MAX_EDITS = 200_000;
// Allow short input bursts (catch-up after client jank) but bound per-player CPU.
const MAX_STEPS_PER_TICK = 8;
const MAX_QUEUED_INPUTS = 32;
// Drop players whose input datagrams stop, without waiting for the
// transport-level disconnect timeout. They rejoin when datagrams resume.
const STALE_MS = 5_000;

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
const ATTACK_RANGE = 4.2;
const MELEE_KNOCKBACK = 5;
const RESPAWN_PROTECTION_MS = 2_000;
// regen 1 hp/s once this long has passed without taking damage
const REGEN_AFTER_MS = 8_000;

const MAX_DROPS = 512;
const DROP_TTL_MS = 120_000;
const DROP_PICKUP_DELAY_MS = 700;
const DROP_PICKUP_RADIUS = 1.6;
// partial dig damage heals back if the block is left alone this long
const BLOCK_DAMAGE_RESET_MS = 10_000;

type Player = {
  name: string;
  userId: string;
  char: CharState;
  heading: number;
  lastSeq: number;
  item: number;
  hp: number;
  lastDamageAt: number;
  lastAttackAt: number;
  protectedUntil: number;
  stepsThisTick: number;
  // inputs beyond the per-tick step budget wait here instead of dropping,
  // so client catch-up bursts don't force prediction rollbacks
  inputQueue: CharInput[];
  syncedChunks: Set<string>;
  lastChunk: string;
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

type World = {
  players: Map<string, Player>;
  lastSeen: Map<string, number>;
  // inventories survive stale-drop/rejoin; deleted on real disconnect
  inventories: Map<string, Map<number, number>>;
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
  projectiles: Map<number, Projectile>;
  nextProjectileId: number;
  hadProjectiles: boolean;
};

export async function main() {
  const edits = new Map<string, Map<string, BlockEdit>>();
  const lookupEdit = (x: number, y: number, z: number) =>
    edits.get(chunkKey(chunkCoord(x), chunkCoord(z)))?.get(editKey(x, y, z));
  const isSolid = makeIsSolid(lookupEdit);
  const isFluid = makeIsFluid(lookupEdit);
  const world: World = {
    players: new Map(),
    lastSeen: new Map(),
    inventories: new Map(),
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
    projectiles: new Map(),
    nextProjectileId: 1,
    hadProjectiles: false,
  };

  // recv() rejects when the runtime is shutting down; the pumps ending is
  // the signal to unwind the tick loop and return from main().
  let stopped = false;
  const pumps = Promise.all([pumpInputs(world), pumpStreams(world)]).then(() => {
    stopped = true;
  });

  while (server.running && !stopped) {
    syncConnections(world);
    dropStalePlayers(world);
    stepProjectiles(world);
    tickDrops(world);
    tickRegen(world);

    if (world.players.size > 0) {
      const players: PlayerSnapshot[] = [];
      for (const [id, player] of world.players) {
        player.stepsThisTick = 0;
        drainInputQueue(world, player);
        syncChunkWindow(world, id, player);
        players.push({
          id,
          lastSeq: player.lastSeq,
          heading: player.heading,
          item: player.item,
          hp: player.hp,
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
    if (player && isValidItem(equip.item)) {
      player.item = equip.item;
    }
    return;
  }
  const throwMsg = parseThrowMessage(value);
  if (throwMsg) {
    broadcastSwing(world, event.connection.id);
    handleThrow(world, event.connection.id, throwMsg.dx, throwMsg.dy, throwMsg.dz);
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
  if (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "debug"
  ) {
    const players = [];
    const now = server.elapsedMs();
    for (const [id, player] of world.players) {
      players.push({
        id,
        userId: player.userId,
        name: player.name,
        x: Math.round(player.char.x * 10) / 10,
        y: Math.round(player.char.y * 10) / 10,
        z: Math.round(player.char.z * 10) / 10,
        lastSeenAgoMs: Math.round(now - (world.lastSeen.get(id) ?? 0)),
      });
    }
    server.streams.send(event.connection.id, {
      type: "debugState",
      players,
      connections: server.connections.length,
      lastSeenEntries: world.lastSeen.size,
      drops: world.drops.size,
      projectiles: world.projectiles.size,
    });
    return;
  }
  const place = parsePlaceMessage(value);
  if (place) {
    broadcastSwing(world, event.connection.id);
    handlePlace(world, event.connection.id, place.item, place.x, place.y, place.z);
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
    victim.char = spawnState();
    victim.hp = MAX_HP;
    victim.protectedUntil = now + RESPAWN_PROTECTION_MS;
    server.streams.broadcast({ type: "death", victim: victimId, attacker: attackerId });
  }
}

/*
 *      Inventory
 */

function inventoryOf(world: World, id: string): Map<number, number> {
  let inv = world.inventories.get(id);
  if (!inv) {
    inv = starterKit();
    world.inventories.set(id, inv);
  }
  return inv;
}

function sendInventory(world: World, id: string) {
  const items: Record<string, number> = {};
  for (const [item, count] of inventoryOf(world, id)) {
    if (count > 0) {
      items[String(item)] = count;
    }
  }
  server.streams.send(id, { type: "inventory", items });
}

function addItem(world: World, id: string, item: number, count: number) {
  const inv = inventoryOf(world, id);
  inv.set(item, (inv.get(item) ?? 0) + count);
  sendInventory(world, id);
}

function tryConsume(world: World, id: string, item: number, count: number): boolean {
  const inv = inventoryOf(world, id);
  const have = inv.get(item) ?? 0;
  if (have < count) {
    return false;
  }
  inv.set(item, have - count);
  sendInventory(world, id);
  return true;
}

/*
 *      Block digging: blocks have HP and drop themselves when broken
 */

function blockAt(world: World, x: number, y: number, z: number): number {
  const edit = world.lookupEdit(x, y, z);
  return edit ? edit.block : baseVoxelID(x, y, z);
}

function handleHit(world: World, id: string, x: number, y: number, z: number) {
  const player = world.players.get(id);
  if (!player) {
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

function handlePlace(world: World, id: string, item: number, x: number, y: number, z: number) {
  const player = world.players.get(id);
  if (!player || !isValidItem(item) || !isBlockItem(item)) {
    return;
  }
  const target = blockAt(world, x, y, z);
  if (target !== 0 && target !== WATER_ID) {
    return;
  }
  if (!tryConsume(world, id, item, 1)) {
    return;
  }
  emitEdit(world, { block: itemToBlock(item), x, y, z }, null);
}

/*
 *      World drops: broken blocks and landed projectiles float in place
 *      until someone walks over them
 */

function spawnDrop(world: World, item: number, x: number, y: number, z: number) {
  if (world.drops.size >= MAX_DROPS) {
    return;
  }
  const id = world.nextDropId;
  world.nextDropId = (world.nextDropId + 1) % 65536 || 1;
  world.drops.set(id, { id, item, x, y, z, ttlMs: DROP_TTL_MS, noPickupMs: DROP_PICKUP_DELAY_MS });
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
        addItem(world, id, drop.item, 1);
        world.drops.delete(drop.id);
        world.dropsDirty = true;
        break;
      }
    }
  }
}

/*
 *      Projectiles: server-authoritative ballistics
 */

function handleThrow(world: World, ownerId: string, dx: number, dy: number, dz: number) {
  const player = world.players.get(ownerId);
  if (!player || !isThrowable(player.item) || world.projectiles.size >= MAX_PROJECTILES) {
    return;
  }
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    return;
  }
  if (!tryConsume(world, ownerId, player.item, 1)) {
    return;
  }
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  const speed = throwSpeed(player.item);
  const id = world.nextProjectileId;
  world.nextProjectileId = (world.nextProjectileId + 1) % 65536 || 1;
  world.projectiles.set(id, {
    id,
    item: player.item,
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
            projectileDamage(proj.item),
            proj.vx,
            proj.vz,
            knockback(proj.item),
          );
          if (dropsOnImpact(proj.item)) {
            spawnDrop(world, proj.item, proj.x, proj.y, proj.z);
          }
          alive = false;
          break;
        }
      }
    }
    if (!alive) {
      world.projectiles.delete(proj.id);
    }
  }
}

function handleInput(world: World, event: DatagramEvent) {
  const message = decodeInput(event.bytes);
  if (!message) {
    return;
  }
  world.lastSeen.set(event.connection.id, server.elapsedMs());
  let player = world.players.get(event.connection.id);
  if (!player) {
    // Player was dropped as stale (e.g. backgrounded tab) and is active again.
    addPlayer(world, event.connection);
    player = world.players.get(event.connection.id);
  }
  if (!player) {
    return;
  }
  // Old or duplicated datagrams are ignored; gaps from lost datagrams are
  // fine — the client detects the resulting divergence and rolls back.
  if (message.seq <= player.lastSeq) {
    return;
  }
  if (player.stepsThisTick >= MAX_STEPS_PER_TICK) {
    if (player.inputQueue.length < MAX_QUEUED_INPUTS) {
      player.inputQueue.push(message);
    }
    return;
  }
  applyInput(world, player, message);
}

function applyInput(world: World, player: Player, message: CharInput) {
  player.char = world.step(player.char, message);
  player.heading = message.heading;
  player.lastSeq = message.seq;
  player.stepsThisTick += 1;
}

function drainInputQueue(world: World, player: Player) {
  while (player.inputQueue.length > 0 && player.stepsThisTick < MAX_STEPS_PER_TICK) {
    const message = player.inputQueue.shift();
    if (message && message.seq > player.lastSeq) {
      applyInput(world, player, message);
    }
  }
}

function addPlayer(world: World, connection: Connection) {
  // a reconnect (tab reload) is the same user on a new connection: evict
  // the old body immediately instead of leaving an "echo" until stale-drop
  for (const [otherId, other] of world.players) {
    if (other.userId === connection.userId && otherId !== connection.id) {
      removePlayer(world, otherId);
    }
  }

  world.players.set(connection.id, {
    name: connection.userName,
    userId: connection.userId,
    char: spawnState(),
    heading: 0,
    lastSeq: 0,
    item: 0,
    hp: MAX_HP,
    lastDamageAt: -100000,
    lastAttackAt: -100000,
    protectedUntil: 0,
    stepsThisTick: 0,
    inputQueue: [],
    syncedChunks: new Set(),
    lastChunk: "none",
  });
  world.lastSeen.set(connection.id, server.elapsedMs());
  server.streams.broadcast(
    { type: "join", id: connection.id, name: connection.userName },
    { except: [connection.id] },
  );
}

function removePlayer(world: World, id: string) {
  world.players.delete(id);
  world.lastSeen.delete(id);
  world.inventories.delete(id);
  server.streams.broadcast({ type: "leave", id });
}

function syncConnections(world: World) {
  const connected = new Set<string>();

  for (const connection of server.connections) {
    connected.add(connection.id);
    if (world.lastSeen.has(connection.id)) {
      continue;
    }

    const roster: RosterEntry[] = [];
    for (const [id, player] of world.players) {
      roster.push({ id, name: player.name });
    }
    addPlayer(world, connection);
    connection.streams.send({ type: "welcome", you: connection.id, players: roster });
    sendInventory(world, connection.id);
  }

  for (const id of world.lastSeen.keys()) {
    if (!connected.has(id)) {
      removePlayer(world, id);
    }
  }
}

function dropStalePlayers(world: World) {
  const now = server.elapsedMs();
  for (const [id, seenAt] of world.lastSeen) {
    if (world.players.has(id) && now - seenAt > STALE_MS) {
      // Keep lastSeen so a resumed connection re-adds via handleInput.
      world.players.delete(id);
      server.streams.broadcast({ type: "leave", id });
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
