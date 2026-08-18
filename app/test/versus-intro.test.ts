import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { UI_CSS } from "../src/ui/dom";
import { VERSUS_THUMB_HALF_FRAME_M, VERSUS_THUMB_SIZE } from "../src/render/thumbs";
import {
  VERSUS_INTRO_TIMING,
  VERSUS_REDUCED_TIMING,
  computeVersusLayout,
  createVersusLifecycle,
  createVersusSparkPattern,
  versusPrepBudget,
  versusIntroTiming,
  type VersusClock,
  type VersusLifecycleTarget,
} from "../src/ui/versus-intro";

class FakeClock implements VersusClock {
  private nextId = 1;
  readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.pending.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  runNext(): void {
    const next = [...this.pending.entries()].sort((a, b) => a[1].delayMs - b[1].delayMs)[0];
    if (!next) return;
    this.pending.delete(next[0]);
    next[1].callback();
  }
}

class FakeTarget implements VersusLifecycleTarget {
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const bucket = this.listeners.get(type) ?? new Set<EventListener>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): Event {
    const event = new Event(type, { cancelable: true });
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

describe("versus intro timing", () => {
  it("holds the normal cinematic long enough to read, then rolls away briskly", () => {
    expect(versusIntroTiming(false)).toBe(VERSUS_INTRO_TIMING);
    expect(VERSUS_INTRO_TIMING.durationMs).toBe(1600);
    expect(VERSUS_INTRO_TIMING.exitStartsMs).toBe(1160);
    expect(VERSUS_INTRO_TIMING.exitStartsMs).toBeLessThan(VERSUS_INTRO_TIMING.durationMs);
  });

  it("uses a brief static presentation for reduced motion", () => {
    expect(versusIntroTiming(true)).toBe(VERSUS_REDUCED_TIMING);
    expect(VERSUS_REDUCED_TIMING.durationMs).toBeGreaterThanOrEqual(150);
    expect(VERSUS_REDUCED_TIMING.durationMs).toBeLessThanOrEqual(180);
  });

  it("gives both motion paths the same bounded real-image preparation window", () => {
    expect(versusPrepBudget(false)).toBe(2000);
    expect(versusPrepBudget(true)).toBe(2000);
  });

  it("frames the widest published Blade with overhead margin", () => {
    const widestBladeRadiusM = 0.0525 / 2;
    expect(VERSUS_THUMB_SIZE).toBe(448);
    expect(VERSUS_THUMB_HALF_FRAME_M).toBeGreaterThan(widestBladeRadiusM * 1.1);
  });
});

describe("versus intro responsive layout", () => {
  it("keeps close-up Beys bounded in portrait and landscape", () => {
    const portrait = computeVersusLayout({ width: 390, height: 844 });
    const landscape = computeVersusLayout({ width: 844, height: 390 });
    expect(portrait.orientation).toBe("portrait");
    expect(landscape.orientation).toBe("landscape");
    for (const layout of [portrait, landscape]) {
      expect(layout.beySizePx).toBeGreaterThanOrEqual(132);
      expect(layout.beySizePx).toBeLessThanOrEqual(272);
      expect(layout.travelPx).toBeGreaterThan(layout.beySizePx);
      expect(layout.nameSizePx).toBeGreaterThanOrEqual(28);
    }
  });

  it("is deterministic for invalid, tiny, and repeated viewport inputs", () => {
    expect(computeVersusLayout({ width: 320, height: 568 }))
      .toEqual(computeVersusLayout({ width: 320, height: 568 }));
    const tiny = computeVersusLayout({ width: Number.NaN, height: 1 });
    expect(tiny.beySizePx).toBe(132);
    expect(Number.isFinite(tiny.travelPx)).toBe(true);
  });

  it("builds a deterministic bounded spark field", () => {
    const a = createVersusSparkPattern(20);
    const b = createVersusSparkPattern(20);
    expect(a).toEqual(b);
    expect(a).toHaveLength(20);
    for (const spark of a) {
      expect(spark.xPercent).toBeGreaterThanOrEqual(8);
      expect(spark.xPercent).toBeLessThanOrEqual(92);
      expect(spark.yPercent).toBeGreaterThanOrEqual(10);
      expect(spark.yPercent).toBeLessThanOrEqual(90);
    }
  });
});

describe("versus intro lifecycle", () => {
  it("completes on its one bounded timer and removes every listener", async () => {
    const target = new FakeTarget();
    const clock = new FakeClock();
    const onFinish = vi.fn();
    const lifecycle = createVersusLifecycle(target, VERSUS_INTRO_TIMING, clock, { onFinish });
    expect(target.listenerCount()).toBe(4);
    expect(clock.pending.size).toBe(1);
    clock.runNext();
    await expect(lifecycle.finished).resolves.toBe("completed");
    expect(onFinish).toHaveBeenCalledOnce();
    expect(target.listenerCount()).toBe(0);
    expect(clock.pending.size).toBe(0);
  });

  it("swallows a pointer skip briefly, then settles once without a ghost timer", async () => {
    const target = new FakeTarget();
    const clock = new FakeClock();
    const onSkipRequested = vi.fn();
    const onFinish = vi.fn();
    const lifecycle = createVersusLifecycle(target, VERSUS_INTRO_TIMING, clock, {
      onSkipRequested,
      onFinish,
    });
    const event = target.dispatch("pointerup");
    expect(event.defaultPrevented).toBe(true);
    expect(onSkipRequested).toHaveBeenCalledOnce();
    expect(clock.pending.size).toBe(2);
    clock.runNext();
    await expect(lifecycle.finished).resolves.toBe("skipped");
    expect(onFinish).toHaveBeenCalledOnce();
    expect(target.listenerCount()).toBe(0);
    expect(clock.pending.size).toBe(0);
    target.dispatch("click");
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("aborts immediately and clears its pending animation timer", async () => {
    const target = new FakeTarget();
    const clock = new FakeClock();
    const abort = new AbortController();
    const lifecycle = createVersusLifecycle(target, VERSUS_INTRO_TIMING, clock, {
      signal: abort.signal,
    });
    abort.abort();
    await expect(lifecycle.finished).resolves.toBe("aborted");
    expect(clock.pending.size).toBe(0);
    expect(target.listenerCount()).toBe(0);
  });
});

describe("versus intro styles", () => {
  it("provides opposing roll directions, safe areas, effects, and a reduced-motion path", () => {
    expect(UI_CSS).toContain(".versus-bey.player");
    expect(UI_CSS).toContain(".versus-bey.opponent");
    expect(UI_CSS).toContain("translateX(calc(var(--versus-travel) * -1))");
    expect(UI_CSS).toContain("translateX(var(--versus-travel))");
    expect(UI_CSS).toContain("@keyframes versus-player-spin");
    expect(UI_CSS).toContain("@keyframes versus-opponent-spin");
    expect(UI_CSS).toContain("env(safe-area-inset-top, 0px)");
    expect(UI_CSS).toContain(".versus-spark");
    expect(UI_CSS).toContain(".versus-burn");
    expect(UI_CSS).toMatch(/\.versus-lockup[^}]*filter:\s*none/s);
    expect(UI_CSS).not.toMatch(/@keyframes versus-lockup[^}]*filter:\s*blur/s);
    expect(UI_CSS).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("match opening integration", () => {
  it("runs exactly once after hook deck setup and before the scoring-battle loop", () => {
    const source = readFileSync(new URL("../src/ui/match.ts", import.meta.url), "utf8");
    expect(source.match(/await playVersusIntro\(/g)).toHaveLength(1);
    const setup = source.indexOf("hooks.setup?.(engine)");
    const intro = source.indexOf("await playVersusIntro(");
    const battleLoop = source.indexOf("while (engine.winner === null");
    expect(setup).toBeGreaterThan(-1);
    expect(intro).toBeGreaterThan(setup);
    expect(intro).toBeLessThan(battleLoop);
    expect(source.slice(setup, intro)).not.toContain("if (hooks.launches)");
  });

  it("maps the sole local human to the player/top slot and cancels launch after an aborted intro", () => {
    const source = readFileSync(new URL("../src/ui/match.ts", import.meta.url), "utf8");
    expect(source).toContain("slots[0].kind === \"human\" || slots[1].kind !== \"human\" ? 0 : 1");
    const abortCheck = source.indexOf("if (introResult === \"aborted\") abortFlag.requested = true");
    const battleLoop = source.indexOf("while (engine.winner === null");
    expect(abortCheck).toBeGreaterThan(-1);
    expect(abortCheck).toBeLessThan(battleLoop);
    expect(source.slice(battleLoop, battleLoop + 100)).toContain("!abortFlag.requested");
  });
});
