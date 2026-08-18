import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { deriveBeyParams, PartIndex, resolveCombo } from "../src/core/derive";
import { STADIUM_BX10, type StadiumSpec } from "../src/core/stadium";
import {
  createWorld,
  hashWorld,
  latchImpactResponse,
  PHYSICS_VERSION,
  simulateBattle,
  step,
} from "../src/core/sim";
import type { BeyParams, LaunchParams, PartEntry, PartsDb, WorldConfig } from "../src/core/types";

const db: PartsDb = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/data/parts.json", import.meta.url)), "utf8"),
);
const partIndex = new PartIndex(db);

const referenceBlade = db.parts.blade.find((part) => !part.integratedRatchet)!;
const fixedResistanceRatchet = db.parts.ratchet.find((part) => part.fixedBurst)!;
const ordinaryRatchet = db.parts.ratchet.find((part) => !part.fixedBurst && !part.integratedRatchet)!;
// DS and LF deliberately differ in both Defense and Burst, proving that the
// complete derived latch resistance is independent of Bit under this Ratchet.
const lowBurstBit = db.parts.bit.find((part) => part.code === "DS")!;
const highBurstBit = db.parts.bit.find((part) => part.code === "LF")!;

function catalogParams(ratchet: PartEntry, bit: PartEntry): BeyParams {
  return deriveBeyParams({
    parts: { blade: referenceBlade, ratchet, bit },
    isCx: false,
  });
}

const bey = (over: Partial<BeyParams> = {}): BeyParams => ({
  label: "Ratchet fixture",
  massKg: 0.036,
  radiusM: 0.0245,
  inertia: 0.000013,
  cogHeightM: 0.016,
  attackFactor: 1,
  attackVariance: 0.2,
  defenseFactor: 1,
  burstRes: 60,
  dashFactor: 1,
  grip: 0,
  muSpin: 0.05,
  muMove: 4,
  spinDir: 1,
  latchCount: 3,
  staminaFactor: 1,
  ...over,
});

const launch = (): LaunchParams => ({
  sp: 7000,
  aimDeg: 0,
  tiltDeg: 0,
  launcher: "string",
  spinDir: 1,
});

const FLAT: StadiumSpec = {
  ...STADIUM_BX10,
  dishDepth: 0,
  rimRise: 0,
  rimBaseSlope: 0,
  railArcs: [],
  pockets: [],
  coverGaps: [],
  exitSpeed: 99,
};

