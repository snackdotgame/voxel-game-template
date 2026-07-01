import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  type MeshLambertMaterial,
  Euler,
  MultiplyBlending,
  NearestFilter,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import { client } from "snack:client";
import { Engine } from "./noa/index.js";
import { disposeObject3D } from "./noa/lib/rendering.js";
import { setupMobileControls } from "./mobile.js";
import {
  type BlockEdit,
  type PlayerSnapshot,
  parseServerStreamMessage,
} from "./shared/messages.js";
import {
  HAIR_BALD,
  HAIR_BUZZ,
  HAIR_COLORS,
  HAIR_LONG,
  HAIR_PONYTAIL,
  HAIR_STYLES,
  PANTS_COLORS,
  SHIRT_COLORS,
  SKIN_TONES,
  appearanceForId,
  isValidAppearance,
  packAppearance,
  unpackAppearance,
  type Appearance,
} from "./shared/appearance.js";
import {
  type ProjectileSnapshot,
  decodeDrops,
  decodeNpcs,
  decodeProjectiles,
  decodeSnapshots,
  encodeInputs,
} from "./shared/netCodec.js";
import {
  ARMOR_BASE,
  ARMOR_SLOTS,
  ARROW,
  AXE,
  BOOTS,
  BOW,
  BOW_DRAW_MS,
  BOW_MIN_CHARGE,
  CHESTPLATE,
  FEATHER,
  HAND,
  HELMET,
  HOTBAR_SLOTS,
  INV_SLOTS,
  LEGGINGS,
  MAX_HP,
  PICKAXE,
  PLANK,
  ROCK,
  SHOVEL,
  SNOWBALL,
  STICK,
  STRING,
  armorPiece,
  blockToItem,
  hitDamage,
  isArmorIndex,
  isThrowable,
  itemName,
  itemToBlock,
  isBlockItem,
  packArmor,
  requiresPickaxe,
  stackLimit,
  unpackArmor,
  type InvSlot,
} from "./shared/items.js";
import { CRAFT_GRID_BASE, craftCellOf, isCraftSlot, matchRecipe } from "./shared/recipes.js";
import {
  type CharInput,
  type CharState,
  SIM_TICK_MS,
  cloneState,
  makeStepper,
  onGround,
  spawnState,
  statesDiverge,
} from "./shared/sim.js";
import { type ChunkState, decodeChunkState } from "./shared/chunkCodec.js";
import {
  COAL_ORE_ID,
  CRAFTING_TABLE_ID,
  DIAMOND_ORE_ID,
  DIRT_ID,
  GOLD_ORE_ID,
  GRASS_ID,
  IRON_ORE_ID,
  LEAVES_ID,
  LOG_ID,
  SAND_ID,
  SNOW_ID,
  STONE_ID,
  WATER_ID,
  baseVoxelID,
  chunkCoord,
  chunkKey,
  editKey,
  makeIsFluid,
  makeIsSolid,
  setWorldSeed,
} from "./shared/terrain.js";

const noa = new Engine({
  debug: false,
  showFPS: false,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
  playerStart: [0.5, 16, 0.5],
  // the targeting ray starts at the camera, which orbits up to 12 blocks
  // behind in third person — cover reach + zoom
  blockTestDistance: 18,
  texturePath: "",
});

/*
 *      Blocks and terrain
 *
 *  Textures are from minetest_game (CC BY-SA 3.0), served out of
 *  assets/textures. See assets/textures/LICENSE-minetest-textures.txt.
 */

const TEX = "/assets/textures";

function texMat(name: string, file: string, texHasAlpha = false): void {
  noa.registry.registerMaterial(name, { textureURL: `${TEX}/${file}`, texHasAlpha });
}

texMat("grass_top", "grass.png");
texMat("grass_side", "grass_side.png");
texMat("dirt", "dirt.png");
texMat("stone", "stone.png");
texMat("sand", "sand.png");
texMat("snow", "snow.png");
texMat("snow_side", "snow_side.png");
texMat("log_side", "tree.png");
texMat("log_top", "tree_top.png");
texMat("leaves", "leaves.png");
texMat("coal_ore", "coal_ore.png");
texMat("iron_ore", "iron_ore.png");
texMat("gold_ore", "gold_ore.png");
texMat("diamond_ore", "diamond_ore.png");
texMat("crafting_table", "crafting_table.png");

noa.registry.registerBlock(GRASS_ID, { material: ["grass_top", "dirt", "grass_side"] });
noa.registry.registerBlock(DIRT_ID, { material: "dirt" });
noa.registry.registerBlock(STONE_ID, { material: "stone" });
noa.registry.registerBlock(SAND_ID, { material: "sand" });
noa.registry.registerBlock(SNOW_ID, { material: ["snow", "dirt", "snow_side"] });
noa.registry.registerBlock(LOG_ID, { material: ["log_top", "log_top", "log_side"] });
noa.registry.registerBlock(LEAVES_ID, { material: "leaves" });
noa.registry.registerBlock(COAL_ORE_ID, { material: "coal_ore" });
noa.registry.registerBlock(IRON_ORE_ID, { material: "iron_ore" });
noa.registry.registerBlock(GOLD_ORE_ID, { material: "gold_ore" });
noa.registry.registerBlock(DIAMOND_ORE_ID, { material: "diamond_ore" });
noa.registry.registerMaterial("water", { color: [0.25, 0.5, 0.95, 0.65] });
noa.registry.registerBlock(WATER_ID, { material: "water", fluid: true, opaque: false });
noa.registry.registerBlock(CRAFTING_TABLE_ID, { material: "crafting_table" });

// Edited-voxel values received from the server, bucketed by chunk column
// and applied on top of the deterministic base terrain whenever a chunk
// (re)generates. The prediction sim collides against the same data via
// makeIsSolid.
const editBuckets = new Map<string, Map<string, BlockEdit>>();

// Optimistic edits, layered over the confirmed state exactly like movement
// prediction: applied to the world instantly, superseded by the server's
// canonical echo for that coordinate, reverted if never confirmed.
const pendingEdits = new Map<string, { edit: BlockEdit; at: number }>();
const PENDING_EDIT_TIMEOUT_MS = 4000;

function editBucket(cx: number, cz: number): Map<string, BlockEdit> {
  const key = chunkKey(cx, cz);
  let bucket = editBuckets.get(key);
  if (!bucket) {
    bucket = new Map();
    editBuckets.set(key, bucket);
  }
  return bucket;
}

function lookupEdit(x: number, y: number, z: number): BlockEdit | undefined {
  const pending = pendingEdits.get(editKey(x, y, z));
  if (pending) {
    return pending.edit;
  }
  return editBuckets.get(chunkKey(chunkCoord(x), chunkCoord(z)))?.get(editKey(x, y, z));
}

function predictEdit(block: number, x: number, y: number, z: number): void {
  pendingEdits.set(editKey(x, y, z), { edit: { block, x, y, z }, at: performance.now() });
  noa.setBlock(block, x, y, z);
}

// revert predictions the server never confirmed (e.g. rejected placements)
setInterval(() => {
  const now = performance.now();
  for (const [key, pending] of pendingEdits) {
    if (now - pending.at > PENDING_EDIT_TIMEOUT_MS) {
      pendingEdits.delete(key);
      const { x, y, z } = pending.edit;
      const confirmed = editBuckets.get(chunkKey(chunkCoord(x), chunkCoord(z)))?.get(key);
      noa.setBlock(confirmed ? confirmed.block : baseVoxelID(x, y, z), x, y, z);
    }
  }
}, 1000);

const isSolid = makeIsSolid(lookupEdit);
const isFluid = makeIsFluid(lookupEdit);
const step = makeStepper(isSolid, isFluid);

type ChunkData = {
  shape: number[];
  set(i: number, j: number, k: number, value: number): void;
};

// Worldgen holds until the server's welcome message delivers the session's
// world seed — a chunk generated before that would bake the wrong terrain.
// Requests queue up here and flush the moment the seed lands.
let worldSeedKnown = false;
let pendingChunks: [string, ChunkData, number, number, number][] = [];

function fillChunk(id: string, data: ChunkData, x: number, y: number, z: number): void {
  for (let i = 0; i < data.shape[0]; i++) {
    for (let j = 0; j < data.shape[1]; j++) {
      for (let k = 0; k < data.shape[2]; k++) {
        data.set(i, j, k, baseVoxelID(x + i, y + j, z + k));
      }
    }
  }
  const bucket = editBuckets.get(chunkKey(chunkCoord(x), chunkCoord(z)));
  if (bucket) {
    for (const edit of bucket.values()) {
      const j = edit.y - y;
      if (j >= 0 && j < data.shape[1]) {
        data.set(edit.x - x, j, edit.z - z, edit.block);
      }
    }
  }
  for (const { edit } of pendingEdits.values()) {
    const j = edit.y - y;
    if (
      chunkCoord(edit.x) === chunkCoord(x) &&
      chunkCoord(edit.z) === chunkCoord(z) &&
      j >= 0 &&
      j < data.shape[1]
    ) {
      data.set(edit.x - x, j, edit.z - z, edit.block);
    }
  }
  noa.world.setChunkData(id, data);
}

function applyWorldSeed(seed: number): void {
  if (worldSeedKnown) {
    return;
  }
  worldSeedKnown = true;
  setWorldSeed(seed);
  const queued = pendingChunks;
  pendingChunks = [];
  for (const [id, data, x, y, z] of queued) {
    fillChunk(id, data, x, y, z);
  }
}

noa.world.on("worldDataNeeded", (id: string, data: ChunkData, x: number, y: number, z: number) => {
  if (!worldSeedKnown) {
    pendingChunks.push([id, data, x, y, z]);
    return;
  }
  fillChunk(id, data, x, y, z);
});

function applyEdit(edit: BlockEdit) {
  editBucket(chunkCoord(edit.x), chunkCoord(edit.z)).set(editKey(edit.x, edit.y, edit.z), edit);
  // the authoritative timeline has reached this coordinate; any local
  // prediction for it is superseded (our own echo arrives in order too)
  pendingEdits.delete(editKey(edit.x, edit.y, edit.z));
  // the block changed, so any breaking overlay on it is stale
  clearBlockDamage(editKey(edit.x, edit.y, edit.z));
  const previous = noa.getBlock(edit.x, edit.y, edit.z);
  if (edit.block === 0 && previous !== 0) {
    // breaking: the old block's voice, weightier than a dig tick
    playSoundAt(blockSoundFamily(previous, "dig"), edit.x, edit.y, edit.z, 1, 0.8);
  } else if (edit.block !== 0) {
    playSoundAt("impactSoft_heavy", edit.x, edit.y, edit.z, 0.8, 1.15);
  }
  noa.setBlock(edit.block, edit.x, edit.y, edit.z);
}

// A chunk-state packet carries the chunk's full current overrides, so the
// first (non-append) packet replaces whatever we had for that chunk.
function applyChunkState(state: ChunkState) {
  const bucket = editBucket(state.cx, state.cz);
  if (!state.append) {
    bucket.clear();
  }
  for (const edit of state.edits) {
    bucket.set(editKey(edit.x, edit.y, edit.z), edit);
    noa.setBlock(edit.block, edit.x, edit.y, edit.z);
  }
  // chunk state is a snapshot, not the live ordered stream — keep local
  // predictions in this chunk layered on top until their echo arrives
  for (const { edit } of pendingEdits.values()) {
    if (chunkCoord(edit.x) === state.cx && chunkCoord(edit.z) === state.cz) {
      noa.setBlock(edit.block, edit.x, edit.y, edit.z);
    }
  }
}

/*
 *      Block damage "breaking" overlay
 *
 *  Minecraft shows destroy_stage_0..9 crack textures over a block as it
 *  takes damage, picked by breaking progress, drawn with a multiplicative
 *  blend (neutral gray leaves the block unchanged, dark texels darken).
 *  Our texture pack ships no crack stages, so they're generated
 *  procedurally: a fixed set of seeded random-walk fractures, drawn
 *  cumulatively so every extra hit adds cracks. White is the neutral
 *  color under three's MultiplyBlending.
 */

const CRACK_STAGES = 8;

// deterministic LCG so every client draws identical fractures
function makeCrackMaterials(): MeshBasicMaterial[] {
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  // precompute one fracture path per stage; stage N renders paths 0..N
  const paths: [number, number][][] = [];
  for (let i = 0; i < CRACK_STAGES; i++) {
    const path: [number, number][] = [];
    let x = 3 + Math.floor(rand() * 10);
    let y = 3 + Math.floor(rand() * 10);
    const steps = 8 + Math.floor(rand() * 8);
    for (let s = 0; s < steps; s++) {
      path.push([x & 15, y & 15]);
      // bias the walk outward from where it started so cracks spread
      x += rand() < 0.5 ? 1 : -1;
      if (rand() < 0.7) y += rand() < 0.5 ? 1 : -1;
    }
    paths.push(path);
  }
  const materials: MeshBasicMaterial[] = [];
  for (let stage = 0; stage < CRACK_STAGES; stage++) {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff"; // neutral under multiply
    ctx.fillRect(0, 0, 16, 16);
    for (let i = 0; i <= stage; i++) {
      for (const [px, py] of paths[i]) {
        ctx.fillStyle = (px + py) % 2 === 0 ? "#3c3c3c" : "#6e6e6e";
        ctx.fillRect(px, py, 1, 1);
      }
    }
    const texture = new CanvasTexture(canvas);
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    const material = new MeshBasicMaterial({
      map: texture,
      blending: MultiplyBlending,
      // required by three for MultiplyBlending; with opaque texels the
      // blend is then exactly dst * src (white = neutral)
      premultipliedAlpha: true,
      transparent: true,
      depthWrite: false,
    });
    material.userData.shared = true;
    materials.push(material);
  }
  return materials;
}

const crackMaterials = makeCrackMaterials();
// slightly inflated so the overlay sits in front of the block's faces
const crackGeometry = new BoxGeometry(1.01, 1.01, 1.01);

type DamageView = { mesh: Mesh; lastHitAt: number };
const blockDamageViews = new Map<string, DamageView>();
// matches the server's heal-after-10s; overlays on healed blocks fade out
const BLOCK_DAMAGE_TTL_MS = 10_000;

function updateBlockDamage(x: number, y: number, z: number, hp: number, maxHp: number): void {
  const key = editKey(x, y, z);
  if (hp <= 0 || hp >= maxHp) {
    clearBlockDamage(key);
    return;
  }
  const stage = Math.min(CRACK_STAGES - 1, Math.floor((1 - hp / maxHp) * CRACK_STAGES));
  let view = blockDamageViews.get(key);
  if (!view) {
    const mesh = new Mesh(crackGeometry, crackMaterials[stage]);
    mesh.name = `crack-${key}`;
    noa.rendering.addMeshToScene(mesh, false, [x + 0.5, y + 0.5, z + 0.5]);
    view = { mesh, lastHitAt: 0 };
    blockDamageViews.set(key, view);
  } else {
    view.mesh.material = crackMaterials[stage];
  }
  // reposition every update: cheap, and keeps the overlay correct if the
  // world origin rebased since the mesh was created
  const lpos = noa.globalToLocal([x + 0.5, y + 0.5, z + 0.5], null, []);
  view.mesh.position.set(lpos[0], lpos[1], -lpos[2]);
  view.lastHitAt = performance.now();
}

function clearBlockDamage(key: string): void {
  const view = blockDamageViews.get(key);
  if (view) {
    view.mesh.removeFromParent();
    blockDamageViews.delete(key);
  }
}

setInterval(() => {
  const now = performance.now();
  for (const [key, view] of blockDamageViews) {
    if (now - view.lastHitAt > BLOCK_DAMAGE_TTL_MS) {
      clearBlockDamage(key);
    }
  }
}, 1000);

/*
 *      Sounds
 *
 *  Kenney "Impact Sounds" (CC0 — assets/sounds/LICENSE-kenney-impact-
 *  sounds.txt), played through WebAudio with a random variant and a
 *  little pitch jitter per play, Minecraft-style. World-positioned
 *  events attenuate with distance from the player. The context can
 *  only start on a user gesture, so everything no-ops until the first
 *  click/keypress.
 */

const kenneyVariants = (family: string) =>
  Array.from({ length: 5 }, (_, i) => `/assets/sounds/${family}_00${i}.ogg`);

const SOUND_FILES: Record<string, string[]> = {
  impactMining: kenneyVariants("impactMining"),
  impactSoft_medium: kenneyVariants("impactSoft_medium"),
  impactSoft_heavy: kenneyVariants("impactSoft_heavy"),
  impactWood_medium: kenneyVariants("impactWood_medium"),
  footstep_grass: kenneyVariants("footstep_grass"),
  footstep_concrete: kenneyVariants("footstep_concrete"),
  footstep_snow: kenneyVariants("footstep_snow"),
  impactPunch_medium: kenneyVariants("impactPunch_medium"),
  // entering water: big Baradari splashes; leaving: a short light plunge
  splash_big: ["/assets/sounds/splash_big_000.wav", "/assets/sounds/splash_big_001.wav"],
  splash_small: ["/assets/sounds/splash_small_000.ogg"],
};

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
const soundBuffers = new Map<string, AudioBuffer[]>();
let soundsPlayed = 0;
// ring log of recently played families, for tests/debugging
const soundLog: string[] = [];

function logSound(tag: string): void {
  soundsPlayed += 1;
  soundLog.push(tag);
  if (soundLog.length > 30) {
    soundLog.shift();
  }
}

