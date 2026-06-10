import { Color3 } from "@babylonjs/core/Maths/math.color";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { client } from "minion:client";
import { Engine } from "noa-engine";
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
  encodeInput,
} from "./shared/netCodec.js";
import {
  AXE,
  HAND,
  ITEMS,
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
  return editBuckets.get(chunkKey(chunkCoord(x), chunkCoord(z)))?.get(editKey(x, y, z));
}

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
  noa.world.setChunkData(id, data);
});

function applyEdit(edit: BlockEdit) {
  editBucket(chunkCoord(edit.x), chunkCoord(edit.z)).set(editKey(edit.x, edit.y, edit.z), edit);
  noa.setBlock(edit.block, edit.x, edit.y, edit.z);
}

// A chunk-state packet carries the chunk's full current overrides, so the
// first (non-append) packet replaces whatever we had for that chunk.
function applyChunkState(state: ChunkState) {
  if (!state.append) {
    editBuckets.get(chunkKey(state.cx, state.cz))?.clear();
  }
  for (const edit of state.edits) {
    applyEdit(edit);
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

const scene = noa.rendering.getScene();
// widen the default ~46° vertical FOV; it reads badly zoomed-in up close
noa.rendering.camera.fov = 1.25;

const SKIN_PX = 0.05625; // world units per skin pixel: 32px of parts -> 1.8 blocks

type Rig = {
  root: Mesh;
  leftArm: TransformNode;
  rightArm: TransformNode;
  leftLeg: TransformNode;
  rightLeg: TransformNode;
  body: TransformNode;
  phase: number;
  idleT: number;
  tool: Mesh | null;
};

// pixel rects (x0, y0, x1, y1 from top-left) in the classic 64x32 skin layout,
// ordered to match CreateBox faceUV: [+z front, -z back, +x, -x, top, bottom]
type FaceRects = number[][];
const HEAD_FACES: FaceRects = [
  [8, 8, 16, 16],
  [24, 8, 32, 16],
  [0, 8, 8, 16],
  [16, 8, 24, 16],
  [8, 0, 16, 8],
  [16, 0, 24, 8],
];
const BODY_FACES: FaceRects = [
  [20, 20, 28, 32],
  [32, 20, 40, 32],
  [16, 20, 20, 32],
  [28, 20, 32, 32],
  [20, 16, 28, 20],
  [28, 16, 36, 20],
];
const ARM_FACES: FaceRects = [
  [44, 20, 48, 32],
  [52, 20, 56, 32],
  [40, 20, 44, 32],
  [48, 20, 52, 32],
  [44, 16, 48, 20],
  [48, 16, 52, 20],
];
const LEG_FACES: FaceRects = [
  [4, 20, 8, 32],
  [12, 20, 16, 32],
  [0, 20, 4, 32],
  [8, 20, 12, 32],
  [4, 16, 8, 20],
  [8, 16, 12, 20],
];

function faceUVs(rects: FaceRects): Vector4[] {
  return rects.map(([x0, y0, x1, y1]) => new Vector4(x0 / 64, 1 - y1 / 32, x1 / 64, 1 - y0 / 32));
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

function makeSkinMaterial(name: string, hueShiftDegrees: number) {
  const texture = new DynamicTexture(
    `${name}-skin`,
    { width: 64, height: 32 },
    scene,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  void skinImage.then((img) => {
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 64, 32);
    ctx.drawImage(img, 0, 0);
    if (hueShiftDegrees !== 0) {
      // rows 16-32 hold the body, arms, and legs; the head keeps its skin tone
      const body = ctx.getImageData(0, 16, 64, 16);
      hueRotate(body.data, hueShiftDegrees);
      ctx.putImageData(body, 0, 16);
    }
    texture.update();
  });
  const material = noa.rendering.makeStandardMaterial(name);
  material.diffuseTexture = texture;
  return material;
}

function buildRig(name: string, hueShiftDegrees: number): Rig {
  const root = new Mesh(`${name}-root`, scene);
  const body = new TransformNode(`${name}-body`, scene);
  body.parent = root;
  const material = makeSkinMaterial(name, hueShiftDegrees);

  const box = (
    part: string,
    pxW: number,
    pxH: number,
    pxD: number,
    rects: FaceRects,
    parent: TransformNode,
    yInParent: number,
  ) => {
    const mesh = CreateBox(
      `${name}-${part}`,
      {
        width: pxW * SKIN_PX,
        height: pxH * SKIN_PX,
        depth: pxD * SKIN_PX,
        faceUV: faceUVs(rects),
        wrap: true,
      },
      scene,
    );
    mesh.material = material;
    mesh.parent = parent;
    mesh.position.y = yInParent;
    return mesh;
  };

  // proportions: 12px legs + 12px torso + 8px head = 32px -> 1.8 blocks
  box("torso", 8, 12, 4, BODY_FACES, body, 1.0125);
  box("head", 8, 8, 8, HEAD_FACES, body, 1.575);

  const limb = (part: string, rects: FaceRects, pivotY: number, xOff: number) => {
    const pivot = new TransformNode(`${name}-${part}-pivot`, scene);
    pivot.parent = body;
    pivot.position.set(xOff, pivotY, 0);
    box(part, 4, 12, 4, rects, pivot, -0.3375);
    return pivot;
  };

  const rig: Rig = {
    root,
    body,
    leftArm: limb("left-arm", ARM_FACES, 1.305, -0.3375),
    rightArm: limb("right-arm", ARM_FACES, 1.305, 0.3375),
    leftLeg: limb("left-leg", LEG_FACES, 0.675, -0.1125),
    rightLeg: limb("right-leg", LEG_FACES, 0.675, 0.1125),
    phase: 0,
    idleT: 0,
    tool: null,
  };

  // noa renders through an octree selection; the mesh component only
  // registers the root, so each child part must be registered too.
  for (const part of root.getChildMeshes()) {
    noa.rendering.addMeshToScene(part);
  }
  return rig;
}

// Walk cycle after Minecraft-classic / ClassiCube: cosine limb swing with
// legs at ~1.4x the arm amplitude in opposite phase, scaled by speed, plus
// a subtle idle breathing sway on the arms.
function animateRig(rig: Rig, speed: number, grounded: boolean, dtSec: number) {
  rig.idleT += dtSec;
  const amount = Math.min(1, speed / 6);
  if (amount > 0.05) {
    rig.phase += dtSec * (4 + speed * 1.3);
  }

  let legTarget = 0;
  let armTarget = 0;
  let legSplit = -1; // -1: opposite-phase swing, +1: same pose both legs
  if (!grounded) {
    // airborne: legs scissor slightly, arms trail up
    legTarget = 0.35;
    armTarget = -0.55;
    legSplit = 1;
    rig.body.position.y = 0;
  } else {
    const cycle = Math.cos(rig.phase);
    legTarget = cycle * 1.3 * amount;
    armTarget = -cycle * 0.9 * amount;
    rig.body.position.y = Math.abs(cycle) * 0.045 * amount;
  }

  // idle sway: arms splay out and breathe a little (always on, scaled down
  // while moving so it doesn't fight the walk swing)
  const idle = 1 - amount * 0.7;
  const swayZ = (Math.cos(rig.idleT * 1.7) * 0.025 + 0.05) * idle;
  const swayX = Math.sin(rig.idleT * 1.3) * 0.04 * idle;

  const blend = 1 - Math.exp(-dtSec * 16);
  const ease = (node: TransformNode, x: number, z: number) => {
    node.rotation.x += (x - node.rotation.x) * blend;
    node.rotation.z += (z - node.rotation.z) * blend;
  };
  ease(rig.leftLeg, legTarget, 0);
  ease(rig.rightLeg, legTarget * legSplit * -1, 0);
  ease(rig.leftArm, armTarget + swayX, -swayZ);
  ease(rig.rightArm, -armTarget + swayX, swayZ);
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

const materialCache = new Map<string, ReturnType<typeof makeSkinMaterial>>();

function colorMaterial(name: string, hex: string) {
  let material = materialCache.get(name);
  if (!material) {
    material = noa.rendering.makeStandardMaterial(name);
    const color = Color3.FromHexString(hex);
    material.diffuseColor = color;
    material.ambientColor = color;
    // matte: the default white specular washes near-camera meshes out
    material.specularColor = Color3.Black();
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

function buildToolMesh(name: string, item: number): Mesh | null {
  if (item === HAND) {
    return null;
  }
  const root = new Mesh(`${name}-item`, scene);
  if (isBlockItem(item)) {
    const block = itemToBlock(item);
    const color = BLOCK_COLORS[block] ?? "#bbbbbb";
    const mesh = CreateBox(`${name}-block`, { size: 0.34 }, scene);
    mesh.material = colorMaterial(`block-item-${block}`, color);
    mesh.parent = root;
    noa.rendering.addMeshToScene(mesh);
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
  ) => {
    const mesh = CreateBox(`${name}-${label}`, { width: w, height: h, depth: d }, scene);
    mesh.material = material;
    mesh.parent = root;
    mesh.position.set(x, y, z);
    mesh.rotation.z = tiltZ;
  };

  if (item === ROCK) {
    part("rock", 0.22, 0.18, 0.2, colorMaterial("tool-rock", "#7d756b"), 0, 0, 0, 0.3);
    for (const mesh of root.getChildMeshes()) {
      noa.rendering.addMeshToScene(mesh);
    }
    return root;
  }
  if (item === SNOWBALL) {
    part("snowball", 0.18, 0.18, 0.18, colorMaterial("tool-snow", "#eef3f6"), 0, 0, 0, 0.78);
    for (const mesh of root.getChildMeshes()) {
      noa.rendering.addMeshToScene(mesh);
    }
    return root;
  }
  part("handle", 0.06, 0.55, 0.06, wood, 0, 0, 0);
  if (item === PICKAXE) {
    part("head", 0.44, 0.07, 0.07, metal, 0, 0.28, 0);
    part("tip-l", 0.14, 0.06, 0.06, metal, -0.26, 0.22, 0, 0.9);
    part("tip-r", 0.14, 0.06, 0.06, metal, 0.26, 0.22, 0, -0.9);
  } else if (item === AXE) {
    part("blade", 0.2, 0.18, 0.06, metal, 0.13, 0.24, 0);
  } else if (item === SHOVEL) {
    part("scoop", 0.15, 0.2, 0.08, metal, 0, 0.33, 0);
  }
  for (const mesh of root.getChildMeshes()) {
    noa.rendering.addMeshToScene(mesh);
  }
  return root;
}

function attachToolToRig(rig: Rig, name: string, item: number): void {
  rig.tool?.dispose();
  rig.tool = buildToolMesh(name, item);
  if (rig.tool) {
    rig.tool.parent = rig.rightArm;
    rig.tool.position.set(0, -0.6, 0.1);
    rig.tool.rotation.x = -Math.PI * 0.45;
  }
}

let equippedItem: number = HAND;
let firstPerson = false;
let swingT = 0;
// server-authoritative inventory, mirrored from inventory stream messages
const inventory = new Map<number, number>();

function invCount(item: number): number {
  return inventory.get(item) ?? 0;
}

// first-person view model: arm + tool fixed to the camera
let viewModel: Mesh | null = null;
const VIEW_MODEL_POS: [number, number, number] = [0.42, -0.42, 1.1];

function refreshViewModel(): void {
  viewModel?.dispose();
  viewModel = null;
  if (!firstPerson) {
    return;
  }
  const root = new Mesh("view-model", scene);
  const arm = CreateBox("view-arm", { width: 0.1, height: 0.1, depth: 0.35 }, scene);
  arm.material = colorMaterial("view-skin", "#e0ac69");
  arm.parent = root;
  arm.position.set(0, -0.1, -0.14);
  arm.rotation.x = 0.35;
  const tool = buildToolMesh("view", equippedItem);
  if (tool) {
    tool.parent = root;
    tool.position.set(0, 0.08, 0.05);
    tool.rotation.set(-Math.PI * 0.38, -0.6, 0.15);
  }
  root.scaling.setAll(0.9);
  root.parent = noa.rendering.camera;
  root.position.fromArray(VIEW_MODEL_POS);
  root.rotation.y = -0.3;
  for (const mesh of root.getChildMeshes()) {
    noa.rendering.addMeshToScene(mesh);
  }
  viewModel = root;
}

function setEquipped(item: number): void {
  if (item === equippedItem) {
    return;
  }
  if (item !== HAND && invCount(item) <= 0) {
    showNotice(`No ${itemName(item)} in your inventory`);
    return;
  }
  equippedItem = item;
  attachToolToRig(selfRig, "self", item);
  refreshViewModel();
  void client.streams.send({ type: "equip", item }).catch(() => {});
  updateHud();
}

function setFirstPerson(on: boolean): void {
  firstPerson = on;
  noa.camera.zoomDistance = on ? 0 : 6;
  selfRig.root.setEnabled(!on);
  refreshViewModel();
  updateHud();
}

for (let slot = 0; slot < ITEMS.length; slot++) {
  noa.inputs.bind(`hotbar-${slot + 1}`, `Digit${slot + 1}`);
  noa.inputs.down.on(`hotbar-${slot + 1}`, () => setEquipped(slot));
}
noa.inputs.bind("toggle-view", "KeyV");
noa.inputs.down.on("toggle-view", () => setFirstPerson(!firstPerson));

// throw the equipped item along the camera's view direction (Q / middle mouse)
noa.inputs.down.on("mid-fire", () => {
  if (!isThrowable(equippedItem)) {
    showNotice("Nothing throwable equipped — try the rock (5)");
    return;
  }
  if (invCount(equippedItem) <= 0) {
    showNotice(`Out of ${itemName(equippedItem)}s`);
    return;
  }
  swingT = 1;
  const dir = noa.rendering.camera.getForwardRay().direction;
  void client.streams.send({ type: "throw", dx: dir.x, dy: dir.y, dz: dir.z }).catch(() => {});
});

/*
 *      Projectiles: rendered from server broadcasts, interpolated and spun
 */

type ProjectileView = {
  entityId: number;
  mesh: Mesh;
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
    mesh.scaling.setAll(scale);
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

noa.inputs.bind("sprint", "ShiftLeft");

function sampleInput(): CharInput {
  const state = noa.inputs.state as Record<string, boolean>;
  return {
    seq: nextSeq++,
    heading: noa.camera.heading,
    fwd: state.forward === true,
    back: state.backward === true,
    left: state.left === true,
    right: state.right === true,
    jump: state.jump === true,
    sprint: state.sprint === true,
  };
}

function simTick(): void {
  const input = sampleInput();
  prevPredicted = predicted;
  predicted = step(predicted, input);
  pending.push({ input, state: predicted });
  if (pending.length > 200) {
    pending.splice(0, pending.length - 100);
  }
  void client.datagrams.send(encodeInput(input)).catch(() => {});
}

// Fixed-step accumulator driven from the render loop: if worldgen or GC
// stalls a frame, the sim runs catch-up steps instead of losing time.
// The burst is capped to match the server's per-tick input budget.
const MAX_CATCHUP_TICKS = 6;

// backup pump: occluded/backgrounded pages throttle rAF, which would starve
// the sim and stale-drop us server-side; a timer keeps inputs flowing
setInterval(() => {
  const sinceFrame = performance.now() - lastFrameAt;
  if (sinceFrame > 150) {
    lastFrameAt = performance.now();
    pumpSim(Math.min(sinceFrame, 1000));
  }
}, 120);

function pumpSim(frameMs: number): void {
  // don't simulate (or burn input seqs) until the server can hear us;
  // both sides then start the spawn fall from the same first input
  if (connectionState !== "connected") {
    simAccumMs = 0;
    return;
  }
  simAccumMs = Math.min(simAccumMs + frameMs, SIM_TICK_MS * MAX_CATCHUP_TICKS);
  while (simAccumMs >= SIM_TICK_MS) {
    simAccumMs -= SIM_TICK_MS;
    simTick();
  }
}

function reconcile(snap: PlayerSnapshot) {
  const ackIndex = pending.findIndex((entry) => entry.input.seq === snap.lastSeq);
  if (ackIndex === -1) {
    if (pending.length > 0 && snap.lastSeq > pending[pending.length - 1].input.seq) {
      // server is ahead of everything we remember; adopt its state
      pending = [];
      predicted = cloneState(snap.state);
      prevPredicted = cloneState(snap.state);
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
  let state = cloneState(snap.state);
  for (const entry of pending) {
    state = step(state, entry.input);
    entry.state = state;
  }
  predicted = state;
  prevPredicted = cloneState(state);
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
};

const remotePlayers = new Map<string, RemotePlayer>();
// id -> display name, from the welcome roster and join messages
const playerNames = new Map<string, string>();

function upsertRemotePlayer(snap: PlayerSnapshot): void {
  const existing = remotePlayers.get(snap.id);
  if (existing) {
    existing.target = snap.state;
    existing.heading = snap.heading;
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
  remotePlayers.set(snap.id, {
    entityId,
    rig,
    target: snap.state,
    heading: snap.heading,
    item: snap.item,
  });
  updateHud();
}

function removeRemotePlayer(id: string): void {
  const remote = remotePlayers.get(id);
  if (!remote) {
    return;
  }
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

  // local player: interpolate between the last two predicted sim states
  const alpha = Math.max(0, Math.min(1, simAccumMs / SIM_TICK_MS));
  ents.setPosition(
    noa.playerEntity,
    prevPredicted.x + (predicted.x - prevPredicted.x) * alpha,
    prevPredicted.y + (predicted.y - prevPredicted.y) * alpha,
    prevPredicted.z + (predicted.z - prevPredicted.z) * alpha,
  );
  selfRig.root.rotation.y = noa.camera.heading;
  animateRig(selfRig, Math.hypot(predicted.vx, predicted.vz), onGround(predicted), dtSec);

  // use animation: fast wind-up chop that eases back (sqrt attack curve),
  // layered on top of the walk swing
  if (swingT > 0) {
    swingT = Math.max(0, swingT - dtSec * 5);
    const p = 1 - swingT;
    const chop = Math.sin(Math.sqrt(p) * Math.PI);
    const reach = Math.sin(p * Math.PI);
    selfRig.rightArm.rotation.x -= chop * 1.9;
    selfRig.rightArm.rotation.z += reach * 0.25;
    if (viewModel) {
      viewModel.rotation.x = -chop * 0.85;
      viewModel.rotation.z = -reach * 0.2;
      viewModel.position.y = VIEW_MODEL_POS[1] - chop * 0.1;
      viewModel.position.z = VIEW_MODEL_POS[2] + reach * 0.3;
    }
  } else if (viewModel) {
    viewModel.rotation.x = 0;
    viewModel.rotation.z = 0;
    viewModel.position.y = VIEW_MODEL_POS[1];
    viewModel.position.z = VIEW_MODEL_POS[2];
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

  // remote players: ease toward their latest authoritative state
  const t = 1 - Math.exp(-dtSec * 12);
  for (const remote of remotePlayers.values()) {
    const current = ents.getPosition(remote.entityId);
    ents.setPosition(
      remote.entityId,
      current[0] + (remote.target.x - current[0]) * t,
      current[1] + (remote.target.y - current[1]) * t,
      current[2] + (remote.target.z - current[2]) * t,
    );
    remote.rig.root.rotation.y = remote.heading;
    animateRig(
      remote.rig,
      Math.hypot(remote.target.vx, remote.target.vz),
      onGround(remote.target),
      dtSec,
    );
  }
});

/*
 *      HUD
 */

const hud = document.createElement("div");
hud.style.cssText =
  "position: fixed; top: 10px; right: 10px; z-index: 10; padding: 8px 12px;" +
  "font: 13px/1.5 system-ui, sans-serif; color: #fff; background: rgba(0,0,0,0.55);" +
  "border-radius: 6px; pointer-events: none; white-space: pre;";
document.body.appendChild(hud);

const crosshair = document.createElement("div");
crosshair.style.cssText =
  "position: fixed; top: 50%; left: 50%; z-index: 10; width: 14px; height: 14px;" +
  "margin: -7px 0 0 -7px; pointer-events: none;" +
  "background: radial-gradient(circle, rgba(255,255,255,0.9) 2px, transparent 3px);";
document.body.appendChild(crosshair);

let connectionState = "connecting";
let myName = "";
let notice = "";
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function showNotice(text: string): void {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = "";
    updateHud();
  }, 1800);
  updateHud();
}

function updateHud(): void {
  const others = [...remotePlayers.keys()].map((id) => playerNames.get(id) ?? "Player");
  const hotbar = ITEMS.map((name, i) =>
    i === equippedItem ? `[${i + 1} ${name}]` : ` ${i + 1} ${name} `,
  ).join(" ");
  const bag = [...inventory.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([item, count]) => `${itemName(item)}×${count}`)
    .slice(0, 10)
    .join("  ");
  hud.textContent =
    `Noa Voxels — ${connectionState}` +
    (myName ? ` as ${myName}` : "") +
    `\nPlayers here: ${remotePlayers.size + 1}` +
    (others.length > 0 ? ` (also: ${others.join(", ")})` : "") +
    `\nPrediction rollbacks: ${rollbacks}` +
    `\n${hotbar}` +
    `\nBag: ${bag || "empty"}` +
    `\nWASD move, shift sprint, space jump, V ${firstPerson ? "third" : "first"}-person` +
    "\nLeft-click dig, right-click/E place, Q throw, scroll zoom" +
    (notice ? `\n>> ${notice}` : "");
}
updateHud();

/*
 *      Block interaction
 */

let placeBlock = DIRT_ID;

function sendEdit(block: number, x: number, y: number, z: number): void {
  applyEdit({ block, x, y, z });
  void client.streams.send({ type: "edit", block, x, y, z }).catch(() => {});
}

noa.inputs.down.on("fire", () => {
  swingT = 1;
  if (!noa.targetedBlock) {
    return;
  }
  const block = noa.targetedBlock.blockID;
  if (hitDamage(equippedItem, block) <= 0) {
    showNotice(
      requiresPickaxe(block) ? "Too hard to dig by hand — equip the pickaxe (2)" : "Can't dig that",
    );
    return;
  }
  const [x, y, z] = noa.targetedBlock.position;
  // remember the last block type you worked on for placement
  placeBlock = block;
  void client.streams.send({ type: "hit", x, y, z }).catch(() => {});
});

noa.inputs.down.on("alt-fire", () => {
  swingT = 1;
  if (!noa.targetedBlock) {
    return;
  }
  const item = blockToItem(placeBlock);
  if (invCount(item) <= 0) {
    showNotice(`No ${itemName(item)} blocks to place — dig some first`);
    return;
  }
  const [x, y, z] = noa.targetedBlock.adjacent;
  void client.streams.send({ type: "place", item, x, y, z }).catch(() => {});
});

/*
 *      Networking
 */

let myId = "";

async function readStreams(): Promise<void> {
  while (true) {
    const event = await client.streams.recv();
    const chunkState = decodeChunkState(event.bytes);
    if (chunkState) {
      applyChunkState(chunkState);
      continue;
    }
    const message = parseServerStreamMessage(safeJson(event));
    if (!message) {
      continue;
    }
    if (message.type === "edit") {
      applyEdit(message);
    } else if (message.type === "damage") {
      showNotice(
        `${itemName(blockToItem(noa.getBlock(message.x, message.y, message.z)))}: ${message.maxHp - message.hp}/${message.maxHp}`,
      );
    } else if (message.type === "inventory") {
      inventory.clear();
      for (const [key, count] of Object.entries(message.items)) {
        inventory.set(Number(key), count);
      }
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
    const projectiles = decodeProjectiles(event.bytes);
    if (projectiles) {
      applyEntityViews(projectileViews, projectiles, "proj", 0.8);
      continue;
    }
    const drops = decodeDrops(event.bytes);
    if (drops) {
      applyEntityViews(dropViews, drops, "drop", 0.7);
      continue;
    }
    const players = decodeSnapshots(event.bytes);
    if (!players || myId === "") {
      continue;
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
  void readStreams().catch(() => {});
  void readDatagrams().catch(() => {});
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
      remotes(): { id: string; name: string; item: number; x: number; y: number; z: number }[];
      equipped(): number;
      projectileCount(): number;
      dropCount(): number;
      inventory(): Record<string, number>;
      sendHit(x: number, y: number, z: number): void;
      playerPosition(): number[];
      connectionState(): string;
      rollbacks(): number;
      lastRollback(): Record<string, unknown> | null;
      pendingInputs(): number;
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
      return { id, name: playerNames.get(id) ?? "Player", item: remote.item, x, y, z };
    }),
  equipped: () => equippedItem,
  projectileCount: () => projectileViews.size,
  dropCount: () => dropViews.size,
  inventory: () => Object.fromEntries(inventory),
  sendHit: (x, y, z) => {
    void client.streams.send({ type: "hit", x, y, z }).catch(() => {});
  },
  playerPosition: () => [predicted.x, predicted.y, predicted.z],
  connectionState: () => connectionState,
  rollbacks: () => rollbacks,
  lastRollback: () => lastRollback,
  pendingInputs: () => pending.length,
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