describe("physical Ratchet detent slip", () => {
  it("publishes the incompatible deterministic-physics version", () => {
    expect(PHYSICS_VERSION).toBe(5);
  });

  it("uses a fixed-resistance Ratchet's stat independently of the selected Bit", () => {
    expect(fixedResistanceRatchet.stats.burst).toBeGreaterThan(0);
    expect(lowBurstBit.stats.defense).not.toBe(highBurstBit.stats.defense);
    expect(lowBurstBit.stats.burst).not.toBe(highBurstBit.stats.burst);

    const fixedLow = catalogParams(fixedResistanceRatchet, lowBurstBit);
    const fixedHigh = catalogParams(fixedResistanceRatchet, highBurstBit);
    expect(fixedHigh.burstRes).toBe(fixedLow.burstRes);
    const expectedDefense = referenceBlade.stats.defense
      + fixedResistanceRatchet.stats.defense;
    expect(fixedLow.burstRes).toBeCloseTo(
      30 + fixedResistanceRatchet.stats.burst + expectedDefense * 0.08,
      10,
    );

    // An ordinary Ratchet still inherits the chosen Bit Gear Structure stat.
    const ordinaryLow = catalogParams(ordinaryRatchet, lowBurstBit);
    const ordinaryHigh = catalogParams(ordinaryRatchet, highBurstBit);
    expect(ordinaryHigh.burstRes - ordinaryLow.burstRes).toBeCloseTo(
      highBurstBit.stats.burst - lowBurstBit.stats.burst,
      10,
    );
  });

  it("does not turn radial impact or resting overlap into Burst clicks", () => {
    const p = bey({ burstRes: 6 });
    expect(latchImpactResponse(p, {
      normalImpulse: 0.4,
      incomingSmash: 0,
      attackerSpinDir: 1,
      currentClicks: 0,
    }).detentDelta).toBe(0);
    expect(latchImpactResponse(p, {
      normalImpulse: 0,
      incomingSmash: 1,
      attackerSpinDir: 1,
      currentClicks: 0,
    }).detentDelta).toBe(0);
  });

  it("requires unlock-direction torque above the Bit yield", () => {
    const impact = {
      normalImpulse: 0.02,
      incomingSmash: 0.05,
      attackerSpinDir: 1 as const,
      currentClicks: 0,
    };
    const weakBit = latchImpactResponse(bey({ burstRes: 6 }), impact);
    const toughBit = latchImpactResponse(bey({ burstRes: 240 }), impact);
    expect(weakBit.openingLoad).toBeGreaterThan(weakBit.yieldLoad);
    expect(weakBit.detentDelta).toBeGreaterThanOrEqual(1);
    expect(weakBit.detentDelta).toBeLessThanOrEqual(2);
    expect(toughBit.detentDelta).toBe(0);
  });

  it("re-seats a partial latch under reverse torque instead of leaking damage", () => {
    const p = bey({ burstRes: 60 });
    const seated = latchImpactResponse(p, {
      normalImpulse: 0.02,
      incomingSmash: 0.2,
      attackerSpinDir: -1,
      currentClicks: 2,
    });
    expect(seated.openingLoad).toBeLessThan(0);
    expect(seated.detentDelta).toBe(-1);

    const alreadyHome = latchImpactResponse(p, {
      normalImpulse: 0.02,
      incomingSmash: 0.2,
      attackerSpinDir: -1,
      currentClicks: 0,
    });
    expect(alreadyHome.detentDelta).toBe(0);
  });

  it("never treats a fixed-resistance Ratchet or integrated stack as Burst-immune", () => {
    const impact = {
      normalImpulse: 0.2,
      incomingSmash: 1,
      attackerSpinDir: 1 as const,
      currentClicks: 0,
    };
    expect(latchImpactResponse(bey({ burstRes: 60 }), impact).detentDelta).toBeGreaterThan(0);
    expect(latchImpactResponse(bey({ latchCount: 0, burstRes: 60 }), impact).detentDelta)
      .toBeGreaterThan(0);
  });

  it("counts one overlapping collision manifold only once", () => {
    const victim = bey({ burstRes: 6 });
    const smasher = bey({ attackFactor: 30, attackVariance: 0.6, burstRes: 10_000 });
    const cfg: WorldConfig = {
      seed: 91,
      beys: [victim, smasher],
      launches: [launch(), launch()],
      xtremeDashEnabled: false,
      clicksMax: 99,
      maxTicks: 4000,
    };
    const world = createWorld(cfg);
    const [a, b] = world.beys;
    for (const state of world.beys) {
      state.pendingTicks = 0;
      state.airborne = false;
      state.z = 0;
      state.vz = 0;
      state.omega = 800;
    }
    a!.x = -0.024;
    a!.y = 0;
    a!.vx = 1.4;
    a!.vy = 0;
    b!.x = 0.024;
    b!.y = 0;
    b!.vx = -1.4;
    b!.vy = 0;
    step(world, cfg, FLAT, true);
    const afterImpact = a!.burstDamage;
    expect(afterImpact).toBeGreaterThan(0);
    expect(Number.isInteger(afterImpact)).toBe(true);

    // Keep forcing the same non-closing overlap, as a contact solver can do
    // for several ticks. With no new radial closing impulse it is still the
    // original physical impact and cannot manufacture more detent slips.
    for (let tick = 0; tick < 20; tick++) {
      a!.x = -0.024;
      a!.y = 0;
      a!.vx = 0;
      a!.vy = 0;
      a!.omega = 800;
      b!.x = 0.024;
      b!.y = 0;
      b!.vx = 0;
      b!.vy = 0;
      b!.omega = 800;
      step(world, cfg, FLAT, true);
    }
    expect(a!.burstDamage).toBe(afterImpact);
    expect(world.events.filter((event) => event.kind === "click" && event.bey === 0)).toHaveLength(
      afterImpact,
    );

    // A later, genuinely new closing impact may advance another detent.
    a!.x = -0.08;
    a!.y = 0;
    a!.vx = 0;
    a!.vy = 0;
    b!.x = 0.08;
    b!.y = 0;
    b!.vx = 0;
    b!.vy = 0;
    for (let tick = 0; tick < 8; tick++) step(world, cfg, FLAT, true);
    a!.x = -0.024;
    a!.y = 0;
    a!.vx = 1.4;
    a!.vy = 0;
    a!.omega = 800;
    b!.x = 0.024;
    b!.y = 0;
    b!.vx = -1.4;
    b!.vy = 0;
    b!.omega = 800;
    step(world, cfg, FLAT, true);
    expect(a!.burstDamage).toBeGreaterThan(afterImpact);
    expect(Number.isInteger(a!.burstDamage)).toBe(true);
  });

  it("keeps routine fresh-Bit battles essentially Burst-free", () => {
    let bursts = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const cfg: WorldConfig = {
        seed,
        beys: [bey({ grip: 0.45 }), bey({ grip: 0.45 })],
        launches: [launch(), launch()],
        xtremeDashEnabled: true,
        clicksMax: 4,
        maxTicks: 240 * 60,
      };
      const world = simulateBattle(cfg, STADIUM_BX10);
      if (world.finish?.type === "burst") bursts++;
      for (const state of world.beys) expect(Number.isInteger(state.burstDamage)).toBe(true);
    }
    expect(bursts).toBeLessThanOrEqual(1);
  }, 90_000);

  it("keeps representative official stock matches low-Burst while an extreme can Burst", () => {
    const stock = (code: string): BeyParams => {
      const preset = db.combos.find((combo) => combo.code === code)!;
      return deriveBeyParams(resolveCombo(partIndex, preset.parts));
    };
    const attack = stock("DRANSWORD");
    const stamina = stock("WIZARDARROW");
    const defense = stock("KNIGHTSHIELD");
    const pairs: [BeyParams, BeyParams][] = [
      [attack, stamina],
      [attack, defense],
      [stamina, defense],
    ];
    let matches = 0;
    let bursts = 0;
    for (let pairing = 0; pairing < pairs.length; pairing++) {
      for (let sample = 0; sample < 12; sample++) {
        const [left, right] = pairs[pairing]!;
        const cfg: WorldConfig = {
          seed: 1000 + pairing * 101 + sample * 17,
          beys: [left, right],
          launches: [launch(), launch()],
          xtremeDashEnabled: true,
          clicksMax: 4,
          maxTicks: 240 * 60,
        };
        const world = simulateBattle(cfg, STADIUM_BX10);
        matches++;
        if (world.finish?.type === "burst") bursts++;
      }
    }
    expect(bursts).toBeLessThanOrEqual(Math.ceil(matches * 0.08));

    const fixedRatchetVictim = catalogParams(fixedResistanceRatchet, lowBurstBit);
    const extremeCfg: WorldConfig = {
      seed: 3,
      beys: [
        bey({ attackFactor: 9, attackVariance: 0.6, burstRes: 10_000, grip: 0.9 }),
        { ...fixedRatchetVictim, defenseFactor: 1, grip: 0.4 },
      ],
      launches: [launch(), launch()],
      xtremeDashEnabled: true,
      clicksMax: 4,
      maxTicks: 240 * 120,
    };
    const extreme = simulateBattle(extremeCfg, FLAT);
    const repeated = simulateBattle(extremeCfg, FLAT);
    expect(extreme.finish?.type).toBe("burst");
    expect(extreme.beys[1]!.burstRelease).not.toBeNull();
    expect(extreme.beys[1]!.burstRelease?.severity).toBe(extreme.beys[1]!.burstOverload);
    expect(extreme.beys[1]!.burstRelease).toEqual(repeated.beys[1]!.burstRelease);
    expect(hashWorld(extreme)).toBe(hashWorld(repeated));
    const release = extreme.beys[1]!.burstRelease!;
    expect(Number.isInteger(release.seed)).toBe(true);
    expect(release.seed).toBeGreaterThanOrEqual(0);
    expect(release.seed).toBeLessThanOrEqual(0xffff_ffff);
    for (const value of [
      release.contactAngle,
      release.normalImpulse,
      release.tangentialImpulse,
      release.preVx,
      release.preVy,
      release.postVx,
      release.postVy,
      release.omega,
      release.phase,
      release.severity,
    ]) expect(Number.isFinite(value)).toBe(true);
  }, 90_000);
});
