import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { POCKET_DWELL_TICKS, STOP_DWELL_TICKS } from "../src/core/sim";
import {
  applyStopTopplePose,
  BALANCE_LOSS_OMEGA,
  balanceTopplePose,
  pocketToppleDwell,
  persistentStopToppleDwell,
  stopTopplePose,
  ZERO_SPIN_TOPPLE_TICKS,
} from "../src/render/topple";

describe("zero-spin topple presentation", () => {
  it("loses balance before exact zero and is side-resting well before Spin Finish", () => {
    const radius = 0.0245;
    expect(balanceTopplePose(BALANCE_LOSS_OMEGA, 0, radius)).toEqual({
      progress: 0,
      angleRad: 0,
      tipPivotLiftM: 0,
    });
    const nearZero = balanceTopplePose(2, 0, radius);
    expect(nearZero.angleRad).toBeGreaterThan(Math.PI / 4);
    const promptlyDown = stopTopplePose(ZERO_SPIN_TOPPLE_TICKS, radius);
    expect(promptlyDown.angleRad).toBeCloseTo(Math.PI / 2, 12);
    expect(ZERO_SPIN_TOPPLE_TICKS).toBeLessThan(STOP_DWELL_TICKS);
    const finished = stopTopplePose(STOP_DWELL_TICKS, radius);
    expect(finished.progress).toBe(1);
    expect(finished.angleRad).toBeCloseTo(Math.PI / 2, 12);
    expect(finished.tipPivotLiftM).toBeCloseTo(radius, 12);
  });

  it("is continuous when epsilon spin clamps to zero and the dwell begins", () => {
    const epsilon = balanceTopplePose(1e-9, 0, 0.024);
    const zero = balanceTopplePose(0, 0, 0.024);
    const firstDwellTick = balanceTopplePose(0, 1, 0.024);
    expect(Math.abs(epsilon.angleRad - zero.angleRad)).toBeLessThan(1e-8);
    expect(firstDwellTick.angleRad - zero.angleRad).toBeGreaterThanOrEqual(0);
    expect(firstDwellTick.angleRad - zero.angleRad).toBeLessThan(0.002);
  });

  it("grows monotonically as RPM dies and as exact-zero dwell advances", () => {
    const poses = [
      balanceTopplePose(55, 0, 0.024),
      balanceTopplePose(40, 0, 0.024),
      balanceTopplePose(20, 0, 0.024),
      balanceTopplePose(5, 0, 0.024),
      balanceTopplePose(0, 0, 0.024),
      balanceTopplePose(0, 1, 0.024),
      balanceTopplePose(0, ZERO_SPIN_TOPPLE_TICKS / 2, 0.024),
      balanceTopplePose(0, ZERO_SPIN_TOPPLE_TICKS, 0.024),
    ];
    for (let index = 1; index < poses.length; index++) {
      expect(poses[index]!.angleRad).toBeGreaterThanOrEqual(poses[index - 1]!.angleRad);
    }
  });

  it("pivots on the Bit before transferring support to the Blade rim", () => {
    const radius = 0.024;
    expect(balanceTopplePose(20, 0, radius).tipPivotLiftM).toBe(0);
    expect(balanceTopplePose(5, 0, radius).tipPivotLiftM).toBeGreaterThan(0);
    expect(balanceTopplePose(0, ZERO_SPIN_TOPPLE_TICKS, radius).tipPivotLiftM)
      .toBeCloseTo(radius, 12);
  });

  it("maps the shorter pocket confirmation to the same side-resting pose", () => {
    const finished = stopTopplePose(pocketToppleDwell(POCKET_DWELL_TICKS), 0.0245);
    expect(finished.progress).toBe(1);
    expect(finished.angleRad).toBeCloseTo(Math.PI / 2, 12);
  });

  it("uses state progress rather than accumulating render delta", () => {
    const half = stopTopplePose(ZERO_SPIN_TOPPLE_TICKS / 2, 0.025);
    expect(half.angleRad).toBeGreaterThan(Math.PI / 4);
    expect(half.angleRad).toBeLessThan(Math.PI / 2);
    expect(stopTopplePose(ZERO_SPIN_TOPPLE_TICKS / 2, 0.025)).toEqual(half);
  });

  it("does not spring upright when a same-tick collision resets settle dwell", () => {
    const almostDown = STOP_DWELL_TICKS - 1;
    expect(persistentStopToppleDwell(almostDown, 0)).toBe(almostDown);
    expect(persistentStopToppleDwell(almostDown, 1)).toBe(almostDown);
    expect(persistentStopToppleDwell(almostDown, STOP_DWELL_TICKS)).toBe(STOP_DWELL_TICKS);
  });

  it("applies tip-pivot lift so the side-resting mesh stays above the bowl", () => {
    const bey = new THREE.Group();
    const surface = 0.011;
    const radius = 0.024;
    const phase = 2.4;
    const pose = applyStopTopplePose(
      bey,
      STOP_DWELL_TICKS,
      radius,
      phase,
      surface,
    );
    expect(bey.rotation.x).toBeCloseTo(Math.PI / 2, 12);
    expect(bey.rotation.z).toBe(phase);
    expect(bey.position.z).toBeCloseTo(surface + radius, 12);
    expect(pose.progress).toBe(1);
  });
});
