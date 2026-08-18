import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { deriveBeyParams, PartIndex, resolveCombo } from "../src/core/derive";
import { pocketGuardRiseAt, pocketPath, STADIUM_BX10 } from "../src/core/stadium";
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

const rounds: { match: string; seed: number; launches: [LaunchParams, LaunchParams] }[] = [
  { match: "msyx4428-r1", seed: 1725447641, launches: [
    { sp: 11000, aimDeg: -1.3098203517225473, tiltDeg: 0.05165700428527309, launcher: "stringL", spinDir: 1, delayTicks: 223 },
    { sp: 10607.802583683735, aimDeg: 1.1134703019708965, tiltDeg: -0.09759861500171166, launcher: "hold", spinDir: 1, delayTicks: 49 },
  ] },
  { match: "msyx4428-r2", seed: 471271024, launches: [
    { sp: 11000, aimDeg: -0.39294232426918413, tiltDeg: 0.004649520254242034, launcher: "stringL", spinDir: 1, delayTicks: 177 },
    { sp: 9997.705044865681, aimDeg: -6.502703770132175, tiltDeg: 1.1955253717194116, launcher: "hold", spinDir: 1, delayTicks: 8 },
  ] },
  { match: "msyx07y0-r1", seed: 67857745, launches: [
    { sp: 11000, aimDeg: -0.4780511194620155, tiltDeg: 0.006881721256689843, launcher: "stringL", spinDir: 1, delayTicks: 92 },
    { sp: 9292.876765080031, aimDeg: 0.9514148407139591, tiltDeg: -2.429381694121537, launcher: "hold", spinDir: 1, delayTicks: 49 },
  ] },
  { match: "msyx07y0-r2", seed: 2318978494, launches: [
    { sp: 11000, aimDeg: 0.395241833840521, tiltDeg: 0.004704097167275378, launcher: "stringL", spinDir: 1, delayTicks: 166 },
    { sp: 10062.421941645538, aimDeg: 4.738243519991169, tiltDeg: 2.671663701142302, launcher: "hold", spinDir: 1, delayTicks: 54 },
  ] },
];

describe("latest deployed BX-10 side-pocket replay regression", () => {
  it("blocks the exact 1.21 m/s side-pocket shortcut seen in production", () => {
    const pA = deriveBeyParams(resolveCombo(index, deckA));
    const pB = deriveBeyParams(resolveCombo(index, deckB));
    const sideEntries: unknown[] = [];
    for (const round of rounds) {
      const cfg: WorldConfig = {
        seed: round.seed,
        beys: [pA, pB],
        launches: round.launches,
        xtremeDashEnabled: true,
        clicksMax: 4,
        // The deployed shortcut entered at tick 239. Five seconds exercises
        // the complete approach and wall response without re-simulating the
        // unrelated remainder of four full matches in every test run.
        maxTicks: 240 * 5,
      };
      const world = createWorld(cfg);
      const previous = [-1, -1];
      while (!world.finish && world.tick < cfg.maxTicks) {
        step(world, cfg, STADIUM_BX10);
        for (let beyIndex = 0; beyIndex < world.beys.length; beyIndex++) {
          const bey = world.beys[beyIndex]!;
          if (bey.pocketIndex >= 0 && previous[beyIndex] !== bey.pocketIndex) {
            const pocket = STADIUM_BX10.pockets[bey.pocketIndex]!;
            if (pocket.kind === "over") {
              const frame = pocketPath(STADIUM_BX10, pocket);
              const dx = bey.x - frame.boundary.x;
              const dy = bey.y - frame.boundary.y;
              sideEntries.push({
                match: round.match,
                tick: world.tick,
                seconds: world.tick / 240,
                bey: beyIndex,
                pocket: pocket.id,
                along: dx * frame.axis.x + dy * frame.axis.y,
                across: dx * frame.across.x + dy * frame.across.y,
                speed: Math.hypot(bey.vx, bey.vy),
                guardRise: pocketGuardRiseAt(STADIUM_BX10, bey.x, bey.y),
              });
            }
          }
          previous[beyIndex] = bey.pocketIndex;
        }
      }
    }
    expect(sideEntries).toEqual([]);
  }, 120_000);
});
