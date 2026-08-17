import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { POCKET_DWELL_TICKS, STOP_DWELL_TICKS } from "../src/core/sim";
import {
  applyStopTopplePose,
  pocketToppleDwell,
  persistentStopToppleDwell,
  stopTopplePose,
} from "../src/render/topple";

describe("zero-spin topple presentation", () => {
  it("starts upright and is fully side-resting on the finish dwell tick", () => {
    const radius = 0.0245;
    expect(stopTopplePose(0, radius)).toEqual({
      progress: 0,
      angleRad: 0,
      tipPivotLiftM: 0,
    });
    const finished = stopTopplePose(STOP_DWELL_TICKS, radius);
    expect(finished.progress).toBe(1);
    expect(finished.angleRad).toBeCloseTo(Math.PI / 2, 12);
    expect(finished.tipPivotLiftM).toBeCloseTo(radius, 12);
  });

  it("maps the shorter pocket confirmation to the same side-resting pose", () => {
    const finished = stopTopplePose(pocketToppleDwell(POCKET_DWELL_TICKS), 0.0245);
    expect(finished.progress).toBe(1);
    expect(finished.angleRad).toBeCloseTo(Math.PI / 2, 12);
  });

  it("uses state progress rather than accumulating render delta", () => {
    const half = stopTopplePose(STOP_DWELL_TICKS / 2, 0.025);
    expect(half.progress).toBe(0.5);
    expect(half.angleRad).toBeCloseTo(Math.PI / 4, 12);
    expect(stopTopplePose(STOP_DWELL_TICKS / 2, 0.025)).toEqual(half);
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
