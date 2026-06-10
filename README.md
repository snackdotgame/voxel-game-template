# Noa Voxels

A multiplayer voxel sandbox built on [noa-engine](https://github.com/fenomas/noa) and the
[Minion](https://minion.game) platform. Run around a procedurally generated voxel world in third
person with other players, dig and place blocks, and watch everyone's Minecraft-style characters
animate as they move. Block edits are shared live and replayed to anyone who joins later.

## Architecture

Movement is **server-authoritative with client-side prediction and rollback**, running
**noa's exact physics on both sides**:

- `src/noa` — noa-engine 0.33 vendored into the source tree and converted to TypeScript,
  with one patch: its internal movement controller (`applyMovementPhysics`) is exported so
  the headless sim can drive it.
- `src/shared/sim.ts` — a fixed-tick (20 Hz) stepper around noa's `voxel-physics-engine`
  rigid body + noa's movement controller (auto-step, Quake-style acceleration, variable-height
  jumps). The body and movement state are fully captured into a plain `CharState` after every
  step, so a state can be restored bit-for-bit — the property rollback depends on.
  `scripts/sim-test.ts` proves settle/walk/jump behavior plus bit-exact determinism and
  snapshot+replay equivalence in node.
- `src/shared/terrain.ts` — deterministic terrain function plus the synced edit overlay, so
  prediction and authority collide against identical geometry.
- `src/client.ts` — samples input every sim tick, steps the sim locally right away
  (prediction), and sends inputs to the server as **datagrams**. Every packet redundantly
  carries the tail of the unacked inputs (Quake-style), so a lost or reordered datagram is
  healed by the next packet ~50ms later instead of skipping a sim step. Server snapshots ack
  the last applied input seq; if the authoritative state still differs from what the client
  predicted at that seq (sustained loss, server-side knockback), the client **rolls back** to
  the server state, replays its pending inputs, and eases the visible correction out over
  ~150ms rather than snapping. Remote players render ~120ms in the past, interpolating
  between buffered snapshots (position and shortest-arc heading), so 20Hz gaps and a dropped
  snapshot are bridged by real data instead of extrapolation. The HUD shows a live rollback
  counter.
- `src/server.ts` — steps each player's authoritative sim from received inputs (burst-buffered
  and rate-capped), broadcasts 20 Hz state snapshots over **datagrams**, and owns the edit log.
  Connection liveness is owned by the Minion runtime (QUIC keep-alives plus app-level
  ping/pong force-disconnect a dead client within ~20s), so a player is removed exactly when
  its connection disappears; the game adds no liveness tracking of its own. What it does keep
  is lifecycle UX: characters and inventories are parked by userId so returns and reconnects
  resume where they left off, and players only materialize on their first input, so
  connections that never send anything can't leave phantom bodies floating at spawn.

  Known runtime-layer issue (minion platform, not this game): under long heavy multi-client
  sessions on a long-lived dev server, reliable stream delivery to idle clients can starve or
  stall while datagrams keep flowing. See the minion toolchain client shim (readStreams has no
  per-stream fault isolation) and dev broker (per-message uni streams with a 16-concurrent
  silent-drop cap).

Datagrams carry everything frequent and loss-tolerant (inputs, snapshots); reliable streams
carry only what must arrive (block edits, join/leave, chunk state).

All high-frequency traffic is **binary** (`src/shared/netCodec.ts`): input packets are 4 + 9
bytes per carried input (seq + heading + button bitfield, last 8 unacked inputs per packet)
and snapshots are ~60 bytes per player (positions
as f64 since they restore the prediction sim on ack; velocities/heading as f32; resting and
jump flags bit-packed), split to fit the datagram size limit. Player names aren't repeated at
20 Hz — they arrive once over the reliable channel (welcome roster + join messages).

### Chunk-scoped world sync

