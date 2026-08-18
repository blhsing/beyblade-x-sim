import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PartIndex, deriveBeyParams, resolveCombo } from "../src/core/derive";
import { createWorld, step } from "../src/core/sim";
import { STADIUM_BX10 } from "../src/core/stadium";
import type { ComboSelection, PartsDb, WorldConfig } from "../src/core/types";

const db: PartsDb = JSON.parse(readFileSync(
  fileURLToPath(new URL("../public/data/parts.json", import.meta.url)),
  "utf8",
));
const index = new PartIndex(db);

describe("reported stationary-pocket replay", () => {
  it("scores the motionless pocketed Bey even while its upper is still spinning", () => {
    const decks: ComboSelection[] = [
      {
        blade: "DRANSWORD", ratchet: "3-60", bit: "F",
        lockChip: null, mainBlade: null, assistBlade: null, metalBlade: null, overBlade: null,
        variantIds: {
          blade: "BL-PRD-910381-00",
          ratchet: "RC-PRD-910381-00",
          bit: "BT-PRD-910381-00",
        },
      },
      {
        blade: "DRANDAGGER", ratchet: "4-70", bit: "P",
        lockChip: null, mainBlade: null, assistBlade: null, metalBlade: null, overBlade: null,
        variantIds: {
          blade: "BL-PRD-914532-04",
          ratchet: "RC-PRD-914532-04",
          bit: "BT-PRD-914532-04",
        },
      },
    ];
    const cfg: WorldConfig = {
      seed: 3824812773,
      beys: decks.map((deck) => deriveBeyParams(resolveCombo(index, deck))),
      launches: [
        {
          sp: 11000,
          aimDeg: -1.153089457768481,
          tiltDeg: 0.04003527561516229,
          launcher: "stringL",
          spinDir: 1,
          delayTicks: 145,
        },
        {
          sp: 9615.550684948255,
          aimDeg: -2.44827564599488,
          tiltDeg: 4.936474272824551,
          launcher: "string",
          spinDir: 1,
          delayTicks: 25,
        },
      ],
      xtremeDashEnabled: true,
      clicksMax: 4,
      maxTicks: 240 * 180,
    };
    const world = createWorld(cfg);
    while (!world.finish && !world.draw && world.tick <= cfg.maxTicks) {
      step(world, cfg, STADIUM_BX10);
    }

    expect(world.finish).toEqual({
      tick: 1678,
      winner: 1,
      type: "xtreme",
      ownFinish: false,
    });
    expect(world.beys[0]?.pocketDwell).toBe(24);
    expect(world.beys[0]?.vx).toBe(0);
    expect(world.beys[0]?.vy).toBe(0);
    expect(world.beys[0]?.omega).toBeGreaterThan(400);
    expect(world.beys[1]?.stoppedTick).toBe(-1);
  }, 30_000);
});