function initAudio(): void {
  if (audioCtx) {
    void audioCtx.resume();
    return;
  }
  audioCtx = new AudioContext();
  void audioCtx.resume();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.6;
  masterGain.connect(audioCtx.destination);
  for (const [family, urls] of Object.entries(SOUND_FILES)) {
    const buffers: AudioBuffer[] = [];
    soundBuffers.set(family, buffers);
    for (const url of urls) {
      void fetch(url)
        .then((response) => response.arrayBuffer())
        .then((bytes) => audioCtx!.decodeAudioData(bytes))
        .then((buffer) => {
          buffers.push(buffer);
        })
        .catch(() => {});
    }
  }
}
document.addEventListener("pointerdown", initAudio);
document.addEventListener("keydown", initAudio);

function playSound(family: string, volume = 1, pitch = 1): void {
  if (!audioCtx || !masterGain) {
    return;
  }
  const buffers = soundBuffers.get(family);
  if (!buffers || buffers.length === 0) {
    return;
  }
  const source = audioCtx.createBufferSource();
  source.buffer = buffers[Math.floor(Math.random() * buffers.length)];
  source.playbackRate.value = pitch * (0.92 + Math.random() * 0.16);
  const gain = audioCtx.createGain();
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(masterGain);
  source.start();
  logSound(family);
}

// volume falls off linearly to silence at 24 blocks from the player
function playSoundAt(family: string, x: number, y: number, z: number, volume = 1, pitch = 1): void {
  const dist = Math.hypot(x - predicted.x, y - predicted.y, z - predicted.z);
  const attenuated = volume * Math.max(0, 1 - dist / 24);
  if (attenuated > 0.02) {
    playSound(family, attenuated, pitch);
  }
}

// Minecraft-style pickup "pop": a short sine blip swept upward, with a
// randomized base pitch per play (no sample in the pack reads as pickup)
function playPop(volume = 0.5): void {
  if (!audioCtx || !masterGain) {
    return;
  }
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  const base = 320 + Math.random() * 160;
  osc.frequency.setValueAtTime(base, t);
  osc.frequency.exponentialRampToValueAtTime(base * 2.2, t + 0.09);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.13);
  logSound("pop");
}

// real splash recordings (see assets/sounds/LICENSE-water-splash.txt):
// a big plunge entering the water, a short light one leaving it
function playSplash(volume = 0.7, entering = true): void {
  if (volume < 0.03) {
    return;
  }
  playSound(entering ? "splash_big" : "splash_small", volume, 0.9 + Math.random() * 0.2);
}

// short synthesized whoosh for swings and throws (no CC0 sample fit)
function playWhoosh(volume = 0.35): void {
  if (!audioCtx || !masterGain) {
    return;
  }
  const dur = 0.18;
  const buffer = audioCtx.createBuffer(
    1,
    Math.ceil(audioCtx.sampleRate * dur),
    audioCtx.sampleRate,
  );
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(400, audioCtx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(1600, audioCtx.currentTime + dur);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(volume, audioCtx.currentTime + 0.04);
  gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + dur);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  source.start();
  logSound("whoosh");
}

// short synthesized bow "twang": a plucked tone that drops in pitch fast
function playBowShot(volume = 0.4): void {
  if (!audioCtx || !masterGain) {
    return;
  }
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(440, t);
  osc.frequency.exponentialRampToValueAtTime(150, t + 0.12);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.18);
  logSound("bow");
}

// which sample family a block speaks with, per interaction
function blockSoundFamily(block: number, kind: "dig" | "step"): string {
  if (block === STONE_ID || block >= COAL_ORE_ID) {
    return kind === "dig" ? "impactMining" : "footstep_concrete";
  }
  if (block === LOG_ID) {
    return kind === "dig" ? "impactWood_medium" : "footstep_concrete";
  }
  if (block === LEAVES_ID) {
    return "footstep_grass";
  }
  if (block === SNOW_ID || block === SAND_ID) {
    return kind === "dig" ? "impactSoft_medium" : "footstep_snow";
  }
  return kind === "dig" ? "impactSoft_medium" : "footstep_grass";
}

/*
 *      Minecraft-style voxel character rig
 *
 *  Box body parts hung off pivot nodes so limbs swing from the
 *  shoulder/hip, textured with a classic-format 64x32 character skin
 *  (minetest_game's "Sam", CC BY-SA 3.0). Remote players get a
 *  deterministic hue shift on the clothing rows. The rig root sits at
 *  the entity's bottom-center, facing +z at yaw 0.
 */

// widen the default ~46° vertical FOV; it reads badly zoomed-in up close
// (1.25 radians; three.js wants degrees)
noa.rendering.camera.fov = 1.25 * (180 / Math.PI);
noa.rendering.camera.updateProjectionMatrix();

const SKIN_PX = 0.05625; // world units per skin pixel: 32px of parts -> 1.8 blocks

type Rig = {
  root: Group;
  head: Group;
  leftArm: Group;
  rightArm: Group;
  leftLeg: Group;
  rightLeg: Group;
  body: Group;
  phase: number;
  idleT: number;
  tool: Group | null;
  skin: MeshLambertMaterial;
  // what the skin texture currently shows (kept for repaints and to detect
  // body changes, which need a geometry rebuild)
  look: number;
  armor: number;
};

// Box UV origins (u, v, w, h, d in pixels from top-left) in the classic
// 64x32 skin layout, applied with the standard MC box unwrap below.
const HEAD_UV: [number, number, number, number, number] = [0, 0, 8, 8, 8];
const BODY_UV: [number, number, number, number, number] = [16, 16, 8, 12, 4];
const ARM_UV: [number, number, number, number, number] = [40, 16, 4, 12, 4];
const LEG_UV: [number, number, number, number, number] = [0, 16, 4, 12, 4];

// Standard Minecraft box-skin unwrap onto a three BoxGeometry, ported
// verbatim from skinview3d (MIT, bs-community/skinview3d src/model.ts);
// the rig uses skinview3d's conventions throughout (character faces
// local +z, right arm on -x), so its UV order applies directly.
function setBoxUVs(
  box: BoxGeometry,
  [u, v, width, height, depth]: [number, number, number, number, number],
): void {
  const textureWidth = 64;
  const textureHeight = 32;
  const toFaceVertices = (x1: number, y1: number, x2: number, y2: number) =>
    [
      [x1 / textureWidth, 1 - y2 / textureHeight],
      [x2 / textureWidth, 1 - y2 / textureHeight],
      [x2 / textureWidth, 1 - y1 / textureHeight],
      [x1 / textureWidth, 1 - y1 / textureHeight],
    ] as const;

  const top = toFaceVertices(u + depth, v, u + width + depth, v + depth);
  const bottom = toFaceVertices(u + width + depth, v, u + width * 2 + depth, v + depth);
  const left = toFaceVertices(u, v + depth, u + depth, v + depth + height);
  const front = toFaceVertices(u + depth, v + depth, u + width + depth, v + depth + height);
  const right = toFaceVertices(
    u + width + depth,
    v + depth,
    u + width + depth * 2,
    v + height + depth,
  );
  const back = toFaceVertices(
    u + width + depth * 2,
    v + depth,
    u + width * 2 + depth * 2,
    v + height + depth,
  );

  const uvData: number[] = [];
  const push = (arr: readonly (readonly [number, number])[]) => {
    for (const [x, y] of arr) {
      uvData.push(x, y);
    }
  };
  push([right[3], right[2], right[0], right[1]]);
  push([left[3], left[2], left[0], left[1]]);
  push([top[3], top[2], top[0], top[1]]);
  push([bottom[0], bottom[1], bottom[3], bottom[2]]);
  push([front[3], front[2], front[0], front[1]]);
  push([back[3], back[2], back[0], back[1]]);
  box.attributes.uv.array.set(uvData);
  box.attributes.uv.needsUpdate = true;
}

/*
 *      Procedural character painting
 *
 *  No skin PNGs: the classic 64x32 texture is painted at runtime from a
 *  packed appearance (body, skin tone, hair style/color — see
 *  shared/appearance.ts) plus the player's equipped armor. Regions below
 *  follow the classic-format unwrap that setBoxUVs applies.
 */

