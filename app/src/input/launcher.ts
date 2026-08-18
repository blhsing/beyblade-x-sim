// Launch gesture: the player holds the phone like a launcher and drags the
// winder/string with the other hand. Pull speed over the stroke integrates
// into Shoot Power (SP, 0..11000 Beybattle-Pass-like units); release timing
// vs the GO SHOOT countdown classifies mislaunches per the official rules.

import { sfx } from "../audio/sfx";

export interface PullAxis {
  /** screen-right component */
  x: number;
  /** screen-down component */
  y: number;
}

/** The default physical pull is straight down the screen. */
export const DEFAULT_PULL_AXIS: Readonly<PullAxis> = Object.freeze({ x: 0, y: 1 });

export interface PullProjection {
  dxPx: number;
  dyPx: number;
  /** signed extension along the launcher's declared pull guide */
  axialPx: number;
  /** signed screen-right error perpendicular to that guide */
  perpendicularPx: number;
  /** signed error angle from the pull axis; positive is its screen-right side */
  gestureAngleDeg: number;
  /** 0..1 alignment with the valid outward pull direction */
  pullQuality: number;
}

export interface LaunchGestureProgress extends PullProjection {
  sp: number;
  /** unique, forward axial travel; reversal/oscillation never increases it */
  pullPx: number;
  maxTravelPx: number;
}

export interface LaunchGestureResult extends PullProjection {
  sp: number;
  /** furthest valid axial extension reached during this pull */
  peakAxialPx: number;
  /** ms relative to the "SHOOT" instant (negative = released early) */
  releaseOffsetMs: number;
  mislaunch: "early" | "late" | "weak" | null;
  /** the match was given up mid-gesture; nothing was launched */
  aborted?: boolean;
  /** the active OS/browser pointer was cancelled; never treat as release */
  cancelled?: boolean;
}

export interface LaunchGestureOptions {
  /** epoch ms of the "SHOOT" instant of the countdown */
  shootAtMs: number;
  earlyWindowMs: number; // released earlier than this before shootAt = early
  lateWindowMs: number; // no release this long after shootAt = late
  minSp: number; // below this = weak launch (發射失誤)
  /** launcher-specific screen-space pull guide; defaults to screen-down */
  pullAxis?: PullAxis;
  /** physical travel available to this product's string/rack on this screen */
  maxTravelPx?: number;
  /**
   * Converts CSS-pixel movement back to the reference physical stroke used
   * to calibrate Shoot Power.  Compact/mobile viewports can expose a shorter
   * gesture lane without making the same complete, equally fast pull weaker.
   */
  powerPxScale?: number;
  /** Complete live gesture state for the hand, string/winder and meter. */
  onProgress?: (progress: LaunchGestureProgress) => void;
  /** resolves when the player gives up — the gesture then resolves as
   * `aborted` instead of hanging until the late-launch timeout, which is
   * what used to leave a "finished" match still running in the background */
  abortSignal?: Promise<unknown>;
  /**
   * Resolves when the current gesture surface becomes invalid (for example,
   * a phone rotates and the physical pull axis changes). This is a free retry,
   * exactly like `pointercancel`, and never incurs a mislaunch penalty.
   */
  cancelSignal?: Promise<unknown>;
}

export interface PullGestureAccumulator {
  sp: number;
  peakAxialPx: number;
  lastAxialPx: number;
  lastSampleAtMs: number;
}

const CLICK_EVERY_PX = 26; // winder ratchet click spacing
const SP_PER_PX_SPEED = 16; // (px/ms) * new physical extension -> SP
export const DEFAULT_MAX_PULL_PX = 480;
export const MAX_SCREEN_PULL_PX = 520;

export interface LaunchViewport {
  widthPx: number;
  heightPx: number;
}

export interface LaunchGestureLayout {
  orientation: "portrait" | "landscape";
  /** The product's physical withdrawal direction expressed in screen axes. */
  pullAxis: PullAxis;
  /** Usable CSS-pixel stroke for this launcher's real rack/string length. */
  maxTravelPx: number;
  /** CSS-pixel normalization used only for power, never for rendered travel. */
  powerPxScale: number;
}

/**
 * Read the actually visible viewport.  `visualViewport` excludes dynamic
 * browser chrome on mobile, unlike the sometimes stale layout viewport.
 */
export function visibleLaunchViewport(): LaunchViewport {
  const visual = typeof window !== "undefined" ? window.visualViewport : null;
  const width = visual?.width ?? (typeof window !== "undefined" ? window.innerWidth : 0);
  const height = visual?.height ?? (typeof window !== "undefined" ? window.innerHeight : 0);
  return {
    widthPx: Math.max(1, Number.isFinite(width) ? width : 1),
    heightPx: Math.max(1, Number.isFinite(height) ? height : 1),
  };
}

