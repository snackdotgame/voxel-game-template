import {
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  type MeshLambertMaterial,
  NearestFilter,
  type Object3D,
} from "three";
import { client } from "minion:client";
import { Engine } from "./noa/index.js";
import { disposeObject3D } from "./noa/lib/rendering.js";
import {
  type BlockEdit,
  type PlayerSnapshot,
  parseServerStreamMessage,
} from "./shared/messages.js";
import {
  type ProjectileSnapshot,
  decodeDrops,
  decodeProjectiles,
  decodeSnapshots,
  encodeInputs,
} from "./shared/netCodec.js";
import {
  AXE,
  HAND,
  HOTBAR_SLOTS,
  INV_SLOTS,
  MAX_HP,
  PICKAXE,
  ROCK,
  SHOVEL,
  SNOWBALL,
  blockToItem,
  hitDamage,
  isThrowable,
  itemName,
  itemToBlock,
  isBlockItem,
  requiresPickaxe,
  stackLimit,
  type InvSlot,
} from "./shared/items.js";
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
texMat("leaves", "leaves.png", true);
texMat("coal_ore", "coal_ore.png");
texMat("iron_ore", "iron_ore.png");
texMat("gold_ore", "gold_ore.png");
texMat("diamond_ore", "diamond_ore.png");

noa.registry.registerBlock(GRASS_ID, { material: ["grass_top", "dirt", "grass_side"] });
noa.registry.registerBlock(DIRT_ID, { material: "dirt" });
noa.registry.registerBlock(STONE_ID, { material: "stone" });
noa.registry.registerBlock(SAND_ID, { material: "sand" });
noa.registry.registerBlock(SNOW_ID, { material: ["snow", "dirt", "snow_side"] });
noa.registry.registerBlock(LOG_ID, { material: ["log_top", "log_top", "log_side"] });
noa.registry.registerBlock(LEAVES_ID, { material: "leaves", opaque: false });
noa.registry.registerBlock(COAL_ORE_ID, { material: "coal_ore" });
noa.registry.registerBlock(IRON_ORE_ID, { material: "iron_ore" });
noa.registry.registerBlock(GOLD_ORE_ID, { material: "gold_ore" });
noa.registry.registerBlock(DIAMOND_ORE_ID, { material: "diamond_ore" });
noa.registry.registerMaterial("water", { color: [0.25, 0.5, 0.95, 0.65] });
noa.registry.registerBlock(WATER_ID, { material: "water", fluid: true, opaque: false });

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

noa.world.on("worldDataNeeded", (id: string, data: ChunkData, x: number, y: number, z: number) => {
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
});

function applyEdit(edit: BlockEdit) {
  editBucket(chunkCoord(edit.x), chunkCoord(edit.z)).set(editKey(edit.x, edit.y, edit.z), edit);
  // the authoritative timeline has reached this coordinate; any local
  // prediction for it is superseded (our own echo arrives in order too)
  pendingEdits.delete(editKey(edit.x, edit.y, edit.z));
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

const skinImage = new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("failed to load character skin"));
  img.src = `${TEX}/character.png`;
});

function hueRotate(pixels: Uint8ClampedArray, degrees: number): void {
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) {
      continue;
    }
    const r = pixels[i] / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) {
      continue;
    }
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === r) {
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    } else if (max === g) {
      h = ((b - r) / d + 2) / 6;
    } else {
      h = ((r - g) / d + 4) / 6;
    }
    h = (h + degrees / 360) % 1;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number) => {
      let u = t;
      if (u < 0) u += 1;
      if (u > 1) u -= 1;
      if (u < 1 / 6) return p + (q - p) * 6 * u;
      if (u < 1 / 2) return q;
      if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
      return p;
    };
    pixels[i] = Math.round(channel(h + 1 / 3) * 255);
    pixels[i + 1] = Math.round(channel(h) * 255);
    pixels[i + 2] = Math.round(channel(h - 1 / 3) * 255);
  }
}

function drawSkin(texture: CanvasTexture, hueShiftDegrees: number): void {
  void skinImage.then((img) => {
    const canvas = texture.image as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 64, 32);
    ctx.drawImage(img, 0, 0);
    if (hueShiftDegrees !== 0) {
      // rows 16-32 hold the body, arms, and legs; the head keeps its skin tone
      const body = ctx.getImageData(0, 16, 64, 16);
      hueRotate(body.data, hueShiftDegrees);
      ctx.putImageData(body, 0, 16);
    }
    texture.needsUpdate = true;
  });
}