Chunk voxel data never crosses the network — terrain regenerates deterministically on every
client. The only synced state is the set of _current edited-voxel values_, bucketed by chunk
column. The server tracks each player's authoritative position and, as chunks enter their sync
window (4-chunk radius, 6 to unsubscribe), sends that chunk's state as a compact **binary
packet** (`src/shared/chunkCodec.ts`: 16-byte header + 7-byte records, run-length encoded
along x, split to fit the stream message limit). Live edits broadcast only to players who
currently have that chunk. Players never receive — or store — edit state for parts of the
world they aren't near, so join cost and memory scale with local activity, not world history.

Block edits are **predicted like movement**: your placement appears instantly as a pending
overlay on the confirmed state (collision included, so you can stand on it), the server
echoes every edit to everyone — including the actor — in one canonical order, each echo
supersedes the matching prediction, and unconfirmed predictions revert after a few seconds.
Conflicting writes from multiple players converge on every client because everyone replays
the same authoritative sequence.

### World

Deterministic value-noise terrain with biomes (plains, forest, desert, snow-capped
mountains), tree placement with cross-chunk canopies, ore deposits (coal, iron, gold,
diamond) clustered in pockets and gated by depth, and **water**: basins below sea level fill
in (about a third of the world is ocean, plus a pond by spawn), with sandy shores. Water is a
real fluid — voxel-physics-engine buoyancy and drag apply on both client and server, and
holding jump swims you upward. The whole generator lives in `src/shared/terrain.ts` and runs
identically on client and server, so collision and prediction agree everywhere.

### Digging, drops, and inventory

Blocks have HP and take multiple hits to break (leaves crumble instantly; earth takes a few
hits by hand; stone takes four pickaxe hits and ores six; matching tools — axe for wood,
shovel for earth, pickaxe for stone — hit for double, and stone/ore can only be dug with
the pickaxe; partial damage heals after 10s, and damaged blocks show Minecraft-style
breaking cracks that deepen with every hit). A broken block becomes a Minecraft-style item drop: a floating,
bobbing, slowly spinning miniature that anyone can walk over to collect after a short delay.
Stone also yields a rock and snow a snowball, keeping throwing ammo renewable. Landed
projectiles persist as drops too, so a thrown pickaxe can be retrieved — or stolen.

Inventories are Minecraft-style server-authoritative slot storage: 9 hotbar slots selected
with the number keys (what you hold is whatever sits in the selected slot) over 27 larger
storage slots behind the inventory screen (E). Picked-up items stack into existing piles
(tools don't stack, everything else stacks to 64) and overflow into empty slots; a full
inventory leaves drops on the ground. The inventory screen is a DOM overlay with
drag-and-drop: drag a stack onto another slot to move it, onto a same-item stack to merge,
or onto a different item to swap — including into and out of the hotbar. Moves apply
optimistically and are confirmed by the server's inventory echo; placing (right-click, from
the held stack) and throwing consume from the slot you're holding. The starting kit is
tools plus 6 rocks and 6 snowballs on the hotbar.

### Characters