/**
 * Lay the physical pull guide along the viewport's long usable dimension.
 * Portrait keeps the familiar downward stroke. In landscape R launchers pull
 * right and L launchers pull left, matching their real rack/string exit.
 *
 * Power is calibrated by fraction and speed of a 480 CSS-pixel reference
 * stroke. Thus a complete pull on a short landscape viewport can still reach
 * the same SP as the same physical gesture in portrait, while each product's
 * different rack/string length remains meaningful.
 */
export function launchGestureLayout(
  viewport: LaunchViewport,
  launcherDirection: -1 | 1,
  productStrokeRatio = 1,
): LaunchGestureLayout {
  const width = Math.max(1, viewport.widthPx);
  const height = Math.max(1, viewport.heightPx);
  const landscape = width > height;
  const usableDimension = landscape ? width : height;
  const referenceLanePx = Math.max(120, Math.min(usableDimension * 0.62, MAX_SCREEN_PULL_PX));
  const ratio = Number.isFinite(productStrokeRatio) ? Math.max(0.1, productStrokeRatio) : 1;
  return {
    orientation: landscape ? "landscape" : "portrait",
    pullAxis: landscape ? { x: launcherDirection, y: 0 } : { x: 0, y: 1 },
    maxTravelPx: Math.max(120, referenceLanePx * ratio),
    powerPxScale: DEFAULT_MAX_PULL_PX / referenceLanePx,
  };
}

/**
 * Project a screen displacement onto a launcher's real pull guide. This is
 * pure so touch, mouse and replay input all use identical geometry.
 */
export function projectPullGesture(
  dxPx: number,
  dyPx: number,
  pullAxis: PullAxis = DEFAULT_PULL_AXIS,
): PullProjection {
  const axisLength = Math.sqrt(pullAxis.x * pullAxis.x + pullAxis.y * pullAxis.y);
  const axisX = axisLength > 1e-9 ? pullAxis.x / axisLength : DEFAULT_PULL_AXIS.x;
  const axisY = axisLength > 1e-9 ? pullAxis.y / axisLength : DEFAULT_PULL_AXIS.y;
  const axialPx = dxPx * axisX + dyPx * axisY;
  // Right-hand normal in screen coordinates. For the default down axis this
  // is simply +screen-X, making the sign intuitive to renderer and aiming.
  const perpendicularPx = dxPx * axisY - dyPx * axisX;
  const magnitude = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
  const gestureAngleDeg =
    magnitude > 1e-9 ? (Math.atan2(perpendicularPx, axialPx) * 180) / Math.PI : 0;
  // No displacement is a neutral held pose, not a maximally crooked pull.
  // This prevents pointerdown from snapping the live launcher to its
  // 70-degree miss pose before the finger has moved at all.
  const pullQuality =
    magnitude > 1e-9 ? Math.max(0, Math.min(1, axialPx / magnitude)) : 1;
  return { dxPx, dyPx, axialPx, perpendicularPx, gestureAngleDeg, pullQuality };
}

export function createPullGestureAccumulator(sampleAtMs = 0): PullGestureAccumulator {
  return { sp: 0, peakAxialPx: 0, lastAxialPx: 0, lastSampleAtMs: sampleAtMs };
}

/**
 * Add one projected sample. Only extension beyond the all-time axial peak
 * can add travel or SP, so reversing and pulling the same section again can
 * animate naturally but cannot farm power. Perpendicular motion contributes
 * no travel and reduces power according to alignment quality.
 */
export function accumulatePullGesture(
  state: PullGestureAccumulator,
  sample: PullProjection,
  sampleAtMs: number,
  maxTravelPx = DEFAULT_MAX_PULL_PX,
  powerPxScale = 1,
): PullGestureAccumulator {
  const limit = Number.isFinite(maxTravelPx) ? Math.max(1, maxTravelPx) : DEFAULT_MAX_PULL_PX;
  const pxScale = Number.isFinite(powerPxScale) ? Math.max(0.01, powerPxScale) : 1;
  const cappedAxial = Math.max(0, Math.min(limit, sample.axialPx));
  const peakAxialPx = Math.max(state.peakAxialPx, cappedAxial);
  const novelTravel = peakAxialPx - state.peakAxialPx;
  const dt = Math.max(1, sampleAtMs - state.lastSampleAtMs);
  const forwardSpeed = Math.max(0, sample.axialPx - state.lastAxialPx) / dt;
  const quality = sample.pullQuality * sample.pullQuality;
  const sp = Math.min(
    11000,
    state.sp +
      novelTravel * pxScale * Math.min(12, forwardSpeed * pxScale) * SP_PER_PX_SPEED * quality,
  );
  return {
    sp,
    peakAxialPx,
    lastAxialPx: sample.axialPx,
    lastSampleAtMs: sampleAtMs,
  };
}

