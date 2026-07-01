// Multi-client synchronization verification: five simultaneous browser
// clients cross-checking positions, concurrent and conflicting edits,
// drops, equipment, inventory isolation, and convergence under a degraded
// network. Run with `npm run dev` up:
//   PLAYWRIGHT_RESOLVE_FROM=/path/to/package.json node scripts/sync-test.mjs
import { createRequire } from "node:module";

const resolveFrom =
  process.env.PLAYWRIGHT_RESOLVE_FROM ?? new URL("../package.json", import.meta.url).pathname;
const require = createRequire(resolveFrom);
const { chromium } = require("playwright");

const SHELL_URL = process.env.SNACK_SHELL_URL ?? "http://127.0.0.1:3030/";
// the vite client port inside the host shell iframe; set alongside
// SNACK_SHELL_URL when testing an isolated dev stack on other ports
const CLIENT_PORT = process.env.SNACK_CLIENT_PORT ?? "3031";
const N = 5;

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`[sync] ${ok ? "OK" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function log(...args) {
  console.log("[sync]", ...args);
}

async function openPlayer(browser, label) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 900, height: 600 },
  });
  const page = await context.newPage();
  await page.goto(SHELL_URL, { waitUntil: "domcontentloaded" });
  let frame;
  for (let i = 0; i < 120 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes(`:${CLIENT_PORT}`));
    if (!frame) await page.waitForTimeout(250);
  }
  if (!frame) throw new Error(`${label}: game iframe never appeared`);
  await frame.waitForFunction(
    () => window.__voxels && window.__voxels.connectionState() === "connected",
    null,
    { timeout: 40000, polling: 100 },
  );
  const id = await frame.waitForFunction(() => window.__voxels.connectionState() === "connected");
  void id;
  log(`${label} connected`);
  return { context, page, frame, label };
}

const browser = await chromium.launch({ headless: true });
try {
  const players = [];
  for (let i = 0; i < N; i++) {
    players.push(await openPlayer(browser, `p${i + 1}`));
  }

  // everyone sees everyone
  for (const p of players) {
    await p.frame.waitForFunction((n) => window.__voxels.remoteCount() === n, N - 1, {
      timeout: 30000,
      polling: 100,
    });
  }
  check(`all ${N} clients see ${N - 1} remote players`, true);

  // wait for everyone to land
  for (const p of players) {
    await p.frame.waitForFunction(
      () => {
        const [, y] = window.__voxels.playerPosition();
        return y > 0 && y < 12;
      },
      null,
      { timeout: 30000, polling: 100 },
    );
  }

  // collect each client's own id (via name matching is fragile; use position
  // agreement instead: each client reports its own position, then every
  // other client must have exactly one remote near it)
  // positions must CONVERGE: poll until every client agrees with every
  // player's own predicted position (interpolation trails briefly)
  async function crossCheckPositions(tag, tolerance) {
    const deadline = Date.now() + 8000;
    let worst = Infinity;
    while (Date.now() < deadline) {
      const own = [];
      for (const p of players) {
        own.push(await p.frame.evaluate(() => window.__voxels.playerPosition()));
      }
      worst = 0;
      for (let viewer = 0; viewer < N; viewer++) {
        const remotes = await players[viewer].frame.evaluate(() => window.__voxels.remotes());
        for (let subject = 0; subject < N; subject++) {
          if (subject === viewer) continue;
          const target = own[subject];
          const best = Math.min(
            ...remotes.map((r) => Math.hypot(r.x - target[0], r.y - target[1], r.z - target[2])),
          );
          worst = Math.max(worst, best);
        }
      }
      if (worst <= tolerance) break;
      await players[0].page.waitForTimeout(300);
    }
    check(
      `${tag}: every client agrees on every player's position`,
      worst <= tolerance,
      `worst error ${worst.toFixed(2)} (tolerance ${tolerance})`,
    );
  }

  // --- phase 1: concurrent movement ---
  log("phase 1: concurrent movement");
  const headings = [0.4, 2.1, 4.4];
  await Promise.all(
    players.slice(0, 3).map(async (p, i) => {
      await p.frame.evaluate((h) => {
        window.__voxels.noa.camera.heading = h;
      }, headings[i]);
      await p.page.mouse.click(450, 300);
      await p.page.keyboard.down("w");
      await p.page.waitForTimeout(1500);
      await p.page.keyboard.up("w");
    }),
  );
  await players[3].page.mouse.click(450, 300);
  for (let i = 0; i < 3; i++) {
    await players[3].page.keyboard.press("Space");
    await players[3].page.waitForTimeout(300);
  }
  await players[0].page.waitForTimeout(2500); // settle + interpolation
  await crossCheckPositions("after concurrent movement", 0.8);

  // --- phase 2: concurrent distinct edits ---
  log("phase 2: concurrent edits");
  const editY = 30 + Math.floor(Math.random() * 30);
  await Promise.all(
    players.map((p, i) =>
      p.frame.evaluate(
        ([y, i2]) => window.__voxels.setBlockAt(2 + (i2 % 3), 8 + i2, y, 8),
        [editY, i],
      ),
    ),
  );
  await players[0].page.waitForTimeout(2500);
  let editsAgree = true;
  const reference = [];
  for (let i = 0; i < N; i++) {
    reference.push(
      await players[0].frame.evaluate(
        ([y, i2]) => window.__voxels.blockAt(8 + i2, y, 8),
        [editY, i],
      ),
    );
  }
  for (const p of players) {
    for (let i = 0; i < N; i++) {
      const value = await p.frame.evaluate(
        ([y, i2]) => window.__voxels.blockAt(8 + i2, y, 8),
        [editY, i],
      );
      if (value !== reference[i]) editsAgree = false;
    }
  }
  check(
    "concurrent edits from all clients visible identically everywhere",
    editsAgree && reference.every((b) => b !== 0),
    `blocks: ${reference.join(",")}`,
  );

  // --- phase 3: conflicting writes to one block converge ---
  const conflictY = editY + 5;
  await Promise.all(
    players.map((p, i) =>
      p.frame.evaluate(([y, i2]) => window.__voxels.setBlockAt(1 + i2, 9, y, 9), [conflictY, i]),
    ),
  );
  await players[0].page.waitForTimeout(2500);
  const conflictValues = [];
  for (const p of players) {
    conflictValues.push(
      await p.frame.evaluate(([y]) => window.__voxels.blockAt(9, y, 9), [conflictY]),
    );
  }
  check(
    "conflicting writes to the same block converge on one value",
    new Set(conflictValues).size === 1 && conflictValues[0] !== 0,
    `values: ${conflictValues.join(",")}`,
  );

  // --- phase 4: real dig path + shared drops ---
  log("phase 4: dig + drops");
  await players[0].page.keyboard.press("2"); // pickaxe digs anything
  const digSpot = await players[0].frame.evaluate(() => {
    const v = window.__voxels;
    for (let y = 12; y >= -6; y--) {
      const b = v.blockAt(9, y, 9);
      if (b !== 0 && b !== 12) return { x: 9, y, z: 9, block: b };
    }
    return null;
  });
  if (!digSpot) throw new Error("no diggable block at (9,*,9)");
  for (let i = 0; i < 8; i++) {
    await players[0].frame.evaluate((s) => window.__voxels.sendHit(s.x, s.y, s.z), digSpot);
    await players[0].page.waitForTimeout(200);
    const gone = await players[0].frame.evaluate(
      (s) => window.__voxels.blockAt(s.x, s.y, s.z) === 0,
      digSpot,
    );
    if (gone) break;
  }
  let digAgree = true;
  for (const p of players) {
    const gone = await p.frame
      .waitForFunction((s) => window.__voxels.blockAt(s.x, s.y, s.z) === 0, digSpot, {
        timeout: 5000,
        polling: 100,
      })
      .then(() => true)
      .catch(() => false);
    if (!gone) digAgree = false;
  }
  check("hit-dug block disappears on all clients", digAgree);
  // drops ride lossy datagrams with a periodic re-sync heartbeat, so poll
  // for agreement instead of sampling one instant
  let dropCounts = [];
  const dropDeadline = Date.now() + 5000;
  while (Date.now() < dropDeadline) {
    dropCounts = [];
    for (const p of players) {
      dropCounts.push(await p.frame.evaluate(() => window.__voxels.dropCount()));
    }
    if (new Set(dropCounts).size === 1 && dropCounts[0] >= 1) break;
    await players[0].page.waitForTimeout(300);
  }
  check(
    "all clients see the same world drops",
    new Set(dropCounts).size === 1 && dropCounts[0] >= 1,
    `counts: ${dropCounts.join(",")}`,
  );

  // --- phase 5: equipment sync everywhere ---
  log("phase 5: equipment");
  const equips = [1, 2, 3, 4, 5];
  for (let i = 0; i < N; i++) {
    await players[i].page.mouse.click(450, 300);
    await players[i].page.keyboard.press(String(equips[i]));
  }
  const expected = equips.map((k) => k - 1); // hotbar key -> item id
  let equipAgree = true;
  for (let viewer = 0; viewer < N; viewer++) {
    const ok = await players[viewer].frame
      .waitForFunction(
        (want) => {
          const items = window.__voxels
            .remotes()
            .map((r) => r.item)
            .sort((a, b) => a - b);
          return JSON.stringify(items) === JSON.stringify(want);
        },
        expected.filter((_, i) => i !== viewer).sort((a, b) => a - b),
        { timeout: 8000, polling: 100 },
      )
      .then(() => true)
      .catch(() => false);
    if (!ok) equipAgree = false;
  }
  check("every client sees every player's equipped item", equipAgree);

  // --- phase 6: inventory isolation ---
  log("phase 6: inventory isolation");
  const rocksBefore = [];
  for (const p of players) {
    rocksBefore.push(await p.frame.evaluate(() => window.__voxels.inventory()["4"] ?? 0));
  }
  // p4 has the rock equipped (key 4 -> shovel? no: key 4 -> item 3 shovel).
  // equip rock on p4 explicitly and throw skyward.
  await players[3].page.keyboard.press("5");
  await players[3].frame.evaluate(() => {
    window.__voxels.noa.camera.pitch = -1.1;
    if (window.__voxels.noa.rendering.camera.getForwardRay().direction.y < 0.3) {
      window.__voxels.noa.camera.pitch = 1.1;
    }
  });
  await players[3].page.waitForTimeout(150);
  await players[3].page.keyboard.press("q");
  await players[3].page.waitForTimeout(800);
  const rocksAfter = [];
  for (const p of players) {
    rocksAfter.push(await p.frame.evaluate(() => window.__voxels.inventory()["4"] ?? 0));
  }
  const throwerSpent = rocksAfter[3] === rocksBefore[3] - 1;
  const othersUntouched = rocksAfter.every((n, i) => i === 3 || n === rocksBefore[i]);
  check(
    "throw consumed only the thrower's inventory",
    throwerSpent && othersUntouched,
    `before: ${rocksBefore.join(",")} after: ${rocksAfter.join(",")}`,
  );

  // --- phase 7: convergence under degraded network ---
  log("phase 7: degraded network");
  await players[0].page.getByRole("button", { name: "Open Snack debug menu" }).click();
  await players[0].page.getByLabel("Latency ms").fill("120");
  await players[0].page.getByLabel("Jitter ms").fill("30");
  await players[0].page.getByLabel("Datagram loss %").fill("10");
  await players[0].page.getByRole("button", { name: "Apply" }).click();
  await players[0].page.getByRole("button", { name: "Close Snack debug menu" }).click();
  await Promise.all(
    players.slice(0, 2).map(async (p, i) => {
      await p.frame.evaluate(
        (h) => {
          window.__voxels.noa.camera.heading = h;
        },
        1 + i * 2,
      );
      await p.page.mouse.click(450, 300);
      await p.page.keyboard.down("w");
      await p.page.waitForTimeout(2000);
      await p.page.keyboard.up("w");
    }),
  );
  await players[0].page.getByRole("button", { name: "Open Snack debug menu" }).click();
  await players[0].page.getByRole("button", { name: "None" }).click();
  await players[0].page.getByRole("button", { name: "Close Snack debug menu" }).click();
  await players[0].page.waitForTimeout(3000); // converge
  await crossCheckPositions("after movement under 120ms/30ms/10% loss", 0.9);

  // cleanup the test blocks
  await players[0].frame.evaluate(
    ([y, y2, n]) => {
      for (let i = 0; i < n; i++) window.__voxels.setBlockAt(0, 8 + i, y, 8);
      window.__voxels.setBlockAt(0, 9, y2, 9);
    },
    [editY, conflictY, N],
  );

  console.log(failures === 0 ? "[sync] ALL SYNC CHECKS PASSED" : `[sync] ${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}
