import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { client } from "minion:client";
import { Engine } from "noa-engine";
import {
  type BlockEdit,
  type PlayerSnapshot,
  parsePlayersMessage,
  parseServerStreamMessage,
} from "./shared/messages.js";
import {
  type CharInput,
  type CharState,
  SIM_TICK_MS,
  cloneState,
  spawnState,
  statesDiverge,
  stepCharacter,
} from "./shared/sim.js";
import {
  DIRT_ID,
  GRASS_ID,
  STONE_ID,
  baseVoxelID,
  editKey,
  makeIsSolid,
} from "./shared/terrain.js";

const noa = new Engine({
  debug: false,
  showFPS: false,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
  playerStart: [0.5, 16, 0.5],
});

/*
 *      Blocks and terrain
 */

noa.registry.registerMaterial("grass", { color: [0.32, 0.78, 0.36] });
noa.registry.registerMaterial("dirt", { color: [0.51, 0.38, 0.25] });
noa.registry.registerMaterial("stone", { color: [0.55, 0.56, 0.6] });

noa.registry.registerBlock(GRASS_ID, { material: "grass" });
noa.registry.registerBlock(DIRT_ID, { material: "dirt" });
noa.registry.registerBlock(STONE_ID, { material: "stone" });

// Edits received from the server, keyed "x,y,z", applied on top of the
// deterministic base terrain whenever a chunk (re)generates. The prediction
// sim collides against the same data via makeIsSolid.
const worldEdits = new Map<string, BlockEdit>();
const isSolid = makeIsSolid(worldEdits);

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
  for (const edit of worldEdits.values()) {
    const i = edit.x - x;
    const j = edit.y - y;
    const k = edit.z - z;
    if (i >= 0 && i < data.shape[0] && j >= 0 && j < data.shape[1] && k >= 0 && k < data.shape[2]) {
      data.set(i, j, k, edit.block);
    }
  }
  noa.world.setChunkData(id, data);
});

function applyEdit(edit: BlockEdit) {
  worldEdits.set(editKey(edit.x, edit.y, edit.z), edit);
  noa.setBlock(edit.block, edit.x, edit.y, edit.z);
}

/*
 *      Minecraft-style voxel character rig
 *
 *  Box body parts hung off pivot nodes so limbs swing from the
 *  shoulder/hip. Proportions follow the classic 8/12/12 pixel split
 *  of a 1.8-block-tall character. The rig root sits at the entity's
 *  bottom-center, facing +z at yaw 0.
 */

const scene = noa.rendering.getScene();

type Rig = {
  root: Mesh;
  leftArm: TransformNode;
  rightArm: TransformNode;
  leftLeg: TransformNode;
  rightLeg: TransformNode;
  body: TransformNode;
  phase: number;
};

type Palette = {
  skin: string;
  shirt: Color3;
  pants: string;
};

function makeMaterial(name: string, color: Color3) {
  const material = noa.rendering.makeStandardMaterial(name);
  material.diffuseColor = color;
  // noa defaults material ambient to white, which washes colors out
  // against the half-strength scene ambient; tint it with the part color.
  material.ambientColor = color;
  return material;
}