// shirt/pants colors come from the shared appearance palettes; armor draws
// over the outfit
const SHOES = "#3b2f25";
const IRON = "#ccd3d9";
const IRON_DARK = "#8b939c";
const EYES = "#47617f";

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 0xff)}, ${ch(n & 0xff)})`;
}

function paintCharacter(ctx: CanvasRenderingContext2D, look: number, armor: number): void {
  const a = unpackAppearance(look);
  const tone = SKIN_TONES[a.tone] ?? SKIN_TONES[0];
  const hair = HAIR_COLORS[a.hairColor] ?? HAIR_COLORS[0];
  const shirt = SHIRT_COLORS[a.shirt] ?? SHIRT_COLORS[0];
  const pants = PANTS_COLORS[a.pants] ?? PANTS_COLORS[0];
  const fill = (color: string, x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  ctx.clearRect(0, 0, 64, 32);

  // bare skin everywhere first: head block region, then legs/torso/arms
  fill(tone, 0, 0, 32, 16);
  fill(tone, 0, 16, 56, 16);

  // face, on the head's front (8,8)-(16,16): brows, eyes (white outer,
  // iris inner), a nose shadow, and a mouth line
  fill(shade(hair, 0.9), 9, 10, 2, 1);
  fill(shade(hair, 0.9), 13, 10, 2, 1);
  fill("#ffffff", 9, 12, 1, 1);
  fill(EYES, 10, 12, 1, 1);
  fill(EYES, 13, 12, 1, 1);
  fill("#ffffff", 14, 12, 1, 1);
  fill(shade(tone, 0.88), 11, 13, 2, 1);
  fill(shade(tone, 0.76), 11, 14, 2, 1);

  // shirt: all torso faces + shoulder tops of the arms as short sleeves
  fill(shirt, 16, 20, 24, 12);
  fill(shirt, 20, 16, 16, 4);
  fill(shade(shirt, 0.85), 16, 31, 24, 1);
  fill(shirt, 40, 20, 16, 5);
  fill(shirt, 44, 16, 4, 4);

  // pants + shoes on the legs (soles use the leg bottom face)
  fill(pants, 0, 20, 16, 9);
  fill(pants, 4, 16, 4, 4);
  fill(SHOES, 0, 29, 16, 3);
  fill(SHOES, 8, 16, 4, 4);

  // hair: crown for every style, then per-style sides/back/length
  if (a.hair !== HAIR_BALD) {
    fill(hair, 8, 0, 8, 8);
  }
  if (a.hair === HAIR_BUZZ) {
    fill(hair, 0, 8, 32, 1);
  } else if (a.hair !== HAIR_BALD) {
    fill(hair, 0, 8, 32, 2);
    fill(hair, 24, 10, 8, 2);
  }
  if (a.hair === HAIR_LONG) {
    // full back of the head, deep sides, and over the shoulders
    fill(hair, 0, 10, 8, 4);
    fill(hair, 16, 10, 8, 4);
    fill(hair, 24, 8, 8, 8);
    fill(hair, 32, 20, 8, 4);
    fill(shade(hair, 0.8), 32, 23, 8, 1);
  } else if (a.hair === HAIR_PONYTAIL) {
    // a tied tail down the center of the head and upper back
    fill(hair, 27, 10, 2, 6);
    fill(hair, 35, 20, 2, 5);
    fill(shade(hair, 0.8), 35, 24, 2, 1);
  }

  // armor overlays, head to toe
  const pieces = unpackArmor(armor);
  if (pieces[0]) {
    // helmet: crown + a brow band all around, deeper over sides and back
    fill(IRON, 8, 0, 8, 8);
    fill(IRON, 0, 8, 32, 2);
    fill(IRON_DARK, 8, 9, 8, 1);
    fill(IRON, 0, 10, 8, 2);
    fill(IRON, 16, 10, 8, 2);
    fill(IRON, 24, 10, 8, 2);
    fill(IRON_DARK, 0, 11, 8, 1);
    fill(IRON_DARK, 16, 11, 8, 1);
    fill(IRON_DARK, 24, 11, 8, 1);
  }
  if (pieces[1]) {
    // chestplate: full torso + pauldrons over the sleeves
    fill(IRON, 16, 20, 24, 12);
    fill(IRON, 20, 16, 16, 4);
    fill(IRON_DARK, 16, 28, 24, 1);
    fill(IRON_DARK, 23, 20, 2, 1);
    fill(IRON, 40, 20, 16, 4);
    fill(IRON, 44, 16, 4, 4);
    fill(IRON_DARK, 40, 23, 16, 1);
  }
  if (pieces[2]) {
    // leggings: upper legs, under the boot line
    fill(IRON, 0, 20, 16, 7);
    fill(IRON, 4, 16, 4, 4);
    fill(IRON_DARK, 0, 26, 16, 1);
  }
  if (pieces[3]) {
    // boots: lower legs + soles
    fill(IRON_DARK, 0, 28, 16, 1);
    fill(IRON, 0, 29, 16, 3);
    fill(IRON_DARK, 8, 16, 4, 4);
  }
}

// The last confirmed look, remembered per-device. Declared here, above the
// self rig's module-scope build, because storedLook() runs during module
// evaluation (a later declaration would be a temporal-dead-zone crash).
const LOOK_STORAGE_KEY = "voxels.look";
const DEFAULT_LOOK = packAppearance({ tone: 2, hair: 2, hairColor: 1, shirt: 0, pants: 0 });

function storedLook(): number {
  try {
    const raw = localStorage.getItem(LOOK_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return isValidAppearance(parsed) ? parsed : DEFAULT_LOOK;
  } catch {
    return DEFAULT_LOOK;
  }
}

function makeSkinMaterial(name: string): MeshLambertMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 32;
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  const material = noa.rendering.makeStandardMaterial(name);
  material.map = texture;
  return material;
}

// Repaint a rig's skin texture for a new appearance and/or armor set.
function dressRig(rig: Rig, look: number, armor: number): void {
  rig.look = look;
  rig.armor = armor;
  const texture = rig.skin.map;
  if (texture instanceof CanvasTexture) {
    paintCharacter((texture.image as HTMLCanvasElement).getContext("2d")!, look, armor);
    texture.needsUpdate = true;
  }
}

function buildRig(name: string, look: number, armor = 0): Rig {
  console.debug(`[rig] build ${name} look=${look} armor=${armor}`);
  const root = new Group();
  root.name = `${name}-root`;
  const body = new Group();
  body.name = `${name}-body`;
  root.add(body);
  const material = makeSkinMaterial(name);

  const box = (
    part: string,
    pxW: number,
    pxH: number,
    pxD: number,
    uv: [number, number, number, number, number],
    parent: Group,
    yInParent: number,
  ) => {
    const geometry = new BoxGeometry(pxW * SKIN_PX, pxH * SKIN_PX, pxD * SKIN_PX);
    setBoxUVs(geometry, uv);
    const mesh = new Mesh(geometry, material);
    mesh.name = `${name}-${part}`;
    parent.add(mesh);
    mesh.position.y = yInParent;
    return mesh;
  };

  // proportions: 12px legs + 12px torso + 8px head = 32px -> 1.8 blocks
  box("torso", 8, 12, 4, BODY_UV, body, 1.0125);
  // the head rotates about the neck, so its mesh hangs off a pivot group
  const head = new Group();
  head.name = `${name}-head-pivot`;
  body.add(head);
  head.position.y = 1.35;
  box("head", 8, 8, 8, HEAD_UV, head, 0.225);

  const limb = (
    part: string,
    uv: [number, number, number, number, number],
    pivotY: number,
    xOff: number,
  ) => {
    const pivot = new Group();
    pivot.name = `${name}-${part}-pivot`;
    body.add(pivot);
    pivot.position.set(xOff, pivotY, 0);
    box(part, 4, 12, 4, uv, pivot, -0.3375);
    return pivot;
  };

  // limb sides follow skinview3d: the character faces local +z and its
  // right arm hangs at negative x (the mirror of the old Babylon rig)
  const rig: Rig = {
    root,
    head,
    body,
    leftArm: limb("left-arm", ARM_UV, 1.305, 0.3375),
    rightArm: limb("right-arm", ARM_UV, 1.305, -0.3375),
    leftLeg: limb("left-leg", LEG_UV, 0.675, 0.1125),
    rightLeg: limb("right-leg", LEG_UV, 0.675, -0.1125),
    phase: 0,
    idleT: 0,
    tool: null,
    skin: material,
    look,
    armor,
  };
  dressRig(rig, look, armor);
  return rig;
}

// Animation math based on skinview3d (MIT, bs-community/skinview3d
// src/animation.ts) and minecraft-web-client (MIT, zardoy/minecraft-web-client
// renderer/viewer/three/entity/animations.js), with walk/run amplitudes
// toned down from the references. Sign convention verified: negative
// rotation.x swings a limb forward in our rig, matching theirs.
// between vanilla walk (4.317) and sprint (5.612) ground speeds
const RUN_SPEED_THRESHOLD = 5;

function animateRig(rig: Rig, speed: number, grounded: boolean, dtSec: number, swinging = false) {
  rig.idleT += dtSec;
  const moving = grounded && speed > 0.4;
  const running = moving && speed > RUN_SPEED_THRESHOLD;
  if (moving) {
    rig.phase += dtSec * (running ? 10 : 8);
  }
  const t = rig.phase;
  const PI = Math.PI;

  let lLegX = 0;
  let rLegX = 0;
  let lArmX = 0;
  let rArmX = 0;
  let lArmZ = 0;
  let rArmZ = 0;
  let headY = 0;
  let headX = 0;
  let bodyBob = 0;

  if (!grounded) {
    // airborne: legs scissor slightly, arms trail up
    lLegX = 0.35;
    rLegX = -0.35;
    lArmX = -0.55;
    rArmX = -0.55;
  } else if (running) {
    // RunningAnimation / WalkingGeneralSwing isRunning branch, with the
    // amplitudes toned well down from the reference's windmilling
    lLegX = Math.cos(t + PI) * 0.75;
    rLegX = Math.cos(t) * 0.75;
    lArmX = Math.cos(t) * 0.65;
    rArmX = Math.cos(t + PI) * 0.65;
    lArmZ = Math.cos(t) * 0.05 + PI * 0.04;
    rArmZ = Math.cos(t + PI) * 0.05 - PI * 0.04;
    bodyBob = Math.abs(Math.cos(t)) * 0.04;
  } else if (moving) {
    // WalkingAnimation, amplitudes toned down
    lLegX = Math.sin(t) * 0.35;
    rLegX = Math.sin(t + PI) * 0.35;
    lArmX = Math.sin(t + PI) * 0.28;
    rArmX = Math.sin(t) * 0.28;
    lArmZ = Math.cos(t) * 0.02 + PI * 0.012;
    rArmZ = Math.cos(t + PI) * 0.02 - PI * 0.012;
    headY = Math.sin(t / 4) * 0.08;
    headX = Math.sin(t / 5) * 0.04;
    bodyBob = Math.abs(Math.cos(t)) * 0.025;
  } else {
    // IdleAnimation: subtle arm breathe
    const it = rig.idleT * 2;
    lArmZ = Math.cos(it) * 0.03 + PI * 0.02;
    rArmZ = Math.cos(it + PI) * 0.03 - PI * 0.02;
  }

  // direct assignment like the references, with a short blend so
  // walk<->idle transitions don't pop
  const blend = 1 - Math.exp(-dtSec * 24);
  const ease = (node: Object3D, x: number, z: number) => {
    node.rotation.x += (x - node.rotation.x) * blend;
    node.rotation.z += (z - node.rotation.z) * blend;
  };
  ease(rig.leftLeg, lLegX, 0);
  ease(rig.rightLeg, rLegX, 0);
  ease(rig.leftArm, lArmX, lArmZ);
  if (!swinging) {
    ease(rig.rightArm, rArmX, rArmZ);
    rig.body.rotation.y += (0 - rig.body.rotation.y) * blend;
  }
  rig.head.rotation.y += (headY - rig.head.rotation.y) * blend;
  rig.head.rotation.x += (headX - rig.head.rotation.x) * blend;
  rig.body.position.y = bodyBob;
}

// HitAnimation from minecraft-web-client, verbatim: the swing arm pose
// REPLACES the walk pose for the right arm (t runs 0..2pi over one swing,
// which chains into a continuous cycle while hold-mining).
function applySwingToRig(rig: Rig, swingT: number, moving: boolean) {
  const t = (1 - swingT) * Math.PI * 2;
  rig.rightArm.rotation.x = -0.4537860552 * 2 + 2 * Math.sin(t + Math.PI) * 0.3;
  if (!moving) {
    rig.rightArm.rotation.z = -Math.cos(t) * 0.403 + 0.01 * Math.PI + 0.06;
    rig.body.rotation.y = -Math.cos(t) * 0.06;
    rig.leftArm.rotation.x += Math.sin(t + Math.PI) * 0.077;
  }
}

// Third-person bow pose, ported from Minecraft's HumanoidModel ArmPose
// BOW_AND_ARROW: both arms reach forward to hold the drawn bow (xRot = -90°),
// with a yaw split so the bow hand points straight out and the string hand
// angles in to the nock. `pitch` tilts the aim up/down with the look. Blended
// in by the draw fraction so it eases as you charge and reverses as you loose;
// applied after the walk/idle pose, which it overrides for the arms.
function applyBowDrawToRig(rig: Rig, draw: number, pitch: number): void {
  const fwd = -Math.PI / 2 + pitch;
  rig.rightArm.rotation.x += (fwd - rig.rightArm.rotation.x) * draw;
  rig.rightArm.rotation.y += (-0.1 - rig.rightArm.rotation.y) * draw;
  rig.rightArm.rotation.z += (0 - rig.rightArm.rotation.z) * draw;
  rig.leftArm.rotation.x += (fwd - rig.leftArm.rotation.x) * draw;
  rig.leftArm.rotation.y += (0.5 - rig.leftArm.rotation.y) * draw;
  rig.leftArm.rotation.z += (0 - rig.leftArm.rotation.z) * draw;
  // The bow rides the right arm, so the forward draw pose would flop it onto its
  // side. Cancel the arm's rotation and hold the bow upright, pitched to the
  // look angle — its body-frame yaw already matches where the player aims, so
  // the bow points where the arrow goes. (Minecraft keeps the bow oriented via
  // the item's display transform; this is the equivalent for a hand-parented mesh.)
  if (rig.tool) {
    // Hold the bow in the orientation it already has at rest — just keep it
    // upright by cancelling the draw arm's rotation. No extra spin: the rest
    // hold is already correct, so flipping here would turn the bow the wrong way.
    bowAimEuler.set(0, 0, 0);
    bowAimQuat.setFromEuler(bowAimEuler);
    rig.tool.quaternion.copy(rig.rightArm.quaternion).invert().multiply(bowAimQuat);
  }
}

/*
 *      3D items from pixel art (the way Minecraft renders held items)
 *
 *  Any pixel-art image becomes an item mesh: every opaque pixel is
 *  extruded one pixel deep — front and back faces everywhere, side
 *  walls only at silhouette boundaries — with the pixel colors baked
 *  into vertex colors (walls slightly darkened so edges read in 3D).
 *  Drop a PNG of any size into assets/items and register it below.
 */

type ItemSpriteConfig = {
  url: string;
  /** world-space size of the sprite's larger image dimension */
  size: number;
  /** pixel coords (x right, y down) of the grip — becomes the mesh origin */
  grip?: [number, number];
  /** rotate so the sprite's up-right diagonal becomes vertical (for
   *  tools drawn diagonally but held by a vertical handle) */
  diagonal?: boolean;
  /** spin the extruded mesh 180° about the (vertical) handle axis, for art
   *  whose business end would otherwise face the holder */
  aboutFace?: boolean;
};

const ITEM_SPRITES: Record<number, ItemSpriteConfig> = {
  // tool art has the business edge on the art-left side, which the extrusion
  // maps to the character's forward — so no aboutFace on any of these (the
  // first-person view model spins tools 180° itself; see refreshViewModel)
  [PICKAXE]: { url: "/assets/items/pickaxe.png", size: 0.85, grip: [3.5, 12.5], diagonal: true },
  [AXE]: { url: "/assets/items/axe.png", size: 0.85, grip: [3.5, 12.5], diagonal: true },
  [SHOVEL]: { url: "/assets/items/shovel.png", size: 0.85, grip: [3.5, 12.5], diagonal: true },
  [ROCK]: { url: "/assets/items/rock.png", size: 0.34 },
  [SNOWBALL]: { url: "/assets/items/snowball.png", size: 0.3 },
  [PLANK]: { url: "/assets/items/plank.png", size: 0.42 },
  [STICK]: { url: "/assets/items/stick.png", size: 0.6, grip: [4, 12], diagonal: true },
  // held upright by the riser; not diagonal
  [BOW]: { url: "/assets/items/bow.png", size: 0.95, grip: [3, 8] },
  // arrow stays upright (head at +y); it's oriented along its velocity in flight
  [ARROW]: { url: "/assets/items/arrow.png", size: 0.7, grip: [7, 8] },
  [FEATHER]: { url: "/assets/items/feather.png", size: 0.4 },
  [STRING]: { url: "/assets/items/string.png", size: 0.36 },
  [HELMET]: { url: "/assets/items/helmet.png", size: 0.45 },
  [CHESTPLATE]: { url: "/assets/items/chestplate.png", size: 0.5 },
  [LEGGINGS]: { url: "/assets/items/leggings.png", size: 0.5 },
  [BOOTS]: { url: "/assets/items/boots.png", size: 0.45 },
};

function loadImageData(url: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = () => reject(new Error(`failed to load item sprite ${url}`));
    img.src = url;
  });
}

// Build the extruded geometry. Art x maps to local -z and art y (up) to
// local +y, so the sprite lies in the character's fore-aft (swing) plane
// with its thickness sideways; `diagonal` then rolls the up-right
// diagonal onto +y so handle-based hold transforms apply unchanged.
function extrudePixelArt(img: ImageData, config: ItemSpriteConfig): BufferGeometry {
  const w = img.width;
  const h = img.height;
  const px = config.size / Math.max(w, h);
  const depth = px;
  const [gripX, gripY] = config.grip ?? [w / 2, h / 2];

  const opaque = (c: number, r: number) =>
    c >= 0 && c < w && r >= 0 && r < h && img.data[(r * w + c) * 4 + 3] >= 128;
  const colorOf = (c: number, r: number) => {
    const o = (r * w + c) * 4;
    return [img.data[o] / 255, img.data[o + 1] / 255, img.data[o + 2] / 255] as const;
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // art-pixel corner -> local point (y up, art-x toward -z)
  const X = depth / 2;
  const zAt = (c: number) => -(c - gripX) * px;
  const yAt = (r: number) => (gripY - r) * px;

  type Vec = [number, number, number];
  const pushQuad = (corners: Vec[], normal: Vec, rgb: readonly number[], shade: number) => {
    const base = positions.length / 3;
    for (const [vx, vy, vz] of corners) {
      positions.push(vx, vy, vz);
      normals.push(normal[0], normal[1], normal[2]);
      colors.push(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!opaque(c, r)) {
        continue;
      }
      const rgb = colorOf(c, r);
      const z0 = zAt(c); // art-left edge (larger z)
      const z1 = zAt(c + 1);
      const y0 = yAt(r + 1); // bottom
      const y1 = yAt(r); // top
      // front (+x) and back (-x) faces, CCW seen from outside
      pushQuad(
        [
          [X, y0, z0],
          [X, y0, z1],
          [X, y1, z1],
          [X, y1, z0],
        ],
        [1, 0, 0],
        rgb,
        1,
      );
      pushQuad(
        [
          [-X, y0, z1],
          [-X, y0, z0],
          [-X, y1, z0],
          [-X, y1, z1],
        ],
        [-1, 0, 0],
        rgb,
        1,
      );
      // boundary walls, darkened so the extrusion reads
      if (!opaque(c, r - 1)) {
        pushQuad(
          [
            [-X, y1, z0],
            [X, y1, z0],
            [X, y1, z1],
            [-X, y1, z1],
          ],
          [0, 1, 0],
          rgb,
          0.9,
        );
      }
      if (!opaque(c, r + 1)) {
        pushQuad(
          [
            [-X, y0, z1],
            [X, y0, z1],
            [X, y0, z0],
            [-X, y0, z0],
          ],
          [0, -1, 0],
          rgb,
          0.6,
        );
      }
      if (!opaque(c - 1, r)) {
        pushQuad(
          [
            [-X, y0, z0],
            [X, y0, z0],
            [X, y1, z0],
            [-X, y1, z0],
          ],
          [0, 0, 1],
          rgb,
          0.75,
        );
      }
      if (!opaque(c + 1, r)) {
        pushQuad(
          [
            [X, y0, z1],
            [-X, y0, z1],
            [-X, y1, z1],
            [X, y1, z1],
          ],
          [0, 0, -1],
          rgb,
          0.75,
        );
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  if (config.diagonal) {
    geometry.rotateX(Math.PI / 4);
  }
  if (config.aboutFace) {
    geometry.rotateY(Math.PI);
  }
  geometry.computeBoundingSphere();
  // shared across every mesh using this item; never dispose with a mesh
  geometry.userData.shared = true;
  return geometry;
}

const itemGeometries = new Map<number, BufferGeometry>();
const itemGeometryLoads = new Map<number, Promise<BufferGeometry>>();

function withItemGeometry(item: number, use: (geometry: BufferGeometry) => void): void {
  const cached = itemGeometries.get(item);
  if (cached) {
    use(cached);
    return;
  }
  let load = itemGeometryLoads.get(item);
  if (!load) {
    const config = ITEM_SPRITES[item];
    load = loadImageData(config.url).then((img) => {
      const geometry = extrudePixelArt(img, config);
      itemGeometries.set(item, geometry);
      return geometry;
    });
    itemGeometryLoads.set(item, load);
  }
  void load.then(use).catch((error: unknown) => console.error(error));
}

// kick the loads at startup so first equips aren't empty-handed
for (const item of Object.keys(ITEM_SPRITES)) {
  withItemGeometry(Number(item), () => {});
}

let itemSpriteMaterial: MeshLambertMaterial | null = null;

function getItemSpriteMaterial(): MeshLambertMaterial {
  if (!itemSpriteMaterial) {
    itemSpriteMaterial = noa.rendering.makeStandardMaterial("item-sprite");
    itemSpriteMaterial.vertexColors = true;
    itemSpriteMaterial.userData.shared = true;
  }
  return itemSpriteMaterial;
}

/*
 *      Tools and equipment
 *
 *  Items are pixel-art sprites extruded into 3D (see above), held in the
 *  right hand. The equipped item id is sent to the server over the
 *  reliable stream and rebroadcast in the binary snapshots, so remote
 *  rigs hold the same tool.
 */

const materialCache = new Map<string, MeshLambertMaterial>();

function colorMaterial(name: string, hex: string) {
  let material = materialCache.get(name);
  if (!material) {
    // lambert is already matte (no specular term)
    material = noa.rendering.makeStandardMaterial(name);
    material.color = new Color(hex);
    // cached and reused across tool meshes; don't dispose with them
    material.userData.shared = true;
    materialCache.set(name, material);
  }
  return material;
}

const BLOCK_COLORS: readonly string[] = [
  "#ffffff",
  "#62b53c", // grass
  "#7a5230", // dirt
  "#8d8d8d", // stone
  "#e7d9a8", // sand
  "#f4f8fa", // snow
  "#6b4a2b", // log
  "#3e7d2e", // leaves
  "#4c4c4c", // coal ore
  "#c9a385", // iron ore
  "#e6c84d", // gold ore
  "#7fe3df", // diamond ore
  "#4d7fd9", // water
  "#8a5a2b", // crafting table
];

function buildToolMesh(name: string, item: number, forViewModel = false): Group | null {
  if (item === HAND) {
    return null;
  }
  const root = new Group();
  root.name = `${name}-item`;
  if (isBlockItem(item)) {
    const block = itemToBlock(item);
    const color = BLOCK_COLORS[block] ?? "#bbbbbb";
    const mesh = new Mesh(
      new BoxGeometry(0.34, 0.34, 0.34),
      colorMaterial(`block-item-${block}`, color),
    );
    mesh.name = `${name}-block`;
    root.add(mesh);
    return root;
  }
  // tools and throwables are extruded pixel-art sprites; the sprite plane
  // is the fore-aft swing plane, with diagonal tools rolled so the handle
  // runs along local +y (the geometry arrives async on first use)
  withItemGeometry(item, (geometry) => {
    const mesh = new Mesh(geometry, getItemSpriteMaterial());
    mesh.name = `${name}-sprite`;
    if (forViewModel) {
      mesh.frustumCulled = false;
    }
    if (isLumpItem(item)) {
      // angle flat lumps slightly so they don't show edge-on
      mesh.rotation.y = -0.6;
    }
    root.add(mesh);
  });
  return root;
}

// rocks, snowballs, and blocks are origin-centered lumps cupped in the
// fist; handle tools have their grip half a handle-length below the origin
function isLumpItem(item: number): boolean {
  return (
    item === ROCK ||
    item === SNOWBALL ||
    item === PLANK ||
    item === FEATHER ||
    item === STRING ||
    isBlockItem(item)
  );
}

function attachToolToRig(rig: Rig, name: string, item: number): void {
  if (rig.tool) {
    disposeObject3D(rig.tool);
  }
  rig.tool = buildToolMesh(name, item);
  if (!rig.tool) {
    return;
  }
  rig.rightArm.add(rig.tool);
  if (isLumpItem(item)) {
    // sits just past the hand (arm spans y 0..-0.675), no handle pitch
    rig.tool.position.set(0, -0.7, 0.16);
  } else if (item === BOW) {
    // Minecraft's walking bow carry: held angled diagonally across the hand,
    // not bolt-upright (vanilla bow thirdperson_righthand ≈ [-80, 260, -40]).
    // Tilt the bow forward and roll it so it lies on a diagonal.
    rig.tool.position.set(0, -0.5, 0.12);
    rig.tool.rotation.set(Math.PI * 0.3, 0, -Math.PI * 0.28);
  } else {
    // grip near the hand; positive rotation.x takes local +y (the tool
    // head) forward, so this is a head-up 54-degree hold
    rig.tool.position.set(0, -0.62, 0.12);
    rig.tool.rotation.x = Math.PI * 0.3;
  }
}

// the renderer patches a Babylon-style getForwardRay() onto the camera,
// returning the view direction in GAME coords (see noa/lib/rendering.ts);
// the test harnesses rely on the same accessor
function cameraForward(): { x: number; y: number; z: number } {
  return (noa.rendering.camera as any).getForwardRay().direction;
}

// Forward along the BODY's facing (same math the camera applies to (0,0,1)
// in noa/lib/camera.ts, with the body heading in place of the camera's).
// Identical to cameraForward() except while Alt-orbiting, when the camera
// swings around the frozen body — projectiles launch from the character, so
// they follow this, not the orbit camera.
function bodyForward(): { x: number; y: number; z: number } {
  const pitch = noa.camera.pitch;
  const cp = Math.cos(pitch);
  return { x: Math.sin(playerHeading) * cp, y: -Math.sin(pitch), z: Math.cos(playerHeading) * cp };
}

let equippedItem: number = HAND;
let firstPerson = false;
let swingT = 0;
// bow draw: holding right-click with a bow equipped charges a shot; release
// looses it. bowDraw is the eased fraction used for the view model + HUD.
let bowDrawing = false;
let bowDrawStartMs = 0;
let bowDraw = 0;
// third-person free-look: hold Alt to orbit the camera around the character.
// playerHeading is the body's facing/movement heading; it tracks the camera
// except while orbiting, when it freezes so the body stays put. On release the
// camera eases back behind the body.
let orbiting = false;
let orbitReturning = false;
let playerHeading = 0;
// eased head yaw (relative to the body) while orbiting, so it follows the
// camera within a neck's range and never snaps; head pitch always tracks the
// look angle like Minecraft
let orbitHeadYaw = 0;
let orbitHeadPitch = 0;
// the third-person camera usually frames the character tilted slightly down
// from above; offset the head pitch by that much so this resting angle reads as
// the character looking straight ahead (≈20°)
const HEAD_PITCH_BIAS = 0.35;
// server-authoritative slot inventory, mirrored from inventory messages:
// 9 hotbar slots + 27 storage slots, each empty or one stack
let invSlots: InvSlot[] = Array.from({ length: INV_SLOTS }, () => null);
// previous inventory total, for the pickup clink (-1 until the first echo)
let lastInvTotal = -1;
let selectedSlot = 0;
let inventoryOpen = false;
// mirror of the open crafting grid (server-authoritative, echoed alongside the
// inventory). craftSize is 0 (closed), 2 (inventory grid), or 3 (table); the
// grid holds craftSize*craftSize cells.
let craftGrid: InvSlot[] = [];
let craftSize = 0;

function heldStack(): InvSlot {
  return invSlots[selectedSlot] ?? null;
}

// total arrows across the whole inventory (ammo isn't tied to the held slot)
function arrowCount(): number {
  let n = 0;
  for (const slot of invSlots) {
    if (slot && slot.item === ARROW) {
      n += slot.count;
    }
  }
  return n;
}

// resolve a drag slot index: 0..INV_SLOTS-1 is the inventory, CRAFT_GRID_BASE..
// addresses the open crafting grid's cells
function slotAt(index: number): InvSlot {
  // the main slots plus the four wear slots appended after them
  if (index >= 0 && index < INV_SLOTS + ARMOR_SLOTS) {
    return invSlots[index] ?? null;
  }
  if (isCraftSlot(index)) {
    const cell = craftCellOf(index);
    if (cell >= 0 && cell < craftGrid.length) {
      return craftGrid[cell] ?? null;
    }
  }
  return null;
}

function setSlotAt(index: number, value: InvSlot): void {
  if (index >= 0 && index < INV_SLOTS + ARMOR_SLOTS) {
    invSlots[index] = value;
    return;
  }
  if (isCraftSlot(index)) {
    const cell = craftCellOf(index);
    if (cell >= 0 && cell < craftGrid.length) {
      craftGrid[cell] = value;
    }
  }
}

function isMoveSlot(index: number): boolean {
  return (
    (index >= 0 && index < INV_SLOTS + ARMOR_SLOTS) ||
    (isCraftSlot(index) && craftCellOf(index) < craftGrid.length)
  );
}

// the grid's item ids (0 = empty), for recipe matching / result preview
function craftCells(): number[] {
  return craftGrid.map((cell) => (cell ? cell.item : 0));
}

// first-person view model: arm + tool fixed to the camera. Camera space
// looks down -z in three.js, so "into the scene" is negative z; the
// values are the Babylon calibration with z (and x/y rotations) negated.
let viewModel: Group | null = null;
const VIEW_MODEL_POS: [number, number, number] = [0.42, -0.42, -1.1];
// walk/run hand bob (minecraft-web-client's HandIdleAnimator pattern:
// x sways with the cycle, y dips on each step at double rate), eased so
// starting/stopping movement never pops the arm
let vmBobPhase = 0;
const vmBob = { x: 0, y: 0 };

function refreshViewModel(): void {
  if (viewModel) {
    disposeObject3D(viewModel);
  }
  viewModel = null;
  if (!firstPerson) {
    return;
  }
  const root = new Group();
  root.name = "view-model";
  const armGeometry = new BoxGeometry(0.16, 0.5, 0.16);
  setBoxUVs(armGeometry, ARM_UV);
  const arm = new Mesh(armGeometry, selfRig.skin);
  arm.name = "view-arm";
  arm.frustumCulled = false;
  root.add(arm);
  // arm extends -y at rest; positive x-rotation tips the hand end forward
  // into the scene (toward -z)
  arm.position.set(0, -0.1, 0.12);
  arm.rotation.x = 1.15;
  const tool = buildToolMesh("view", equippedItem, true);
  if (tool) {
    root.add(tool);
    if (isLumpItem(equippedItem)) {
      // cupped on top of the fist (the hand ends up near (0, -0.2, -0.11))
      tool.position.set(0, -0.08, -0.16);
      tool.rotation.set(-0.25, -0.4, 0.15);
    } else if (equippedItem === BOW) {
      // the bow's limbs face the holder by default; spin it 180° about vertical
      // so they point forward (down-range) in the first-person hold
      tool.position.set(-0.02, -0.06, -0.1);
      tool.rotation.set(-0.2, Math.PI, 0);
    } else {
      // tools hang with the handle vertical and the sprite face toward the
      // camera — a clean, readable hold. A small forward pitch gives a bit of
      // 3D depth. The half-turn yaw exists because camera space looks down -z
      // while rigs face +z: without it the tool's business edge (forward on
      // the rig) would point back at the viewer. The root's resting yaw (0.3)
      // supplies the slight side angle, so this reads the same for every tool.
      tool.position.set(-0.02, -0.06, -0.1);
      tool.rotation.set(-0.2, Math.PI, 0);
    }
  }
  root.scale.setScalar(0.9);
  noa.rendering.camera.add(root);
  root.position.fromArray(VIEW_MODEL_POS);
  root.rotation.y = 0.3;
  viewModel = root;
}

// what you hold is whatever sits in the selected hotbar slot; re-derived
// on selection AND on every inventory change (the stack under the cursor
// can be moved, merged away, or consumed)
function syncEquipped(): void {
  const item = heldStack()?.item ?? HAND;
  if (item === equippedItem) {
    return;
  }
  equippedItem = item;
  if (item !== BOW) {
    bowDrawing = false;
  }
  attachToolToRig(selfRig, "self", item);
  refreshViewModel();
  void client.streams.send({ type: "equip", item }).catch(() => {});
}

function selectSlot(slot: number): void {
  selectedSlot = slot;
  syncEquipped();
  updateHud();
}

function setFirstPerson(on: boolean): void {
  firstPerson = on;
  noa.camera.zoomDistance = on ? 0 : 6;
  selfRig.root.visible = !on;
  refreshViewModel();
  updateHud();
}

for (let slot = 0; slot < HOTBAR_SLOTS; slot++) {
  noa.inputs.bind(`hotbar-${slot + 1}`, `Digit${slot + 1}`);
  noa.inputs.down.on(`hotbar-${slot + 1}`, () => selectSlot(slot));
}
noa.inputs.bind("toggle-view", "KeyV");
noa.inputs.down.on("toggle-view", () => setFirstPerson(!firstPerson));

// hold Alt to orbit the camera around your character (third person only)
noa.inputs.bind("orbit", "AltLeft", "AltRight");
noa.inputs.down.on("orbit", () => {
  if (!firstPerson && !inventoryOpen) {
    orbiting = true;
    orbitReturning = false;
  }
});
noa.inputs.up.on("orbit", () => {
  if (orbiting) {
    orbiting = false;
    orbitReturning = true;
  }
});

// Reconcile the body's heading with the camera each frame. Normally they move
// together; while orbiting the body freezes so the camera can swing around it;
// on release the camera eases back to behind the body. noa applies mouse input
// to the camera before "beforeRender", so reading camera.heading here is current.
function updateOrbit(dtSec: number): void {
  if (firstPerson) {
    orbiting = false;
    orbitReturning = false;
    playerHeading = noa.camera.heading;
    return;
  }
  if (orbiting) {
    return; // camera orbits via the mouse; body heading stays frozen
  }
  if (orbitReturning) {
    noa.camera.heading = lerpAngle(noa.camera.heading, playerHeading, 1 - Math.exp(-dtSec * 18));
    if (Math.abs(lerpAngle(noa.camera.heading, playerHeading, 1) - noa.camera.heading) < 0.01) {
      noa.camera.heading = playerHeading;
      orbitReturning = false;
    }
    return;
  }
  playerHeading = noa.camera.heading;
}

// throw the equipped item along the camera's view direction (Q / middle mouse)
noa.inputs.down.on("mid-fire", () => {
  if (inventoryOpen) {
    return;
  }
  const held = heldStack();
  if (!held || !isThrowable(held.item)) {
    showNotice("Nothing throwable in hand — try the rock (5)");
    return;
  }
  swingT = 1;
  playWhoosh(0.4);
  // thrown from the character's hand, so it follows the body's facing
  const dir = bodyForward();
  void client.streams
    .send({ type: "throw", item: held.item, slot: selectedSlot, dx: dir.x, dy: dir.y, dz: dir.z })
    .catch(() => {});
});

/*
 *      Projectiles: rendered from server broadcasts, interpolated and spun
 */

type ProjectileView = {
  entityId: number;
  mesh: Group;
  target: ProjectileSnapshot;
};

const projectileViews = new Map<number, ProjectileView>();
const dropViews = new Map<number, ProjectileView>();
// reused each frame to aim flying arrows along their travel direction
const ARROW_UP = new Vector3(0, 1, 0);
const arrowDir = new Vector3();
// reused to keep the drawn bow upright + aimed regardless of the draw arm pose
const bowAimQuat = new Quaternion();
const bowAimEuler = new Euler();
// render-space direction of the last arrow we loosed, used to orient a freshly
// spawned arrow before it has moved far enough to derive its heading (otherwise
// it shows the geometry's default +y, i.e. pointing straight up, for a frame)
const lastArrowDir = new Vector3(0, 0, -1);

function applyEntityViews(
  views: Map<number, ProjectileView>,
  snapshots: ProjectileSnapshot[],
  prefix: string,
  scale: number,
): void {
  const seen = new Set<number>();
  for (const snap of snapshots) {
    seen.add(snap.id);
    const existing = views.get(snap.id);
    if (existing) {
      existing.target = snap;
      continue;
    }
    const mesh = buildToolMesh(`${prefix}-${snap.id}`, snap.item);
    if (!mesh) {
      continue;
    }
    mesh.scale.setScalar(scale);
    // a new arrow starts aimed along its launch direction, not the default up
    if (prefix === "proj" && snap.item === ARROW) {
      mesh.quaternion.setFromUnitVectors(ARROW_UP, lastArrowDir);
    }
    const entityId = ents.add([snap.x, snap.y, snap.z], 0.2, 0.2, mesh, [0, 0, 0], false, false);
    views.set(snap.id, { entityId, mesh, target: snap });
  }
  for (const [id, view] of views) {
    if (!seen.has(id)) {
      views.delete(id);
      ents.deleteEntity(view.entityId, true);
    }
  }
}

/*
 *      NPCs (chickens): server-driven wanderers, rendered like other remote
 *      entities — eased toward broadcast positions and turned to face travel.
 *      They appear/vanish as the server starts/stops broadcasting them with
 *      chunk loading, handled by the same seen-set despawn as projectiles.
 */

type ChickenView = {
  entityId: number;
  mesh: Group;
  target: ProjectileSnapshot;
  faceY: number;
  waddle: number;
};

const chickenViews = new Map<number, ChickenView>();

function chickenMaterial(name: string, hex: number): MeshLambertMaterial {
  const material = noa.rendering.makeStandardMaterial(name);
  material.color = new Color(hex);
  return material;
}

// A small low-poly chicken built from boxes, origin at the feet (so it sits on
// the entity's base position) and facing +z.
function buildChickenMesh(name: string): Group {
  const root = new Group();
  root.name = name;
  const white = chickenMaterial(`${name}-body`, 0xf5f5f5);
  const red = chickenMaterial(`${name}-comb`, 0xd83a3a);
  const yellow = chickenMaterial(`${name}-beak`, 0xf2a93b);

  const addBox = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material: MeshLambertMaterial,
  ): Mesh => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };

  addBox(0.38, 0.34, 0.5, 0, 0.42, 0, white); // body
  addBox(0.26, 0.28, 0.26, 0, 0.66, 0.26, white); // head
  addBox(0.1, 0.12, 0.18, 0, 0.8, 0.28, red); // comb
  addBox(0.1, 0.09, 0.16, 0, 0.62, 0.42, yellow); // beak
  const tail = addBox(0.18, 0.26, 0.16, 0, 0.5, -0.3, white);
  tail.rotation.x = -0.5;
  addBox(0.07, 0.25, 0.07, -0.1, 0.13, 0.05, yellow); // left leg
  addBox(0.07, 0.25, 0.07, 0.1, 0.13, 0.05, yellow); // right leg
  return root;
}

// Shortest-path angle interpolation so a chicken turns the short way around.
function angleLerp(from: number, to: number, t: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return from + delta * t;
}

function applyChickenViews(snapshots: ProjectileSnapshot[]): void {
  const seen = new Set<number>();
  for (const snap of snapshots) {
    seen.add(snap.id);
    const existing = chickenViews.get(snap.id);
    if (existing) {
      existing.target = snap;
      continue;
    }
    const mesh = buildChickenMesh(`chicken-${snap.id}`);
    const entityId = ents.add([snap.x, snap.y, snap.z], 0.5, 0.6, mesh, [0, 0, 0], false, false);
    chickenViews.set(snap.id, { entityId, mesh, target: snap, faceY: 0, waddle: 0 });
  }
  for (const [id, view] of chickenViews) {
    if (!seen.has(id)) {
      chickenViews.delete(id);
      ents.deleteEntity(view.entityId, true);
    }
  }
}

/*
 *      Local player: third-person camera + own rig
 *
 *  noa's own input/movement/physics components come off the player
 *  entity — the shared prediction sim below owns movement instead.
 */

const ents = noa.entities;
for (const comp of [
  ents.names.receivesInputs,
  ents.names.movement,
  ents.names.physics,
  ents.names.fadeOnZoom,
]) {
  if (comp && ents.hasComponent(noa.playerEntity, comp)) {
    ents.removeComponent(noa.playerEntity, comp);
  }
}

// starts as last session's character; the creator screen re-dresses it
const selfRig = buildRig("self", storedLook());
ents.addComponent(noa.playerEntity, ents.names.mesh, {
  mesh: selfRig.root,
  offset: [0, 0, 0],
});

noa.camera.zoomDistance = 6;
noa.on("tick", () => {
  // scroll zoom is a third-person control; in first person the camera is
  // pinned to the eyes (any zoom would float it behind the hidden body)
  if (firstPerson) {
    return;
  }
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = Math.max(2, Math.min(12, noa.camera.zoomDistance));
  }
});

/*
 *      Client-side prediction
 *
 *  Every sim tick the client samples input, advances its own copy of the
 *  shared character sim immediately (prediction), and sends the input to
 *  the server as a datagram. Server snapshots ack the last applied input
 *  seq; if the authoritative state disagrees with what we predicted at
 *  that seq, we roll back to the server state and replay pending inputs.
 */

let predicted = spawnState();
let prevPredicted = cloneState(predicted);
let pending: { input: CharInput; state: CharState }[] = [];
let nextSeq = 1;
let rollbacks = 0;
let simAccumMs = 0;
let lastRollback: Record<string, unknown> | null = null;

// rollback corrections ease out over ~150ms instead of snapping: this
// offset holds where the body was rendered minus where it should be, is
// added to the render position, and decays each frame. Big jumps
// (respawn/teleport) snap — easing across the map would look worse.
const correction = { x: 0, y: 0, z: 0 };
const CORRECTION_SNAP_DISTANCE = 2;

function renderAlpha(): number {
  return Math.max(0, Math.min(1, simAccumMs / SIM_TICK_MS));
}

function renderPosition(): [number, number, number] {
  const alpha = renderAlpha();
  return [
    prevPredicted.x + (predicted.x - prevPredicted.x) * alpha,
    prevPredicted.y + (predicted.y - prevPredicted.y) * alpha,
    prevPredicted.z + (predicted.z - prevPredicted.z) * alpha,
  ];
}

function absorbCorrection(before: [number, number, number]): void {
  const after = renderPosition();
  const x = correction.x + before[0] - after[0];
  const y = correction.y + before[1] - after[1];
  const z = correction.z + before[2] - after[2];
  if (Math.hypot(x, y, z) > CORRECTION_SNAP_DISTANCE) {
    correction.x = correction.y = correction.z = 0;
  } else {
    correction.x = x;
    correction.y = y;
    correction.z = z;
  }
}

noa.inputs.bind("sprint", "ShiftLeft");

function sampleInput(): CharInput {
  const state = noa.inputs.state as Record<string, boolean>;
  // the inventory screen captures the keyboard: keep ticking (and staying
  // non-AFK) but stop moving, like Minecraft's inventory pause
  const ui = inventoryOpen;
  return {
    seq: nextSeq++,
    heading: playerHeading,
    fwd: !ui && state.forward === true,
    back: !ui && state.backward === true,
    left: !ui && state.left === true,
    right: !ui && state.right === true,
    jump: !ui && state.jump === true,
    sprint: !ui && state.sprint === true,
  };
}

// each packet carries this many trailing unacked inputs, so a step is only
// lost (forcing a rollback) if this many consecutive datagrams drop
const INPUT_REDUNDANCY = 8;

function simTick(): void {
  const input = sampleInput();
  prevPredicted = predicted;
  predicted = step(predicted, input);
  pending.push({ input, state: predicted });
  if (pending.length > 200) {
    pending.splice(0, pending.length - 100);
  }
  const tail = pending.slice(-INPUT_REDUNDANCY).map((entry) => entry.input);
  void client.datagrams.send(encodeInputs(tail)).catch(() => {});
}

// Fixed-step accumulator driven from the render loop: if worldgen or GC
// stalls a frame, the sim runs catch-up steps instead of losing time.
// The burst is capped to match the server's per-tick input budget.
const MAX_CATCHUP_TICKS = 6;

// backup pump: backgrounded tabs throttle rAF and clamp DOM timers (1s,
// then 1/min under intensive throttling), which would starve the sim and
// make the server think we left. Worker timers are exempt from visibility
// throttling, so a tiny inline worker keeps ticks flowing while hidden.
const pumpWorker = new Worker(
  URL.createObjectURL(
    new Blob(["setInterval(() => postMessage(0), 100);"], { type: "application/javascript" }),
  ),
);
pumpWorker.onmessage = () => {
  const sinceFrame = performance.now() - lastFrameAt;
  if (sinceFrame > 150) {
    lastFrameAt = performance.now();
    pumpSim(Math.min(sinceFrame, 1000));
  }
};

// when the page thaws from a freeze or becomes visible again, catch up
// immediately instead of waiting for the next worker tick
function pumpAfterThaw(): void {
  const sinceFrame = performance.now() - lastFrameAt;
  if (sinceFrame > 150) {
    lastFrameAt = performance.now();
    pumpSim(Math.min(sinceFrame, 1000));
  }
}
document.addEventListener("resume", pumpAfterThaw);
document.addEventListener("visibilitychange", pumpAfterThaw);
// pageshow (bfcache restore) dispatches at window, not document
window.addEventListener("pageshow", pumpAfterThaw);

// dev/test: simulate a fully-frozen tab (no sim, no inputs) until this time
let inputSuspendedUntil = 0;

function pumpSim(frameMs: number): void {
  // don't simulate (or burn input seqs) until the server can hear us AND a
  // character has been picked: the body materializes server-side on the
  // first input, so holding inputs keeps it unspawned (and invisible to
  // others) until it can appear wearing the chosen skin
  if (
    connectionState !== "connected" ||
    !characterChosen ||
    performance.now() < inputSuspendedUntil
  ) {
    simAccumMs = 0;
    return;
  }
  simAccumMs = Math.min(simAccumMs + frameMs, SIM_TICK_MS * MAX_CATCHUP_TICKS);
  while (simAccumMs >= SIM_TICK_MS) {
    simAccumMs -= SIM_TICK_MS;
    simTick();
  }
}

let lastDeath: { victim: string; attacker: string } | null = null;
let lastServerDebug: Record<string, unknown> | null = null;
let remoteSwingsSeen = 0;

// self-heal equip desync: our own snapshot carries the server's view of
// what we hold, which can go stale in either direction (reload during the
// parking window resumes the old item before the client can equip; park
// expiry resets the server to bare hand while the client still shows a
// tool). syncEquipped only sends on change, so re-assert here.
let lastEquipAssertAt = 0;

function reconcile(snap: PlayerSnapshot) {
  if (snap.item !== equippedItem) {
    const now = performance.now();
    if (now - lastEquipAssertAt > 500) {
      lastEquipAssertAt = now;
      void client.streams.send({ type: "equip", item: equippedItem }).catch(() => {});
    }
  }
  if (snap.hp !== myHp) {
    myHp = snap.hp;
    updateHearts();
  }
  const ackIndex = pending.findIndex((entry) => entry.input.seq === snap.lastSeq);
  if (ackIndex === -1) {
    if (pending.length > 0 && snap.lastSeq > pending[pending.length - 1].input.seq) {
      // server is ahead of everything we remember; adopt its state
      const before = renderPosition();
      pending = [];
      predicted = cloneState(snap.state);
      prevPredicted = cloneState(snap.state);
      absorbCorrection(before);
    }
    return;
  }

  const predictedThen = pending[ackIndex].state;
  pending = pending.slice(ackIndex + 1);
  if (!statesDiverge(predictedThen, snap.state)) {
    return;
  }

  // rollback: restart from the authoritative state and replay unacked inputs
  rollbacks += 1;
  lastRollback = {
    seq: snap.lastSeq,
    dx: snap.state.x - predictedThen.x,
    dy: snap.state.y - predictedThen.y,
    dz: snap.state.z - predictedThen.z,
    dvy: snap.state.vy - predictedThen.vy,
    groundServer: onGround(snap.state),
    groundClient: onGround(predictedThen),
    jumpServer: snap.state.jumping,
    jumpClient: predictedThen.jumping,
    sleepServer: snap.state.sleep,
    sleepClient: predictedThen.sleep,
  };
  const before = renderPosition();
  let state = cloneState(snap.state);
  for (const entry of pending) {
    state = step(state, entry.input);
    entry.state = state;
  }
  predicted = state;
  prevPredicted = cloneState(state);
  absorbCorrection(before);
  updateHud();
}

/*
 *      Remote players
 */

type RemotePlayer = {
  entityId: number;
  rig: Rig;
  target: CharState;
  heading: number;
  item: number;
  hp: number;
  hurtUntil: number;
  swingT: number;
  // received snapshots, stamped with local receipt time; rendering
  // interpolates between them slightly in the past
  buffer: { at: number; state: CharState; heading: number }[];
};

const remotePlayers = new Map<string, RemotePlayer>();

// remotes render this far behind the newest snapshot: enough to bridge
// 20Hz snapshot gaps plus one dropped packet without extrapolating
const INTERP_DELAY_MS = 120;
// a teleport-sized jump between snapshots (respawn) snaps instead of gliding
const REMOTE_SNAP_DISTANCE = 8;

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) {
    d -= Math.PI * 2;
  } else if (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return a + d * t;
}

function pushRemoteSample(remote: RemotePlayer, snap: PlayerSnapshot): void {
  const last = remote.buffer[remote.buffer.length - 1];
  if (last) {
    const wasIn = isFluid(
      Math.floor(last.state.x),
      Math.floor(last.state.y + 0.3),
      Math.floor(last.state.z),
    );
    const isIn = isFluid(
      Math.floor(snap.state.x),
      Math.floor(snap.state.y + 0.3),
      Math.floor(snap.state.z),
    );
    if (isIn !== wasIn) {
      const dist = Math.hypot(
        snap.state.x - predicted.x,
        snap.state.y - predicted.y,
        snap.state.z - predicted.z,
      );
      playSplash((isIn ? 0.7 : 0.35) * Math.max(0, 1 - dist / 24), isIn);
    }
  }
  if (
    last &&
    Math.hypot(
      snap.state.x - last.state.x,
      snap.state.y - last.state.y,
      snap.state.z - last.state.z,
    ) > REMOTE_SNAP_DISTANCE
  ) {
    remote.buffer.length = 0;
  }
  remote.buffer.push({ at: performance.now(), state: snap.state, heading: snap.heading });
  if (remote.buffer.length > 40) {
    remote.buffer.splice(0, remote.buffer.length - 20);
  }
}
const HURT_FLASH = new Color(0.55, 0.05, 0.05);
const NO_FLASH = new Color(0, 0, 0);
// id -> display name, from the welcome roster and join messages
const playerNames = new Map<string, string>();

// id -> packed appearance / packed armor, from the welcome roster, join,
// skin, and armor messages; ids with no recorded appearance fall back to
// the deterministic hash
const playerLooks = new Map<string, number>();
const playerArmor = new Map<string, number>();

function setPlayerLook(id: string, look: number): void {
  playerLooks.set(id, look);
  // datagram snapshots can outrun the stream roster, so the rig may already
  // exist wearing the fallback appearance
  const remote = remotePlayers.get(id);
  if (remote) {
    dressRig(remote.rig, look, playerArmor.get(id) ?? 0);
  }
}

function setPlayerArmor(id: string, armor: number): void {
  playerArmor.set(id, armor);
  const remote = remotePlayers.get(id);
  if (remote) {
    dressRig(remote.rig, remote.rig.look, armor);
  }
}

function upsertRemotePlayer(snap: PlayerSnapshot): void {
  const existing = remotePlayers.get(snap.id);
  if (!existing) {
    console.debug(`[rig] upsert NEW remote ${snap.id} (myId=${myId || "unset"})`);
  }
  if (existing) {
    existing.target = snap.state;
    existing.heading = snap.heading;
    existing.hp = snap.hp;
    pushRemoteSample(existing, snap);
    if (existing.item !== snap.item) {
      existing.item = snap.item;
      attachToolToRig(existing.rig, `remote-${snap.id}`, snap.item);
    }
    return;
  }

  const rig = buildRig(
    `remote-${snap.id}`,
    playerLooks.get(snap.id) ?? appearanceForId(snap.id),
    playerArmor.get(snap.id) ?? 0,
  );
  attachToolToRig(rig, `remote-${snap.id}`, snap.item);
  const entityId = ents.add(
    [snap.state.x, snap.state.y, snap.state.z],
    0.6,
    1.8,
    rig.root,
    [0, 0, 0],
    false,
    true,
  );
  const remote: RemotePlayer = {
    entityId,
    rig,
    target: snap.state,
    heading: snap.heading,
    item: snap.item,
    hp: snap.hp,
    hurtUntil: 0,
    swingT: 0,
    buffer: [],
  };
  pushRemoteSample(remote, snap);
  remotePlayers.set(snap.id, remote);
  updateHud();
}

function removeRemotePlayer(id: string): void {
  const remote = remotePlayers.get(id);
  if (!remote) {
    return;
  }
  console.debug(`[rig] remove remote ${id}`);
  remotePlayers.delete(id);
  ents.deleteEntity(remote.entityId, true);
  updateHud();
}

/*
 *      Per-frame rendering: interpolation + animation
 */

let lastFrameAt = performance.now();
let lastStepIndex = -1;
let wasInWater = false;

noa.on("beforeRender", () => {
  const now = performance.now();
  const dtSec = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  updateOrbit(dtSec);
  pumpSim(dtSec * 1000);

  // local player: interpolate between the last two predicted sim states,
  // plus the decaying rollback-correction offset
  const decay = Math.exp(-dtSec * 14); // ~150ms to fade a correction
  correction.x *= decay;
  correction.y *= decay;
  correction.z *= decay;
  const rp = renderPosition();
  ents.setPosition(
    noa.playerEntity,
    rp[0] + correction.x,
    rp[1] + correction.y,
    rp[2] + correction.z,
  );
  // rigs face local +z (skinview3d convention); in render space the
  // game heading h maps to a yaw of PI - h (see noa/lib/rendering.ts)
  selfRig.root.rotation.y = Math.PI - playerHeading;
  const selfSpeed = Math.hypot(predicted.vx, predicted.vz);
  const selfMoving = onGround(predicted) && selfSpeed > 0.4;
  animateRig(selfRig, selfSpeed, onGround(predicted), dtSec, swingT > 0);
  // while orbiting (Alt held), the body stays put but the head turns to look
  // toward the camera. Like Minecraft's head/body split, the turn is capped at
  // a neck's range (~75°) so it never twists past the shoulder, and it's eased
  // so passing directly behind sweeps smoothly instead of snapping sides.
  const headWant = orbiting || orbitReturning;
  const headDelta = Math.atan2(
    Math.sin(playerHeading - noa.camera.heading),
    Math.cos(playerHeading - noa.camera.heading),
  );
  const headYawTarget = headWant ? Math.max(-1.3, Math.min(1.3, headDelta)) : 0;
  // head pitch tracks the look angle (Minecraft maps look pitch straight to
  // head.xRot), biased so the resting third-person camera (tilted slightly down
  // at the character) reads as the face looking straight ahead
  const headPitchTarget = Math.max(-1.3, Math.min(1.3, noa.camera.pitch - HEAD_PITCH_BIAS));
  const headBlend = 1 - Math.exp(-dtSec * 12);
  orbitHeadYaw += (headYawTarget - orbitHeadYaw) * headBlend;
  orbitHeadPitch += (headPitchTarget - orbitHeadPitch) * headBlend;
  selfRig.head.rotation.y = orbitHeadYaw;
  selfRig.head.rotation.x = orbitHeadPitch;
  // drawing/loosing a bow animates the arms in third person too (the first-
  // person view model has its own draw motion)
  if (equippedItem === BOW && bowDraw > 0.01) {
    applyBowDrawToRig(selfRig, bowDraw, noa.camera.pitch);
  } else if (equippedItem === BOW && selfRig.tool) {
    // not drawing: restore the resting hold (the draw counter-rotates the bow)
    selfRig.tool.rotation.set(Math.PI * 0.06, 0, 0);
  }

  // splash on crossing the water surface, scaled by entry speed; leaving
  // the water gets a softer one
  const inWater = isFluid(
    Math.floor(predicted.x),
    Math.floor(predicted.y + 0.3),
    Math.floor(predicted.z),
  );
  if (inWater !== wasInWater) {
    const speed = Math.min(1, 0.35 + Math.abs(predicted.vy) * 0.08);
    playSplash(inWater ? speed : speed * 0.5, inWater);
    wasInWater = inWater;
  }

  // footsteps: the walk cycle plants a foot every half phase-cycle
  if (selfMoving) {
    const stepIndex = Math.floor(selfRig.phase / Math.PI);
    if (stepIndex !== lastStepIndex) {
      lastStepIndex = stepIndex;
      const under = noa.getBlock(
        Math.floor(predicted.x),
        Math.floor(predicted.y - 0.1),
        Math.floor(predicted.z),
      );
      if (under !== 0 && under !== WATER_ID) {
        playSound(blockSoundFamily(under, "step"), 0.22);
      }
    }
  }

  // bow draw: ease the pull fraction toward the held target and drive the
  // charge meter (the eased value also poses the view model below)
  const drawTarget = bowDrawing ? Math.min(1, (now - bowDrawStartMs) / BOW_DRAW_MS) : 0;
  bowDraw += (drawTarget - bowDraw) * (1 - Math.exp(-dtSec * 18));
  updateChargeBar(bowDrawing ? drawTarget : 0, bowDrawing);

  // swing: third person uses the ported HitAnimation; first person is a
  // fore-aft chop — the tool thrusts forward and the head pitches down, then
  // returns. No sideways slide or yaw sweep: that reads as a sword slash,
  // which is wrong for a pick/axe/shovel.
  if (swingT > 0) {
    swingT = Math.max(0, swingT - dtSec * 3.1); // one swing ~= 0.32s, like MC
    applySwingToRig(selfRig, swingT, selfMoving);
    if (viewModel) {
      const p = 1 - swingT;
      const sinP = Math.sin(p * Math.PI); // 0 -> 1 -> 0 across the swing
      // chop by pitching the forearm about the ELBOW (a point set back toward
      // the camera from the hand), so the elbow stays put and the hand + tool
      // arc down/forward — rather than pivoting at the hand (which made the
      // elbow bob). The position offset cancels the elbow's motion under the
      // pitch so that point stays fixed. Base yaw held: no left/right sweep.
      const a = -0.7 * sinP;
      const pz = 0.35; // elbow pivot distance behind the hand (+z toward camera)
      viewModel.position.set(
        VIEW_MODEL_POS[0],
        VIEW_MODEL_POS[1] + pz * Math.sin(a),
        VIEW_MODEL_POS[2] + pz * (1 - Math.cos(a)),
      );
      viewModel.rotation.set(a, 0.3, 0);
    }
  } else if (bowDraw > 0.01 && viewModel) {
    // drawing (or easing back from a release): pull the bow toward the eye
    // and tilt it up to aim
    const d = bowDraw;
    viewModel.position.set(
      VIEW_MODEL_POS[0] - 0.05 * d,
      VIEW_MODEL_POS[1] + 0.06 * d,
      VIEW_MODEL_POS[2] + 0.12 * d,
    );
    viewModel.rotation.set(-0.12 * d, 0.3, 0);
  } else if (viewModel) {
    if (selfMoving) {
      vmBobPhase += dtSec * (selfSpeed > RUN_SPEED_THRESHOLD ? 16 : 8);
    }
    const bobBlend = 1 - Math.exp(-dtSec * 20);
    const targetX = selfMoving ? Math.sin(vmBobPhase) * 0.03 : 0;
    const targetY = selfMoving ? -Math.abs(Math.cos(vmBobPhase)) * 0.055 : 0;
    vmBob.x += (targetX - vmBob.x) * bobBlend;
    vmBob.y += (targetY - vmBob.y) * bobBlend;
    viewModel.position.set(
      VIEW_MODEL_POS[0] + vmBob.x,
      VIEW_MODEL_POS[1] + vmBob.y,
      VIEW_MODEL_POS[2],
    );
    viewModel.rotation.set(0, 0.3, vmBob.x * 0.6);
  }

  // projectiles: ease toward broadcast positions. Arrows nose along their
  // travel direction (point-first, arcing down); thrown items tumble.
  const pt = 1 - Math.exp(-dtSec * 18);
  for (const view of projectileViews.values()) {
    const current = ents.getPosition(view.entityId);
    const nx = current[0] + (view.target.x - current[0]) * pt;
    const ny = current[1] + (view.target.y - current[1]) * pt;
    const nz = current[2] + (view.target.z - current[2]) * pt;
    ents.setPosition(view.entityId, nx, ny, nz);
    if (view.target.item === ARROW) {
      // aim the shaft (+y is the arrowhead) along the direction of travel
      // (toward the next broadcast position); hold the last aim when nearly
      // there. Render space negates Z vs world (the rig's PI - heading
      // convention), so flip the Z delta before orienting the mesh.
      arrowDir.set(view.target.x - nx, view.target.y - ny, -(view.target.z - nz));
      if (arrowDir.lengthSq() > 1e-6) {
        arrowDir.normalize();
        view.mesh.quaternion.setFromUnitVectors(ARROW_UP, arrowDir);
      }
    } else {
      view.mesh.rotation.x += dtSec * 9;
    }
  }

  // world drops: float in place, bobbing and slowly spinning
  const dropTime = now / 1000;
  for (const [id, view] of dropViews) {
    const bob = Math.sin(dropTime * 2.4 + id * 1.7) * 0.08;
    const current = ents.getPosition(view.entityId);
    ents.setPosition(
      view.entityId,
      current[0] + (view.target.x - current[0]) * pt,
      current[1] + (view.target.y + 0.25 + bob - current[1]) * pt,
      current[2] + (view.target.z - current[2]) * pt,
    );
    view.mesh.rotation.y += dtSec * 1.6;
  }

  // chickens: ease toward broadcast positions, turn to face travel, waddle
  for (const view of chickenViews.values()) {
    const current = ents.getPosition(view.entityId);
    const nx = current[0] + (view.target.x - current[0]) * pt;
    const ny = current[1] + (view.target.y - current[1]) * pt;
    const nz = current[2] + (view.target.z - current[2]) * pt;
    ents.setPosition(view.entityId, nx, ny, nz);
    const dx = nx - current[0];
    const dz = nz - current[2];
    const speed = Math.hypot(dx, dz);
    if (speed > 0.0006) {
      view.faceY = angleLerp(view.faceY, Math.atan2(dx, dz), 0.3);
      view.waddle += dtSec * 12;
    }
    view.mesh.rotation.y = view.faceY;
    view.mesh.rotation.z = speed > 0.0006 ? Math.sin(view.waddle) * 0.12 : 0;
  }

  // remote players: interpolate between buffered snapshots, rendered
  // INTERP_DELAY_MS in the past so 20Hz gaps and a dropped packet are
  // bridged by real data instead of extrapolation
  const renderTime = now - INTERP_DELAY_MS;
  for (const remote of remotePlayers.values()) {
    remote.rig.skin.emissive.copy(now < remote.hurtUntil ? HURT_FLASH : NO_FLASH);
    const buf = remote.buffer;
    while (buf.length > 2 && buf[1].at <= renderTime) {
      buf.shift();
    }
    // during warmup (all samples newer than renderTime) hold the OLDEST
    // sample: holding the newest would pop backward once interpolation
    // catches up and replays the same motion
    let shown = buf.length > 0 ? buf[0] : undefined;
    if (buf.length >= 2 && buf[0].at <= renderTime) {
      const [a, b] = buf;
      const span = b.at - a.at;
      const f = span > 0 ? Math.min(1, (renderTime - a.at) / span) : 1;
      ents.setPosition(
        remote.entityId,
        a.state.x + (b.state.x - a.state.x) * f,
        a.state.y + (b.state.y - a.state.y) * f,
        a.state.z + (b.state.z - a.state.z) * f,
      );
      remote.rig.root.rotation.y = Math.PI - lerpAngle(a.heading, b.heading, f);
      shown = f < 0.5 ? a : b;
    } else if (shown) {
      // buffer underrun (or just spawned): hold the newest known state
      ents.setPosition(remote.entityId, shown.state.x, shown.state.y, shown.state.z);
      remote.rig.root.rotation.y = Math.PI - shown.heading;
    }
    const animState = shown ? shown.state : remote.target;
    const remoteSpeed = Math.hypot(animState.vx, animState.vz);
    const remoteMoving = onGround(animState) && remoteSpeed > 0.4;
    animateRig(remote.rig, remoteSpeed, onGround(animState), dtSec, remote.swingT > 0);
    if (remote.swingT > 0) {
      remote.swingT = Math.max(0, remote.swingT - dtSec * 3.1);
      applySwingToRig(remote.rig, remote.swingT, remoteMoving);
    }
  }
});

/*
 *      HUD
 */

/*
 *      HUD: status panel, crosshair, hotbar with item icons, block bar,
 *      and toast notices
 */

const UI_FONT = "12px/1.4 system-ui, sans-serif";

function uiDiv(css: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `position: fixed; z-index: 10; pointer-events: none; ${css}`;
  document.body.appendChild(el);
  return el;
}

const statusPanel = uiDiv(
  `top: 10px; right: 10px; padding: 6px 10px; font: ${UI_FONT}; color: #fff;` +
    "background: rgba(0,0,0,0.45); border-radius: 6px; white-space: pre; text-align: right;",
);

