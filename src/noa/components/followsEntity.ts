import vec3 from "gl-vec3";

import type { Engine } from "../index";

/*
 * Indicates that an entity should be moved to another entity's position each tick,
 * possibly by a fixed offset, and the same for renderPositions each render
 */

export default function (noa: Engine) {
  return {
    name: "followsEntity",

    order: 50,

    state: {
      entity: 0 | 0,
      offset: null as any,
      onTargetMissing: null as ((id: number) => void) | null,
    },

    onAdd: function (eid: number, state: any) {
      var off = vec3.create();
      state.offset = state.offset ? vec3.copy(off, state.offset) : off;
      updatePosition(state);
      updateRenderPosition(state);
    },

    onRemove: null,

    // on tick, copy over regular positions
    system: function followEntity(dt: number, states: any[]) {
      for (var i = 0; i < states.length; i++) {
        updatePosition(states[i]);
      }
    },

    // on render, copy over render positions
    renderSystem: function followEntityMesh(dt: number, states: any[]) {
      for (var i = 0; i < states.length; i++) {
        updateRenderPosition(states[i]);
      }
    },
  };

  function updatePosition(state: any) {
    var id = state.__id;
    var self = noa.ents.getPositionData(id);
    var other = noa.ents.getPositionData(state.entity);
    if (!other) {
      if (state.onTargetMissing) state.onTargetMissing(id);
      noa.ents.removeComponent(id, noa.ents.names.followsEntity);
    } else {
      vec3.add(self._localPosition, other._localPosition, state.offset);
    }
  }

  function updateRenderPosition(state: any) {
    var id = state.__id;
    var self = noa.ents.getPositionData(id);
    var other = noa.ents.getPositionData(state.entity);
    if (other) {
      vec3.add(self._renderPosition, other._renderPosition, state.offset);
    }
  }
}