function buildRig(name: string, palette: Palette): Rig {
  const root = new Mesh(`${name}-root`, scene);
  const body = new TransformNode(`${name}-body`, scene);
  body.parent = root;

  const skin = makeMaterial(`${name}-skin`, Color3.FromHexString(palette.skin));
  const shirt = makeMaterial(`${name}-shirt`, palette.shirt);
  const pants = makeMaterial(`${name}-pants`, Color3.FromHexString(palette.pants));
  const eye = makeMaterial(`${name}-eye`, Color3.FromHexString("#2d2d3a"));

  const box = (
    part: string,
    w: number,
    h: number,
    d: number,
    material: ReturnType<typeof makeMaterial>,
    parent: TransformNode,
    yInParent: number,
  ) => {
    const mesh = CreateBox(`${name}-${part}`, { width: w, height: h, depth: d }, scene);
    mesh.material = material;
    mesh.parent = parent;
    mesh.position.y = yInParent;
    return mesh;
  };

  // torso: 0.5 x 0.675 x 0.25, from y 0.675 to 1.35
  box("torso", 0.5, 0.675, 0.25, shirt, body, 1.0125);

  // head: 0.45 cube on top, with eyes on the +z face
  const head = box("head", 0.45, 0.45, 0.45, skin, body, 1.575);
  for (const side of [-1, 1]) {
    const eyeBox = CreateBox(
      `${name}-eye${side}`,
      { width: 0.08, height: 0.08, depth: 0.03 },
      scene,
    );
    eyeBox.material = eye;
    eyeBox.parent = head;
    eyeBox.position.set(side * 0.1, 0.04, 0.225);
  }

  const limb = (
    part: string,
    pivotY: number,
    w: number,
    material: ReturnType<typeof makeMaterial>,
    xOff: number,
  ) => {
    const pivot = new TransformNode(`${name}-${part}-pivot`, scene);
    pivot.parent = body;
    pivot.position.set(xOff, pivotY, 0);
    box(part, w, 0.675, w, material, pivot, -0.3375);
    return pivot;
  };

  const rig: Rig = {
    root,
    body,
    leftArm: limb("left-arm", 1.305, 0.2, shirt, -0.35),
    rightArm: limb("right-arm", 1.305, 0.2, shirt, 0.35),
    leftLeg: limb("left-leg", 0.675, 0.22, pants, -0.125),
    rightLeg: limb("right-leg", 0.675, 0.22, pants, 0.125),
    phase: 0,
  };

  // noa renders through an octree selection; the mesh component only
  // registers the root, so each child part must be registered too.
  for (const part of root.getChildMeshes()) {
    noa.rendering.addMeshToScene(part);
  }
  return rig;
}

function animateRig(rig: Rig, speed: number, onGround: boolean, dtSec: number) {
  let legSwing: number;
  let armSwing: number;
  if (!onGround) {
    // airborne pose: legs tucked, arms slightly raised
    legSwing = 0.35;
    armSwing = -0.6;
    rig.body.position.y = 0;
  } else if (speed > 0.4) {
    rig.phase += dtSec * (3 + speed * 2.6);
    const amp = Math.min(1, speed / 4.5) * 0.85;
    legSwing = Math.sin(rig.phase) * amp;
    armSwing = -legSwing * 0.9;
    rig.body.position.y = Math.abs(Math.cos(rig.phase)) * 0.035;
  } else {
    legSwing = 0;
    armSwing = 0;
    rig.body.position.y = 0;
  }
  const blend = 1 - Math.exp(-dtSec * 14);
  rig.leftLeg.rotation.x += (legSwing - rig.leftLeg.rotation.x) * blend;
  rig.rightLeg.rotation.x += (-legSwing - rig.rightLeg.rotation.x) * blend;
  rig.leftArm.rotation.x += (armSwing - rig.leftArm.rotation.x) * blend;
  rig.rightArm.rotation.x += (-armSwing - rig.rightArm.rotation.x) * blend;
}

