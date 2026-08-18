import { describe, expect, it } from "vitest";

import { STADIUM_BX10, type StadiumSpec } from "../src/core/stadium";
import {
  createWorld,
  hashWorld,
  OMEGA_STOP,
  STOP_DWELL_TICKS,
  STOP_LINEAR_SPEED,
  step,
} from "../src/core/sim";
import type { BeyParams, LaunchParams, WorldConfig, WorldState } from "../src/core/types";

const params = (): BeyParams => ({
  label: "settle fixture",
  massKg: 0.036,
  radiusM: 0.0245,
  inertia: 0.000013,
  cogHeightM: 0.016,
  attackFactor: 1,
  attackVariance: 0.2,
  defenseFactor: 1,
  burstRes: 80,
  dashFactor: 1,
  grip: 0,
  muSpin: 0.05,
  muMove: 2,
  spinDir: 1,
  latchCount: 3,
  staminaFactor: 1,
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
};

function fixture(slowMuSpin = 0.05): { world: WorldState; cfg: WorldConfig } {
  const cfg: WorldConfig = {
    seed: 44,
    beys: [{ ...params(), muSpin: slowMuSpin }, params()],
    launches: [launch(), launch()],
    xtremeDashEnabled: false,
    clicksMax: 4,
    maxTicks: 240 * 30,
  };
  const world = createWorld(cfg);
  for (const [index, state] of world.beys.entries()) {
    state.pendingTicks = 0;
    state.airborne = false;
    state.z = 0;
    state.vz = 0;
    state.x = index === 0 ? -0.06 : 0.06;
    state.y = 0;
    state.vx = 0;
    state.vy = 0;
    state.omega = index === 0 ? 0 : 100;
  }
  return { world, cfg };
}

describe("fully settled Spin Finish", () => {
  it("does not stop a low-rpm bey that is still translating/wobbling", () => {
    const { world, cfg } = fixture();
    const slowing = world.beys[0]!;
    for (let tick = 0; tick < STOP_DWELL_TICKS * 2; tick++) {
      slowing.x = -0.06;
      slowing.y = 0;
      slowing.vx = STOP_LINEAR_SPEED * 4;
      slowing.vy = 0;
      slowing.omega = 0;
      step(world, cfg, FLAT, true);
    }
    expect(slowing.stoppedTick).toBe(-1);
    expect(slowing.stopDwell).toBe(0);
  });

  it("requires the full sustained dwell and resets on a threshold rebound", () => {
    const { world, cfg } = fixture();
    const slowing = world.beys[0]!;
    for (let tick = 0; tick < Math.floor(STOP_DWELL_TICKS / 2); tick++) {
      step(world, cfg, FLAT, true);
    }
    expect(slowing.stopDwell).toBe(Math.floor(STOP_DWELL_TICKS / 2));
    slowing.omega = OMEGA_STOP * 2;
    step(world, cfg, FLAT, true);
    expect(slowing.stopDwell).toBe(0);
    expect(slowing.stoppedTick).toBe(-1);

    slowing.omega = 0;
    for (let tick = 0; tick < STOP_DWELL_TICKS - 1; tick++) {
      step(world, cfg, FLAT, true);
    }
    expect(slowing.stoppedTick).toBe(-1);
    expect(slowing.stopDwell).toBe(STOP_DWELL_TICKS - 1);
    step(world, cfg, FLAT, true);
    expect(slowing.stoppedTick).toBe(world.tick);
    expect(slowing.omega).toBe(0);
  });

  it("never finishes a slow-decaying synthetic bey merely for staying below 2 rad/s", () => {
    const { world, cfg } = fixture(0.02);
    const slowing = world.beys[0]!;
    slowing.omega = OMEGA_STOP * 0.99;
    for (let tick = 0; tick < STOP_DWELL_TICKS; tick++) step(world, cfg, FLAT, true);
    expect(slowing.omega).toBeGreaterThan(0);
    expect(slowing.stopDwell).toBe(0);
    expect(slowing.stoppedTick).toBe(-1);
  });

  it("sleeps zero-spin static contact before the qualifying settle dwell", () => {
    const { world, cfg } = fixture();
    const slowing = world.beys[0]!;
    slowing.vx = STOP_LINEAR_SPEED * 0.8;
    const start = { x: slowing.x, y: slowing.y };
    for (let tick = 0; tick < STOP_DWELL_TICKS; tick++) step(world, cfg, FLAT, true);
    expect(Math.hypot(slowing.x - start.x, slowing.y - start.y)).toBeLessThan(0.003);
    expect(slowing.vx).toBe(0);
    expect(slowing.vy).toBe(0);
    expect(slowing.stoppedTick).toBe(world.tick);
  });

  it("settles a toppled zero-spin Bey without repeated center-crossing glides", () => {
    const { world, cfg } = fixture();
    const [slowing, opponent] = world.beys;
    Object.assign(slowing!, {
      x: 0.15,
      y: 0,
      vx: -0.32,
      vy: 0,
      omega: 0,
      stopDwell: 0,
      stoppedTick: -1,
    });
    // Keep the rival staged so this fixture measures toppled-body contact,
    // not collision response.
    opponent!.pendingTicks = 10_000;
    let previousSide = Math.sign(slowing!.x);
    let centerCrossings = 0;
    for (let tick = 0; tick < 720 && slowing!.stoppedTick < 0; tick++) {
      if (Math.hypot(slowing!.vx, slowing!.vy) >= STOP_LINEAR_SPEED) {
        expect(slowing!.stoppedTick).toBe(-1);
      }
      step(world, cfg, STADIUM_BX10, true);
      const side = Math.sign(slowing!.x);
      if (side && previousSide && side !== previousSide) centerCrossings++;
      if (side) previousSide = side;
    }
    expect(centerCrossings).toBeLessThanOrEqual(1);
    expect(slowing!.vx).toBe(0);
    expect(slowing!.vy).toBe(0);
    expect(slowing!.stoppedTick).toBeGreaterThan(0);
  });

  it("revalidates settle after a same-tick collision wakes the bey", () => {
    const { world, cfg } = fixture();
    const [slowing, opponent] = world.beys;
    slowing!.stopDwell = STOP_DWELL_TICKS - 1;
    slowing!.omega = 0;
    slowing!.x = -0.024;
    slowing!.y = 0;
    slowing!.vx = 0;
    slowing!.vy = 0;
    opponent!.x = 0.024;
    opponent!.y = 0;
    opponent!.vx = -1.2;
    opponent!.vy = 0;
    opponent!.omega = 100;

    step(world, cfg, FLAT);
    expect(Math.hypot(slowing!.vx, slowing!.vy)).toBeGreaterThan(STOP_LINEAR_SPEED);
    expect(slowing!.stopDwell).toBe(0);
    expect(slowing!.stoppedTick).toBe(-1);
    expect(world.finish?.type).not.toBe("spin");
  });

  it("includes outcome-relevant settle progress in the lockstep hash", () => {
    const { world } = fixture();
    const before = hashWorld(world);
    world.beys[0]!.stopDwell++;
    expect(hashWorld(world)).not.toBe(before);
  });

  it("treats the safety cap as a draw while both beys are still rotating", () => {
    const { world, cfg } = fixture();
    cfg.maxTicks = 10;
    world.tick = cfg.maxTicks - 1;
    world.beys[0]!.omega = 20;
    world.beys[1]!.omega = 80;

    step(world, cfg, FLAT);
    expect(world.draw).toBe(true);
    expect(world.finish).toBeNull();
    expect(world.beys.every((bey) => Math.abs(bey.omega) > 0)).toBe(true);
  });
});
