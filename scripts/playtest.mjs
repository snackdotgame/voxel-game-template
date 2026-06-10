// Multiplayer smoke test driven through the Minion dev host shell.
//
// Prereqs: `npm run dev` (vite on :3031, minion dev on :3030) and a Playwright
// install to borrow. Point PLAYWRIGHT_RESOLVE_FROM at any package.json whose
// node_modules contains playwright, then run: node scripts/playtest.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const resolveFrom =
  process.env.PLAYWRIGHT_RESOLVE_FROM ?? new URL("../package.json", import.meta.url).pathname;
const require = createRequire(resolveFrom);
const { chromium } = require("playwright");

const SHELL_URL = process.env.MINION_SHELL_URL ?? "http://127.0.0.1:3030/";
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
    frame = page.frames().find((f) => f.url().includes(":3031"));
    if (frame) break;
    await page.waitForTimeout(250);
  }
  if (!frame) throw new Error(`${label}: game iframe never appeared`);

  await frame.waitForFunction(
    () => window.__voxels && window.__voxels.connectionState() === "connected",
    null,
    { timeout: 30000 },
  );
  log(`${label}: connected to minion server`);
  return { context, page, frame, errors, label };
}

async function dump(players) {
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

  // keyboard movement: click canvas, hold W
  await p1.page.mouse.click(550, 375);
  const before = await p1.frame.evaluate(() => window.__voxels.playerPosition());
  await p1.page.keyboard.down("w");
  await p1.page.waitForTimeout(1200);
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

  // digging propagates p2 -> p1
  const digTarget = await p2.frame.evaluate(() => {
    for (let y = 8; y >= -8; y--) {
      if (window.__voxels.blockAt(5, y, 5) !== 0) return y;
    }
    return null;
  });
  if (digTarget === null) throw new Error("no terrain found at (5, *, 5)");
  await p2.frame.evaluate((y) => window.__voxels.setBlockAt(0, 5, y, 5), digTarget);
  await waitFor(
    p1.frame,
    (y) => window.__voxels.blockAt(5, y, 5) === 0,
    digTarget,
    `block dug by player2 at (5,${digTarget},5) disappears for player1`,
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

  // now hit player2 with one; the knockback lands as a server-side velocity
  // change that reaches p2's own client through prediction rollback
  const p2Before = await p2.frame.evaluate(() => window.__voxels.playerPosition());
  await p1.frame.evaluate((target) => {
    const v = window.__voxels;
    const pos = v.playerPosition();
    v.noa.camera.heading = Math.atan2(target[0] - pos[0], target[2] - pos[2]);
    v.noa.camera.pitch = 0;
  }, p2Before);
  await p1.page.waitForTimeout(150);
  await p1.page.keyboard.press("q");
  await waitFor(
    p2.frame,
    (before) => {
      const pos = window.__voxels.playerPosition();
      return Math.hypot(pos[0] - before[0], pos[2] - before[2]) > 0.4;
    },
    p2Before,
    "player2 knocked back by the rock",
    8000,
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

  // prediction rollback: degrade the network (latency + jitter + datagram
  // loss) via the dev shell debug menu, run around, and check that lost or
  // reordered inputs produce server corrections the client rolls back from.
  await p1.page.getByRole("button", { name: "Open Minion debug menu" }).click();
  await p1.page.getByLabel("Latency ms").fill("150");
  await p1.page.getByLabel("Jitter ms").fill("40");
  await p1.page.getByLabel("Datagram loss %").fill("20");
  await p1.page.getByRole("button", { name: "Apply" }).click();
  await p1.page.getByRole("button", { name: "Close Minion debug menu" }).click();
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
  if (rollbacksAfter <= rollbacksBefore) {
    throw new Error(
      `expected rollbacks under packet loss (before=${rollbacksBefore}, after=${rollbacksAfter})`,
    );
  }
  log(
    `OK: prediction rollbacks fired under packet loss (${rollbacksAfter - rollbacksBefore} rollbacks)`,
  );

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
  await p1.page.getByRole("button", { name: "Open Minion debug menu" }).click();
  await p1.page.getByRole("button", { name: "None" }).click();
  await p1.page.getByRole("button", { name: "Close Minion debug menu" }).click();
  log("network simulation reset to none");

  // disconnect: close player3, others should drop to 1 remote
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