const helpPanel = uiDiv(
  `bottom: 10px; left: 10px; padding: 6px 10px; font: ${UI_FONT}; color: rgba(255,255,255,0.75);` +
    "background: rgba(0,0,0,0.35); border-radius: 6px; white-space: pre;",
);
helpPanel.textContent =
  "WASD move · shift sprint · space jump/swim\n" +
  "LMB dig / hold to draw bow · RMB place block · Q throw\n" +
  "E inventory · V first/third person · scroll zoom · hold Alt to orbit";

const crosshair = uiDiv(
  "top: 50%; left: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px;" +
    "background: radial-gradient(circle, rgba(255,255,255,0.9) 2px, transparent 3px);",
);
void crosshair;

// bow charge meter: a thin bar just under the crosshair, shown only while
// drawing; fills over a full draw and turns gold at full power
const chargeBar = uiDiv(
  "bottom: 96px; left: 50%; transform: translateX(-50%); width: 120px; height: 6px;" +
    "background: rgba(0,0,0,0.5); border-radius: 3px; overflow: hidden;" +
    "opacity: 0; transition: opacity 0.12s;",
);
const chargeFill = document.createElement("div");
chargeFill.style.cssText = "height: 100%; width: 0%; background: #fff; border-radius: 3px;";
chargeBar.appendChild(chargeFill);

