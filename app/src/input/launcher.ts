// Launch gesture: the player holds the phone like a launcher and drags the
// winder/string with the other hand. Pull speed over the stroke integrates
// into Shoot Power (SP, 0..11000 Beybattle-Pass-like units); release timing
// vs the GO SHOOT countdown classifies mislaunches per the official rules.

import { sfx } from "../audio/sfx";

export interface LaunchGestureResult {
  sp: number;
  /** ms relative to the "SHOOT" instant (negative = released early) */
  releaseOffsetMs: number;
  mislaunch: "early" | "late" | "weak" | null;
}

export interface LaunchGestureOptions {
  /** epoch ms of the "SHOOT" instant of the countdown */
  shootAtMs: number;
  earlyWindowMs: number; // released earlier than this before shootAt = early
  lateWindowMs: number; // no release this long after shootAt = late
  minSp: number; // below this = weak launch (發射失誤)
  /** dx/dy = live pointer offset from where the finger touched down (px),
   * so the string/winder can track the actual touch in real time */
  onProgress?: (sp: number, pullPx: number, dx: number, dy: number) => void;
}

const CLICK_EVERY_PX = 26; // winder ratchet click spacing
const SP_PER_PX_SPEED = 2.6; // px/ms → SP contribution

/**
 * Attaches to an element for ONE launch. Resolves on release (or late
 * timeout). The drag may be multi-stroke for winder launchers — SP keeps the
 * best continuous stroke.
 */
export function captureLaunch(
  el: HTMLElement,
  opts: LaunchGestureOptions,
): Promise<LaunchGestureResult> {
  return new Promise((resolve) => {
    let active = false;
    let lastY = 0;
    let lastT = 0;
    let travel = 0;
    let clickAcc = 0;
    let sp = 0;
    let done = false;

    const finish = (result: LaunchGestureResult): void => {
      if (done) return;
      done = true;
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      window.clearTimeout(lateTimer);
      resolve(result);
    };

    const lateTimer = window.setTimeout(() => {
      finish({ sp: 0, releaseOffsetMs: opts.lateWindowMs, mislaunch: "late" });
    }, Math.max(0, opts.shootAtMs - Date.now()) + opts.lateWindowMs);

    let originX = 0;
    let originY = 0;
    const onDown = (e: PointerEvent): void => {
      active = true;
      lastY = e.clientY;
      lastT = performance.now();
      originX = e.clientX;
      originY = e.clientY;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events have no capturable pointer */
      }
    };
    const onMove = (e: PointerEvent): void => {
      if (!active) return;
      const now = performance.now();
      const dy = e.clientY - lastY; // downward pull = positive
      const dt = Math.max(1, now - lastT);
      if (dy > 0) {
        travel += dy;
        clickAcc += dy;
        const speed = dy / dt; // px per ms
        sp = Math.min(11000, sp + speed * SP_PER_PX_SPEED * dy * 0.55);
        while (clickAcc >= CLICK_EVERY_PX) {
          clickAcc -= CLICK_EVERY_PX;
          sfx.click(0.8);
          if (navigator.vibrate) navigator.vibrate(8);
        }
      }
      // the winder tracks the finger every move, in ANY direction
      opts.onProgress?.(sp, travel, e.clientX - originX, e.clientY - originY);
      lastY = e.clientY;
      lastT = now;
    };
    const onUp = (): void => {
      if (!active) return;
      active = false;
      const offset = Date.now() - opts.shootAtMs;
      if (offset < -opts.earlyWindowMs) {
        finish({ sp, releaseOffsetMs: offset, mislaunch: "early" });
        return;
      }
      if (sp < opts.minSp) {
        finish({ sp, releaseOffsetMs: offset, mislaunch: "weak" });
        return;
      }
      sfx.launch(sp);
      if (navigator.vibrate) navigator.vibrate([10, 20, 40]);
      finish({ sp, releaseOffsetMs: offset, mislaunch: null });
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  });
}

/** Default gesture windows (rule-variation friendly). */
export const LAUNCH_WINDOWS = {
  earlyWindowMs: 350,
  lateWindowMs: 1600,
  minSp: 1200,
};
