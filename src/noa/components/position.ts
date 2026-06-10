/**
 * @module
 * @internal
 */

import vec3 from "gl-vec3";

import type { Engine } from "../index";

// definition for this component's state object
// Fields are typed with their post-onAdd (always-populated) shapes, matching
// the d.ts the engine used to publish; they hold null only before onAdd runs.
export class PositionState {
  /** Position in global coords (may be low precision) */
  position: number[];
  width: number;
  height: number;

  /** Precise position in local coords */
  _localPosition: number[];

  /** [x,y,z] in LOCAL COORDS */
  _renderPosition: number[];

  /** [lo,lo,lo, hi,hi,hi] in LOCAL COORDS */
  _extents: Float32Array;

  constructor() {
    this.position = null as any;
    this.width = 0.8;
    this.height = 0.8;

    this._localPosition = null as any;

    this._renderPosition = null as any;

    this._extents = null as any;
  }
}

/**
 * 	Component holding entity's position, width, and height.
 *  By convention, entity's "position" is the bottom center of its AABB
 *
 *  Of the various properties, _localPosition is the "real",
 *  single-source-of-truth position. Others are derived.
 *  Local coords are relative to `noa.worldOriginOffset`.
 */

export default function (noa: Engine) {
  return {
    name: "position",

    order: 60,

    state: new PositionState(),

    onAdd: function (eid: number, state: any) {
      // copy position into a plain array
      var pos = [0, 0, 0];
      if (state.position) vec3.copy(pos, state.position);
      state.position = pos;

      state._localPosition = vec3.create();
      state._renderPosition = vec3.create();
      state._extents = new Float32Array(6);

      // on init only, set local from global
      noa.globalToLocal(state.position, null, state._localPosition);
      vec3.copy(state._renderPosition, state._localPosition);
      updatePositionExtents(state);
    },

    onRemove: null,

    system: function (dt: number, states: any[]) {
      var off = noa.worldOriginOffset;
      for (var i = 0; i < states.length; i++) {
        var state = states[i];
        vec3.add(state.position, state._localPosition, off);
        updatePositionExtents(state);
      }
    },
  };
}

// update an entity's position state `_extents`
export function updatePositionExtents(state: any) {
  var hw = state.width / 2;
  var lpos = state._localPosition;
  var ext = state._extents;
  ext[0] = lpos[0] - hw;
  ext[1] = lpos[1];
  ext[2] = lpos[2] - hw;
  ext[3] = lpos[0] + hw;
  ext[4] = lpos[1] + state.height;
  ext[5] = lpos[2] + hw;
}
