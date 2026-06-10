import ECS from "ent-comp";
import vec3 from "gl-vec3";
import { updatePositionExtents } from "../components/position";
import { setPhysicsFromPosition } from "../components/physics";

import type { Engine } from "../index";
import type { PositionState } from "../components/position";
import type { PhysicsState } from "../components/physics";
import type { MovementState } from "../components/movement";
import type { RigidBody } from "voxel-physics-engine";

// Component definitions
import collideEntitiesComp from "../components/collideEntities.js";
import collideTerrainComp from "../components/collideTerrain.js";
import fadeOnZoomComp from "../components/fadeOnZoom.js";
import followsEntityComp from "../components/followsEntity.js";
import meshComp from "../components/mesh.js";
import movementComp from "../components/movement.js";
import physicsComp from "../components/physics.js";
import positionComp from "../components/position.js";
import receivesInputsComp from "../components/receivesInputs.js";
import shadowComp from "../components/shadow.js";
import smoothCameraComp from "../components/smoothCamera.js";

var defaultOptions = {
  shadowDistance: 10,
};

/**
 * `noa.entities` - manages entities and components.
 *
 * This class extends [ent-comp](https://github.com/fenomas/ent-comp),
 * a general-purpose ECS. It's also decorated with noa-specific helpers and
 * accessor functions for querying entity positions, etc.
 *
 * Expects entity definitions in a specific format - see source `components`
 * folder for examples.
 *
 * This module uses the following default options (from the options
 * object passed to the {@link Engine}):
 *
 * ```js
 * var defaults = {
 *     shadowDistance: 10,
 * }
 * ```
 */

export class Entities extends ECS {
  /** @internal */
  declare noa: Engine;

  /** Hash containing the component names of built-in components. */
  declare names: { [key: string]: string };

  /** @internal */
  declare cameraSmoothed: (id: number) => boolean;

  /** Returns whether the entity has a physics body */
  declare hasPhysics: (id: number) => boolean;

  /** Returns whether the entity has a position */
  declare hasPosition: (id: number) => boolean;

  // The accessors below return state objects for entities that have the
  // component, or null otherwise. They're typed non-null (matching the
  // d.ts the engine used to publish) since callers gate on has*()/known ids.

  /** Returns the entity's position component state */
  declare getPositionData: (id: number) => PositionState;

  /** Returns the entity's position vector. */
  declare getPosition: (id: number) => number[];

  /** Get the entity's `physics` component state. */
  declare getPhysics: (id: number) => PhysicsState;

  /**
   * Returns the entity's physics body
   * Note, will throw if the entity doesn't have the position component!
   */
  declare getPhysicsBody: (id: number) => RigidBody;

  /** Returns whether the entity has a mesh */
  declare hasMesh: (id: number) => boolean;

  /** Returns the entity's `mesh` component state */
  declare getMeshData: (id: number) => { mesh: any; offset: number[] };

  /** Returns the entity's `movement` component state */
  declare getMovement: (id: number) => MovementState;

  /** Returns the entity's `collideTerrain` component state */
  declare getCollideTerrain: (id: number) => { callback: any };

  /** Returns the entity's `collideEntities` component state */
  declare getCollideEntities: (id: number) => {
    cylinder: boolean;
    collideBits: number;
    collideMask: number;
    callback: any;
  };

  /**
   * Pairwise collideEntities event - assign your own function to this
   * property if you want to handle entity-entity overlap events.
   */
  declare onPairwiseEntityCollision: (id1: number, id2: number) => void;

