// Standalone determinism test for the shared character sim.
// Bundle and run:
//   node_modules/.bin/esbuild scripts/sim-test.ts --bundle --format=esm \
//     --outfile=/tmp/sim-test.mjs && node /tmp/sim-test.mjs
import {
  type CharInput,
  type CharState,
  cloneState,
  makeStepper,
  onGround,
  spawnState,
} from "../src/shared/sim.js";
import { makeIsSolid, terrainHeight } from "../src/shared/terrain.js";

const isSolid = makeIsSolid(() => undefined);

function input(seq: number, over: Partial<CharInput> = {}): CharInput {
  return {
    seq,
    heading: 0,
    fwd: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    ...over,
  };
}

function fmt(s: CharState): string {
  return `pos=(${s.x.toFixed(3)},${s.y.toFixed(3)},${s.z.toFixed(3)}) vel=(${s.vx.toFixed(3)},${s.vy.toFixed(3)},${s.vz.toFixed(3)}) ry=${s.ry} ground=${onGround(s)} sleep=${s.sleep}`;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. idle settle: spawn at y=16 over terrain height 2, feet should rest at y=3
{
  const step = makeStepper(isSolid);
  let s = spawnState();
  for (let i = 1; i <= 200; i++) {
    s = step(s, input(i));
  }
  console.log("settled:", fmt(s), `(terrain h=${terrainHeight(0, 0)})`);
  check(
    "idle player settles on terrain surface",
    Math.abs(s.y - 3) < 0.01 && onGround(s),
    `y=${s.y.toFixed(3)}`,
  );
  check("settled player is at rest", Math.abs(s.vy) < 0.01);
}

// 2. walking speed
{
  const step = makeStepper(isSolid);
  let s = spawnState();
  let seq = 0;
  for (let i = 0; i < 100; i++) s = step(s, input(++seq)); // settle
  const start = cloneState(s);
  for (let i = 0; i < 40; i++) s = step(s, input(++seq, { fwd: true })); // 2s
  const dist = Math.hypot(s.x - start.x, s.z - start.z);
  console.log("walked:", dist.toFixed(2), "blocks in 2s,", fmt(s));
  check("walking covers ~2x maxSpeed in 2s", dist > 7 && dist < 10, `${dist.toFixed(2)} blocks`);
}

// 3. jumping
{
  const step = makeStepper(isSolid);
  let s = spawnState();
  let seq = 0;
  for (let i = 0; i < 100; i++) s = step(s, input(++seq));
  const groundY = s.y;
  let peak = s.y;
  for (let i = 0; i < 30; i++) {
    s = step(s, input(++seq, { jump: i < 10 }));
    peak = Math.max(peak, s.y);
  }
  console.log("jump peak:", (peak - groundY).toFixed(2), "blocks; after 1.5s:", fmt(s));
  check("jump rises >1 block", peak - groundY > 1, `peak +${(peak - groundY).toFixed(2)}`);
  check("lands back on ground", Math.abs(s.y - groundY) < 0.01 && onGround(s));
}

// 4. two independent steppers produce identical states (no scratch leaks)
{
  const stepA = makeStepper(isSolid);
  const stepB = makeStepper(isSolid);
  let a = spawnState();
  let b = spawnState();
  let diverged = -1;
  for (let i = 1; i <= 300; i++) {
    const inp = input(i, {
      fwd: i % 7 !== 0,
      jump: i % 31 === 0,
      right: i % 13 < 4,
      heading: i / 50,
    });
    a = stepA(a, inp);
    b = stepB(b, inp);
    if (JSON.stringify(a) !== JSON.stringify(b) && diverged < 0) diverged = i;
  }
  check(
    "independent steppers agree bit-for-bit over 300 ticks",
    diverged < 0,
    diverged >= 0 ? `diverged at tick ${diverged}` : "",
  );
}

// 5. THE rollback property: snapshot mid-run, replay through a fresh stepper,
// states must match the continuous run exactly
{
  const step = makeStepper(isSolid);
  const inputs: CharInput[] = [];
  for (let i = 1; i <= 300; i++) {
    inputs.push(
      input(i, { fwd: i % 5 !== 0, jump: i % 23 === 0, left: i % 11 < 3, heading: i / 40 }),
    );
  }
  let s = spawnState();
  const snapshots: CharState[] = [];
  for (const inp of inputs) {
    s = step(s, inp);
    snapshots.push(cloneState(s));
  }
  // roll back to tick 150 and replay 150..300 through a different stepper
  const replayStep = makeStepper(isSolid);
  let r = cloneState(snapshots[149]);
  let diverged = -1;
  for (let i = 150; i < 300; i++) {
    r = replayStep(r, inputs[i]);
    if (JSON.stringify(r) !== JSON.stringify(snapshots[i]) && diverged < 0) diverged = i + 1;
  }
  check(
    "snapshot+replay matches continuous run bit-for-bit",
    diverged < 0,
    diverged >= 0 ? `diverged at tick ${diverged}` : "",
  );
  if (diverged >= 0) {
    const i = diverged - 1;
    console.log("  continuous:", JSON.stringify(snapshots[i]));
    const rr = makeStepper(isSolid);
    let r2 = cloneState(snapshots[i - 1]);
    r2 = rr(r2, inputs[i]);
    console.log("  replayed:  ", JSON.stringify(r2));
  }
}

process.exit(failures > 0 ? 1 : 0);
