import { describe, expect, it } from "vitest";

import {
  accumulatePullGesture,
  captureLaunch,
  createPullGestureAccumulator,
  launchGestureLayout,
  projectPullGesture,
} from "../src/input/launcher";
import { LAUNCHER_MODELS } from "../src/render/launcher";

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

  it("uses the long screen axis and the real L/R withdrawal direction in landscape", () => {
    const right = launchGestureLayout({ widthPx: 1024, heightPx: 360 }, 1);
    const left = launchGestureLayout({ widthPx: 1024, heightPx: 360 }, -1);
    expect(right.orientation).toBe("landscape");
    expect(right.pullAxis).toEqual({ x: 1, y: 0 });
    expect(left.pullAxis).toEqual({ x: -1, y: 0 });
    expect(right.maxTravelPx).toBe(520);

    const portrait = launchGestureLayout({ widthPx: 390, heightPx: 844 }, -1);
    expect(portrait.orientation).toBe("portrait");
    expect(portrait.pullAxis).toEqual({ x: 0, y: 1 });
  });

  it("normalizes a complete compact-viewport pull to the same physical power", () => {
    const compact = launchGestureLayout({ widthPx: 640, heightPx: 320 }, 1);
    const reference = launchGestureLayout({ widthPx: 1024, heightPx: 360 }, 1);
    expect(compact.maxTravelPx).toBeCloseTo(396.8, 8);
    expect(compact.powerPxScale).toBeGreaterThan(1);

    const durationMs = 600;
    const compactPull = projectPullGesture(compact.maxTravelPx, 0, compact.pullAxis);
    const referencePull = projectPullGesture(reference.maxTravelPx, 0, reference.pullAxis);
    const compactState = accumulatePullGesture(
      createPullGestureAccumulator(0),
      compactPull,
      durationMs,
      compact.maxTravelPx,
      compact.powerPxScale,
    );
    const referenceState = accumulatePullGesture(
      createPullGestureAccumulator(0),
      referencePull,
      durationMs,
      reference.maxTravelPx,
      reference.powerPxScale,
    );
    expect(compactState.sp).toBe(referenceState.sp);
    expect(compactState.sp).toBeGreaterThan(0);
    expect(compactState.sp).toBeLessThan(11000);
  });

  it("keeps real product stroke-length differences after viewport normalization", () => {
    const string = launchGestureLayout({ widthPx: 640, heightPx: 320 }, 1, 1);
    const entry = launchGestureLayout({ widthPx: 640, heightPx: 320 }, 1, 0.55);
    expect(entry.maxTravelPx).toBeCloseTo(string.maxTravelPx * 0.55, 8);
    const durationMs = 420;
    const stringState = accumulatePullGesture(
      createPullGestureAccumulator(0),
      projectPullGesture(string.maxTravelPx, 0, string.pullAxis),
      durationMs,
      string.maxTravelPx,
      string.powerPxScale,
    );
    const entryState = accumulatePullGesture(
      createPullGestureAccumulator(0),
      projectPullGesture(entry.maxTravelPx, 0, entry.pullAxis),
      durationMs,
      entry.maxTravelPx,
      entry.powerPxScale,
    );
    expect(entryState.sp).toBeLessThan(stringState.sp);
  });

  it("lets every selectable launcher reach 11k with a complete fast landscape pull", () => {
    for (const product of Object.values(LAUNCHER_MODELS)) {
      const layout = launchGestureLayout(
        { widthPx: 640, heightPx: 320 },
        product.direction,
        product.maxPullM / LAUNCHER_MODELS.string.maxPullM,
      );
      const sample = projectPullGesture(
        layout.pullAxis.x * layout.maxTravelPx,
        layout.pullAxis.y * layout.maxTravelPx,
        layout.pullAxis,
      );
      const state = accumulatePullGesture(
        createPullGestureAccumulator(0),
        sample,
        100,
        layout.maxTravelPx,
        layout.powerPxScale,
      );
      expect(state.sp, product.kind).toBe(11000);
    }
  });

  it("treats an invalidated orientation as a free cancelled retry", async () => {
    const hadWindow = "window" in globalThis;
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
    });
    try {
      const element = new EventTarget() as HTMLElement;
      const result = await captureLaunch(element, {
        shootAtMs: Date.now() + 10_000,
        earlyWindowMs: 350,
        lateWindowMs: 1600,
        minSp: 1200,
        cancelSignal: Promise.resolve(),
      });
      expect(result.cancelled).toBe(true);
      expect(result.aborted).not.toBe(true);
      expect(result.mislaunch).toBe("weak");
    } finally {
      if (hadWindow) {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      } else {
        delete (globalThis as { window?: Window }).window;
      }
    }
  });
});