function updateChargeBar(frac: number, active: boolean): void {
  chargeBar.style.opacity = active ? "1" : "0";
  chargeFill.style.width = `${Math.round(frac * 100)}%`;
  chargeFill.style.background = frac >= 0.999 ? "#ffd24a" : "#ffffff";
}

const toast = uiDiv(
  "bottom: 168px; left: 50%; transform: translateX(-50%); padding: 6px 14px;" +
    `font: ${UI_FONT}; font-size: 13px; color: #fff; background: rgba(20,20,28,0.8);` +
    "border-radius: 6px; opacity: 0; transition: opacity 0.25s;",
);

const BLOCK_TEXTURE_FILES: readonly string[] = [
  "",
  "grass.png",
  "dirt.png",
  "stone.png",
  "sand.png",
  "snow.png",
  "tree.png",
  "leaves.png",
  "coal_ore.png",
  "iron_ore.png",
  "gold_ore.png",
  "diamond_ore.png",
  "",
  "crafting_table.png",
];

// the HUD icons are the same sprites the 3D items are extruded from
const ITEM_ICON_FILES: Record<number, string> = {
  [HAND]: "/assets/items/hand.png",
  [PICKAXE]: "/assets/items/pickaxe.png",
  [AXE]: "/assets/items/axe.png",
  [SHOVEL]: "/assets/items/shovel.png",
  [ROCK]: "/assets/items/rock.png",
  [SNOWBALL]: "/assets/items/snowball.png",
  [PLANK]: "/assets/items/plank.png",
  [STICK]: "/assets/items/stick.png",
  [BOW]: "/assets/items/bow.png",
  [ARROW]: "/assets/items/arrow.png",
  [FEATHER]: "/assets/items/feather.png",
  [STRING]: "/assets/items/string.png",
  [HELMET]: "/assets/items/helmet.png",
  [CHESTPLATE]: "/assets/items/chestplate.png",
  [LEGGINGS]: "/assets/items/leggings.png",
  [BOOTS]: "/assets/items/boots.png",
};

