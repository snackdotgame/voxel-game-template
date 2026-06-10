import type { Engine } from "../index";
import type { Chunk } from "./chunk";
import { DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Object3D } from "three";
import { makeProfileHook } from "./util";

var PROFILE = 0;

/*
 *
 *          Object meshing
 *
 *      Per-chunk handling of the creation/disposal of static meshes
 *      associated with particular voxel IDs
 *
 *      Instance translations are stored in render coords (z negated),
 *      matching the terrain mesher's game->render boundary.
 *
 */

/** @internal */
export class ObjectMesher {
  /** group for all instance meshes to be parented to */
  rootNode: Group;

  /** list of known base meshes */
  allBaseMeshes: any[];

  initChunk: (chunk: Chunk) => void;
  setObjectBlock: (chunk: Chunk, blockID: number, i: number, j: number, k: number) => void;
  buildObjectMeshes: () => void;
  disposeChunk: (chunk: Chunk) => void;
  tick: () => void;
  _rebaseOrigin: (delta: number[]) => void;

  constructor(noa: Engine) {
    // group for all instance meshes to be parented to
    this.rootNode = new Group();
    this.rootNode.name = "objectMeshRoot";
    this.rootNode.userData.noaSkipRebase = true;
    noa.rendering.scene.add(this.rootNode);

    // tracking rebase amount inside matrix data
    var rebaseOffset = [0, 0, 0];

    // flag to trigger a rebuild after a chunk is disposed
    var rebuildNextTick = false;

    // mock object to pass to customMesh handler, to get transforms
    var transformObj = new Object3D();

    // list of known base meshes
    this.allBaseMeshes = [];

    // internal storage of instance managers, keyed by ID
    // has check to dedupe by mesh, since instance managers are
    // per-geometry rather than per-block-ID
    var managers: { [id: string]: InstanceManager } = {};
    var getManager = (id: number): InstanceManager => {
      if (managers[id]) return managers[id];
      var mesh = noa.registry._blockMeshLookup[id];
      for (var id2 in managers) {
        var prev = managers[id2].baseMesh;
        if (prev === mesh || prev.geometry === mesh.geometry) {
          return (managers[id] = managers[id2]);
        }
      }
      this.allBaseMeshes.push(mesh);
      mesh.userData[objectMeshFlag] = true;
      return (managers[id] = new InstanceManager(noa, mesh));
    };
    var objectMeshFlag = "noa_object_base_mesh";

    /*
     *
     *      public API
     *
     */

    // add any properties that will get used for meshing
    this.initChunk = function (chunk) {
      chunk._objectBlocks = {};
    };

    // called by world when an object block is set or cleared
    this.setObjectBlock = function (chunk, blockID, i, j, k) {
      var x = chunk.x + i;
      var y = chunk.y + j;
      var z = chunk.z + k;
      var key = `${x}:${y}:${z}`;

      var oldID = chunk._objectBlocks[key] || 0;
      if (oldID === blockID) return; // should be impossible
      if (oldID > 0) {
        var oldMgr = getManager(oldID);
        oldMgr.removeInstance(chunk, key);
      }

      if (blockID > 0) {
        // if there's a block event handler, call it with
        // a mock object so client can add transforms
        var handlers = noa.registry._blockHandlerLookup[blockID];
        var onCreate = handlers && handlers.onCustomMeshCreate;
        if (onCreate) {
          transformObj.position.set(0.5, 0, 0.5);
          transformObj.scale.setScalar(1);
          transformObj.rotation.set(0, 0, 0);
          onCreate(transformObj, x, y, z);
        }
        var mgr = getManager(blockID);
        var xform = onCreate ? transformObj : null;
        mgr.addInstance(chunk, key, i, j, k, xform, rebaseOffset);
      }

      if (oldID > 0 && !blockID) delete chunk._objectBlocks[key];
      if (blockID > 0) chunk._objectBlocks[key] = blockID;
    };

    // called by world when it knows that objects have been updated
    this.buildObjectMeshes = function () {
      profile_hook("start");

      for (var id in managers) {
        var mgr = managers[id];
        mgr.updateMatrix();
        if (mgr.count === 0) mgr.dispose();
        if (mgr.disposed) delete managers[id];
      }

      profile_hook("rebuilt");
      profile_hook("end");
    };

    // called by world at end of chunk lifecycle
    this.disposeChunk = function (chunk) {
      for (var key in chunk._objectBlocks) {
        var id = chunk._objectBlocks[key];
        if (id > 0) {
          var mgr = getManager(id);
          mgr.removeInstance(chunk, key);
        }
      }
      chunk._objectBlocks = null;

      // since some instance managers will have been updated
      rebuildNextTick = true;
    };

    // tick handler catches case where objects are dirty due to disposal
    this.tick = function (this: ObjectMesher) {
      if (rebuildNextTick) {
        this.buildObjectMeshes();
        rebuildNextTick = false;
      }
    };

    // world rebase handler
    this._rebaseOrigin = function (delta) {
      rebaseOffset[0] += delta[0];
      rebaseOffset[1] += delta[1];
      rebaseOffset[2] += delta[2];

      for (var id1 in managers) managers[id1].rebased = false;
      for (var id2 in managers) {
        var mgr = managers[id2];
        if (mgr.rebased) continue;
        for (var i = 0; i < mgr.count; i++) {
          var ix = i << 4;
          // buffer translations are in render coords: x, y as-is, z negated
          mgr.buffer![ix + 12] -= delta[0];
          mgr.buffer![ix + 13] -= delta[1];
          mgr.buffer![ix + 14] += delta[2];
        }
        mgr.rebased = true;
        mgr.dirty = true;
      }
      rebuildNextTick = true;
    };
  }
}