function makeSkinMaterial(name: string, hueShiftDegrees: number): MeshLambertMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 32;
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  drawSkin(texture, hueShiftDegrees);
  const material = noa.rendering.makeStandardMaterial(name);
  material.map = texture;
  return material;
}

// re-tint a rig's existing skin texture (used once our own id is known, so
// the outfit we see on ourselves matches what everyone else sees)
function tintRig(rig: Rig, hueShiftDegrees: number): void {
  const texture = rig.skin.map;
  if (texture instanceof CanvasTexture) {
    drawSkin(texture, hueShiftDegrees);
  }
}

function buildRig(name: string, hueShiftDegrees: number): Rig {
  console.debug(`[rig] build ${name} hue=${hueShiftDegrees}`);
  const root = new Group();
  root.name = `${name}-root`;
  const body = new Group();
  body.name = `${name}-body`;
  root.add(body);
  const material = makeSkinMaterial(name, hueShiftDegrees);

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
  };
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

function hueForId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return 40 + (hash % 280);
}

/*
 *      Tools and equipment
 *
 *  Procedural box models held in the right hand. The equipped item id is
 *  sent to the server over the reliable stream and rebroadcast in the
 *  binary snapshots, so remote rigs hold the same tool.
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
];

function buildToolMesh(name: string, item: number): Group | null {
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
  const wood = colorMaterial("tool-wood", "#8a5a2b");
  const metal = colorMaterial("tool-metal", "#aab4be");
  const part = (
    label: string,
    w: number,
    h: number,
    d: number,
    material: ReturnType<typeof colorMaterial>,
    x: number,
    y: number,
    z: number,
    tiltZ = 0,
    tiltX = 0,
  ) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), material);
    mesh.name = `${name}-${label}`;
    root.add(mesh);
    mesh.position.set(x, y, z);
    mesh.rotation.z = tiltZ;
    mesh.rotation.x = tiltX;
  };

  if (item === ROCK) {
    part("rock", 0.22, 0.18, 0.2, colorMaterial("tool-rock", "#7d756b"), 0, 0, 0, 0.3);
    return root;
  }
  if (item === SNOWBALL) {
    part("snowball", 0.18, 0.18, 0.18, colorMaterial("tool-snow", "#eef3f6"), 0, 0, 0, 0.78);
    return root;
  }
  part("handle", 0.06, 0.55, 0.06, wood, 0, 0, 0);
  // tool heads live in the local Y-Z plane — the vertical swing plane once
  // held — so spikes/blades point fore-aft, not sideways (a pickaxe held
  // with a horizontal head reads as a hammer)
  if (item === PICKAXE) {
    part("hub", 0.07, 0.09, 0.14, metal, 0, 0.26, 0);
    part("tip-f", 0.06, 0.07, 0.2, metal, 0, 0.24, 0.15, 0, 0.45);
    part("tip-b", 0.06, 0.07, 0.2, metal, 0, 0.24, -0.15, 0, -0.45);
  } else if (item === AXE) {
    part("blade", 0.06, 0.2, 0.14, metal, 0, 0.23, 0.1);
  } else if (item === SHOVEL) {
    part("scoop", 0.13, 0.2, 0.06, metal, 0, 0.33, 0);
  }
  return root;
}

// rocks, snowballs, and blocks are origin-centered lumps cupped in the
// fist; handle tools have their grip half a handle-length below the origin
function isLumpItem(item: number): boolean {
  return item === ROCK || item === SNOWBALL || isBlockItem(item);
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

let equippedItem: number = HAND;
let firstPerson = false;
let swingT = 0;
// server-authoritative slot inventory, mirrored from inventory messages:
// 9 hotbar slots + 27 storage slots, each empty or one stack
let invSlots: InvSlot[] = Array.from({ length: INV_SLOTS }, () => null);
let selectedSlot = 0;
let inventoryOpen = false;

function heldStack(): InvSlot {
  return invSlots[selectedSlot] ?? null;
}

// first-person view model: arm + tool fixed to the camera. Camera space
// looks down -z in three.js, so "into the scene" is negative z; the
// values are the Babylon calibration with z (and x/y rotations) negated.
let viewModel: Group | null = null;
const VIEW_MODEL_POS: [number, number, number] = [0.42, -0.42, -1.1];

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
  const tool = buildToolMesh("view", equippedItem);
  if (tool) {
    root.add(tool);
    tool.traverse((mesh) => {
      mesh.frustumCulled = false;
    });
    if (isLumpItem(equippedItem)) {
      // cupped on top of the fist (the hand ends up near (0, -0.2, -0.11))
      tool.position.set(0, -0.08, -0.16);
      tool.rotation.set(-0.25, -0.4, 0.15);
    } else {
      // handle runs diagonally out of the fist toward upper-left, head
      // tipped away from the camera
      tool.position.set(-0.02, -0.06, -0.1);
      tool.rotation.set(-0.5, 0.2, 0.45);
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
  const dir = cameraForward();
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

const selfRig = buildRig("self", 0);
ents.addComponent(noa.playerEntity, ents.names.mesh, {
  mesh: selfRig.root,
  offset: [0, 0, 0],
});

noa.camera.zoomDistance = 6;
noa.on("tick", () => {
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
    heading: noa.camera.heading,
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
  // don't simulate (or burn input seqs) until the server can hear us;
  // both sides then start the spawn fall from the same first input
  if (connectionState !== "connected" || performance.now() < inputSuspendedUntil) {
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

  const rig = buildRig(`remote-${snap.id}`, hueForId(snap.id));
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

noa.on("beforeRender", () => {
  const now = performance.now();
  const dtSec = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
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
  selfRig.root.rotation.y = Math.PI - noa.camera.heading;
  const selfSpeed = Math.hypot(predicted.vx, predicted.vz);
  const selfMoving = onGround(predicted) && selfSpeed > 0.4;
  animateRig(selfRig, selfSpeed, onGround(predicted), dtSec, swingT > 0);

  // swing: third person uses the ported HitAnimation; first person uses
  // minecraft-web-client's hand-swing parameter set (scaled to our model)
  if (swingT > 0) {
    swingT = Math.max(0, swingT - dtSec * 3.1); // one swing ~= 0.32s, like MC
    applySwingToRig(selfRig, swingT, selfMoving);
    if (viewModel) {
      const p = 1 - swingT;
      const sqrtP = Math.sqrt(p);
      const sinP = Math.sin(p * Math.PI);
      const sinSqrtP = Math.sin(sqrtP * Math.PI);
      const sin2SqrtP = Math.sin(sqrtP * Math.PI * 2);
      const S = 0.5;
      viewModel.position.x = VIEW_MODEL_POS[0] - 0.8 * sinSqrtP * S;
      viewModel.position.y = VIEW_MODEL_POS[1] + (0.2 * sin2SqrtP - 0.6 * p) * S;
      viewModel.position.z = VIEW_MODEL_POS[2] + 0.2 * sinP * S;
      viewModel.rotation.x = 0.5236 * sinP; // 30deg * sin(p*pi)
      viewModel.rotation.y = 0.3 + 0.6109 * sinSqrtP; // 35deg * sin(sqrt(p)*pi)
      viewModel.rotation.z = -0.0873 * sinP; // -5deg
    }
  } else if (viewModel) {
    viewModel.position.fromArray(VIEW_MODEL_POS);
    viewModel.rotation.set(0, 0.3, 0);
  }

  // projectiles: ease toward broadcast positions, tumbling as they fly
  const pt = 1 - Math.exp(-dtSec * 18);
  for (const view of projectileViews.values()) {
    const current = ents.getPosition(view.entityId);
    ents.setPosition(
      view.entityId,
      current[0] + (view.target.x - current[0]) * pt,
      current[1] + (view.target.y - current[1]) * pt,
      current[2] + (view.target.z - current[2]) * pt,
    );
    view.mesh.rotation.x += dtSec * 9;
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
  "LMB dig · RMB place held block · Q throw\n" +
  "E inventory · V first/third person · scroll zoom";

const crosshair = uiDiv(
  "top: 50%; left: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px;" +
    "background: radial-gradient(circle, rgba(255,255,255,0.9) 2px, transparent 3px);",
);
void crosshair;

const toast = uiDiv(
  "bottom: 168px; left: 50%; transform: translateX(-50%); padding: 6px 14px;" +
    `font: ${UI_FONT}; font-size: 13px; color: #fff; background: rgba(20,20,28,0.8);` +
    "border-radius: 6px; opacity: 0; transition: opacity 0.25s;",
);

// pixel-art icons for the tool items, drawn once onto small canvases
const ICON_PALETTE: Record<string, string> = {
  b: "#8a5a2b",
  g: "#aab4be",
  r: "#7d756b",
  d: "#5c564e",
  w: "#f2f7fa",
  s: "#e0ac69",
};

const TOOL_ICONS: Record<number, string[]> = {
  [HAND]: ["", "", "..s.s.s.", ".sssssss", "ssssssss", ".sssssss", ".ssssss.", "..sssss."],
  [PICKAXE]: [
    "..gggggg..",
    ".gg....ggg",
    "g.....b..g",
    "......b...",
    ".....b....",
    "....b.....",
    "...b......",
    "..b.......",
    ".b........",
    "b.........",
  ],
  [AXE]: [
    "..ggg.....",
    ".ggggg....",
    ".gggggb...",
    ".ggg.b....",
    "..g.b.....",
    "....b.....",
    "...b......",
    "..b.......",
    ".b........",
    "b.........",
  ],
  [SHOVEL]: [
    "....gg....",
    "...gggg...",
    "...gggg...",
    "....gg....",
    "....b.....",
    "....b.....",
    "...b......",
    "...b......",
    "..b.......",
    "..b.......",
  ],
  [ROCK]: [
    "",
    "",
    "...rrr....",
    "..rrrrrr..",
    ".rrrdrrrr.",
    ".rrrrrrdr.",
    ".rdrrrrrr.",
    "..rrrrrr..",
    "...rrrr...",
  ],
  [SNOWBALL]: [
    "",
    "...wwww...",
    "..wwwwww..",
    ".wwwwwwww.",
    ".wwwswwww.",
    ".wwwwwwsw.",
    ".wswwwwww.",
    "..wwwwww..",
    "...wwww...",
  ],
};

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
];

function makeIconElement(item: number): Node {
  if (isBlockItem(item)) {
    const file = BLOCK_TEXTURE_FILES[itemToBlock(item)];
    if (file) {
      const img = document.createElement("img");
      img.src = `${TEX}/${file}`;
      img.style.cssText = "width: 28px; height: 28px; image-rendering: pixelated;";
      return img;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = 10;
  canvas.height = 10;
  canvas.style.cssText = "width: 30px; height: 30px; image-rendering: pixelated;";
  const ctx = canvas.getContext("2d");
  const rows = TOOL_ICONS[item];
  if (ctx && rows) {
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        const color = ICON_PALETTE[rows[y][x]];
        if (color) {
          ctx.fillStyle = color;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }
  return canvas;
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
}

// after the panel closes, a fire that arrives while the pointer is still
// unlocked is the user's re-lock click, not an attack
let fireSuppressedUntil = 0;

function setInventoryOpen(on: boolean): void {
  inventoryOpen = on;
  invBackdrop.style.display = on ? "flex" : "none";
  if (on) {
    document.exitPointerLock?.();
    updateInventoryPanel();
  } else {
    endDrag(null);
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

// the same merge-or-swap rule the server applies, run optimistically
function applyLocalMove(from: number, to: number): void {
  const source = invSlots[from];
  if (!source) {
    return;
  }
  const target = invSlots[to];
  if (target && target.item === source.item) {
    const take = Math.min(stackLimit(source.item) - target.count, source.count);
    target.count += take;
    source.count -= take;
    if (source.count === 0) {
      invSlots[from] = null;
    }
  } else {
    invSlots[from] = target;
    invSlots[to] = source;
  }
}

function moveItem(from: number, to: number): void {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= INV_SLOTS ||
    to >= INV_SLOTS ||
    !invSlots[from]
  ) {
    return;
  }
  applyLocalMove(from, to);
  syncEquipped();
  updateHud();
  void client.streams.send({ type: "invMove", from, to }).catch(() => {});
}

// drag and drop: pick a stack up on pointerdown, float its icon under the
// cursor, drop it on the slot under the pointer
let dragFrom = -1;
let dragGhost: HTMLDivElement | null = null;

function endDrag(ev: PointerEvent | null): void {
  if (dragFrom === -1) {
    return;
  }
  if (ev) {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const slotEl = under?.closest?.("[data-inv-slot]") as HTMLElement | null;
    if (slotEl?.dataset.invSlot !== undefined) {
      moveItem(dragFrom, Number(slotEl.dataset.invSlot));
    }
  }
  dragFrom = -1;
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
  if (ev.button !== 0) {
    return;
  }
  const slotEl = (ev.target as HTMLElement).closest?.("[data-inv-slot]") as HTMLElement | null;
  const index = slotEl ? Number(slotEl.dataset.invSlot) : -1;
  if (index < 0 || !invSlots[index]) {
    return;
  }
  ev.preventDefault();
  dragFrom = index;
  dragGhost = document.createElement("div");
  dragGhost.style.cssText =
    "position: fixed; z-index: 30; pointer-events: none; opacity: 0.85;" +
    "transform: translate(-50%, -50%);";
  dragGhost.appendChild(makeIconElement(invSlots[index].item));
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
noa.inputs.down.on("inventory", () => setInventoryOpen(!inventoryOpen));

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

noa.inputs.down.on("fire", () => primaryAction(false));

// hold to keep mining/attacking: re-trigger at swing cadence while held
setInterval(() => {
  const state = noa.inputs.state as Record<string, boolean>;
  if (state.fire === true && swingT <= 0 && !inventoryOpen) {
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
  swingT = 1;
  if (!noa.targetedBlock) {
    return;
  }
  const held = heldStack();
  if (!held || !isBlockItem(held.item)) {
    showNotice("Hold a block to place it — dig some, then grab it from a slot");
    return;
  }
  const [x, y, z] = noa.targetedBlock.adjacent;
  // optimistic placement, reconciled by the server's echo (or reverted)
  predictEdit(itemToBlock(held.item), x, y, z);
  void client.streams
    .send({ type: "place", item: held.item, slot: selectedSlot, x, y, z })
    .catch(() => {});
});

/*
 *      Networking
 */

