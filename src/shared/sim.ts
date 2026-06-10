// Deterministic fixed-tick character simulation, run identically on the
// client (prediction) and the server (authority).
//
// This is noa's exact player physics: a voxel-physics-engine rigid body
// driven by noa's own movement controller (vendored in vendor/noa, which
// exports applyMovementPhysics). The body state is fully captured into a
// plain CharState after every step so the client can roll back to a
// server state and replay pending inputs through the same code.

import aabb from "aabb-3d";
import { MovementState, applyMovementPhysics } from "noa-engine/src/components/movement.js";
import { Physics } from "voxel-physics-engine";

export const SIM_TICK_MS = 50;

export const CHAR_WIDTH = 0.6;
export const CHAR_HEIGHT = 1.8;
const HALF_W = CHAR_WIDTH / 2;

// vanilla Minecraft ground speeds: walk 4.317 blocks/s, sprint +30%
const WALK_SPEED = 4.317;
const SPRINT_SPEED = 5.612;

export type CharInput = {
  seq: number;
  heading: number;
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
};

// Full snapshot of the rigid body + movement controller between ticks.
// x/z are the AABB's bottom-center (noa's position convention); rx/ry/rz
// are the body's resting flags (-1/0/1); sleep is the engine's
// sleep-frame countdown, which gates whether a tick integrates at all.
export type CharState = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  jumpCount: number;
  jumpMsLeft: number;
  jumping: boolean;
  sleep: number;
};

export type IsSolid = (x: number, y: number, z: number) => boolean;
export type Stepper = (state: CharState, input: CharInput) => CharState;

export function onGround(state: CharState): boolean {
  return state.ry < 0;
}

export function spawnState(): CharState {
  return {
    x: 0.5,
    y: 16,
    z: 0.5,
    vx: 0,
    vy: 0,
    vz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    jumpCount: 0,
    jumpMsLeft: 0,
    jumping: false,
    sleep: 10,
  };
}

export function cloneState(state: CharState): CharState {
  return { ...state };
}

export function makeStepper(isSolid: IsSolid, isFluid: IsSolid = () => false): Stepper {
  // fluidDensity tuned so a fully submerged body sinks slowly; holding
  // jump adds swim force to rise
  const world = new Physics({ fluidDensity: 2.8 }, isSolid, isFluid);
  const body = world.addBody(new aabb([0, 0, 0], [CHAR_WIDTH, CHAR_HEIGHT, CHAR_WIDTH]));
  // match noa's player body setup (Engine constructor)
  body.gravityMultiplier = 2;
  body.autoStep = true;

  const move = new MovementState();
  move.airJumps = 0;
  // vanilla jump apex is ~1.25 blocks with a fixed height (holding jump
  // does not extend it): pure impulse, no hold time
  move.jumpImpulse = 7.7;
  move.jumpTime = 0;

  return (prev, input) => {
    // restore the body from the previous tick's snapshot
    const { base, max, vec } = body.aabb;
    base[0] = prev.x - HALF_W;
    base[1] = prev.y;
    base[2] = prev.z - HALF_W;
    vec[0] = CHAR_WIDTH;
    vec[1] = CHAR_HEIGHT;
    vec[2] = CHAR_WIDTH;
    max[0] = base[0] + vec[0];
    max[1] = base[1] + vec[1];
    max[2] = base[2] + vec[2];
    body.velocity[0] = prev.vx;
    body.velocity[1] = prev.vy;
    body.velocity[2] = prev.vz;
    body.resting[0] = prev.rx;
    body.resting[1] = prev.ry;
    body.resting[2] = prev.rz;
    body._forces[0] = 0;
    body._forces[1] = 0;
    body._forces[2] = 0;
    body._impulses[0] = 0;
    body._impulses[1] = 0;
    body._impulses[2] = 0;
    body.inFluid = false;
    body.ratioInFluid = 0;
    body._sleepFrameCount = prev.sleep;

    // restore the movement controller's jump bookkeeping
    move._jumpCount = prev.jumpCount;
    move._currjumptime = prev.jumpMsLeft;
    move._isJumping = prev.jumping;
    move.jumping = input.jump;
    move.maxSpeed = input.sprint ? SPRINT_SPEED : WALK_SPEED;

    // WASD -> heading/running, mirroring noa's receivesInputs component
    const fb = input.fwd ? (input.back ? 0 : 1) : input.back ? -1 : 0;
    const rl = input.right ? (input.left ? 0 : 1) : input.left ? -1 : 0;
    if ((fb | rl) === 0) {
      move.running = false;
    } else {
      move.running = true;
      let heading = input.heading;
      if (fb) {
        if (fb === -1) {
          heading += Math.PI;
        }
        if (rl) {
          heading += (Math.PI / 4) * fb * rl;
        }
      } else {
        heading += rl * (Math.PI / 2);
      }
      move.heading = heading;
    }

    // swimming: holding jump in water pushes upward (deterministic — the
    // check reads the world, not transient body state)
    if (input.jump && isFluid(Math.floor(prev.x), Math.floor(prev.y + 0.6), Math.floor(prev.z))) {
      body.applyForce([0, 34, 0]);
    }

    // same per-tick order as noa: movement system, then physics
    applyMovementPhysics(SIM_TICK_MS, move, body);
    world.tick(SIM_TICK_MS);

    return {
      x: body.aabb.base[0] + HALF_W,
      y: body.aabb.base[1],
      z: body.aabb.base[2] + HALF_W,
      vx: body.velocity[0],
      vy: body.velocity[1],
      vz: body.velocity[2],
      rx: body.resting[0],
      ry: body.resting[1],
      rz: body.resting[2],
      jumpCount: move._jumpCount,
      jumpMsLeft: move._currjumptime,
      jumping: move._isJumping,
      sleep: body._sleepFrameCount,
    };
  };
}

export function statesDiverge(a: CharState, b: CharState): boolean {
  return (
    Math.abs(a.x - b.x) > 0.01 ||
    Math.abs(a.y - b.y) > 0.01 ||
    Math.abs(a.z - b.z) > 0.01 ||
    Math.abs(a.vx - b.vx) > 0.05 ||
    Math.abs(a.vy - b.vy) > 0.05 ||
    Math.abs(a.vz - b.vz) > 0.05 ||
    onGround(a) !== onGround(b) ||
    a.jumping !== b.jumping ||
    a.jumpCount !== b.jumpCount
  );
}
