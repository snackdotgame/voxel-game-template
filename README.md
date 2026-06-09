# Noa Voxels

A multiplayer voxel sandbox built on [noa-engine](https://github.com/fenomas/noa) and the
[Minion](https://minion.game) platform. Run around a procedurally generated voxel world in third
person with other players, dig and place blocks, and watch everyone's Minecraft-style characters
animate as they move. Block edits are shared live and replayed to anyone who joins later.

## Architecture

Movement is **server-authoritative with client-side prediction and rollback**:

- `src/shared/sim.ts` — deterministic fixed-tick (20 Hz) character sim: walk/sprint/jump,
  gravity, and AABB voxel collision. The exact same code steps the sim on both sides.
- `src/shared/terrain.ts` — deterministic terrain function plus the shared block-edit overlay,
  so prediction and authority collide against identical geometry.
- `src/client.ts` — samples input every sim tick, steps the sim locally right away
  (prediction), and sends the sequenced input to the server as a **datagram**. Server snapshots
  ack the last applied input seq; if the authoritative state differs from what the client
  predicted at that seq (lost/reordered datagrams), the client **rolls back** to the server
  state and replays its pending inputs. The HUD shows a live rollback counter.
- `src/server.ts` — steps each player's authoritative sim from received inputs (rate-capped),
  broadcasts 20 Hz state snapshots over **datagrams**, relays block edits over reliable
  streams, and replays the edit log to late joiners. Players whose inputs stop for 5s are
  dropped without waiting for transport timeouts.

Datagrams carry everything frequent and loss-tolerant (inputs, snapshots); reliable streams
carry only what must arrive (block edits, join/leave, welcome replay).

### Characters

Minecraft-proportioned box rigs (head with eyes, torso, swinging arms/legs hung off
shoulder/hip pivots) with procedural animation: walk cycle scaled by speed, body bob, an
airborne pose, and yaw following each player's view heading. Your own character is visible in
third person; remote players get a deterministic shirt color from their connection id.

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
