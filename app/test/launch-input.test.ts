import { describe, expect, it } from "vitest";

import {
  accumulatePullGesture,
  createPullGestureAccumulator,
  projectPullGesture,
} from "../src/input/launcher";

describe("physical launcher pull projection", () => {
  it("treats an untouched pointer as a neutral aligned hold", () => {
    expect(projectPullGesture(0, 0)).toMatchObject({
      axialPx: 0,
      perpendicularPx: 0,
      gestureAngleDeg: 0,
      pullQuality: 1,
    });
  });

  it("projects signed axial extension and perpendicular error", () => {
    const p = projectPullGesture(20, 100);
    expect(p.axialPx).toBe(100);
    expect(p.perpendicularPx).toBe(20);
    expect(p.gestureAngleDeg).toBeCloseTo(11.3099, 3);
    expect(p.pullQuality).toBeCloseTo(100 / Math.hypot(20, 100), 8);

    const reverse = projectPullGesture(0, -40);
    expect(reverse.axialPx).toBe(-40);
    expect(reverse.pullQuality).toBe(0);
  });

  it("gives perpendicular movement no travel or power", () => {
    const start = createPullGestureAccumulator(0);
    const sideways = projectPullGesture(180, 0);
    const next = accumulatePullGesture(start, sideways, 50, 400);
    expect(next.peakAxialPx).toBe(0);
    expect(next.sp).toBe(0);
  });

  it("cannot farm SP by reversing and repeating the same pull", () => {
    let state = createPullGestureAccumulator(0);
    state = accumulatePullGesture(state, projectPullGesture(0, 100), 100, 400);
    const firstSp = state.sp;
    expect(state.peakAxialPx).toBe(100);
    expect(firstSp).toBeGreaterThan(0);

    state = accumulatePullGesture(state, projectPullGesture(0, 20), 200, 400);
    state = accumulatePullGesture(state, projectPullGesture(0, 100), 300, 400);
    expect(state.peakAxialPx).toBe(100);
    expect(state.sp).toBe(firstSp);

    state = accumulatePullGesture(state, projectPullGesture(0, 150), 350, 400);
    expect(state.peakAxialPx).toBe(150);
    expect(state.sp).toBeGreaterThan(firstSp);
  });

  it("caps physical travel and never reuses travel beyond the product limit", () => {
    let state = createPullGestureAccumulator(0);
    state = accumulatePullGesture(state, projectPullGesture(0, 600), 100, 250);
    const cappedSp = state.sp;
    expect(state.peakAxialPx).toBe(250);
    state = accumulatePullGesture(state, projectPullGesture(0, 900), 120, 250);
    expect(state.peakAxialPx).toBe(250);
    expect(state.sp).toBe(cappedSp);
  });

  it("mirrors R/L product axes without changing valid pull power", () => {
    const right = projectPullGesture(60, 80, { x: 0.6, y: 0.8 });
    const left = projectPullGesture(-60, 80, { x: -0.6, y: 0.8 });
    expect(right.axialPx).toBeCloseTo(100, 8);
    expect(left.axialPx).toBeCloseTo(100, 8);
    expect(right.perpendicularPx).toBeCloseTo(0, 8);
    expect(left.perpendicularPx).toBeCloseTo(0, 8);

    const rState = accumulatePullGesture(createPullGestureAccumulator(0), right, 100, 300);
    const lState = accumulatePullGesture(createPullGestureAccumulator(0), left, 100, 300);
    expect(rState).toEqual(lState);
  });

  it("scores a final new peak exactly once (the pointerup sample contract)", () => {
    let state = createPullGestureAccumulator(0);
    state = accumulatePullGesture(state, projectPullGesture(0, 80), 80, 400);
    const beforeRelease = state.sp;
    state = accumulatePullGesture(state, projectPullGesture(0, 160), 120, 400);
    expect(state.peakAxialPx).toBe(160);
    expect(state.sp).toBeGreaterThan(beforeRelease);
    const afterRelease = state.sp;
    state = accumulatePullGesture(state, projectPullGesture(0, 160), 121, 400);
    expect(state.sp).toBe(afterRelease);
  });
});