function colorForId(id: string): Color3 {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return Color3.FromHSV(hash % 360, 0.6, 0.85);
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

const selfRig = buildRig("self", {
  skin: "#e0ac69",
  shirt: Color3.FromHexString("#e98a2b"),
  pants: "#3d4a63",
});
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
let lastTickAt = performance.now();

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

setInterval(() => {
  const input = sampleInput();
  prevPredicted = predicted;
  predicted = stepCharacter(predicted, input, isSolid);
  pending.push({ input, state: predicted });
  if (pending.length > 200) {
    pending.splice(0, pending.length - 100);
  }
  lastTickAt = performance.now();
  if (connectionState === "connected") {
    void client.datagrams.send({ type: "input", ...input }).catch(() => {});
  }
}, SIM_TICK_MS);

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
  let state = cloneState(snap.state);
  for (const entry of pending) {
    state = stepCharacter(state, entry.input, isSolid);
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
  name: string;
  target: CharState;
  heading: number;
};

const remotePlayers = new Map<string, RemotePlayer>();

function upsertRemotePlayer(snap: PlayerSnapshot): void {
  const existing = remotePlayers.get(snap.id);
  if (existing) {
    existing.target = snap.state;
    existing.heading = snap.heading;
    return;
  }

  const rig = buildRig(`remote-${snap.id}`, {
    skin: "#e0ac69",
    shirt: colorForId(snap.id),
    pants: "#3d4a63",
  });
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
    name: snap.name,
    target: snap.state,
    heading: snap.heading,
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

  // local player: interpolate between the last two predicted sim states
  const alpha = Math.max(0, Math.min(1, (now - lastTickAt) / SIM_TICK_MS));
  ents.setPosition(
    noa.playerEntity,
    prevPredicted.x + (predicted.x - prevPredicted.x) * alpha,
    prevPredicted.y + (predicted.y - prevPredicted.y) * alpha,
    prevPredicted.z + (predicted.z - prevPredicted.z) * alpha,
  );
  selfRig.root.rotation.y = noa.camera.heading;
  animateRig(selfRig, Math.hypot(predicted.vx, predicted.vz), predicted.onGround, dtSec);

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
      remote.target.onGround,
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

function updateHud(): void {
  const others = [...remotePlayers.values()].map((remote) => remote.name);
  hud.textContent =
    `Noa Voxels — ${connectionState}` +
    (myName ? ` as ${myName}` : "") +
    `\nPlayers here: ${remotePlayers.size + 1}` +
    (others.length > 0 ? ` (also: ${others.join(", ")})` : "") +
    `\nPrediction rollbacks: ${rollbacks}` +
    "\nClick to look, WASD move, shift sprint, space jump" +
    "\nLeft-click dig, right-click/E place, scroll zoom";
}
updateHud();

/*
 *      Block interaction
 */

function sendEdit(block: number, x: number, y: number, z: number): void {
  applyEdit({ block, x, y, z });
  void client.streams.send({ type: "edit", block, x, y, z }).catch(() => {});
}

noa.inputs.down.on("fire", () => {
  if (noa.targetedBlock) {
    const [x, y, z] = noa.targetedBlock.position;
    sendEdit(0, x, y, z);
  }
});

noa.inputs.down.on("alt-fire", () => {
  if (noa.targetedBlock) {
    const [x, y, z] = noa.targetedBlock.adjacent;
    sendEdit(DIRT_ID, x, y, z);
  }
});

/*
 *      Networking
 */

let myId = "";

async function readStreams(): Promise<void> {
  while (true) {
    const event = await client.streams.recv();
    const message = parseServerStreamMessage(safeJson(event));
    if (!message) {
      continue;
    }
    if (message.type === "welcome") {
      for (const edit of message.edits) {
        applyEdit(edit);
      }
    } else if (message.type === "edit") {
      applyEdit(message);
    } else if (message.type === "leave") {
      removeRemotePlayer(message.id);
    }
  }
}

async function readDatagrams(): Promise<void> {
  while (true) {
    const event = await client.datagrams.recv();
    const message = parsePlayersMessage(safeJson(event));
    if (!message || myId === "") {
      continue;
    }
    const seen = new Set<string>();
    for (const player of message.players) {
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
      remotes(): { id: string; name: string; x: number; y: number; z: number }[];
      playerPosition(): number[];
      connectionState(): string;
      rollbacks(): number;
      pendingInputs(): number;
      blockAt(x: number, y: number, z: number): number;
      setBlockAt(block: number, x: number, y: number, z: number): void;
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
      return { id, name: remote.name, x, y, z };
    }),
  playerPosition: () => [predicted.x, predicted.y, predicted.z],
  connectionState: () => connectionState,
  rollbacks: () => rollbacks,
  pendingInputs: () => pending.length,
  blockAt: (x, y, z) => noa.getBlock(x, y, z),
  setBlockAt: (block, x, y, z) => sendEdit(block, x, y, z),
  digTargeted: () => {
    if (noa.targetedBlock) {
      const [x, y, z] = noa.targetedBlock.position;
      sendEdit(0, x, y, z);
    }
  },
};
