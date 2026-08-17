import { describe, expect, it } from "vitest";

import { STADIUM_BX10, STADIUM_BX32 } from "../src/core/stadium";
import { createWorld, launchKinematics, step } from "../src/core/sim";
import { LAUNCHER_KINDS, type BeyParams, type LaunchParams, type WorldConfig } from "../src/core/types";

const bey = (spinDir: 1 | -1 = 1): BeyParams => ({
  label: "trajectory fixture",
  massKg: 0.036,
  radiusM: 0.0245,
  inertia: 0.000013,
  cogHeightM: 0.016,
  attackFactor: 1,
  attackVariance: 0.2,
  defenseFactor: 0.8,
  burstRes: 120,
  dashFactor: 1,
  grip: 0.4,
  muSpin: 0.05,
  muMove: 0.9,
  spinDir,
  latchCount: 4,
  staminaFactor: 1,
});

const launch = (over: Partial<LaunchParams> = {}): LaunchParams => ({
  sp: 7000,
  aimDeg: 0,
  tiltDeg: 0,
  launcher: "string",
  spinDir: 1,
  ...over,
});

describe("launcher-to-stadium ballistic contract", () => {
  it("is deterministic and makeBey consumes the exact returned initial state", () => {
    const p = bey();
    const l = launch({ sp: 8432, aimDeg: 13, tiltDeg: 7 });
    const a = launchKinematics(p, l, 0, 2);
    const b = launchKinematics(p, l, 0, 2);
    expect(a).toEqual(b);

    const cfg: WorldConfig = {
      seed: 1,
      beys: [p, bey()],
      launches: [l, launch()],
      xtremeDashEnabled: true,
      clicksMax: 4,
      maxTicks: 2400,
    };
    const state = createWorld(cfg).beys[0]!;
    expect({
      x: state.x,
      y: state.y,
      z: state.z,
      vx: state.vx,
      vy: state.vy,
      vz: state.vz,
      omega: state.omega,
    }).toEqual({
      x: a.x,
      y: a.y,
      z: a.z,
      vx: a.vx,
      vy: a.vy,
      vz: a.vz,
      omega: a.omega,
    });
  });

  it("uses the positive ballistic root including nonzero launchVz", () => {
    const k = launchKinematics(bey(), launch({ tiltDeg: 20 }), 0, 2);
    const zAtPrediction = k.z + k.vz * k.flightSeconds - 0.5 * 9.81 * k.flightSeconds ** 2;
    expect(zAtPrediction).toBeCloseTo(0, 10);
    expect(k.landingX).toBeCloseTo(k.x + k.vx * k.flightSeconds, 12);
    expect(k.landingY).toBeCloseTo(k.y + k.vy * k.flightSeconds, 12);
    // This deliberately differs from the old formula, which ignored vz.
    expect(k.flightSeconds).not.toBeCloseTo(Math.sqrt((2 * k.z) / 9.81), 5);
  });

  it("keeps the physical mount fixed while power, aim and tilt alter landing", () => {
    const clean = launchKinematics(bey(), launch(), 0, 2);
    const changed = launchKinematics(
      bey(),
      launch({ sp: 11000, aimDeg: 28, tiltDeg: 18, launcher: "longWinder" }),
      0,
      2,
    );
    expect(changed.x).toBe(clean.x);
    expect(changed.y).toBe(clean.y);
    expect(changed.landingX).not.toBe(clean.landingX);
    expect(changed.landingY).not.toBe(clean.landingY);
  });

  it("lands every normal product/side/direction combination inside BX-10", () => {
    for (const launcher of LAUNCHER_KINDS) {
      for (const spinDir of [-1, 1] as const) {
        for (const side of [0, 1]) {
          for (const sp of [0, 7000, 11000]) {
            for (const aimDeg of [-30, 0, 30]) {
              for (const tiltDeg of [-20, 0, 20]) {
                const k = launchKinematics(
                  bey(spinDir),
                  launch({ launcher, spinDir, sp, aimDeg, tiltDeg }),
                  side,
                  2,
                );
                expect(
                  Math.hypot(k.landingX, k.landingY),
                  `${launcher} spin=${spinDir} side=${side} sp=${sp} aim=${aimDeg} tilt=${tiltDeg}`,
                ).toBeLessThan(STADIUM_BX10.rWall);
              }
            }
          }
        }
      }
    }
  });

  it("predicts severe side-pull and outward tilt beyond both stadium walls", () => {
    const wall = Math.max(STADIUM_BX10.rWall, STADIUM_BX32.rWall);
    for (const side of [0, 1]) {
      const crooked = launchKinematics(bey(), launch({ aimDeg: 120 }), side, 2);
      const tilted = launchKinematics(bey(), launch({ tiltDeg: 70 }), side, 2);
      expect(Math.hypot(crooked.landingX, crooked.landingY)).toBeGreaterThan(wall);
      expect(Math.hypot(tilted.landingX, tilted.landingY)).toBeGreaterThan(wall);
    }
  });

  it("classifies an untouched outside touchdown as an own over finish", () => {
    const cfg: WorldConfig = {
      seed: 2,
      beys: [bey(), bey()],
      launches: [launch({ aimDeg: 120 }), launch()],
      xtremeDashEnabled: true,
      clicksMax: 4,
      maxTicks: 2400,
    };
    const world = createWorld(cfg);
    for (let i = 0; i < 300 && !world.finish; i++) step(world, cfg, STADIUM_BX10);
    expect(world.beys[0]!.exited).toBe("launchMiss");
    expect(world.finish).toMatchObject({
      type: "over",
      winner: 1,
      ownFinish: true,
    });
  });
});