/*
 *
 *
 *      manager class for instances of a given object block ID
 *
 *
 */

class InstanceManager {
  noa: Engine;
  baseMesh: any;
  mesh: InstancedMesh | null;
  buffer: Float32Array | null;
  capacity: number;
  count: number;
  dirty: boolean;
  rebased: boolean;
  disposed: boolean;
  // dual struct to map keys (locations) to buffer locations, and back
  keyToIndex: any;
  locToKey: any;

  constructor(noa: Engine, baseMesh: any) {
    this.noa = noa;
    this.baseMesh = baseMesh;
    this.mesh = null;
    this.buffer = null;
    this.capacity = 0;
    this.count = 0;
    this.dirty = false;
    this.rebased = true;
    this.disposed = false;
    // dual struct to map keys (locations) to buffer locations, and back
    this.keyToIndex = {};
    this.locToKey = [];
  }

  dispose() {
    if (this.disposed) return;
    if (this.mesh) {
      this.noa.emit("removingTerrainMesh", this.mesh);
      this.mesh.removeFromParent();
      this.mesh.dispose();
      this.mesh = null;
    }
    this.buffer = null;
    this.capacity = 0;
    this.keyToIndex = null;
    this.locToKey = null;
    this.disposed = true;
  }

  addInstance(
    chunk: Chunk,
    key: string,
    i: number,
    j: number,
    k: number,
    transform: any,
    rebaseVec: number[],
  ) {
    maybeExpandBuffer(this);
    var ix = this.count << 4;
    this.locToKey[this.count] = key;
    this.keyToIndex[key] = ix;
    if (transform) {
      // the handler positioned a mock node in game coords relative to the
      // voxel; convert the composed matrix to render coords (negate z)
      transform.position.x += chunk.x - rebaseVec[0] + i;
      transform.position.y += chunk.y - rebaseVec[1] + j;
      transform.position.z += chunk.z - rebaseVec[2] + k;
      transform.position.z = -transform.position.z;
      transform.rotation.x = -transform.rotation.x;
      transform.rotation.y = -transform.rotation.y;
      transform.updateMatrix();
      copyMatrixData(transform.matrix.elements, 0, this.buffer, ix);
    } else {
      var matArray = tempMatrixArray;
      matArray[12] = chunk.x - rebaseVec[0] + i + 0.5;
      matArray[13] = chunk.y - rebaseVec[1] + j;
      matArray[14] = -(chunk.z - rebaseVec[2] + k + 0.5);
      copyMatrixData(matArray, 0, this.buffer, ix);
    }
    this.count++;
    this.dirty = true;
  }

  removeInstance(chunk: Chunk, key: string) {
    var remIndex = this.keyToIndex[key];
    if (!(remIndex >= 0)) throw "tried to remove object instance not in storage";
    delete this.keyToIndex[key];
    var remLoc = remIndex >> 4;
    // copy tail instance's data to location of one we're removing
    var tailLoc = this.count - 1;
    if (remLoc !== tailLoc) {
      var tailIndex = tailLoc << 4;
      copyMatrixData(this.buffer, tailIndex, this.buffer, remIndex);
      // update key/location structs
      var tailKey = this.locToKey[tailLoc];
      this.keyToIndex[tailKey] = remIndex;
      this.locToKey[remLoc] = tailKey;
    }
    this.count--;
    this.dirty = true;
    maybeContractBuffer(this);
  }

  updateMatrix() {
    if (!this.dirty) return;
    if (this.mesh) {
      this.mesh.count = this.count;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.visible = this.count > 0;
    }
    this.dirty = false;
  }

  setCapacity(size = 4) {
    this.capacity = size;
    if (size === 0) {
      this.buffer = null;
      if (this.mesh) {
        this.mesh.removeFromParent();
        this.mesh.dispose();
        this.mesh = null;
      }
      return;
    }
    var newBuff = new Float32Array(this.capacity * 16);
    if (this.buffer) {
      var len = Math.min(this.buffer.length, newBuff.length);
      for (var i = 0; i < len; i++) newBuff[i] = this.buffer[i];
    }
    this.buffer = newBuff;

    // (re)create the InstancedMesh over the new buffer
    var old = this.mesh;
    var mesh = new InstancedMesh(this.baseMesh.geometry, this.baseMesh.material, this.capacity);
    mesh.instanceMatrix = new InstancedBufferAttribute(this.buffer, 16);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = this.count;
    this.noa._objectMesher.rootNode.add(mesh);
    if (!old) this.noa.emit("addingTerrainMesh", mesh);
    if (old) {
      old.removeFromParent();
      old.dispose();
    }
    this.mesh = mesh;
    this.updateMatrix();
  }
}

function maybeExpandBuffer(mgr: InstanceManager) {
  if (mgr.count < mgr.capacity) return;
  var size = Math.max(8, mgr.capacity * 2);
  mgr.setCapacity(size);
}

function maybeContractBuffer(mgr: InstanceManager) {
  if (mgr.count > mgr.capacity * 0.4) return;
  if (mgr.capacity < 100) return;
  mgr.setCapacity(Math.round(mgr.capacity / 2));
  mgr.locToKey.length = Math.min(mgr.locToKey.length, mgr.capacity);
}

// helpers

var tempMatrixArray = [
  1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

function copyMatrixData(src: any, srcOff: number, dest: any, destOff: number) {
  for (var i = 0; i < 16; i++) dest[destOff + i] = src[srcOff + i];
}

var profile_hook = PROFILE ? makeProfileHook(PROFILE, "Object meshing") : () => {};