function makeIconElement(item: number): Node {
  const img = document.createElement("img");
  img.style.cssText = "width: 28px; height: 28px; image-rendering: pixelated;";
  if (isBlockItem(item)) {
    const file = BLOCK_TEXTURE_FILES[itemToBlock(item)];
    img.src = file ? `${TEX}/${file}` : "";
  } else {
    img.src = ITEM_ICON_FILES[item] ?? "";
  }
  return img;
}

type Slot = {
  root: HTMLDivElement;
  count: HTMLDivElement;
  iconNode: Node | null;
  iconItem: number;
};

const SLOT_CSS =
  "position: relative; width: 44px; height: 44px; border-radius: 6px;" +
  "background: rgba(10,10,16,0.55); border: 2px solid rgba(255,255,255,0.25);" +
  "display: flex; align-items: center; justify-content: center; transition: border-color 0.1s;";

function makeSlot(container: HTMLElement, keyLabel: string): Slot {
  const root = document.createElement("div");
  root.style.cssText = SLOT_CSS;
  if (keyLabel) {
    const key = document.createElement("div");
    key.textContent = keyLabel;
    key.style.cssText = `position: absolute; top: 1px; left: 4px; font: ${UI_FONT}; font-size: 9px; color: rgba(255,255,255,0.7);`;
    root.appendChild(key);
  }
  const count = document.createElement("div");
  count.style.cssText = `position: absolute; bottom: 1px; right: 4px; font: ${UI_FONT}; font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 1px 2px #000;`;
  root.appendChild(count);
  container.appendChild(root);
  return { root, count, iconNode: null, iconItem: -1 };
}

// points a slot tile at a stack: swaps the icon when the item changes and
// shows the count for stacks of 2+ (Minecraft hides singletons)
function setSlotContent(slot: Slot, stack: InvSlot): void {
  const item = stack ? stack.item : -1;
  if (item !== slot.iconItem) {
    if (slot.iconNode) {
      slot.root.removeChild(slot.iconNode);
    }
    slot.iconNode = item >= 0 ? makeIconElement(item) : null;
    if (slot.iconNode) {
      slot.root.insertBefore(slot.iconNode, slot.root.firstChild);
    }
    slot.iconItem = item;
  }
  slot.count.textContent = stack && stack.count > 1 ? String(stack.count) : "";
}

const hotbarEl = uiDiv(
  "bottom: 14px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px;",
);
const hotbarSlots: Slot[] = [];
for (let i = 0; i < HOTBAR_SLOTS; i++) {
  hotbarSlots.push(makeSlot(hotbarEl, String(i + 1)));
}

const hurtVignette = uiDiv(
  "inset: 0; background: radial-gradient(ellipse at center, transparent 55%, rgba(200,16,16,0.55) 100%);" +
    "opacity: 0; transition: opacity 0.15s;",
);
let vignetteTimer: ReturnType<typeof setTimeout> | undefined;

function flashHurt(strength: number): void {
  hurtVignette.style.opacity = String(Math.min(1, strength));
  clearTimeout(vignetteTimer);
  vignetteTimer = setTimeout(() => {
    hurtVignette.style.opacity = "0";
  }, 250);
}

const heartsEl = uiDiv(
  "bottom: 64px; left: 50%; transform: translateX(-50%); display: flex; gap: 2px;" +
    "font: 15px/1 system-ui, sans-serif; text-shadow: 0 1px 2px #000;",
);
const heartSpans: HTMLSpanElement[] = [];
for (let i = 0; i < MAX_HP / 2; i++) {
  const span = document.createElement("span");
  span.textContent = "\u2665";
  heartsEl.appendChild(span);
  heartSpans.push(span);
}

let myHp = MAX_HP;

function updateHearts(): void {
  for (let i = 0; i < heartSpans.length; i++) {
    const heartHp = myHp - i * 2;
    heartSpans[i].style.color =
      heartHp >= 2 ? "#ff3b48" : heartHp === 1 ? "#ff9d4d" : "rgba(255,255,255,0.22)";
  }
}
updateHearts();

let connectionState = "connecting";
let myName = "";
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function showNotice(text: string): void {
  toast.textContent = text;
  toast.style.opacity = "1";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    toast.style.opacity = "0";
  }, 1800);
}

function updateStatus(): void {
  const others = [...remotePlayers.keys()].map((id) => playerNames.get(id) ?? "Player");
  statusPanel.textContent =
    `${connectionState}${myName ? ` as ${myName}` : ""}` +
    `\nPlayers: ${remotePlayers.size + 1}` +
    (others.length > 0 ? ` (${others.join(", ")})` : "") +
    `\nRollbacks: ${rollbacks}`;
}

function updateHotbar(): void {
  for (let i = 0; i < hotbarSlots.length; i++) {
    setSlotContent(hotbarSlots[i], invSlots[i] ?? null);
    hotbarSlots[i].root.style.borderColor = i === selectedSlot ? "#fff" : "rgba(255,255,255,0.25)";
  }
}

function updateHud(): void {
  updateStatus();
  updateHotbar();
  updateInventoryPanel();
}

/*
 *      Inventory screen (E): the larger storage behind the hotbar.
 *
 *  A DOM overlay, not canvas UI: 27 storage slots over a mirror of the 9
 *  hotbar slots, drag-and-drop to move/merge/swap stacks. Moves apply
 *  optimistically and go to the server as invMove messages; the server's
 *  inventory echo is authoritative.
 */

const invBackdrop = document.createElement("div");
invBackdrop.style.cssText =
  "position: fixed; inset: 0; z-index: 20; display: none; align-items: center;" +
  "justify-content: center; background: rgba(0,0,0,0.45); pointer-events: auto;";
document.body.appendChild(invBackdrop);

const invPanel = document.createElement("div");
invPanel.style.cssText =
  "background: rgba(18,20,28,0.94); border: 1px solid rgba(255,255,255,0.15);" +
  "border-radius: 10px; padding: 14px 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);";
invBackdrop.appendChild(invPanel);

const invTitle = document.createElement("div");
invTitle.textContent = "Inventory";
invTitle.style.cssText = `font: ${UI_FONT}; font-size: 13px; color: #fff; margin-bottom: 10px;`;
invPanel.appendChild(invTitle);

// crafting: a square grid (2x2 in the inventory, 3x3 at a table) feeding a
// result slot. Grid cells use slot indices CRAFT_GRID_BASE+cell so the
// existing inventory drag system moves items in and out via invMove; clicking
// the result crafts (shift-click crafts as many as the grid allows).
const craftSlots2: Slot[] = [];
const craftSlots3: Slot[] = [];
const craftSection = document.createElement("div");
craftSection.style.cssText = "display: flex; align-items: center; gap: 14px; margin-bottom: 14px;";
invPanel.appendChild(craftSection);
const grid2El = document.createElement("div");
grid2El.style.cssText = "display: grid; grid-template-columns: repeat(2, 44px); gap: 5px;";
const grid3El = document.createElement("div");
grid3El.style.cssText = "display: grid; grid-template-columns: repeat(3, 44px); gap: 5px;";
craftSection.appendChild(grid2El);
craftSection.appendChild(grid3El);
for (let cell = 0; cell < 4; cell++) {
  const s = makeSlot(grid2El, "");
  s.root.dataset.invSlot = String(CRAFT_GRID_BASE + cell);
  s.root.style.cursor = "grab";
  craftSlots2.push(s);
}
for (let cell = 0; cell < 9; cell++) {
  const s = makeSlot(grid3El, "");
  s.root.dataset.invSlot = String(CRAFT_GRID_BASE + cell);
  s.root.style.cursor = "grab";
  craftSlots3.push(s);
}
const craftArrow = document.createElement("div");
craftArrow.textContent = "→";
craftArrow.style.cssText = `font: ${UI_FONT}; font-size: 22px; color: rgba(255,255,255,0.65);`;
craftSection.appendChild(craftArrow);
const resultTile = makeSlot(craftSection, "");
resultTile.root.style.cursor = "pointer";
resultTile.root.style.borderColor = "rgba(120,220,120,0.55)";
resultTile.root.addEventListener("click", (ev) => {
  void client.streams.send({ type: "craftTake", all: ev.shiftKey }).catch(() => {});
});

// wear slots: drag a piece in to put it on (slot indexes ARMOR_BASE+piece,
// so the ordinary invMove drag machinery equips it); a faint glyph shows
// which piece each slot takes while it's empty
const armorTiles: Slot[] = [];
const armorGhosts: HTMLImageElement[] = [];
{
  const armorSection = document.createElement("div");
  armorSection.style.cssText = "display: flex; gap: 5px; margin-bottom: 12px;";
  invPanel.appendChild(armorSection);
  for (let piece = 0; piece < ARMOR_SLOTS; piece++) {
    const slot = makeSlot(armorSection, "");
    slot.root.dataset.invSlot = String(ARMOR_BASE + piece);
    slot.root.style.cursor = "grab";
    const ghost = document.createElement("img");
    ghost.src = ITEM_ICON_FILES[HELMET + piece] ?? "";
    ghost.style.cssText =
      "position: absolute; width: 28px; height: 28px; image-rendering: pixelated; opacity: 0.25;";
    slot.root.insertBefore(ghost, slot.root.firstChild);
    armorTiles.push(slot);
    armorGhosts.push(ghost);
  }
}

