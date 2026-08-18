// Short, DOM-only match-opening splash. Bey imagery is prepared before the
// overlay is mounted, so the animation never starts with an empty image, and
// all motion/lifecycle decisions remain deterministic and independently testable.

import { el } from "./dom";
import { VERSUS_THUMB_SIZE } from "../render/thumbs";

export interface VersusIntroTiming {
  durationMs: number;
  exitStartsMs: number;
  skipSettleMs: number;
}

export const VERSUS_INTRO_TIMING: Readonly<VersusIntroTiming> = Object.freeze({
  // Long enough for both real tops and the name lock-up to register, while
  // remaining a brisk match bumper rather than a loading screen.
  durationMs: 1600,
  exitStartsMs: 1160,
  // Keep the skip surface around through the pointerup -> click synthesis so
  // a skip cannot become an accidental launch gesture on the next screen.
  skipSettleMs: 48,
});

export const VERSUS_REDUCED_TIMING: Readonly<VersusIntroTiming> = Object.freeze({
  durationMs: 170,
  exitStartsMs: 120,
  skipSettleMs: 32,
});

export function versusIntroTiming(reducedMotion: boolean): Readonly<VersusIntroTiming> {
  return reducedMotion ? VERSUS_REDUCED_TIMING : VERSUS_INTRO_TIMING;
}

export function versusPrepBudget(reducedMotion: boolean): number {
  // This is preparation, before the visible sequence. Both accessibility
  // paths require the real overhead renders; reduced motion shortens motion,
  // not asset fidelity. Setup/picker prefetch normally makes this a cache hit.
  void reducedMotion;
  return 2000;
}

export interface VersusViewport {
  width: number;
  height: number;
}

export interface VersusLayout {
  orientation: "portrait" | "landscape";
  beySizePx: number;
  travelPx: number;
  nameSizePx: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Pixel values used as CSS variables; safe-area offsets stay in CSS env(). */
export function computeVersusLayout(viewport: VersusViewport): VersusLayout {
  const width = Math.max(1, Number.isFinite(viewport.width) ? viewport.width : 1);
  const height = Math.max(1, Number.isFinite(viewport.height) ? viewport.height : 1);
  const orientation = width > height ? "landscape" : "portrait";
  const shortSide = Math.min(width, height);
  const beySizePx = Math.round(clamp(shortSide * (orientation === "landscape" ? 0.49 : 0.52), 132, 272));
  return {
    orientation,
    beySizePx,
    travelPx: Math.round(width / 2 + beySizePx * 0.78 + 24),
    nameSizePx: Math.round(clamp(shortSide * (orientation === "landscape" ? 0.09 : 0.105), 28, 62)),
  };
}

export interface VersusSpark {
  xPercent: number;
  yPercent: number;
  angleDeg: number;
  lengthPx: number;
  delayMs: number;
  durationMs: number;
}

function deterministicUnit(index: number, salt: number): number {
  let value = (index + 1) * 0x9e3779b1 ^ salt * 0x85ebca6b;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

/** Fixed effect field: visually varied, but identical on every run/client. */
export function createVersusSparkPattern(count = 20): readonly VersusSpark[] {
  return Object.freeze(Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => Object.freeze({
    xPercent: Math.round((8 + deterministicUnit(index, 1) * 84) * 10) / 10,
    yPercent: Math.round((10 + deterministicUnit(index, 2) * 80) * 10) / 10,
    angleDeg: Math.round(-62 + deterministicUnit(index, 3) * 124),
    lengthPx: Math.round(18 + deterministicUnit(index, 4) * 54),
    delayMs: Math.round(deterministicUnit(index, 5) * 760),
    durationMs: Math.round(360 + deterministicUnit(index, 6) * 420),
  })));
}

export const VERSUS_SPARKS = createVersusSparkPattern();

export type VersusIntroResult = "completed" | "skipped" | "aborted" | "unavailable";

export interface VersusClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VersusLifecycleTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface VersusLifecycle {
  finished: Promise<VersusIntroResult>;
  finish(reason: VersusIntroResult): void;
}

/** Owns every timer/listener used by an intro and resolves exactly once. */
export function createVersusLifecycle(
  target: VersusLifecycleTarget,
  timing: Readonly<VersusIntroTiming>,
  clock: VersusClock,
  options: {
    signal?: AbortSignal;
    onSkipRequested?: () => void;
    onFinish?: (reason: VersusIntroResult) => void;
  } = {},
): VersusLifecycle {
  let settled = false;
  let completionTimer: unknown = null;
  let skipTimer: unknown = null;
  let resolveFinished: (reason: VersusIntroResult) => void = () => {};
  const finished = new Promise<VersusIntroResult>((resolve) => {
    resolveFinished = resolve;
  });

  const blockPointer: EventListener = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const requestSkip: EventListener = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (settled || skipTimer !== null) return;
    options.onSkipRequested?.();
    skipTimer = clock.setTimeout(() => finish("skipped"), timing.skipSettleMs);
  };

