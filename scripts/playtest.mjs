// Multiplayer smoke test driven through the Snack dev host shell.
//
// Prereqs: `npm run dev` (vite on :3031, snack dev on :3030) and a Playwright
// install to borrow. Point PLAYWRIGHT_RESOLVE_FROM at any package.json whose
// node_modules contains playwright, then run: node scripts/playtest.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const resolveFrom =
  process.env.PLAYWRIGHT_RESOLVE_FROM ?? new URL("../package.json", import.meta.url).pathname;
const require = createRequire(resolveFrom);
const { chromium } = require("playwright");

const SHELL_URL = process.env.SNACK_SHELL_URL ?? "http://127.0.0.1:3030/";
// the vite client port inside the host shell iframe; set alongside
// SNACK_SHELL_URL when testing an isolated dev stack on other ports
const CLIENT_PORT = process.env.SNACK_CLIENT_PORT ?? "3031";
const SHOTS = new URL("../.playtest-shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

function log(...args) {
  console.log("[playtest]", ...args);
}

async function openPlayer(browser, label) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1100, height: 750 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`[${label}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`[${label} pageerror] ${err.message}`));
  await page.goto(SHELL_URL, { waitUntil: "domcontentloaded" });

  let frame;
  for (let i = 0; i < 120; i++) {
    frame = page.frames().find((f) => f.url().includes(`:${CLIENT_PORT}`));
    if (frame) break;
    await page.waitForTimeout(250);
  }
  if (!frame) throw new Error(`${label}: game iframe never appeared`);

  await frame.waitForFunction(
    () => window.__voxels && window.__voxels.connectionState() === "connected",
    null,
    { timeout: 30000 },
  );
  log(`${label}: connected to snack server`);
  return { context, page, frame, errors, label };
}

async function dump(players) {
  for (const p of players) {
    if (p.errors && p.errors.length) {
      log(`console errors ${p.label}:`, p.errors.slice(0, 6).join(" | "));
    }
  }
  for (const p of players) {
    try {
      const state = await p.frame.evaluate(() => ({
        conn: window.__voxels.connectionState(),
        remotes: window.__voxels.remotes(),
        pos: window.__voxels.playerPosition().map((n) => Math.round(n * 10) / 10),
      }));
      log(`state ${p.label}:`, JSON.stringify(state));
    } catch (e) {
      log(`state ${p.label}: <unavailable: ${e.message.split("\n")[0]}>`);
    }
  }
}

async function waitFor(frame, fn, arg, label, timeout = 15000) {
  // interval polling: rAF-based polling can throttle in occluded headless pages
  await frame.waitForFunction(fn, arg, { timeout, polling: 100 });
  log(`OK: ${label}`);
}

const browser = await chromium.launch({ headless: true });
const live = [];
try {
  const p1 = await openPlayer(browser, "player1");
  const p2 = await openPlayer(browser, "player2");
  live.push(p1, p2);

  await waitFor(
    p1.frame,
    () => window.__voxels.remoteCount() === 1,
    null,
    "player1 sees 1 remote player",
    30000, // leftover ghosts from prior sessions despawn once the runtime reaps them (~20s)
  );
  await waitFor(
    p2.frame,
    () => window.__voxels.remoteCount() === 1,
    null,
    "player2 sees 1 remote player",
  );

  await waitFor(
    p1.frame,
    () => {
      const [, y] = window.__voxels.playerPosition();
      return y > 0 && y < 10;
    },
    null,
    "player1 landed on terrain after falling",
    20000,
  );

  // water: the spawn pond is part of deterministic worldgen
  await waitFor(
    p1.frame,
    () => window.__voxels.blockAt(18, 0, 14) === 12,
    null,
    "spawn pond water generated at (18,0,14)",
    10000,
  );

  // keyboard movement: click canvas, hold W (after a beat for worldgen to
  // settle — chunk meshing on a cold server starves the first sim ticks)
  await p1.page.waitForTimeout(2000);
  await p1.page.mouse.click(550, 375);
  const before = await p1.frame.evaluate(() => window.__voxels.playerPosition());
  await p1.page.keyboard.down("w");
  await p1.page.waitForTimeout(1500);
  await p1.page.keyboard.up("w");
  const after = await p1.frame.evaluate(() => window.__voxels.playerPosition());
  const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
  if (moved < 1) throw new Error(`keyboard movement did not move player (distance ${moved})`);
  log(`OK: player1 moved ${moved.toFixed(1)} blocks with W key (predicted locally)`);

  // jump: predicted y should rise immediately after pressing space
  const groundY = (await p1.frame.evaluate(() => window.__voxels.playerPosition()))[1];
  await p1.page.keyboard.down("Space");
  await waitFor(
    p1.frame,
    (y) => window.__voxels.playerPosition()[1] > y + 0.5,
    groundY,
    "player1 jumped (predicted y rose)",
    5000,
  );
  await p1.page.keyboard.up("Space");
  await p1.page.waitForTimeout(800);

  // position sync: player2's rendered remote should converge near player1's position
  await p1.page.waitForTimeout(600);
  const p1pos = await p1.frame.evaluate(() => window.__voxels.playerPosition());
  await waitFor(
    p2.frame,
    (expected) => {
      const remotes = window.__voxels.remotes();
      if (remotes.length !== 1) return false;
      const r = remotes[0];
      return Math.hypot(r.x - expected[0], r.y - expected[1], r.z - expected[2]) < 1.5;
    },
    p1pos,
    `player2 renders player1 near ${p1pos.map((n) => n.toFixed(1))}`,
  );

  // block placement propagates p1 -> p2
  await p1.frame.evaluate(() => window.__voxels.setBlockAt(2, 3, 10, 3));
  await waitFor(
    p2.frame,
    () => window.__voxels.blockAt(3, 10, 3) === 2,
    null,
    "block placed by player1 appears for player2",
  );

  // optimistic prediction: the acting client sees its own edit instantly,
  // before any server round-trip
  const instant = await p1.frame.evaluate(() => {
    window.__voxels.setBlockAt(2, 3, 12, 3);
    return window.__voxels.blockAt(3, 12, 3);
  });
  if (instant !== 2) throw new Error(`optimistic edit not instant (read ${instant})`);
  log("OK: optimistic edit visible instantly on the acting client");
  await p1.frame.evaluate(() => window.__voxels.setBlockAt(0, 3, 12, 3));

  // digging propagates p2 -> p1 (random column so repeated runs against a
  // long-lived dev server don't exhaust one spot)
  const digX = 5 + Math.floor(Math.random() * 30);
  const digTarget = await p2.frame.evaluate((x) => {
    for (let y = 14; y >= -8; y--) {
      if (window.__voxels.blockAt(x, y, 5) !== 0) return y;
    }
    return null;
  }, digX);
  if (digTarget === null) throw new Error(`no terrain found at (${digX}, *, 5)`);
  await p2.frame.evaluate(([x, y]) => window.__voxels.setBlockAt(0, x, y, 5), [digX, digTarget]);
  await waitFor(
    p1.frame,
    ([x, y]) => window.__voxels.blockAt(x, y, 5) === 0,
    [digX, digTarget],
    `block dug by player2 at (${digX},${digTarget},5) disappears for player1`,
  );

  // late joiner receives the edit log via welcome replay
  const p3 = await openPlayer(browser, "player3");
  live.push(p3);
  await waitFor(
    p3.frame,
    () => window.__voxels.blockAt(3, 10, 3) === 2,
    null,
    "late-joining player3 received replayed block edit",
    20000,
  );
  await waitFor(
    p3.frame,
    () => window.__voxels.remoteCount() === 2,
    null,
    "player3 sees 2 remote players",
  );
  await waitFor(
    p1.frame,
    () => window.__voxels.remoteCount() === 2,
    null,
    "player1 sees 2 remote players",
  );

  // equipment: p1 equips the pickaxe; p2 must see it on p1's rig via snapshots
  await p1.page.keyboard.press("2");
  await waitFor(
    p1.frame,
    () => window.__voxels.equipped() === 1,
    null,
    "player1 equipped the pickaxe",
  );
  await waitFor(
    p2.frame,
    () => window.__voxels.remotes().some((r) => r.item === 1),
    null,
    "player2 sees player1 holding the pickaxe",
  );

  // inventory screen: E opens the larger storage; drag-and-drop moves a
  // stack between slots, the server echo confirms, and E closes it
  await p1.page.keyboard.press("e");
  await waitFor(p1.frame, () => window.__voxels.inventoryOpen(), null, "E opened the inventory");
  const dragRects = await p1.frame.evaluate(() => {
    const rects = {};
    for (const el of document.querySelectorAll("[data-inv-slot]")) {
      const r = el.getBoundingClientRect();
      rects[el.dataset.invSlot] = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return rects;
  });
  const frameBox = await (await p1.page.$("iframe"))?.boundingBox();
  const slotPoint = (i) => ({
    x: dragRects[String(i)].x + (frameBox?.x ?? 0),
    y: dragRects[String(i)].y + (frameBox?.y ?? 0),
  });
  // drag the snowball stack (hotbar slot 5) into storage slot 20 and back
  const fromPt = slotPoint(5);
  const toPt = slotPoint(20);
  await p1.page.mouse.move(fromPt.x, fromPt.y);
  await p1.page.mouse.down();
  await p1.page.mouse.move(toPt.x, toPt.y, { steps: 6 });
  await p1.page.mouse.up();
  await waitFor(
    p1.frame,
    () => {
      const s = window.__voxels.slots();
      return !s[5] && s[20]?.item === 5 && s[20]?.count === 6;
    },
    null,
    "drag-and-drop moved the snowball stack into storage",
  );
  await p1.page.waitForTimeout(600);
  const echoed = await p1.frame.evaluate(() => {
    const s = window.__voxels.slots();
    return !s[5] && s[20]?.item === 5 && s[20]?.count === 6;
  });
  if (!echoed) throw new Error("server inventory echo disagrees with the drag move");
  log("OK: server echo confirms the inventory move");
  await p1.frame.evaluate(() => window.__voxels.moveItem(20, 5));
  await waitFor(
    p1.frame,
    () => window.__voxels.slots()[5]?.item === 5,
    null,
    "moveItem returned the stack to the hotbar",
  );
  await p1.page.keyboard.press("e");
  await waitFor(p1.frame, () => !window.__voxels.inventoryOpen(), null, "E closed the inventory");

  // first-person toggle
  await p1.page.keyboard.press("v");
  await waitFor(
    p1.frame,
    () => window.__voxels.noa.camera.zoomDistance === 0,
    null,
    "player1 toggled to first person",
  );
  await p1.page.waitForTimeout(400);
  await p1.page.screenshot({ path: `${SHOTS}first-person.png` });
  await p1.page.keyboard.press("v");
  await waitFor(
    p1.frame,
    () => window.__voxels.noa.camera.zoomDistance === 6,
    null,
    "player1 back to third person",
  );

  // projectiles: lob a rock upward and verify it broadcasts while in flight
  await p1.page.keyboard.press("5");
  await waitFor(
    p1.frame,
    () => window.__voxels.equipped() === 4,
    null,
    "player1 equipped the rock",
  );
  await p1.frame.evaluate(() => {
    const noa = window.__voxels.noa;
    noa.camera.pitch = -1.1;
  });
  await p1.page.waitForTimeout(150);
  await p1.frame.evaluate(() => {
    const noa = window.__voxels.noa;
    if (noa.rendering.camera.getForwardRay().direction.y < 0.3) {
      noa.camera.pitch = 1.1;
    }
  });
  await p1.page.waitForTimeout(150);
  await p1.page.keyboard.press("q");
  await waitFor(
    p1.frame,
    () => window.__voxels.projectileCount() > 0,
    null,
    "thrown rock is visible in flight",
    5000,
  );
  await waitFor(
    p2.frame,
    () => window.__voxels.projectileCount() > 0,
    null,
    "player2 sees the rock too",
    5000,
  );

  // now hit the players idling at spawn; the knockback lands as a
  // server-side velocity change that reaches the hit player's own client
  // through prediction rollback. p2 and p3 overlap at spawn, so accept
  // either being displaced.
  const spawnBefore = await p1.frame.evaluate(() =>
    window.__voxels.remotes().map((r) => ({ id: r.id, x: r.x, z: r.z })),
  );
  // projectiles spawn ~1 block ahead of the eye; back away if we're on top
  // of the targets so the rock doesn't spawn past them
  const tooClose = await p1.frame.evaluate((target) => {
    const pos = window.__voxels.playerPosition();
    return Math.hypot(target.x - pos[0], target.z - pos[2]) < 3;
  }, spawnBefore[0]);
  if (tooClose) {
    await p1.frame.evaluate((target) => {
      const v = window.__voxels;
      const pos = v.playerPosition();
      v.noa.camera.heading = Math.atan2(pos[0] - target.x, pos[2] - target.z);
    }, spawnBefore[0]);
    await p1.page.mouse.click(550, 375);
    await p1.page.keyboard.down("w");
    await p1.page.waitForTimeout(900);
    await p1.page.keyboard.up("w");
    await p1.page.waitForTimeout(400);
  }
  await p1.frame.evaluate((target) => {
    const v = window.__voxels;
    const pos = v.playerPosition();
    v.noa.camera.heading = Math.atan2(target.x - pos[0], target.z - pos[2]);
    v.noa.camera.pitch = 0;
  }, spawnBefore[0]);
  await p1.page.waitForTimeout(150);
  await p1.page.keyboard.press("q");
  await waitFor(
    p1.frame,
    (before) =>
      window.__voxels.remotes().some((r) => {
        const was = before.find((b) => b.id === r.id);
        return was && Math.hypot(r.x - was.x, r.z - was.z) > 0.4;
      }),
    spawnBefore,
    "a player at spawn was knocked back by the rock",
    8000,
  );

  // combat: the rock hit already dealt damage; now chase a player down with
  // the axe and verify damage, death, and respawn with full hp
  const hurtVictim = await p1.frame.evaluate(() =>
    window.__voxels.remotes().find((r) => r.hp < 20),
  );
  if (!hurtVictim) throw new Error("rock hit dealt no damage");
  log(`OK: projectile damage landed (${hurtVictim.name} at ${hurtVictim.hp}/20 hp)`);

  await p1.page.keyboard.press("3"); // axe: 5 melee damage
  await waitFor(p1.frame, () => window.__voxels.equipped() === 2, null, "player1 equipped the axe");
  const victimId = hurtVictim.id;
  let died = false;
  for (let i = 0; i < 24 && !died; i++) {
    // close the distance the knockback opens up; only swing when in reach
    const chase = await p1.frame.evaluate((id) => {
      const v = window.__voxels;
      const victim = v.remotes().find((r) => r.id === id);
      if (!victim) return null;
      const pos = v.playerPosition();
      v.noa.camera.heading = Math.atan2(victim.x - pos[0], victim.z - pos[2]);
      return Math.hypot(victim.x - pos[0], victim.z - pos[2]);
    }, victimId);
    if (chase === null) throw new Error("melee victim disappeared");
    if (chase > 3.5) {
      await p1.page.keyboard.down("w");
      await p1.page.waitForTimeout(Math.min(2000, chase * 300));
      await p1.page.keyboard.up("w");
      continue;
    }
    await p1.frame.evaluate((id) => window.__voxels.attack(id), victimId);
    await p1.page.waitForTimeout(450);
    died = await p1.frame.evaluate((id) => window.__voxels.lastDeath()?.victim === id, victimId);
  }
  if (!died) throw new Error("melee attacks never killed the victim");
  log("OK: melee attacks killed the victim (death broadcast received)");
  await waitFor(
    p1.frame,
    (id) => {
      const victim = window.__voxels.remotes().find((r) => r.id === id);
      return !!victim && victim.hp === 20;
    },
    victimId,
    "victim respawned with full hp",
    8000,
  );

  // hold-to-mine: one continuous LMB hold must keep swinging and digging.
  // Aim down at the ground with the pickaxe and hold for a few seconds —
  // multiple blocks should break (auto-picked up as drops), and player2's
  // view of player1's arm must visibly swing (networked swing events).
  // step away from the spawn crowd first — players in the aim corridor are
  // (deliberately) attacked in preference to blocks
  await p1.frame.evaluate(() => {
    const v = window.__voxels;
    const pos = v.playerPosition();
    v.noa.camera.heading = Math.atan2(pos[0] - 0.5, pos[2] - 0.5); // away from spawn
    v.noa.camera.pitch = 0;
  });
  await p1.page.mouse.click(550, 375);
  await p1.page.keyboard.down("w");
  await p1.page.waitForTimeout(1600);
  await p1.page.keyboard.up("w");
  await p1.page.waitForTimeout(400);

  // block health: blocks take multiple hits, then drop a floating pickup
  // that lands in the digger's inventory when they stand nearby
  await p1.page.keyboard.press("2"); // pickaxe digs everything
  await waitFor(
    p1.frame,
    () => window.__voxels.equipped() === 1,
    null,
    "player1 re-equipped pickaxe",
  );
  // the drop must land within pickup range of where we stand, so only
  // accept a dig spot whose surface is near our feet (prior runs may have
  // dug some columns deep)
  const digSpot = await p1.frame.evaluate(() => {
    const v = window.__voxels;
    const pos = v.playerPosition();
    const px = Math.floor(pos[0]);
    const pz = Math.floor(pos[2]);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, -1],
    ]) {
      const x = px + dx;
      const z = pz + dz;
      for (let y = Math.ceil(pos[1]) + 1; y >= Math.floor(pos[1]) - 1; y--) {
        const b = v.blockAt(x, y, z);
        if (b !== 0 && b !== 12) {
          return { x, y, z, block: b };
        }
      }
    }
    return null;
  });
  if (!digSpot) throw new Error("no diggable block next to player1");
  const invBefore = await p1.frame.evaluate(() => {
    const inv = window.__voxels.inventory();
    return Object.values(inv).reduce((a, b) => a + b, 0);
  });
  let hits = 0;
  let broke = false;
  for (; hits < 8 && !broke; ) {
    await p1.frame.evaluate((s) => window.__voxels.sendHit(s.x, s.y, s.z), digSpot);
    hits++;
    await p1.page.waitForTimeout(250);
    broke = await p1.frame.evaluate((s) => window.__voxels.blockAt(s.x, s.y, s.z) === 0, digSpot);
  }
  if (!broke) throw new Error(`block ${digSpot.block} did not break in ${hits} hits`);
  if (hits < 2)
    throw new Error(`block ${digSpot.block} broke in a single hit — expected multi-hit HP`);
  log(`OK: block (type ${digSpot.block}) broke after ${hits} hits and dropped`);
  await waitFor(
    p1.frame,
    (before) => {
      const inv = window.__voxels.inventory();
      return Object.values(inv).reduce((a, b) => a + b, 0) > before;
    },
    invBefore,
    "player1 picked the drop up into their inventory",
    8000,
  );

  const invBeforeHold = await p1.frame.evaluate(() => {
    const inv = window.__voxels.inventory();
    return Object.values(inv).reduce((a, b) => a + b, 0);
  });
  await p1.frame.evaluate(() => {
    window.__voxels.noa.camera.pitch = 0.9; // look down at nearby ground
  });
  const beforeStats = await p2.frame.evaluate(() => ({
    swings: window.__voxels.remoteSwingsSeen(),
    events: window.__voxels.streamEventsSeen(),
  }));
  await p1.page.mouse.down();
  await p1.page.waitForTimeout(4500);
  await p1.page.mouse.up();
  const afterStats = await p2.frame.evaluate(() => ({
    swings: window.__voxels.remoteSwingsSeen(),
    events: window.__voxels.streamEventsSeen(),
  }));
  const swingsBefore = beforeStats.swings;
  const swingsAfter = afterStats.swings;
  log(
    `p2 during mining: +${afterStats.swings - beforeStats.swings} swings, +${afterStats.events - beforeStats.events} stream events (lifetime ${afterStats.events})`,
  );
  if (afterStats.events - beforeStats.events === 0) {
    const tail = await p2.frame.evaluate(() => window.__voxels.streamEventLog().slice(-15));
    log(`p2 last stream events: ${tail.join(" | ")}`);
  }
  // dug blocks land ahead of the player (the camera ray hits ground a few
  // blocks out) — walk forward to collect, then count inventory + leftovers
  await p1.frame.evaluate(() => {
    window.__voxels.noa.camera.pitch = 0;
  });
  await p1.page.keyboard.down("w");
  await p1.page.waitForTimeout(900);
  await p1.page.keyboard.up("w");
  await p1.page.waitForTimeout(2000);
  const afterHold = await p1.frame.evaluate(() => ({
    inv: Object.values(window.__voxels.inventory()).reduce((a, b) => a + b, 0),
    drops: window.__voxels.dropCount(),
  }));
  const mined = afterHold.inv - invBeforeHold + afterHold.drops;
  if (mined < 2) {
    throw new Error(
      `hold-to-mine broke too little: inventory +${afterHold.inv - invBeforeHold}, drops ${afterHold.drops}`,
    );
  }
  log(
    `OK: hold-to-mine broke ${mined} blocks from one hold (collected ${afterHold.inv - invBeforeHold}, ${afterHold.drops} still floating)`,
  );
  // long-idle clients in heavy sessions can have stream delivery starved to
  // a trickle (runtime-layer issue, see README); >=1 event still proves the
  // swing broadcast pipeline end to end
  if (swingsAfter - swingsBefore < 1) {
    throw new Error(`player2 received no swing events (lifetime ${afterStats.events})`);
  }
  log(
    `OK: player2 received ${swingsAfter - swingsBefore} networked swing events while player1 mined`,
  );

  // chunk-scoped sync: an edit in a far-away chunk (nobody nearby) must not
  // be delivered to other players' edit state
  await p1.frame.evaluate(() => window.__voxels.setBlockAt(2, 3000, 10, 3000));
  await p1.page.waitForTimeout(1200);
  const farLeaks = await Promise.all(
    [p2, p3].map((p) => p.frame.evaluate(() => window.__voxels.hasEdit(3000, 10, 3000))),
  );
  if (farLeaks.some(Boolean)) throw new Error("far-chunk edit leaked to non-nearby players");
  // every nearby player should hold the same spawn-area edit state (the dev
  // server's log persists across runs, so compare counts rather than pin them)
  const nearCounts = await Promise.all(
    [p2, p3].map((p) =>
      p.frame.evaluate(() => ({
        near: window.__voxels.hasEdit(3, 10, 3),
        count: window.__voxels.editCount(),
      })),
    ),
  );
  for (const { near } of nearCounts) {
    if (!near) throw new Error("nearby edit missing from a nearby player");
  }
  if (nearCounts[0].count !== nearCounts[1].count) {
    throw new Error(
      `nearby players disagree on edit state: ${nearCounts.map((c) => c.count).join(" vs ")}`,
    );
  }
  log("OK: far-chunk edit not synced to others; nearby players agree on local edit state");

  // screenshots while all three are in-world
  await p1.page.waitForTimeout(400);
  await p1.page.screenshot({ path: `${SHOTS}player1.png` });
  await p2.page.screenshot({ path: `${SHOTS}player2.png` });
  log(`screenshots saved to ${SHOTS}`);

  // input redundancy under loss: degrade the network (latency + jitter +
  // datagram loss) via the dev shell debug menu and run around. Every input
  // packet carries the unacked tail, so a lost datagram is healed by the
  // next one — rollbacks must stay near zero (the rollback machinery itself
  // is proven by the knockback check above, which corrects the victim's
  // client through a rollback). Before redundancy this same run produced a
  // rollback for every lost packet (~14 over this window at 20% loss).
  await p1.page.getByRole("button", { name: "Open Snack debug menu" }).click();
  await p1.page.getByLabel("Latency ms").fill("150");
  await p1.page.getByLabel("Jitter ms").fill("40");
  await p1.page.getByLabel("Datagram loss %").fill("20");
  await p1.page.getByRole("button", { name: "Apply" }).click();
  await p1.page.getByRole("button", { name: "Close Snack debug menu" }).click();
  log("network simulation on: 150ms latency, 40ms jitter, 20% datagram loss");

  const rollbacksBefore = await p1.frame.evaluate(() => window.__voxels.rollbacks());
  await p1.page.mouse.click(550, 375);
  for (const key of ["w", "a", "s", "d", "w"]) {
    await p1.page.keyboard.down(key);
    await p1.page.keyboard.down("Space");
    await p1.page.waitForTimeout(700);
    await p1.page.keyboard.up("Space");
    await p1.page.keyboard.up(key);
  }
  const rollbacksAfter = await p1.frame.evaluate(() => window.__voxels.rollbacks());
  const lossRollbacks = rollbacksAfter - rollbacksBefore;
  if (lossRollbacks > 4) {
    throw new Error(`input redundancy failed to absorb packet loss (${lossRollbacks} rollbacks)`);
  }
  log(`OK: input redundancy held under packet loss (${lossRollbacks} rollbacks)`);

  // after movement stops, client prediction and the server view converge
  await p1.page.waitForTimeout(2500);
  const settled = await p1.frame.evaluate(() => window.__voxels.playerPosition());
  await waitFor(
    p2.frame,
    (expected) =>
      window.__voxels
        .remotes()
        .some((r) => Math.hypot(r.x - expected[0], r.y - expected[1], r.z - expected[2]) < 0.8),
    settled,
    "player2's view of player1 converged after rollbacks",
    15000,
  );

  // restore a clean network before the disconnect test
  await p1.page.getByRole("button", { name: "Open Snack debug menu" }).click();
  await p1.page.getByRole("button", { name: "None" }).click();
  await p1.page.getByRole("button", { name: "Close Snack debug menu" }).click();
  log("network simulation reset to none");

  // disconnect: close player3, others should drop to 1 remote. Usually the
  // broker reports the closed connection within seconds; when it doesn't
  // (load, abrupt teardown), the runtime's liveness reap (~20s of inbound
  // silence) is the fallback — the budget sits comfortably past that.
  await p3.context.close();
  live.pop();
  const t0 = Date.now();
  await waitFor(
    p1.frame,
    () => window.__voxels.remoteCount() === 1,
    null,
    "player1 sees player3 leave",
    30000,
  );
  await waitFor(
    p2.frame,
    () => window.__voxels.remoteCount() === 1,
    null,
    "player2 sees player3 leave",
    30000,
  );
  log(`leave detected in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const p of [p1, p2]) {
    if (p.errors.length) log("console errors:", p.errors.slice(0, 10));
  }
  log("ALL CHECKS PASSED");
} catch (err) {
  log("FAILURE:", err.message.split("\n")[0]);
  await dump(live);
  process.exitCode = 1;
} finally {
  await browser.close();
}