// panel slot index -> inventory slot index: storage rows first (9-35),
// then the hotbar mirror row (0-8), like Minecraft's layout
const panelSlots: Slot[] = [];
{
  const storageGrid = document.createElement("div");
  storageGrid.style.cssText =
    "display: grid; grid-template-columns: repeat(9, 44px); gap: 5px; margin-bottom: 12px;";
  invPanel.appendChild(storageGrid);
  const hotbarRow = document.createElement("div");
  hotbarRow.style.cssText = "display: grid; grid-template-columns: repeat(9, 44px); gap: 5px;";
  invPanel.appendChild(hotbarRow);
  for (let i = 0; i < INV_SLOTS; i++) {
    const inStorage = i >= HOTBAR_SLOTS;
    const slot = makeSlot(inStorage ? storageGrid : hotbarRow, inStorage ? "" : String(i + 1));
    slot.root.dataset.invSlot = String(i);
    slot.root.style.cursor = "grab";
    panelSlots.push(slot);
  }
}

function updateInventoryPanel(): void {
  if (!inventoryOpen) {
    return;
  }
  for (let i = 0; i < panelSlots.length; i++) {
    setSlotContent(panelSlots[i], invSlots[i] ?? null);
    panelSlots[i].root.style.borderColor = i === selectedSlot ? "#fff" : "rgba(255,255,255,0.25)";
  }
  for (let piece = 0; piece < ARMOR_SLOTS; piece++) {
    const worn = invSlots[ARMOR_BASE + piece] ?? null;
    setSlotContent(armorTiles[piece], worn);
    armorGhosts[piece].style.display = worn ? "none" : "block";
  }
  // crafting grid: show the one matching craftSize, fill its cells, and
  // preview the result the current pattern would yield
  const show3 = craftSize === 3;
  craftSection.style.display = craftSize > 0 ? "flex" : "none";
  grid2El.style.display = craftSize === 2 ? "grid" : "none";
  grid3El.style.display = show3 ? "grid" : "none";
  const tiles = show3 ? craftSlots3 : craftSlots2;
  for (let cell = 0; cell < tiles.length; cell++) {
    setSlotContent(tiles[cell], craftGrid[cell] ?? null);
  }
  const recipe = craftSize > 0 ? matchRecipe(craftCells(), craftSize) : null;
  setSlotContent(resultTile, recipe ? { item: recipe.out, count: recipe.count } : null);
  invTitle.textContent = show3 ? "Crafting Table" : "Inventory";
}

// after the panel closes, a fire that arrives while the pointer is still
// unlocked is the user's re-lock click, not an attack
let fireSuppressedUntil = 0;

function setInventoryOpen(
  on: boolean,
  size = 2,
  table: { x: number; y: number; z: number } | null = null,
): void {
  inventoryOpen = on;
  invBackdrop.style.display = on ? "flex" : "none";
  if (on) {
    // optimistic grid so cells render before the server's echo; the echo is
    // authoritative (and validates table proximity for the 3x3)
    craftSize = size;
    craftGrid = Array.from({ length: size * size }, () => null);
    document.exitPointerLock?.();
    if (table) {
      void client.streams
        .send({ type: "craftOpen", size, x: table.x, y: table.y, z: table.z })
        .catch(() => {});
    } else {
      void client.streams.send({ type: "craftOpen", size }).catch(() => {});
    }
    updateInventoryPanel();
  } else {
    endDrag(null);
    // hand any items left in the grid back to the inventory, server-side
    void client.streams.send({ type: "craftClose" }).catch(() => {});
    craftSize = 0;
    craftGrid = [];
    // the E keypress is a user gesture, so this usually succeeds; when the
    // browser refuses, the grace window below swallows the re-lock click
    noa.container.setPointerLock(true);
    fireSuppressedUntil = performance.now() + 1500;
  }
}

function fireSuppressed(): boolean {
  return (
    inventoryOpen || (!noa.container.hasPointerLock && performance.now() < fireSuppressedUntil)
  );
}

// the same rule the server applies, run optimistically; works across
// inventory and crafting-grid slots via slotAt/setSlotAt. `one` moves a single
// item (right-drag) onto an empty cell or matching stack.
function applyLocalMove(from: number, to: number, one: boolean): void {
  const source = slotAt(from);
  if (!source) {
    return;
  }
  // wear slots only accept their matching armor piece (the server enforces
  // the same rule)
  if (isArmorIndex(to) && armorPiece(source.item) !== to - ARMOR_BASE) {
    return;
  }
  const target = slotAt(to);
  if (one) {
    if (target && (target.item !== source.item || target.count >= stackLimit(source.item))) {
      return;
    }
    if (target) {
      target.count += 1;
    } else {
      setSlotAt(to, { item: source.item, count: 1 });
    }
    source.count -= 1;
    if (source.count === 0) {
      setSlotAt(from, null);
    }
  } else if (target && target.item === source.item) {
    const take = Math.min(stackLimit(source.item) - target.count, source.count);
    target.count += take;
    source.count -= take;
    if (source.count === 0) {
      setSlotAt(from, null);
    }
  } else {
    setSlotAt(from, target);
    setSlotAt(to, source);
  }
}

function moveItem(from: number, to: number, one: boolean): void {
  if (from === to || !isMoveSlot(from) || !isMoveSlot(to) || !slotAt(from)) {
    return;
  }
  applyLocalMove(from, to, one);
  syncEquipped();
  updateHud();
  void client.streams.send({ type: "invMove", from, to, one }).catch(() => {});
}

// drag and drop: pick a stack up on pointerdown, float its icon under the
// cursor, drop it on the slot under the pointer. right-button drag moves a
// single item (so one stack can be spread across crafting-grid cells).
let dragFrom = -1;
let dragOne = false;
let dragGhost: HTMLDivElement | null = null;

function endDrag(ev: PointerEvent | null): void {
  if (dragFrom === -1) {
    return;
  }
  if (ev) {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const slotEl = under?.closest?.("[data-inv-slot]") as HTMLElement | null;
    if (slotEl?.dataset.invSlot !== undefined) {
      moveItem(dragFrom, Number(slotEl.dataset.invSlot), dragOne);
    }
  }
  dragFrom = -1;
  dragOne = false;
  dragGhost?.remove();
  dragGhost = null;
}

invBackdrop.addEventListener("contextmenu", (ev) => ev.preventDefault());

invBackdrop.addEventListener("pointerdown", (ev) => {
  // a drag still armed here lost its pointerup (context menu, window
  // blur): cancel it instead of letting this click complete it
  if (dragFrom !== -1 || dragGhost) {
    endDrag(null);
  }
  // left button drags the whole stack; right button drags a single item
  if (ev.button !== 0 && ev.button !== 2) {
    return;
  }
  const slotEl = (ev.target as HTMLElement).closest?.("[data-inv-slot]") as HTMLElement | null;
  const index = slotEl ? Number(slotEl.dataset.invSlot) : -1;
  const stack = slotAt(index);
  if (index < 0 || !stack) {
    return;
  }
  ev.preventDefault();
  dragFrom = index;
  dragOne = ev.button === 2;
  dragGhost = document.createElement("div");
  dragGhost.style.cssText =
    "position: fixed; z-index: 30; pointer-events: none; opacity: 0.85;" +
    "transform: translate(-50%, -50%);";
  dragGhost.appendChild(makeIconElement(stack.item));
  dragGhost.style.left = `${ev.clientX}px`;
  dragGhost.style.top = `${ev.clientY}px`;
  document.body.appendChild(dragGhost);
});

document.addEventListener("pointermove", (ev) => {
  if (dragGhost) {
    dragGhost.style.left = `${ev.clientX}px`;
    dragGhost.style.top = `${ev.clientY}px`;
  }
});

document.addEventListener("pointerup", (ev) => endDrag(ev));
document.addEventListener("pointercancel", () => endDrag(null));

updateHud();

/*
 *      Block interaction
 */

noa.inputs.bind("inventory", "KeyE");
noa.inputs.down.on("inventory", () => {
  if (characterChosen) {
    setInventoryOpen(!inventoryOpen);
  }
});

// dev/test backdoor: predicted locally like placement, confirmed by the
// server echo so all clients converge on the same order
function sendEdit(block: number, x: number, y: number, z: number): void {
  predictEdit(block, x, y, z);
  void client.streams.send({ type: "edit", block, x, y, z }).catch(() => {});
}

// aim-corridor player targeting: nearest remote within reach whose center
// sits close to the camera ray
function findAttackTarget(): string | null {
  const dir = cameraForward();
  const ox = predicted.x;
  const oy = predicted.y + 1.5;
  const oz = predicted.z;
  let best: string | null = null;
  let bestDist = 4.2;
  for (const [id, remote] of remotePlayers) {
    const cx = remote.target.x - ox;
    const cy = remote.target.y + 0.9 - oy;
    const cz = remote.target.z - oz;
    const dist = Math.hypot(cx, cy, cz);
    if (dist > 4.2 || dist >= bestDist) {
      continue;
    }
    const along = cx * dir.x + cy * dir.y + cz * dir.z;
    if (along <= 0) {
      continue;
    }
    const offAxis = Math.hypot(cx - dir.x * along, cy - dir.y * along, cz - dir.z * along);
    if (offAxis > 0.9) {
      continue;
    }
    best = id;
    bestDist = dist;
  }
  return best;
}

function primaryAction(fromHold: boolean): void {
  if (fireSuppressed()) {
    return;
  }
  swingT = 1;
  playWhoosh(0.25);
  const target = findAttackTarget();
  if (target) {
    void client.streams.send({ type: "attack", target }).catch(() => {});
    return;
  }
  if (!noa.targetedBlock) {
    return;
  }
  const block = noa.targetedBlock.blockID;
  if (hitDamage(equippedItem, block) <= 0) {
    if (!fromHold) {
      showNotice(
        requiresPickaxe(block)
          ? "Too hard to dig by hand — equip the pickaxe (2)"
          : "Can't dig that",
      );
    }
    return;
  }
  const [x, y, z] = noa.targetedBlock.position;
  void client.streams.send({ type: "hit", x, y, z }).catch(() => {});
}

noa.inputs.down.on("fire", () => {
  // a bow draws on hold and looses on release (left click) — no melee swing
  if (equippedItem === BOW) {
    if (fireSuppressed()) {
      return;
    }
    if (arrowCount() <= 0) {
      showNotice("Out of arrows — craft more (rock + stick + feather)");
      return;
    }
    bowDrawing = true;
    bowDrawStartMs = performance.now();
    playWhoosh(0.12);
    return;
  }
  primaryAction(false);
});

// hold to keep mining/attacking: re-trigger at swing cadence while held (but a
// held bow is drawing, not mining)
setInterval(() => {
  const state = noa.inputs.state as Record<string, boolean>;
  if (state.fire === true && swingT <= 0 && !inventoryOpen && equippedItem !== BOW) {
    primaryAction(true);
  }
}, 80);

// noa binds alt-fire to both right-click and E by default; E is the
// inventory screen now, so place is right-click only
noa.inputs.unbind("alt-fire");
noa.inputs.bind("alt-fire", "Mouse3");
noa.inputs.down.on("alt-fire", () => {
  if (fireSuppressed()) {
    return;
  }
  const target = noa.targetedBlock;
  // right-clicking a crafting table opens its 3x3 grid instead of placing
  if (target && target.blockID === CRAFTING_TABLE_ID) {
    const [tx, ty, tz] = target.position;
    setInventoryOpen(true, 3, { x: tx, y: ty, z: tz });
    return;
  }
  swingT = 1;
  if (!target) {
    return;
  }
  const held = heldStack();
  if (!held || !isBlockItem(held.item)) {
    showNotice("Hold a block to place it — dig some, then grab it from a slot");
    return;
  }
  const [x, y, z] = target.adjacent;
  // optimistic placement, reconciled by the server's echo (or reverted)
  predictEdit(itemToBlock(held.item), x, y, z);
  void client.streams
    .send({ type: "place", item: held.item, slot: selectedSlot, x, y, z })
    .catch(() => {});
});

// release the bow (left click up): loose an arrow whose power is the fraction
// of a full draw. No swing animation — the draw-and-release pose is enough.
noa.inputs.up.on("fire", () => {
  if (!bowDrawing) {
    return;
  }
  bowDrawing = false;
  if (inventoryOpen || arrowCount() <= 0) {
    return;
  }
  const charge = Math.min(1, (performance.now() - bowDrawStartMs) / BOW_DRAW_MS);
  if (charge < BOW_MIN_CHARGE) {
    return;
  }
  playBowShot(0.35 + charge * 0.3);
  // arrows leave the bow, not the camera: while Alt-orbiting the torso (and
  // the drawn bow) keep pointing along the body heading, so fire that way
  const dir = bodyForward();
  // remember the launch heading (render space: Z flipped) to seed the arrow's
  // orientation the instant it spawns
  lastArrowDir.set(dir.x, dir.y, -dir.z).normalize();
  void client.streams
    .send({ type: "fireArrow", charge, dx: dir.x, dy: dir.y, dz: dir.z })
    .catch(() => {});
});

// Optional on-screen touch controls (no-op on desktop). Installed last so all
// the input handlers, HUD elements, and toggles it wires into already exist.
setupMobileControls({
  noa,
  hotbarEl,
  hotbarSlots,
  helpPanel,
  selectSlot,
  toggleView: () => setFirstPerson(!firstPerson),
  openInventory: () => setInventoryOpen(!inventoryOpen),
});

/*
 *      Character creator
 *
 *  A blocking overlay shown on load: build a character (body, skin tone,
 *  hair) before the sim starts sending inputs. Bodies materialize
 *  server-side on the first input (see pumpSim/addPlayer), so until the
 *  creator confirms this player is invisible to everyone — and then spawns
 *  already looking like their pick. The pick is remembered per-device.
 */

let characterChosen = false;
let chosenLook: number | null = null;
let skinChoiceSent = false;
// our own packed wear slots, mirrored out of the inventory echoes
let myArmor = 0;

// the pick can confirm before or after the transport is ready; whichever
// happens second delivers it (connect() calls this again on "connected")
function sendSkinChoice(): void {
  if (skinChoiceSent || chosenLook === null || connectionState !== "connected") {
    return;
  }
  skinChoiceSent = true;
  void client.streams.send({ type: "skin", skin: chosenLook }).catch(() => {});
}

// Flat "paper doll" views assembled from the painted 64x32 skin onto a
// 16x32 canvas, CSS-scaled up with image-rendering: pixelated. The back
// view is what makes the hair styles legible (length, ponytail).
const dollScratch = document.createElement("canvas");
dollScratch.width = 64;
dollScratch.height = 32;

