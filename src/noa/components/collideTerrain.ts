import type { Engine } from "../index";

export default function (noa: Engine) {
  return {
    name: "collideTerrain",

    order: 0,

    state: {
      callback: null as ((impulse: number, eid: number) => void) | null,
    },

    onAdd: function (eid: number, _state: any) {
      // add collide handler for physics engine to call
      var ents = noa.entities;
      if (ents.hasPhysics(eid)) {
        var body = ents.getPhysics(eid).body;
        body.onCollide = function bodyOnCollide(impulse: number[]) {
          var cb = noa.ents.getCollideTerrain(eid).callback;
          if (cb) cb(impulse, eid);
        };
      }
    },

    onRemove: function (eid: number, _state: any) {
      var ents = noa.entities;
      if (ents.hasPhysics(eid)) {
        ents.getPhysics(eid).body.onCollide = null;
      }
    },
  };
}