  const requestKeyboardSkip: EventListener = (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" || key === " " || key === "Escape") requestSkip(event);
  };

  const onAbort: EventListener = () => finish("aborted");
  const eventListeners: readonly [string, EventListener][] = [
    ["pointerdown", blockPointer],
    ["pointerup", requestSkip],
    ["click", requestSkip],
    ["keydown", requestKeyboardSkip],
  ];

  const cleanup = (): void => {
    if (completionTimer !== null) clock.clearTimeout(completionTimer);
    if (skipTimer !== null) clock.clearTimeout(skipTimer);
    completionTimer = null;
    skipTimer = null;
    for (const [type, listener] of eventListeners) target.removeEventListener(type, listener);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const finish = (reason: VersusIntroResult): void => {
    if (settled) return;
    settled = true;
    cleanup();
    options.onFinish?.(reason);
    resolveFinished(reason);
  };

  for (const [type, listener] of eventListeners) target.addEventListener(type, listener);
  if (options.signal?.aborted) {
    finish("aborted");
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    completionTimer = clock.setTimeout(() => finish("completed"), timing.durationMs);
  }

  return { finished, finish };
}

export interface VersusCompetitor {
  name: string;
  image: string | Promise<string> | ((preparation: VersusImagePreparation) => string | Promise<string>);
}

export interface VersusImagePreparation {
  signal: AbortSignal;
  deadlineMs: number;
}

export interface PlayVersusIntroOptions {
  player: VersusCompetitor;
  opponent: VersusCompetitor;
  signal?: AbortSignal;
  reducedMotion?: boolean;
}

const ABORTED = Symbol("versus-intro-aborted");

async function prepareImage(
  competitor: VersusCompetitor,
  preparation: VersusImagePreparation,
): Promise<HTMLImageElement | null> {
  const pending = typeof competitor.image === "function"
    ? competitor.image(preparation)
    : competitor.image;
  const source = await Promise.resolve(pending).catch(() => "");
  if (preparation.signal.aborted || performance.now() >= preparation.deadlineMs) return null;
  if (!source) return null;
  const image = document.createElement("img");
  image.alt = competitor.name;
  image.decoding = "async";
  image.draggable = false;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    image.onload = done;
    image.onerror = done;
    image.src = source;
    if (image.complete) done();
  });
  if (image.naturalWidth !== VERSUS_THUMB_SIZE || image.naturalHeight !== VERSUS_THUMB_SIZE) return null;
  try {
    await image.decode();
  } catch {
    // A successful load is already paintable in browsers whose decode()
    // rejects for a supported data URL.
  }
  return image;
}