  /** @internal */
  constructor(noa: Engine, opts: any) {
    super();
    opts = Object.assign({}, defaultOptions, opts);
    // optional arguments to supply to component creation functions
    var componentArgs: { [key: string]: any } = {
      shadow: opts.shadowDistance,
    };

    /** @internal */
    this.noa = noa;

    /** Hash containing the component names of built-in components. */
    this.names = {};

    // call `createComponent` on all component definitions, and
    // store their names in ents.names
    var compDefs: { [key: string]: any } = {
      collideEntities: collideEntitiesComp,
      collideTerrain: collideTerrainComp,
      fadeOnZoom: fadeOnZoomComp,
      followsEntity: followsEntityComp,
      mesh: meshComp,
      movement: movementComp,
      physics: physicsComp,
      position: positionComp,
      receivesInputs: receivesInputsComp,
      shadow: shadowComp,
      smoothCamera: smoothCameraComp,
    };

    Object.keys(compDefs).forEach((bareName) => {
      var arg = componentArgs[bareName] || undefined;
      var compFn = compDefs[bareName];
      var compDef = compFn(noa, arg);
      this.names[bareName] = this.createComponent(compDef);
    });

    /*
     *
     *
     *
     *          ENTITY ACCESSORS
     *
     * A whole bunch of getters and such for accessing component state.
     * These are moderately faster than `ents.getState(whatever)`.
     *
     *
     *
     */

    /** @internal */
    this.cameraSmoothed = this.getComponentAccessor(this.names.smoothCamera);

    /**
     * Returns whether the entity has a physics body
     */
    this.hasPhysics = this.getComponentAccessor(this.names.physics);

    /**
     * Returns whether the entity has a position
     */
    this.hasPosition = this.getComponentAccessor(this.names.position);

    /**
     * Returns the entity's position component state
     */
    this.getPositionData = this.getStateAccessor(this.names.position);

    /**
     * Returns the entity's position vector.
     */
    this.getPosition = ((id: number) => {
      var state = this.getPositionData(id);
      return state ? state.position : null;
    }) as (id: number) => number[];

    /**
     * Get the entity's `physics` component state.
     */
    this.getPhysics = this.getStateAccessor(this.names.physics);

    /**
     * Returns the entity's physics body
     * Note, will throw if the entity doesn't have the position component!
     */
    this.getPhysicsBody = ((id: number) => {
      var state = this.getPhysics(id);
      return state ? state.body : null;
    }) as (id: number) => RigidBody;

    /**
     * Returns whether the entity has a mesh
     */
    this.hasMesh = this.getComponentAccessor(this.names.mesh);

    /**
     * Returns the entity's `mesh` component state
     */
    this.getMeshData = this.getStateAccessor(this.names.mesh);

    /**
     * Returns the entity's `movement` component state
     */
    this.getMovement = this.getStateAccessor(this.names.movement);

    /**
     * Returns the entity's `collideTerrain` component state
     */
    this.getCollideTerrain = this.getStateAccessor(this.names.collideTerrain);

    /**
     * Returns the entity's `collideEntities` component state
     */
    this.getCollideEntities = this.getStateAccessor(this.names.collideEntities);

    /**
     * Pairwise collideEntities event - assign your own function to this
     * property if you want to handle entity-entity overlap events.
     */
    this.onPairwiseEntityCollision = function (_id1, _id2) {};
  }

  /*
   *
   *
   *      PUBLIC ENTITY STATE ACCESSORS
   *
   *
   */

  /** Set an entity's position, and update all derived state.
   *
   * In general, always use this to set an entity's position unless
   * you're familiar with engine internals.
   *
   * ```js
   * noa.ents.setPosition(playerEntity, [5, 6, 7])
   * noa.ents.setPosition(playerEntity, 5, 6, 7)  // also works
   * ```
   *
   */
  setPosition(id: number, pos: number | number[], y: number = 0, z: number = 0) {
    if (typeof pos === "number") pos = [pos, y, z];
    // convert to local and defer impl
    var loc = this.noa.globalToLocal(pos, null, []);
    this._localSetPosition(id, loc);
  }

  /** Set an entity's size */
  setEntitySize(id: number, xs: number, ys: number, zs: number) {
    var posDat = this.getPositionData(id)!;
    posDat.width = (xs + zs) / 2;
    posDat.height = ys;
    this._updateDerivedPositionData(id, posDat);
  }

  /**
   * called when engine rebases its local coords
   * @internal
   */
  _rebaseOrigin(delta: number[]) {
    for (var state of this.getStatesList(this.names.position)) {
      var locPos = state._localPosition;
      var hw = state.width / 2;
      nudgePosition(locPos, 0, -hw, hw, state.__id);
      nudgePosition(locPos, 1, 0, state.height, state.__id);
      nudgePosition(locPos, 2, -hw, hw, state.__id);
      vec3.subtract(locPos, locPos, delta);
      this._updateDerivedPositionData(state.__id, state);
    }
  }

  /** @internal */
  _localGetPosition(id: number) {
    return this.getPositionData(id)!._localPosition;
  }

  /** @internal */
  _localSetPosition(id: number, pos: number[]) {
    var posDat = this.getPositionData(id)!;
    vec3.copy(posDat._localPosition, pos);
    this._updateDerivedPositionData(id, posDat);
  }

  /**
   * helper to update everything derived from `_localPosition`
   * @internal
   */
  _updateDerivedPositionData(id: number, posDat: PositionState) {
    vec3.copy(posDat._renderPosition, posDat._localPosition);
    var offset = this.noa.worldOriginOffset;
    vec3.add(posDat.position, posDat._localPosition, offset);
    updatePositionExtents(posDat);
    var physDat = this.getPhysics(id);
    if (physDat) setPhysicsFromPosition(physDat, posDat);
  }

