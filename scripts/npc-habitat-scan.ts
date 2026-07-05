// Dev scan: per NPC kind, what fraction of the map allows spawns and how far
// from the origin the nearest habitat patch sits, under the biome + territory
// rules. Run with `node scripts/npc-habitat-scan.ts <worldSeed>` (the seed is
// printed by `snack dev` on boot). KINDS mirrors NPC_CONFIG in src/server.ts —
// keep the biome lists, territory thresholds, and the noise seeds (1100+kind,
// scale 96) in sync by hand when tuning spawn rules.
import { biomeAt, noise2, setWorldSeed, type Biome } from "../src/shared/terrain.ts";

const seed = Number(process.argv[2] ?? 1);
setWorldSeed(seed);

const KINDS: { name: string; biomes: Biome[]; territory: number }[] = [
  { name: "chicken", biomes: ["plains", "forest"], territory: 0.55 },
  { name: "pig", biomes: ["plains", "forest"], territory: 0.55 },
  { name: "cow", biomes: ["plains"], territory: 0.55 },
  { name: "zombie", biomes: ["forest", "mountains"], territory: 0.6 },
  { name: "spider", biomes: ["forest", "mountains", "desert"], territory: 0.6 },
];

for (let kind = 0; kind < KINDS.length; kind++) {
  const cfg = KINDS[kind];
  let nearest = Infinity;
  let coverage = 0;
  let total = 0;
  for (let x = -400; x <= 400; x += 4) {
    for (let z = -400; z <= 400; z += 4) {
      total++;
      const ok =
        cfg.biomes.includes(biomeAt(x, z)) && noise2(x, z, 96, 1100 + kind) >= cfg.territory;
      if (ok) {
        coverage++;
        nearest = Math.min(nearest, Math.hypot(x, z));
      }
    }
  }
  console.log(
    `${cfg.name}: coverage ${((coverage / total) * 100).toFixed(1)}%  nearest patch ${
      nearest === Infinity ? "none in 400" : `${Math.round(nearest)} blocks`
    }`,
  );
}
