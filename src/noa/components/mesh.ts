import vec3 from "gl-vec3";

import type { Engine } from "../index";
import type { Object3D } from "three";
import { disposeObject3D } from "../lib/rendering";

export default function (noa: Engine) {
  return {
    name: "mesh",

    order: 100,

    state: {
      mesh: null as Object3D | null,
      offset: null as any,
    },

    onAdd: function (eid: number, state: any) {
      // implicitly assume there's already a position component
      var posDat = noa.ents.getPositionData(eid);
      if (state.mesh) {
        noa.rendering.addMeshToScene(state.mesh, false, posDat.position);
      } else {
        throw new Error("Mesh component added without a mesh - probably a bug!");
      }
      if (!state.offset) state.offset = vec3.create();

      // set mesh to correct position (game coords -> render coords)
      var rpos = posDat._renderPosition;
      state.mesh.position.set(
        rpos[0] + state.offset[0],
        rpos[1] + state.offset[1],
        -(rpos[2] + state.offset[2]),
      );
    },

    onRemove: function (eid: number, state: any) {
      disposeObject3D(state.mesh);
    },

    renderSystem: function (dt: number, states: any[]) {
      // before render move each mesh to its render position,
      // set by the physics engine or driving logic
      for (var i = 0; i < states.length; i++) {
        var state = states[i];
        var id = state.__id;

        var rpos = noa.ents.getPositionData(id)._renderPosition;
        state.mesh.position.set(
          rpos[0] + state.offset[0],
          rpos[1] + state.offset[1],
          -(rpos[2] + state.offset[2]),
        );
      }
    },
  };
}