Minecraft-proportioned box rigs (swinging arms/legs hung off shoulder/hip pivots) UV-mapped
with a classic-format 64x32 character skin. Procedural animation follows the
Minecraft-classic/ClassiCube formulas: cosine limb swing with legs at ~1.4x arm amplitude in
opposite phase, scaled by speed, plus idle breathing sway, body bob, an airborne pose, a
use/attack animation, and yaw following each player's view heading. The animation math is
ported verbatim from open-source references: walk/run/idle cycles from
[skinview3d](https://github.com/bs-community/skinview3d) (MIT) and the third-person
HitAnimation plus first-person hand-swing parameters from
[minecraft-web-client](https://github.com/zardoy/minecraft-web-client) (MIT), with the rig's
rotation signs verified empirically. Swings are broadcast, so everyone sees everyone mining
and attacking; holding the mouse keeps swinging and digging. Your own character is visible in third person, and your
outfit — a deterministic hue shift derived from your connection id — is the same one everyone
else sees, including the sleeve on your first-person arm, which wears the actual skin
texture.

### Combat

Players have 20 HP (hearts above the hotbar), server-authoritative like everything else.
Left-click attacks a player in your aim corridor within reach — per-item melee damage (axe 5,
pickaxe 4, hand 2...), a 400ms server-enforced cooldown, and knockback. Projectiles deal
direct-hit damage too (rock 4, thrown tools 5, snowballs sting for 1). Damage and knockback
land in the victim's authoritative state, so their own screen reacts through the normal
prediction-rollback path; victims flash red, you get a hurt vignette, and kills hit the
toast feed. Death respawns you at spawn with full HP and 2s of protection; HP regenerates
8s after you last took damage.

### Equipment and views

V toggles first/third person (first person gets a camera-attached arm + held-item view
model). The hotbar (keys 1-6) equips hand, pickaxe, axe, shovel, rock, or snowball as
procedural box models held in the right hand, with a swing animation on dig/place. Stone and
ores require the pickaxe. The equipped item id rides in the binary snapshots, so everyone
sees what everyone is holding.

### Projectiles

Q (or middle-click) throws the equipped item along the view direction. Every item except the
bare hand is throwable, each with its own throw speed — and therefore distance: a rock flies
far, a snowball decently, tools are heavy and land short. Projectiles are simulated
server-side (ballistic arc, voxel collision, 5s lifetime) and broadcast as compact binary
datagrams; clients render them as tumbling meshes on interpolated entities. Hitting another
player applies a per-item knockback impulse to their authoritative state, which reaches the
hit player's own screen through the normal prediction-rollback path — no special casing.

### Sounds

WebAudio effects with per-play variant and pitch randomization, Minecraft-style: per-material
dig ticks and breaks (mining clinks for stone/ore, soft thuds for earth, wood knocks for
logs), placement thuds, footsteps that follow the walk cycle and the surface underfoot,
melee/hurt punches, and synthesized effects where no sample fit: an upward pickup pop,
whooshes for swings and throws, and a splash when crossing the water surface.
World-positioned events attenuate with distance. Audio starts on the first input gesture,
as browsers require.

### Asset credits

Block textures and the character skin are from
[Soothing 32](https://content.luanti.org/packages/Zughy/soothing32/) by Zughy and
contributors, licensed CC BY-SA 4.0 — see `assets/textures/LICENSE-soothing32.txt`. Ore and
grass/snow side tiles are composited from the pack's base + overlay textures. Sound effects
are from [Kenney's Impact Sounds](https://kenney.nl/assets/impact-sounds), CC0 — see
`assets/sounds/LICENSE-kenney-impact-sounds.txt`.

## Develop

```sh
npm install
npm run dev
```

Then open the Minion host shell at `http://127.0.0.1:3030/`. Each tab gets its own guest
identity, so two tabs are a two-player game.

Controls: click to capture the mouse, WASD to move, shift to sprint, space to jump,
left-click to dig, right-click to place the held block, E for the inventory screen, scroll
to zoom the camera.

## Test

With `npm run dev` running:

```sh
PLAYWRIGHT_RESOLVE_FROM=/path/to/some/package.json node scripts/playtest.mjs
```

Drives three browser sessions through the host shell and asserts connection, predicted
movement and jumping, cross-client position sync, block-edit propagation, late-join edit
replay, and disconnect handling. It then degrades the network (150ms latency, 40ms jitter,
20% datagram loss) via the dev shell's debug menu to prove input redundancy absorbs the loss
without rollbacks and the authoritative and predicted states converge. `window.__voxels` exposes the dev hooks the
script uses.

A separate synchronization suite, `scripts/sync-test.mjs` (same invocation), drives **five
concurrent clients** and cross-verifies: position agreement between every client pair after
concurrent movement, concurrent block edits visible identically everywhere, conflicting
writes to the same block converging to one value on all clients, hit-dug blocks and drops
shared consistently, equipment visibility, inventory isolation, and position convergence
after movement under 120ms latency / 30ms jitter / 10% datagram loss.

Checks: `npm run check` (format, client+server typecheck, lint).
