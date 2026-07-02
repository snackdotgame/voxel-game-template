# Asset Provenance

This file records where the bundled visual and audio assets come from. The root
project license does not override the third-party asset licenses listed here.

## Project-Owned Assets

- `assets/snack.svg` is original Snack.Game icon artwork included with this
  template. It is not sourced from a third-party art pack. The Snack.Game name
  and mark remain project/brand identifiers.
- `assets/noa-voxels-cover.webp` is AI-generated project artwork created for
  this template. It is not sourced from the third-party asset packs listed
  below. The exact generator, prompt, and creation date were not recorded in
  this repository.
- Current character textures are generated procedurally at runtime from
  `src/shared/appearance.ts`; there are no bundled character skin PNGs in the
  current tree.

## Third-Party And Derived Assets

- Block textures in `assets/textures` are from Soothing 32 by Zughy and
  contributors, licensed CC BY-SA 4.0. See
  `assets/textures/LICENSE-soothing32.txt`.
- Ore tiles and grass/snow side tiles are composites made from Soothing 32 base
  and overlay textures and should be treated as adapted CC BY-SA 4.0 material.
- Some item sprites are adapted from Soothing 32, and the remaining item sprites
  are original project art. See `assets/items/LICENSE-items.txt`.
- Footstep and impact sounds are from Kenney's Impact Sounds pack, licensed
  CC0. See `assets/sounds/LICENSE-kenney-impact-sounds.txt`.
- Water splash sounds are credited in `assets/sounds/LICENSE-water-splash.txt`.
