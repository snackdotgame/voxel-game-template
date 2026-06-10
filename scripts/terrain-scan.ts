import { SEA_LEVEL, terrainHeight } from "../src/shared/terrain.js";

let waterCols = 0;
let total = 0;
let nearest: { x: number; z: number; d: number } | null = null;
let minH = 99;
let maxH = -99;
for (let x = -400; x <= 400; x += 4) {
  for (let z = -400; z <= 400; z += 4) {
    const h = terrainHeight(x, z);
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
    total++;
    if (h < SEA_LEVEL) {
      waterCols++;
      const d = Math.hypot(x, z);
      if (!nearest || d < nearest.d) nearest = { x, z, d };
    }
  }
}
console.log(
  `water coverage: ${((waterCols / total) * 100).toFixed(1)}%  height range: ${minH}..${maxH}`,
);
console.log("nearest water column:", JSON.stringify(nearest));
