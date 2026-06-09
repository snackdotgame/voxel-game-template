import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { client } from "minion:client";
import { Engine } from "noa-engine";
import {
  type BlockEdit,
  type PlayerState,
  parsePlayersMessage,
  parseServerStreamMessage,
} from "./shared/messages.js";

const POS_SEND_INTERVAL_MS = 50;

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

const grassID = noa.registry.registerBlock(1, { material: "grass" });
const dirtID = noa.registry.registerBlock(2, { material: "dirt" });
const stoneID = noa.registry.registerBlock(3, { material: "stone" });

// Edits received from the server, keyed "x,y,z", applied on top of the
// deterministic base terrain whenever a chunk (re)generates.
const worldEdits = new Map<string, BlockEdit>();

function terrainHeight(x: number, z: number): number {
  return Math.floor(2 * Math.sin(x / 10) + 3 * Math.cos(z / 14));
}

function baseVoxelID(x: number, y: number, z: number): number {
  const height = terrainHeight(x, z);
  if (y < height - 3) {
    return stoneID;
  }
  if (y < height) {
    return dirtID;
  }
  if (y === height) {
    return grassID;
  }
  return 0;
}

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
  worldEdits.set(`${edit.x},${edit.y},${edit.z}`, edit);
  noa.setBlock(edit.block, edit.x, edit.y, edit.z);
}

/*
 *      Player + remote player meshes
 */

const scene = noa.rendering.getScene();

function makePlayerMesh(name: string, color: Color3): Mesh {
  const mesh = CreateBox(name, {}, scene);
  const material = noa.rendering.makeStandardMaterial(`${name}-mat`);
  material.diffuseColor = color;
  mesh.material = material;
  return mesh;
}

const playerData = noa.entities.getPositionData(noa.playerEntity);
const playerWidth = playerData?.width ?? 0.6;
const playerHeight = playerData?.height ?? 1.8;

const playerMesh = makePlayerMesh("player-mesh", Color3.FromHexString("#ffb24d"));
playerMesh.scaling.set(playerWidth, playerHeight, playerWidth);
noa.entities.addComponent(noa.playerEntity, noa.entities.names.mesh, {
  mesh: playerMesh,
  offset: [0, playerHeight / 2, 0],
});

function colorForId(id: string): Color3 {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return Color3.FromHSV(hash % 360, 0.65, 0.9);
}

type RemotePlayer = {
  entityId: number;
  mesh: Mesh;
  name: string;
  target: [number, number, number];
  heading: number;
};

const remotePlayers = new Map<string, RemotePlayer>();

function upsertRemotePlayer(state: PlayerState): void {
  const existing = remotePlayers.get(state.id);
  if (existing) {
    existing.target = [state.x, state.y, state.z];
    existing.heading = state.heading;
    return;
  }

  const mesh = makePlayerMesh(`remote-${state.id}`, colorForId(state.id));
  mesh.scaling.set(playerWidth, playerHeight, playerWidth);
  const entityId = noa.entities.add(
    [state.x, state.y, state.z],
    playerWidth,
    playerHeight,
    mesh,
    [0, playerHeight / 2, 0],
    false,
    true,
  );
  remotePlayers.set(state.id, {
    entityId,
    mesh,
    name: state.name,
    target: [state.x, state.y, state.z],
    heading: state.heading,
  });
  updateHud();
}

function removeRemotePlayer(id: string): void {
  const remote = remotePlayers.get(id);
  if (!remote) {
    return;
  }
  remotePlayers.delete(id);
  noa.entities.deleteEntity(remote.entityId, true);
  updateHud();
}

noa.on("beforeRender", () => {
  for (const remote of remotePlayers.values()) {
    const current = noa.entities.getPosition(remote.entityId);
    const t = 0.25;
    noa.entities.setPosition(
      remote.entityId,
      current[0] + (remote.target[0] - current[0]) * t,
      current[1] + (remote.target[1] - current[1]) * t,
      current[2] + (remote.target[2] - current[2]) * t,
    );
    remote.mesh.rotation.y = remote.heading;
  }
});

/*
 *      HUD
 */

const hud = document.createElement("div");
hud.style.cssText =
  "position: fixed; top: 10px; left: 10px; z-index: 10; padding: 8px 12px;" +
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
    "\nClick to look, WASD to move, left-click dig, right-click/E place";
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
    sendEdit(dirtID, x, y, z);
  }
});

noa.inputs.bind("alt-fire", "KeyE");

/*
 *      Networking
 */

let myId = "";
let lastPosSentAt = 0;

noa.on("tick", () => {
  if (connectionState !== "connected") {
    return;
  }
  const now = performance.now();
  if (now - lastPosSentAt < POS_SEND_INTERVAL_MS) {
    return;
  }
  lastPosSentAt = now;
  const [x, y, z] = noa.entities.getPosition(noa.playerEntity);
  void client.datagrams.send({ type: "pos", x, y, z, heading: noa.camera.heading }).catch(() => {});
});

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
    if (!message) {
      continue;
    }
    const seen = new Set<string>();
    for (const player of message.players) {
      if (player.id === myId) {
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
      playerPosition(): number[];
      connectionState(): string;
      blockAt(x: number, y: number, z: number): number;
      digTargeted(): void;
    };
  }
}

window.__voxels = {
  noa,
  remoteCount: () => remotePlayers.size,
  playerPosition: () => [...noa.entities.getPosition(noa.playerEntity)],
  connectionState: () => connectionState,
  blockAt: (x, y, z) => noa.getBlock(x, y, z),
  digTargeted: () => {
    if (noa.targetedBlock) {
      const [x, y, z] = noa.targetedBlock.position;
      sendEdit(0, x, y, z);
    }
  },
};