function progressFor(
  projection: PullProjection,
  state: PullGestureAccumulator,
  maxTravelPx: number,
): LaunchGestureProgress {
  return {
    ...projection,
    sp: state.sp,
    pullPx: state.peakAxialPx,
    maxTravelPx,
  };
}

/**
 * Attach to an element for exactly one launch. One pointer owns the launch;
 * secondary touches are ignored, and pointercancel is never mistaken for a
 * release. The visual callback receives raw displacement plus its physical
 * axis projection on every move.
 */
export function captureLaunch(
  el: HTMLElement,
  opts: LaunchGestureOptions,
): Promise<LaunchGestureResult> {
  return new Promise((resolve) => {
    const pullAxis = opts.pullAxis ?? DEFAULT_PULL_AXIS;
    const maxTravelPx = Number.isFinite(opts.maxTravelPx)
      ? Math.max(1, opts.maxTravelPx!)
      : DEFAULT_MAX_PULL_PX;
    const powerPxScale = Number.isFinite(opts.powerPxScale)
      ? Math.max(0.01, opts.powerPxScale!)
      : 1;
    let pointerId: number | null = null;
    let originX = 0;
    let originY = 0;
    let projection = projectPullGesture(0, 0, pullAxis);
    let accumulator = createPullGestureAccumulator();
    let clickCount = 0;
    let done = false;

    const resultFrom = (
      releaseOffsetMs: number,
      mislaunch: LaunchGestureResult["mislaunch"],
      extra: Pick<LaunchGestureResult, "aborted" | "cancelled"> = {},
    ): LaunchGestureResult => ({
      ...projection,
      sp: accumulator.sp,
      peakAxialPx: accumulator.peakAxialPx,
      releaseOffsetMs,
      mislaunch,
      ...extra,
    });

    const finish = (result: LaunchGestureResult): void => {
      if (done) return;
      done = true;
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (pointerId !== null) {
        const capturedPointer = pointerId;
        try {
          el.releasePointerCapture(capturedPointer);
        } catch {
          /* synthetic or already-released pointer */
        }
        pointerId = null;
      }
      window.clearTimeout(lateTimer);
      resolve(result);
    };

    const lateTimer = window.setTimeout(() => {
      finish(resultFrom(opts.lateWindowMs, "late"));
    }, Math.max(0, opts.shootAtMs - Date.now()) + opts.lateWindowMs);

    const onDown = (e: PointerEvent): void => {
      if (pointerId !== null) return; // a second finger cannot steal/farm this pull
      pointerId = e.pointerId;
      originX = e.clientX;
      originY = e.clientY;
      projection = projectPullGesture(0, 0, pullAxis);
      accumulator = createPullGestureAccumulator(performance.now());
      opts.onProgress?.(progressFor(projection, accumulator, maxTravelPx));
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events have no capturable pointer */
      }
    };

    const updatePointerSample = (e: PointerEvent): void => {
      const now = performance.now();
      projection = projectPullGesture(e.clientX - originX, e.clientY - originY, pullAxis);
      accumulator = accumulatePullGesture(
        accumulator,
        projection,
        now,
        maxTravelPx,
        powerPxScale,
      );
      const nextClickCount = Math.floor(
        (accumulator.peakAxialPx * powerPxScale) / CLICK_EVERY_PX,
      );
      while (clickCount < nextClickCount) {
        clickCount++;
        sfx.click(0.8);
        if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(8);
      }
      opts.onProgress?.(progressFor(projection, accumulator, maxTravelPx));
    };

    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      updatePointerSample(e);
    };

    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      // Some touch stacks coalesce the fastest final part of the pull into
      // pointerup. Consume its coordinates before scoring or releasing the
      // capture so that real motion is not silently discarded.
      updatePointerSample(e);
      const offset = Date.now() - opts.shootAtMs;
      if (offset < -opts.earlyWindowMs) {
        finish(resultFrom(offset, "early"));
        return;
      }
      if (accumulator.sp < opts.minSp) {
        finish(resultFrom(offset, "weak"));
        return;
      }
      sfx.launch(accumulator.sp);
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([10, 20, 40]);
      finish(resultFrom(offset, null));
    };

    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      // Cancellation (lost capture, OS gesture, app switch) is not the
      // player's explicit match abort. Mark it separately; `weak` keeps old
      // callers fail-safe while newer match UI can retry without a penalty.
      finish(resultFrom(Date.now() - opts.shootAtMs, "weak", { cancelled: true }));
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    void opts.abortSignal?.then(() =>
      finish(resultFrom(0, null, { aborted: true })),
    );
    void opts.cancelSignal?.then(() =>
      finish(resultFrom(Date.now() - opts.shootAtMs, "weak", { cancelled: true })),
    );
  });
}

/** Default gesture windows (rule-variation friendly). */
export const LAUNCH_WINDOWS = {
  earlyWindowMs: 350,
  lateWindowMs: 1600,
  minSp: 1200,
};
