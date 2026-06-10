// Deterministic fixed-tick character simulation, run identically on the
// client (prediction) and the server (authority). Everything here must stay
// pure: same state + same input + same world = same result on both sides.

export const SIM_TICK_MS = 50;
const DT = SIM_TICK_MS / 1000;

const GRAVITY = -28;
const JUMP_SPEED = 9;
const WALK_SPEED = 4.5;
const SPRINT_SPEED = 7;
const GROUND_BLEND = 0.5;
const AIR_BLEND = 0.12;
const TERMINAL_FALL = -50;

export const CHAR_HALF_WIDTH = 0.3;
export const CHAR_HEIGHT = 1.8;
const COLLIDE_STEP = 0.05;
const EPS = 1e-4;

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

export type CharState = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
};

export type IsSolid = (x: number, y: number, z: number) => boolean;

export function spawnState(): CharState {
  return { x: 0.5, y: 16, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false };
}

export function cloneState(state: CharState): CharState {
  return { ...state };
}

function collides(x: number, y: number, z: number, isSolid: IsSolid): boolean {
  const x0 = Math.floor(x - CHAR_HALF_WIDTH + EPS);
  const x1 = Math.floor(x + CHAR_HALF_WIDTH - EPS);
  const y0 = Math.floor(y + EPS);
  const y1 = Math.floor(y + CHAR_HEIGHT - EPS);
  const z0 = Math.floor(z - CHAR_HALF_WIDTH + EPS);
  const z1 = Math.floor(z + CHAR_HALF_WIDTH - EPS);
  for (let vx = x0; vx <= x1; vx++) {
    for (let vy = y0; vy <= y1; vy++) {
      for (let vz = z0; vz <= z1; vz++) {
        if (isSolid(vx, vy, vz)) {
          return true;
        }
      }
    }
  }
  return false;
}

// Move along one axis in fixed substeps, stopping at the first colliding
// position. Substepping keeps the math identical on both sides and avoids
// tunneling at our speeds (max ~0.5 blocks per tick). Returns the
// un-traveled remainder (0 when the full delta was applied).
function moveAxis(
  state: CharState,
  axis: "x" | "y" | "z",
  delta: number,
  isSolid: IsSolid,
): number {
  let remaining = delta;
  while (Math.abs(remaining) > 1e-9) {
    const step = Math.max(-COLLIDE_STEP, Math.min(COLLIDE_STEP, remaining));
    const next = { ...state, [axis]: state[axis] + step };
    if (collides(next.x, next.y, next.z, isSolid)) {
      return remaining;
    }
    state[axis] += step;
    remaining -= step;
  }
  return 0;
}

const STEP_UP_HEIGHT = 1.05;

// Auto-step: when a grounded horizontal move is blocked, try raising the
// character one block, finishing the move, and settling back down.
function moveAxisWithStepUp(
  state: CharState,
  axis: "x" | "z",
  delta: number,
  isSolid: IsSolid,
): number {
  const remaining = moveAxis(state, axis, delta, isSolid);
  if (remaining === 0 || !state.onGround) {
    return remaining;
  }

  const before = cloneState(state);
  const upBlocked = moveAxis(state, "y", STEP_UP_HEIGHT, isSolid);
  if (upBlocked !== 0) {
    state.x = before.x;
    state.y = before.y;
    state.z = before.z;
    return remaining;
  }
  const after = moveAxis(state, axis, remaining, isSolid);
  moveAxis(state, "y", -STEP_UP_HEIGHT, isSolid);
  if (after === remaining) {
    // no horizontal progress even when raised; undo the whole attempt
    state.x = before.x;
    state.y = before.y;
    state.z = before.z;
  }
  return after;
}

export function stepCharacter(previous: CharState, input: CharInput, isSolid: IsSolid): CharState {
  const state = cloneState(previous);

  // input direction in the horizontal plane, relative to heading
  const sin = Math.sin(input.heading);
  const cos = Math.cos(input.heading);
  let mx = 0;
  let mz = 0;
  if (input.fwd) {
    mx += sin;
    mz += cos;
  }
  if (input.back) {
    mx -= sin;
    mz -= cos;
  }
  if (input.right) {
    mx += cos;
    mz -= sin;
  }
  if (input.left) {
    mx -= cos;
    mz += sin;
  }
  const mlen = Math.hypot(mx, mz);
  const speed = input.sprint ? SPRINT_SPEED : WALK_SPEED;
  const tx = mlen > 0 ? (mx / mlen) * speed : 0;
  const tz = mlen > 0 ? (mz / mlen) * speed : 0;

  const blend = state.onGround ? GROUND_BLEND : AIR_BLEND;
  state.vx += (tx - state.vx) * blend;
  state.vz += (tz - state.vz) * blend;

  if (input.jump && state.onGround) {
    state.vy = JUMP_SPEED;
    state.onGround = false;
  }
  state.vy = Math.max(TERMINAL_FALL, state.vy + GRAVITY * DT);

  if (moveAxisWithStepUp(state, "x", state.vx * DT, isSolid) !== 0) {
    state.vx = 0;
  }
  if (moveAxisWithStepUp(state, "z", state.vz * DT, isSolid) !== 0) {
    state.vz = 0;
  }
  const falling = state.vy <= 0;
  if (moveAxis(state, "y", state.vy * DT, isSolid) !== 0) {
    state.vy = 0;
    state.onGround = falling;
  } else if (falling) {
    // didn't hit anything moving down: airborne (walked off an edge)
    state.onGround = false;
  }

  return state;
}

export function statesDiverge(a: CharState, b: CharState): boolean {
  return (
    Math.abs(a.x - b.x) > 0.01 ||
    Math.abs(a.y - b.y) > 0.01 ||
    Math.abs(a.z - b.z) > 0.01 ||
    Math.abs(a.vx - b.vx) > 0.05 ||
    Math.abs(a.vy - b.vy) > 0.05 ||
    Math.abs(a.vz - b.vz) > 0.05
  );
}
