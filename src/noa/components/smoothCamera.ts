import type { Engine } from "../index";

export default function (noa: Engine) {
  var compName = "smoothCamera";

  return {
    name: compName,

    order: 99,

    state: {
      time: 100.1,
    },

    onAdd: null,

    onRemove: null,

    system: function (dt: number, states: any[]) {
      // remove self after time elapses
      for (var i = 0; i < states.length; i++) {
        var state = states[i];
        state.time -= dt;
        if (state.time < 0) noa.ents.removeComponent(state.__id, compName);
      }
    },
  };
}