let myId = "";
let myOutfitHue = 0;

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
      showNotice(
        `${itemName(blockToItem(noa.getBlock(message.x, message.y, message.z)))}: ${message.maxHp - message.hp}/${message.maxHp}`,
      );
    } else if (message.type === "swing") {
      const remote = remotePlayers.get(message.id);
      if (remote) {
        remote.swingT = 1;
        remoteSwingsSeen += 1;
      }
    } else if (message.type === "hurt") {
      if (message.id === myId) {
        flashHurt(0.35 + message.amount * 0.1);
      } else {
        const remote = remotePlayers.get(message.id);
        if (remote) {
          remote.hurtUntil = performance.now() + 200;
        }
      }
    } else if (message.type === "death") {
      lastDeath = { victim: message.victim, attacker: message.attacker };
      const victimName =
        message.victim === myId ? "You" : (playerNames.get(message.victim) ?? "Player");
      const attackerName =
        message.attacker === myId ? "you" : (playerNames.get(message.attacker) ?? "a player");
      showNotice(
        message.victim === myId
          ? `You were slain by ${attackerName}!`
          : `${victimName} was slain by ${attackerName}`,
      );
      if (message.victim === myId) {
        flashHurt(1);
      }
    } else if (message.type === "inventory") {
      invSlots = message.slots
        .slice(0, INV_SLOTS)
        .map((entry) => (entry ? { item: entry.i, count: entry.n } : null));
      while (invSlots.length < INV_SLOTS) {
        invSlots.push(null);
      }
      // the stack in the selected slot may have changed or moved
      syncEquipped();
      updateHud();
    } else if (message.type === "welcome") {
      for (const entry of message.players) {
        playerNames.set(entry.id, entry.name);
      }
      updateHud();
    } else if (message.type === "join") {
      playerNames.set(message.id, message.name);
      updateHud();
    } else if (message.type === "leave") {
      playerNames.delete(message.id);
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
    // wear the same outfit everyone else sees on us
    myOutfitHue = hueForId(myId);
    tintRig(selfRig, myOutfitHue);
    updateHud();
  });
  try {
    await client.ready;
    // let the datagram path warm up so the first inputs aren't dropped
    // while the transport settles (each early loss forces a rollback)
    await new Promise((resolve) => setTimeout(resolve, 300));
    connectionState = "connected";
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
  moveItem: (from, to) => moveItem(from, to),
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
  digTargeted: () => {
    if (noa.targetedBlock) {
      const [x, y, z] = noa.targetedBlock.position;
      sendEdit(0, x, y, z);
    }
  },
};
