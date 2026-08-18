import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { deriveBeyParams, PartIndex, resolveCombo } from "../src/core/derive";
import { pocketGuardRiseAt, pocketPath, STADIUM_BX32 } from "../src/core/stadium";
import { createWorld, step } from "../src/core/sim";
import type { ComboSelection, LaunchParams, PartsDb, WorldConfig } from "../src/core/types";

const db: PartsDb = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/data/parts.json", import.meta.url)), "utf8"),
);
const index = new PartIndex(db);
const deckA = {
  blade: null, ratchet: "1-60", bit: "Tr#2", lockChip: "PERSEUS",
  mainBlade: "DARK", assistBlade: "B", metalBlade: "BLITZ", overBlade: "B",
} as ComboSelection;
const deckB = {
  blade: "DRANBUSTER#2", ratchet: "1-60", bit: "A", lockChip: null,
  mainBlade: null, assistBlade: null, metalBlade: null, overBlade: null,
  variantIds: {
    blade: "BL-PRD-941460-00", ratchet: "RC-PRD-941460-00", bit: "BT-PRD-941460-00",
  },
} as ComboSelection;

const rounds: { seed: number; launches: [LaunchParams, LaunchParams] }[] = [
  { seed: 2101907530, launches: [
    { sp: 11000, aimDeg: 0.16604270732812393, tiltDeg: 0.0008302211138375704, launcher: "stringL", spinDir: 1, delayTicks: 135 },
    { sp: 10287.214107475433, aimDeg: 0.7759957273218482, tiltDeg: 6.5127120640014535, launcher: "hold", spinDir: 1, delayTicks: 50 },
  ] },
  { seed: 3676897953, launches: [
    { sp: 11000, aimDeg: 1.8079057562938181, tiltDeg: 0.09840400754794087, launcher: "stringL", spinDir: 1, delayTicks: 128 },
    { sp: 10271.765494035888, aimDeg: -5.33671735381367, tiltDeg: 3.3049878397338244, launcher: "hold", spinDir: 1, delayTicks: 33 },
  ] },
  { seed: 3825931895, launches: [
    { sp: 11000, aimDeg: -1.710008554776358, tiltDeg: 0.08803749043431797, launcher: "stringL", spinDir: 1, delayTicks: 200 },
    { sp: 9703.463101804835, aimDeg: 1.2766214294653857, tiltDeg: 4.3464311098398305, launcher: "hold", spinDir: 1, delayTicks: 47 },
  ] },
  { seed: 2862602845, launches: [
    { sp: 11000, aimDeg: -0.5929381403884127, tiltDeg: 0.010586774037116164, launcher: "stringL", spinDir: 1, delayTicks: 161 },
    { sp: 10666.501931319353, aimDeg: -5.587777380350666, tiltDeg: 3.423860518933776, launcher: "hold", spinDir: 1, delayTicks: 5 },
  ] },
];

describe("latest deployed BX-32 quick-pocket replay regression", () => {
  it("blocks the three direct corner-pocket paths from the deployed match", () => {
    const pA = deriveBeyParams(resolveCombo(index, deckA));
    const pB = deriveBeyParams(resolveCombo(index, deckB));
    for (const [roundIndex, round] of rounds.entries()) {
      const cfg: WorldConfig = {
        seed: round.seed,
        beys: [pA, pB],
        launches: round.launches,
        xtremeDashEnabled: true,
        clicksMax: 4,
        maxTicks: 240 * 180,
      };
      const world = createWorld(cfg);
      const previous = [-1, -1];
      const entries: unknown[] = [];
      while (!world.finish && world.tick < cfg.maxTicks) {
        step(world, cfg, STADIUM_BX32);
        for (let beyIndex = 0; beyIndex < world.beys.length; beyIndex++) {
          const bey = world.beys[beyIndex]!;
          if (bey.pocketIndex >= 0 && previous[beyIndex] !== bey.pocketIndex) {
            const pocket = STADIUM_BX32.pockets[bey.pocketIndex]!;
            const frame = pocketPath(STADIUM_BX32, pocket);
            const dx = bey.x - frame.boundary.x;
            const dy = bey.y - frame.boundary.y;
            entries.push({
              tick: world.tick,
              seconds: world.tick / 240,
              bey: beyIndex,
              pocket: pocket.id,
              x: bey.x,
              y: bey.y,
              along: dx * frame.axis.x + dy * frame.axis.y,
              across: dx * frame.across.x + dy * frame.across.y,
              speed: Math.hypot(bey.vx, bey.vy),
              guardRise: pocketGuardRiseAt(STADIUM_BX32, bey.x, bey.y),
            });
          }
          previous[beyIndex] = bey.pocketIndex;
        }
      }
      expect(entries, `round ${roundIndex + 1}`).toEqual([]);
      expect(world.finish?.type, `round ${roundIndex + 1}`).not.toBe("xtreme");
    }
  }, 120_000);
});
