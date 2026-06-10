# Noa Voxels

A multiplayer voxel sandbox built on [noa-engine](https://github.com/fenomas/noa) and the
[Minion](https://minion.game) platform. Run around a procedurally generated voxel world in third
person with other players, dig and place blocks, and watch everyone's Minecraft-style characters
animate as they move. Block edits are shared live and replayed to anyone who joins later.

## Architecture

Movement is **server-authoritative with client-side prediction and rollback**, running
**noa's exact physics on both sides**:

- `vendor/noa` — noa-engine 0.33 vendored as an npm workspace, with one patch: its internal
  movement controller (`applyMovementPhysics`) is exported so the headless sim can drive it.
- `src/shared/sim.ts` — a fixed-tick (20 Hz) stepper around noa's `voxel-physics-engine`
  rigid body + noa's movement controller (auto-step, Quake-style acceleration, variable-height
  jumps). The body and movement state are fully captured into a plain `CharState` after every
  step, so a state can be restored bit-for-bit — the property rollback depends on.
  `scripts/sim-test.ts` proves settle/walk/jump behavior plus bit-exact determinism and
  snapshot+replay equivalence in node.
- `src/shared/terrain.ts` — deterministic terrain function plus the synced edit overlay, so
  prediction and authority collide against identical geometry.
- `src/client.ts` — samples input every sim tick, steps the sim locally right away
  (prediction), and sends the sequenced input to the server as a **datagram**. Server snapshots
  ack the last applied input seq; if the authoritative state differs from what the client
  predicted at that seq (lost/reordered datagrams), the client **rolls back** to the server
  state and replays its pending inputs. The HUD shows a live rollback counter.
- `src/server.ts` — steps each player's authoritative sim from received inputs (burst-buffered
  and rate-capped), broadcasts 20 Hz state snapshots over **datagrams**, and owns the edit log.
  Players whose inputs stop for 5s are dropped without waiting for transport timeouts.

Datagrams carry everything frequent and loss-tolerant (inputs, snapshots); reliable streams
carry only what must arrive (block edits, join/leave, chunk state).

### Chunk-scoped world sync

Chunk voxel data never crosses the network — terrain regenerates deterministically on every
client. The only synced state is the set of _current edited-voxel values_, bucketed by chunk
column. The server tracks each player's authoritative position and, as chunks enter their sync
window (4-chunk radius, 6 to unsubscribe), sends that chunk's state as a compact **binary
packet** (`src/shared/chunkCodec.ts`: 16-byte header + 7-byte records, run-length encoded
along x, split to fit the stream message limit). Live edits broadcast only to players who
currently have that chunk. Players never receive — or store — edit state for parts of the
world they aren't near, so join cost and memory scale with local activity, not world history.

### World

Deterministic value-noise terrain with biomes (plains, forest, desert, snow-capped
mountains), tree placement with cross-chunk canopies, and ore deposits (coal, iron, gold,
diamond) clustered in pockets and gated by depth — dig down to find the good stuff. The whole
generator lives in `src/shared/terrain.ts` and runs identically on client and server, so
collision and prediction agree everywhere. Digging remembers the block you broke and
right-click places it.

### Characters

Minecraft-proportioned box rigs (swinging arms/legs hung off shoulder/hip pivots) UV-mapped
with a classic-format 64x32 character skin, with procedural animation: walk cycle scaled by
speed, body bob, an airborne pose, and yaw following each player's view heading. Your own
character is visible in third person; remote players get a deterministic hue shift on the
clothing so everyone looks different.

### Asset credits

Block textures and the character skin are from
[minetest_game](https://github.com/luanti-org/minetest_game) (Luanti/Minetest), licensed
CC BY-SA 3.0 — see `assets/textures/LICENSE-minetest-textures.txt`. Ore tiles are composited
from their stone + mineral overlay textures.

## Develop

```sh
npm install
npm run dev
```

Then open the Minion host shell at `http://127.0.0.1:3030/`. Each tab gets its own guest
identity, so two tabs are a two-player game.

Controls: click to capture the mouse, WASD to move, shift to sprint, space to jump,
left-click to dig, right-click or E to place dirt, scroll to zoom the camera.

## Test

With `npm run dev` running:

```sh
PLAYWRIGHT_RESOLVE_FROM=/path/to/some/package.json node scripts/playtest.mjs
```

Drives three browser sessions through the host shell and asserts connection, predicted
movement and jumping, cross-client position sync, block-edit propagation, late-join edit
replay, and disconnect handling. It then degrades the network (150ms latency, 40ms jitter,
20% datagram loss) via the dev shell's debug menu to prove prediction rollbacks fire and the
authoritative and predicted states converge. `window.__voxels` exposes the dev hooks the
script uses.

Checks: `npm run check` (format, client+server typecheck, lint).
