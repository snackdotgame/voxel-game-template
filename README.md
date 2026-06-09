# Noa Voxels

A multiplayer voxel sandbox built on [noa-engine](https://github.com/fenomas/noa) and the
[Minion](https://minion.game) platform. Walk around a procedurally generated voxel world with
other players, dig blocks, and place blocks — edits are shared live and replayed to anyone who
joins later.

## How it works

- `src/client.ts` — noa-engine world in the browser. Deterministic terrain is generated locally
  on every client; server-confirmed block edits are layered on top during chunk generation.
  Remote players render as colored boxes that interpolate toward 20 Hz position snapshots.
- `src/server.ts` — Minion server. A 20 Hz loop that tracks connections, relays player positions
  over datagrams, and rebroadcasts block edits over reliable streams. New players get a `welcome`
  message replaying the full edit log.
- `src/shared/messages.ts` — message shapes and parsers shared by both sides.

Position updates use datagrams (frequent, loss-tolerant); block edits use streams (must arrive).

## Develop

```sh
npm install
npm run dev
```

Then open the Minion host shell at `http://127.0.0.1:3030/`. Each tab gets its own guest
identity, so two tabs are a two-player game.

Controls: click to capture the mouse, WASD to move, space to jump, left-click to dig,
right-click or E to place dirt.

## Test

With `npm run dev` running:

```sh
PLAYWRIGHT_RESOLVE_FROM=/path/to/some/package.json node scripts/playtest.mjs
```

Drives three browser sessions through the host shell and asserts connection, movement,
position sync, block-edit propagation, late-join edit replay, and disconnect handling.
`window.__voxels` exposes the dev hooks the script uses.

Checks: `npm run check` (format, client+server typecheck, lint).