async function prepareImagesWithin(
  competitors: readonly [VersusCompetitor, VersusCompetitor],
  budgetMs: number,
  signal?: AbortSignal,
): Promise<readonly [HTMLImageElement | null, HTMLImageElement | null] | typeof ABORTED> {
  if (signal?.aborted) return ABORTED;
  const prepared: [HTMLImageElement | null, HTMLImageElement | null] = [null, null];
  return new Promise((resolve) => {
    let done = false;
    const preparationAbort = new AbortController();
    const deadlineMs = performance.now() + budgetMs;
    let timeout = 0;
    const onAbort = (): void => finish(ABORTED);
    const finish = (result: readonly [HTMLImageElement | null, HTMLImageElement | null] | typeof ABORTED): void => {
      if (done) return;
      done = true;
      preparationAbort.abort();
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    timeout = window.setTimeout(() => finish([...prepared] as const), budgetMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const work = competitors.map((competitor, index) =>
      prepareImage(competitor, { signal: preparationAbort.signal, deadlineMs }).then((image) => {
        prepared[index as 0 | 1] = image;
      }),
    );
    void Promise.allSettled(work).then(() => finish(prepared));
  });
}

async function prepareMissingImages(
  competitors: readonly [VersusCompetitor, VersusCompetitor],
  initial: readonly [HTMLImageElement | null, HTMLImageElement | null],
  signal?: AbortSignal,
): Promise<readonly [HTMLImageElement | null, HTMLImageElement | null] | typeof ABORTED> {
  if (signal?.aborted) return ABORTED;
  const prepared: [HTMLImageElement | null, HTMLImageElement | null] = [...initial];
  const retryAbort = new AbortController();
  return new Promise((resolve) => {
    let done = false;
    const onAbort = (): void => finish(ABORTED);
    const finish = (result: readonly [HTMLImageElement | null, HTMLImageElement | null] | typeof ABORTED): void => {
      if (done) return;
      done = true;
      retryAbort.abort();
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const work = competitors.map((competitor, index) => {
      if (prepared[index as 0 | 1]) return Promise.resolve();
      return prepareImage(competitor, {
        signal: retryAbort.signal,
        deadlineMs: Number.POSITIVE_INFINITY,
      }).then((image) => {
        prepared[index as 0 | 1] = image;
      });
    });
    void Promise.allSettled(work).then(() => finish(prepared));
  });
}

function beyCard(
  side: "player" | "opponent",
  competitor: VersusCompetitor,
  image: HTMLImageElement,
): HTMLElement {
  const disc = el("div", { class: "versus-bey-disc" });
  disc.append(image);
  const card = el("div", { class: `versus-bey ${side}`, "aria-hidden": "true" });
  card.append(
    el("div", { class: "versus-speed-lines" }),
    el("div", { class: "versus-bey-aura" }),
    disc,
    el("div", { class: "versus-bey-rim" }),
  );
  return card;
}

function effectField(): HTMLElement {
  const effects = el("div", { class: "versus-effects", "aria-hidden": "true" });
  effects.append(
    el("div", { class: "versus-burn player" }),
    el("div", { class: "versus-burn opponent" }),
    el("div", { class: "versus-center-flare" }),
    el("div", { class: "versus-light-slash" }),
  );
  for (const [index, spark] of VERSUS_SPARKS.entries()) {
    effects.append(el("i", {
      class: `versus-spark s${index % 4}`,
      style: `--spark-x:${spark.xPercent}%;--spark-y:${spark.yPercent}%;` +
        `--spark-angle:${spark.angleDeg}deg;--spark-length:${spark.lengthPx}px;` +
        `--spark-delay:${spark.delayMs}ms;--spark-life:${spark.durationMs}ms`,
    }));
  }
  return effects;
}

function visualViewportSize(): VersusViewport {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

let activeGeneration = 0;
let activeFinish: ((reason: VersusIntroResult) => void) | null = null;

/** Immediately tears down a currently mounted intro, if any. */
export function teardownActiveVersusIntro(): void {
  activeGeneration++;
  activeFinish?.("aborted");
  activeFinish = null;
}

/** Prepare both overhead captures, then play one bounded opening sequence. */
export async function playVersusIntro(options: PlayVersusIntroOptions): Promise<VersusIntroResult> {
  teardownActiveVersusIntro();
  const generation = activeGeneration;
  const reducedMotion = options.reducedMotion
    ?? window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ?? false;
  const timing = versusIntroTiming(reducedMotion);
  let prepared = await prepareImagesWithin(
    [options.player, options.opponent],
    versusPrepBudget(reducedMotion),
    options.signal,
  );
  if (prepared === ABORTED || options.signal?.aborted || generation !== activeGeneration) {
    return "aborted";
  }
  if (!prepared[0] || !prepared[1]) {
    prepared = await prepareMissingImages(
      [options.player, options.opponent],
      prepared,
      options.signal,
    );
    if (prepared === ABORTED || options.signal?.aborted || generation !== activeGeneration) {
      return "aborted";
    }
  }
  // Renderer failure must never degrade the requested close-ups into initials.
  // Skip the optional splash and let the match proceed if a real 448 px pair
  // cannot be produced even by the uncapped, abort-aware retry.
  if (!prepared[0] || !prepared[1]) return "unavailable";

  const root = el("div", {
    class: `versus-intro${reducedMotion ? " reduced" : ""}`,
    role: "button",
    tabindex: "0",
    "aria-label": `${options.player.name} versus ${options.opponent.name}，點按可跳過`,
  });
  root.style.setProperty("--versus-duration", `${timing.durationMs}ms`);
  root.style.setProperty("--versus-exit", `${Math.round(timing.exitStartsMs / timing.durationMs * 100)}%`);

  const lockup = el("div", { class: "versus-lockup", "aria-live": "polite" });
  lockup.append(
    el("div", { class: "versus-name player" }, options.player.name),
    el("div", { class: "versus-vs" }, el("span", {}, "V"), el("span", {}, "S")),
    el("div", { class: "versus-name opponent" }, options.opponent.name),
    el("div", { class: "versus-battle-call" }, "BATTLE"),
  );
  root.append(
    el("div", { class: "versus-vignette", "aria-hidden": "true" }),
    effectField(),
    beyCard("player", options.player, prepared[0]),
    beyCard("opponent", options.opponent, prepared[1]),
    lockup,
    el("div", { class: "versus-skip-hint" }, "點按跳過"),
  );

  const applyLayout = (): void => {
    const layout = computeVersusLayout(visualViewportSize());
    root.dataset.orientation = layout.orientation;
    root.style.setProperty("--versus-bey-size", `${layout.beySizePx}px`);
    root.style.setProperty("--versus-travel", `${layout.travelPx}px`);
    root.style.setProperty("--versus-name-size", `${layout.nameSizePx}px`);
  };
  applyLayout();
  window.addEventListener("resize", applyLayout);
  window.visualViewport?.addEventListener("resize", applyLayout);
  document.body.append(root);

  const clock: VersusClock = {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
  const lifecycle = createVersusLifecycle(root, timing, clock, {
    signal: options.signal,
    onSkipRequested: () => root.classList.add("skipping"),
  });
  activeFinish = lifecycle.finish;
  try {
    return await lifecycle.finished;
  } finally {
    window.removeEventListener("resize", applyLayout);
    window.visualViewport?.removeEventListener("resize", applyLayout);
    root.remove();
    if (activeFinish === lifecycle.finish) activeFinish = null;
  }
}
