import vec3 from "gl-vec3";

import { CircleGeometry, Mesh, MeshBasicMaterial } from "three";

import type { Engine } from "../index";

export default function (noa: Engine, distance = 10) {
  var shadowDist = distance;

  // create a geometry/material to re-use for all entity shadows.
  // CircleGeometry faces +z; rotate -PI/2 about x so it faces up
  var shadowGeometry = new CircleGeometry(0.75, 30);
  shadowGeometry.rotateX(-Math.PI / 2);
  var shadowMaterial = new MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  shadowMaterial.userData.shared = true;

  return {
    name: "shadow",

    order: 80,

    state: {
      size: 0.5,
      _mesh: null as any,
    },

    onAdd: function (eid: number, state: any) {
      var mesh = new Mesh(shadowGeometry, shadowMaterial);
      mesh.name = "shadow_instance";
      noa.rendering.addMeshToScene(mesh);
      mesh.visible = false;
      state._mesh = mesh;
    },

    onRemove: function (eid: number, state: any) {
      state._mesh.removeFromParent();
      state._mesh = null;
    },

    system: function shadowSystem(dt: number, states: any[]) {
      var cpos = noa.camera._localGetPosition();
      var dist = shadowDist;
      for (var i = 0; i < states.length; i++) {
        var state = states[i];
        var posState = noa.ents.getPositionData(state.__id);
        var physState = noa.ents.getPhysics(state.__id);
        updateShadowHeight(noa, posState, physState, state._mesh, state.size, dist, cpos);
      }
    },

    renderSystem: function (dt: number, states: any[]) {
      // before render adjust shadow x/z to render positions
      for (var i = 0; i < states.length; i++) {
        var state = states[i];
        var rpos = noa.ents.getPositionData(state.__id)._renderPosition;
        var spos = state._mesh.position;
        spos.x = rpos[0];
        spos.z = -rpos[2];
      }
    },
  };
}

var shadowPos = vec3.fromValues(0, 0, 0);
var down = vec3.fromValues(0, -1, 0);

function updateShadowHeight(
  noa: Engine,
  posDat: any,
  physDat: any,
  mesh: any,
  size: number,
  shadowDist: number,
  camPos: any,
) {
  // local Y ground position - from physics or raycast
  var localY;
  if (physDat && physDat.body.resting[1] < 0) {
    localY = posDat._localPosition[1];
  } else {
    var res = noa._localPick(posDat._localPosition, down, shadowDist);
    if (!res) {
      mesh.visible = false;
      return;
    }
    localY = res.position[1] - noa.worldOriginOffset[1];
  }

  // round Y pos and offset upwards slightly to avoid z-fighting
  localY = Math.round(localY);
  vec3.copy(shadowPos, posDat._localPosition);
  shadowPos[1] = localY;
  var sqdist = vec3.squaredDistance(camPos, shadowPos);
  // offset ~ 0.01 for nearby shadows, up to 0.1 at distance of ~40
  var offset = 0.01 + 0.1 * (sqdist / 1600);
  if (offset > 0.1) offset = 0.1;
  mesh.position.y = localY + offset;
  // set shadow scale
  var dist = posDat._localPosition[1] - localY;
  var scale = size * 0.7 * (1 - dist / shadowDist);
  mesh.scale.set(scale, scale, scale);
  mesh.visible = true;
}