function drawDoll(canvas: HTMLCanvasElement, look: number, back = false): void {
  paintCharacter(dollScratch.getContext("2d")!, look, 0);
  const headX = back ? 24 : 8;
  const torsoX = back ? 32 : 20;
  const armX = back ? 52 : 44;
  const legX = back ? 12 : 4;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(dollScratch, headX, 8, 8, 8, 4, 0, 8, 8); // head
  ctx.drawImage(dollScratch, torsoX, 20, 8, 12, 4, 8, 8, 12); // torso
  ctx.drawImage(dollScratch, armX, 20, 4, 12, 0, 8, 4, 12); // right arm
  ctx.drawImage(dollScratch, legX, 20, 4, 12, 4, 20, 4, 12); // right leg
  // left arm/leg mirror the right ones, like the rig
  ctx.scale(-1, 1);
  ctx.drawImage(dollScratch, armX, 20, 4, 12, -16, 8, 4, 12); // left arm
  ctx.drawImage(dollScratch, legX, 20, 4, 12, -12, 20, 4, 12); // left leg
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

const creatorBackdrop = document.createElement("div");
creatorBackdrop.style.cssText =
  "position: fixed; inset: 0; z-index: 30; display: flex; align-items: center;" +
  "justify-content: center; background: rgba(0,0,0,0.55); pointer-events: auto;";
document.body.appendChild(creatorBackdrop);

const creatorPanel = document.createElement("div");
creatorPanel.style.cssText =
  "background: rgba(18,20,28,0.94); border: 1px solid rgba(255,255,255,0.15);" +
  "border-radius: 10px; padding: 16px 18px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);" +
  "max-width: min(92vw, 560px); text-align: center;";
creatorBackdrop.appendChild(creatorPanel);

const creatorTitle = document.createElement("div");
creatorTitle.textContent = "Create your character";
creatorTitle.style.cssText = `font: ${UI_FONT}; font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 12px;`;
creatorPanel.appendChild(creatorTitle);

const creatorRow = document.createElement("div");
creatorRow.style.cssText =
  "display: flex; flex-wrap: wrap; gap: 14px; justify-content: center;" +
  "align-items: stretch; margin-bottom: 14px;";
creatorPanel.appendChild(creatorRow);

// live preview: the character from the front and from behind
const previewWrap = document.createElement("div");
previewWrap.style.cssText =
  "display: flex; gap: 10px; align-items: center; justify-content: center;" +
  "padding: 10px 12px; background: rgba(10,10,16,0.55); border-radius: 8px;";
creatorRow.appendChild(previewWrap);
const previewFront = document.createElement("canvas");
const previewBack = document.createElement("canvas");
for (const canvas of [previewFront, previewBack]) {
  canvas.width = 16;
  canvas.height = 32;
  canvas.style.cssText = "width: 80px; height: 160px; image-rendering: pixelated;";
  previewWrap.appendChild(canvas);
}

const optionsCol = document.createElement("div");
optionsCol.style.cssText =
  "display: flex; flex-direction: column; gap: 8px; justify-content: center; text-align: left;";
creatorRow.appendChild(optionsCol);

const selected = unpackAppearance(storedLook());

function currentLook(): number {
  return packAppearance(selected);
}

// every option button, keyed by the field it sets, so one pass can update
// the selection highlights
const optionButtons: { field: keyof Appearance; value: number; el: HTMLButtonElement }[] = [];
// hair-style minis repaint with the current tone/color
const hairMinis: { style: number; canvas: HTMLCanvasElement }[] = [];

function refreshCreator(): void {
  drawDoll(previewFront, currentLook());
  drawDoll(previewBack, currentLook(), true);
  for (const mini of hairMinis) {
    drawDoll(mini.canvas, packAppearance({ ...selected, hair: mini.style }), true);
  }
  for (const opt of optionButtons) {
    const picked = selected[opt.field] === opt.value;
    opt.el.style.borderColor = picked ? "#fff" : "rgba(255,255,255,0.25)";
    // color swatches keep their palette color; selection shows on the
    // border alone
    if (opt.field === "tone") {
      opt.el.style.background = SKIN_TONES[opt.value];
    } else if (opt.field === "hairColor") {
      opt.el.style.background = HAIR_COLORS[opt.value];
    } else if (opt.field === "shirt") {
      opt.el.style.background = SHIRT_COLORS[opt.value];
    } else if (opt.field === "pants") {
      opt.el.style.background = PANTS_COLORS[opt.value];
    } else {
      opt.el.style.background = picked ? "rgba(60,70,95,0.6)" : "rgba(10,10,16,0.55)";
    }
  }
}

function optionRow(label: string): HTMLDivElement {
  const caption = document.createElement("div");
  caption.textContent = label;
  caption.style.cssText = `font: ${UI_FONT}; font-size: 10px; color: rgba(255,255,255,0.55);`;
  optionsCol.appendChild(caption);
  const row = document.createElement("div");
  row.style.cssText = "display: flex; gap: 6px; flex-wrap: wrap;";
  optionsCol.appendChild(row);
  return row;
}

function optionButton(
  row: HTMLElement,
  field: keyof Appearance,
  value: number,
  css: string,
): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.style.cssText =
    "border: 2px solid rgba(255,255,255,0.25); border-radius: 6px; cursor: pointer;" +
    `background: rgba(10,10,16,0.55); transition: border-color 0.1s; padding: 0; ${css}`;
  el.addEventListener("click", () => {
    selected[field] = value;
    refreshCreator();
  });
  row.appendChild(el);
  optionButtons.push({ field, value, el });
  return el;
}

{
  const toneRow = optionRow("Skin");
  for (let tone = 0; tone < SKIN_TONES.length; tone++) {
    const el = optionButton(toneRow, "tone", tone, "width: 26px; height: 26px;");
    el.style.background = SKIN_TONES[tone];
  }

  const hairRow = optionRow("Hair");
  for (let style = 0; style < HAIR_STYLES; style++) {
    const el = optionButton(hairRow, "hair", style, "padding: 2px 3px; line-height: 0;");
    const mini = document.createElement("canvas");
    mini.width = 16;
    mini.height = 32;
    mini.style.cssText = "width: 28px; height: 56px; image-rendering: pixelated;";
    el.appendChild(mini);
    hairMinis.push({ style, canvas: mini });
  }

  const colorRow = optionRow("Hair color");
  for (let color = 0; color < HAIR_COLORS.length; color++) {
    const el = optionButton(colorRow, "hairColor", color, "width: 26px; height: 26px;");
    el.style.background = HAIR_COLORS[color];
  }

  const shirtRow = optionRow("Shirt");
  for (let shirt = 0; shirt < SHIRT_COLORS.length; shirt++) {
    const el = optionButton(shirtRow, "shirt", shirt, "width: 26px; height: 26px;");
    el.style.background = SHIRT_COLORS[shirt];
  }

  const pantsRow = optionRow("Pants");
  for (let pants = 0; pants < PANTS_COLORS.length; pants++) {
    const el = optionButton(pantsRow, "pants", pants, "width: 26px; height: 26px;");
    el.style.background = PANTS_COLORS[pants];
  }
}

refreshCreator();

const playButton = document.createElement("button");
playButton.type = "button";
playButton.textContent = "Play";
playButton.style.cssText =
  `width: 100%; padding: 9px 0; font: ${UI_FONT}; font-size: 14px; font-weight: 700;` +
  "color: #08130a; background: rgba(120,220,120,0.9); border: none; border-radius: 6px;" +
  "cursor: pointer;";
playButton.addEventListener("click", () => {
  const look = currentLook();
  chosenLook = look;
  characterChosen = true;
  try {
    localStorage.setItem(LOOK_STORAGE_KEY, String(look));
  } catch {
    // storage can be unavailable in some embeds; the pick still applies
  }
  dressRig(selfRig, look, myArmor);
  sendSkinChoice();
  creatorBackdrop.style.display = "none";
  // the click is a user gesture: enter the game pointer-locked like the
  // inventory close path; the grace window swallows the re-lock click if
  // the browser refuses
  noa.container.setPointerLock(true);
  fireSuppressedUntil = performance.now() + 1500;
});
creatorPanel.appendChild(playButton);

/*
 *      Networking
 */

let myId = "";

let streamEventsSeen = 0;
const streamEventLog: string[] = [];

function logStreamEvent(tag: string): void {
  streamEventLog.push(`${streamEventsSeen}:${tag}`);
  if (streamEventLog.length > 60) {
    streamEventLog.shift();
  }
}

async function readStreams(): Promise<void> {
  while (true) {
    const event = await client.streams.recv();
    streamEventsSeen += 1;
    try {
      handleStreamEvent(event);
    } catch (error) {
      // a bad message must never kill the reader: every later stream
      // message (edits, inventory, swings) would be silently lost
      console.error("stream handler error", error);
    }
  }
}

function handleStreamEvent(event: { bytes: Uint8Array; json<T = unknown>(): T }): void {
  {
    const chunkState = decodeChunkState(event.bytes);
    if (chunkState) {
      logStreamEvent(`chunkState(${chunkState.cx},${chunkState.cz})x${chunkState.edits.length}`);
      applyChunkState(chunkState);
      return;
    }
    const raw = safeJson(event) as Record<string, unknown> | undefined;
    logStreamEvent(
      String(raw?.type ?? `binary[${event.bytes[0]},${event.bytes[1]}]len${event.bytes.length}`),
    );
    if (raw && raw.type === "debugState") {
      lastServerDebug = raw;
      return;
    }
    const message = parseServerStreamMessage(raw);
    if (!message) {
      return;
    }
    if (message.type === "edit") {
      applyEdit(message);
    } else if (message.type === "damage") {
      const block = noa.getBlock(message.x, message.y, message.z);
      playSoundAt(blockSoundFamily(block, "dig"), message.x, message.y, message.z, 0.8);
      updateBlockDamage(message.x, message.y, message.z, message.hp, message.maxHp);
      showNotice(
        `${itemName(blockToItem(noa.getBlock(message.x, message.y, message.z)))}: ${message.maxHp - message.hp}/${message.maxHp}`,
      );
    } else if (message.type === "swing") {
      const remote = remotePlayers.get(message.id);
      if (remote) {
        remote.swingT = 1;
        remoteSwingsSeen += 1;
        const dist = Math.hypot(remote.target.x - predicted.x, remote.target.z - predicted.z);
        if (dist < 16) {
          playWhoosh(0.12 * Math.max(0, 1 - dist / 16));
        }
      }
    } else if (message.type === "hurt") {
      if (message.id === myId) {
        flashHurt(0.35 + message.amount * 0.1);
        playSound("impactPunch_medium", 1);
      } else {
        const remote = remotePlayers.get(message.id);
        if (remote) {
          remote.hurtUntil = performance.now() + 200;
          playSoundAt("impactPunch_medium", remote.target.x, remote.target.y, remote.target.z, 0.8);
        }
      }
    } else if (message.type === "death") {
      lastDeath = { victim: message.victim, attacker: message.attacker };
      const victimName =
        message.victim === myId ? "You" : (playerNames.get(message.victim) ?? "Player");
      const attackerName =
        message.attacker === myId ? "you" : (playerNames.get(message.attacker) ?? "a player");
      showNotice(
        // a victim who is their own attacker died to the world (fall damage)
        message.victim === message.attacker
          ? `${victimName} fell from a great height${message.victim === myId ? "!" : ""}`
          : message.victim === myId
            ? `You were slain by ${attackerName}!`
            : `${victimName} was slain by ${attackerName}`,
      );
      if (message.victim === myId) {
        flashHurt(1);
      }
    } else if (message.type === "inventory") {
      invSlots = message.slots
        .slice(0, INV_SLOTS + ARMOR_SLOTS)
        .map((entry) => (entry ? { item: entry.i, count: entry.n } : null));
      while (invSlots.length < INV_SLOTS + ARMOR_SLOTS) {
        invSlots.push(null);
      }
      // our own armor rides the inventory's wear slots; repaint on change
      const wornPack = packArmor(invSlots);
      if (wornPack !== myArmor) {
        myArmor = wornPack;
        dressRig(selfRig, selfRig.look, myArmor);
      }
      const invTotal = invSlots.reduce((sum, slot) => sum + (slot ? slot.count : 0), 0);
      if (lastInvTotal >= 0 && invTotal > lastInvTotal) {
        playPop(0.5);
      }
      lastInvTotal = invTotal;
      // mirror the authoritative crafting grid (size 0 when closed)
      craftSize = message.craft.size;
      craftGrid = message.craft.grid.map((entry) =>
        entry ? { item: entry.i, count: entry.n } : null,
      );
      // the stack in the selected slot may have changed or moved
      syncEquipped();
      updateHud();
    } else if (message.type === "welcome") {
      applyWorldSeed(message.seed);
      for (const entry of message.players) {
        playerNames.set(entry.id, entry.name);
        setPlayerLook(entry.id, entry.skin);
        setPlayerArmor(entry.id, entry.armor);
      }
      updateHud();
    } else if (message.type === "join") {
      playerNames.set(message.id, message.name);
      setPlayerLook(message.id, message.skin);
      setPlayerArmor(message.id, message.armor);
      updateHud();
    } else if (message.type === "skin") {
      setPlayerLook(message.id, message.skin);
    } else if (message.type === "armor") {
      setPlayerArmor(message.id, message.armor);
    } else if (message.type === "leave") {
      playerNames.delete(message.id);
      playerLooks.delete(message.id);
      playerArmor.delete(message.id);
      removeRemotePlayer(message.id);
    }
  }
}

async function readDatagrams(): Promise<void> {
  while (true) {
    const event = await client.datagrams.recv();
    try {
      handleDatagramEvent(event);
    } catch (error) {
      console.error("datagram handler error", error);
    }
  }
}

function handleDatagramEvent(event: { bytes: Uint8Array }): void {
  {
    const projectiles = decodeProjectiles(event.bytes);
    if (projectiles) {
      applyEntityViews(projectileViews, projectiles, "proj", 0.8);
      return;
    }
    const drops = decodeDrops(event.bytes);
    if (drops) {
      applyEntityViews(dropViews, drops, "drop", 0.7);
      return;
    }
    const npcs = decodeNpcs(event.bytes);
    if (npcs) {
      applyChickenViews(npcs);
      return;
    }
    const players = decodeSnapshots(event.bytes);
    if (!players || myId === "") {
      return;
    }
    const seen = new Set<string>();
    for (const player of players) {
      if (player.id === myId) {
        reconcile(player);
        continue;
      }
      seen.add(player.id);
      upsertRemotePlayer(player);
    }
    for (const id of remotePlayers.keys()) {
      if (!seen.has(id)) {
        removeRemotePlayer(id);
      }
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

async function connect(): Promise<void> {
  void readStreams().catch((error: unknown) => {
    console.error("stream reader died", error);
  });
  void readDatagrams().catch((error: unknown) => {
    console.error("datagram reader died", error);
  });
  void client.connection.then((connection) => {
    myId = connection.connectionId;
    myName = connection.userName;
    updateHud();
  });
  try {
    await client.ready;
    // let the datagram path warm up so the first inputs aren't dropped
    // while the transport settles (each early loss forces a rollback)
    await new Promise((resolve) => setTimeout(resolve, 300));
    connectionState = "connected";
    // a pick confirmed while still connecting waits here
    sendSkinChoice();
  } catch {
    connectionState = "disconnected";
  }
  updateHud();
  void client.closed.then(() => {
    connectionState = "disconnected";
    updateHud();
  });
}

void connect();

// Dev-only hook so game state can be inspected from the browser console.
declare global {
  interface Window {
    __voxels?: {
      noa: Engine;
      remoteCount(): number;
      remotes(): {
        id: string;
        name: string;
        item: number;
        hp: number;
        x: number;
        y: number;
        z: number;
      }[];
      equipped(): number;
      hp(): number;
      lastDeath(): { victim: string; attacker: string } | null;
      attack(target: string): void;
      swing(): number;
      suspendInput(ms: number): void;
      remoteSwingsSeen(): number;
      streamEventsSeen(): number;
      streamEventLog(): string[];
      requestServerDebug(): void;
      serverDebug(): Record<string, unknown> | null;
      projectileCount(): number;
      dropCount(): number;
      chickenCount(): number;
      chickens(): { id: number; x: number; y: number; z: number; faceY: number }[];
      inventory(): Record<string, number>;
      slots(): ({ item: number; count: number } | null)[];
      selectedSlot(): number;
      moveItem(from: number, to: number): void;
      inventoryOpen(): boolean;
      setInventoryOpen(on: boolean): void;
      sendHit(x: number, y: number, z: number): void;
      playerPosition(): number[];
      connectionState(): string;
      rollbacks(): number;
      lastRollback(): Record<string, unknown> | null;
      pendingInputs(): number;
      characterMeshes(): string[];
      blockAt(x: number, y: number, z: number): number;
      setBlockAt(block: number, x: number, y: number, z: number): void;
      hasEdit(x: number, y: number, z: number): boolean;
      editCount(): number;
      digTargeted(): void;
      soundsPlayed(): number;
      soundLog(): string[];
    };
  }
}

window.__voxels = {
  noa,
  remoteCount: () => remotePlayers.size,
  remotes: () =>
    [...remotePlayers.entries()].map(([id, remote]) => {
      const [x, y, z] = ents.getPosition(remote.entityId);
      return {
        id,
        name: playerNames.get(id) ?? "Player",
        item: remote.item,
        hp: remote.hp,
        x,
        y,
        z,
      };
    }),
  equipped: () => equippedItem,
  hp: () => myHp,
  lastDeath: () => lastDeath,
  attack: (target) => {
    void client.streams.send({ type: "attack", target }).catch(() => {});
  },
  swing: () => swingT,
  suspendInput: (ms) => {
    inputSuspendedUntil = performance.now() + ms;
  },
  remoteSwingsSeen: () => remoteSwingsSeen,
  streamEventsSeen: () => streamEventsSeen,
  streamEventLog: () => [...streamEventLog],
  requestServerDebug: () => {
    void client.streams.send({ type: "debug" }).catch(() => {});
  },
  serverDebug: () => lastServerDebug,
  projectileCount: () => projectileViews.size,
  dropCount: () => dropViews.size,
  chickenCount: () => chickenViews.size,
  chickens: () =>
    [...chickenViews.entries()].map(([id, view]) => {
      const [x, y, z] = ents.getPosition(view.entityId);
      return { id, x, y, z, faceY: view.faceY };
    }),
  inventory: () => {
    const totals: Record<string, number> = {};
    for (const slot of invSlots) {
      if (slot) {
        totals[String(slot.item)] = (totals[String(slot.item)] ?? 0) + slot.count;
      }
    }
    return totals;
  },
  slots: () => invSlots.map((slot) => (slot ? { ...slot } : null)),
  selectedSlot: () => selectedSlot,
  moveItem: (from, to) => moveItem(from, to, false),
  inventoryOpen: () => inventoryOpen,
  setInventoryOpen: (on) => setInventoryOpen(on),
  sendHit: (x, y, z) => {
    void client.streams.send({ type: "hit", x, y, z }).catch(() => {});
  },
  playerPosition: () => [predicted.x, predicted.y, predicted.z],
  connectionState: () => connectionState,
  rollbacks: () => rollbacks,
  lastRollback: () => lastRollback,
  pendingInputs: () => pending.length,
  characterMeshes: () => {
    const names: string[] = [];
    noa.rendering.getScene().traverse((obj) => {
      if (obj.name.endsWith("-root") && obj.visible) {
        names.push(obj.name);
      }
    });
    return names;
  },
  blockAt: (x, y, z) => noa.getBlock(x, y, z),
  setBlockAt: (block, x, y, z) => sendEdit(block, x, y, z),
  hasEdit: (x, y, z) => lookupEdit(x, y, z) !== undefined,
  editCount: () => [...editBuckets.values()].reduce((sum, bucket) => sum + bucket.size, 0),
  soundsPlayed: () => soundsPlayed,
  soundLog: () => [...soundLog],
  digTargeted: () => {
    if (noa.targetedBlock) {
      const [x, y, z] = noa.targetedBlock.position;
      sendEdit(0, x, y, z);
    }
  },
};