  /*
   *
   *
   *      OTHER ENTITY MANAGEMENT APIs
   *
   *      note most APIs are on the original ECS module (ent-comp)
   *      these are some overlaid extras for noa
   *
   *
   */

  /**
   * Safely add a component - if the entity already had the
   * component, this will remove and re-add it.
   */
  addComponentAgain(id: number, name: string, state?: any) {
    // removes component first if necessary
    if (this.hasComponent(id, name)) this.removeComponent(id, name);
    this.addComponent(id, name, state);
  }

  /**
   * Checks whether a voxel is obstructed by any entity (with the
   * `collidesTerrain` component)
   */
  isTerrainBlocked(x: number, y: number, z: number) {
    // checks if terrain location is blocked by entities
    var off = this.noa.worldOriginOffset;
    var xlocal = Math.floor(x - off[0]);
    var ylocal = Math.floor(y - off[1]);
    var zlocal = Math.floor(z - off[2]);
    var blockExt = [
      xlocal + 0.001,
      ylocal + 0.001,
      zlocal + 0.001,
      xlocal + 0.999,
      ylocal + 0.999,
      zlocal + 0.999,
    ];
    var list = this.getStatesList(this.names.collideTerrain);
    for (var i = 0; i < list.length; i++) {
      var id = list[i].__id;
      var ext = this.getPositionData(id)!._extents;
      if (extentsOverlap(blockExt, ext)) return true;
    }
    return false;
  }

  /**
   * Gets an array of all entities overlapping the given AABB
   */
  getEntitiesInAABB(box: { base: number[]; max: number[] }, withComponent?: string) {
    // extents to test against
    var off = this.noa.worldOriginOffset;
    var testExtents = [
      box.base[0] - off[0],
      box.base[1] - off[1],
      box.base[2] - off[2],
      box.max[0] - off[0],
      box.max[1] - off[1],
      box.max[2] - off[2],
    ];
    // entity position state list
    var entStates;
    if (withComponent) {
      entStates = [];
      for (var compState of this.getStatesList(withComponent)) {
        var pdat = this.getPositionData(compState.__id);
        if (pdat) entStates.push(pdat);
      }
    } else {
      entStates = this.getStatesList(this.names.position);
    }

    // run each test
    var hits = [];
    for (var i = 0; i < entStates.length; i++) {
      var state = entStates[i];
      if (extentsOverlap(testExtents, state._extents)) {
        hits.push(state.__id);
      }
    }
    return hits;
  }

  /**
   * Helper to set up a general entity, and populate with some common components depending on arguments.
   */
  add(
    position: number[] | null = null,
    width: number = 1,
    height: number = 1,
    mesh: any = null,
    meshOffset: number[] | null = null,
    doPhysics: boolean = false,
    shadow: boolean = false,
  ) {
    // oxlint-disable-next-line typescript-eslint/no-this-alias
    var self = this;

    // new entity
    var eid = this.createEntity();

    // position component
    this.addComponent(eid, this.names.position, {
      position: position || vec3.create(),
      width: width,
      height: height,
    });

    // rigid body in physics simulator
    if (doPhysics) {
      // body = this.noa.physics.addBody(box)
      this.addComponent(eid, this.names.physics);
      var body = this.getPhysics(eid)!.body as any;

      // handler for physics engine to call on auto-step
      var smoothName = this.names.smoothCamera;
      body.onStep = function () {
        self.addComponentAgain(eid, smoothName);
      };
    }

    // mesh for the entity
    if (mesh) {
      if (!meshOffset) meshOffset = vec3.create();
      this.addComponent(eid, this.names.mesh, {
        mesh: mesh,
        offset: meshOffset,
      });
    }

    // add shadow-drawing component
    if (shadow) {
      this.addComponent(eid, this.names.shadow, { size: width });
    }

    return eid;
  }
}

/*
 *
 *
 *
 *          HELPERS
 *
 *
 *
 */

// safety helper - when rebasing, nudge extent away from
// voxel boudaries, so floating point error doesn't carry us accross
function nudgePosition(pos: number[], index: number, dmin: number, dmax: number, _id: number) {
  var min = pos[index] + dmin;
  var max = pos[index] + dmax;
  if (Math.abs(min - Math.round(min)) < 0.002) pos[index] += 0.002;
  if (Math.abs(max - Math.round(max)) < 0.001) pos[index] -= 0.001;
}

// compare extent arrays
function extentsOverlap(extA: number[] | Float32Array, extB: number[] | Float32Array) {
  if (extA[0] > extB[3]) return false;
  if (extA[1] > extB[4]) return false;
  if (extA[2] > extB[5]) return false;
  if (extA[3] < extB[0]) return false;
  if (extA[4] < extB[1]) return false;
  if (extA[5] < extB[2]) return false;
  return true;
}
