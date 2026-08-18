import { afterEach, describe, expect, it, vi } from "vitest";

import {
  playVersusIntro,
  VERSUS_INTRO_TIMING,
  VERSUS_REDUCED_TIMING,
  type VersusImagePreparation,
} from "../src/ui/versus-intro";

class FakeStyle {
  readonly values = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }
}

class FakeElement extends EventTarget {
  readonly tagName: string;
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  parentElement: FakeElement | null = null;
  className = "";
  removed = false;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  readonly classList = {
    add: (...names: string[]): void => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const name of names) classes.add(name);
      this.className = [...classes].join(" ");
    },
  };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      this.children.push(node);
      if (node instanceof FakeElement) node.parentElement = this;
    }
  }

  remove(): void {
    this.removed = true;
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement): boolean => selector.startsWith(".")
      ? element.className.split(/\s+/).includes(selector.slice(1))
      : element.tagName === selector.toUpperCase();
    const found: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (matches(element)) found.push(element);
      for (const child of element.children) {
        if (child instanceof FakeElement) visit(child);
      }
    };
    visit(this);
    return found;
  }
}

class FakeImage extends FakeElement {
  alt = "";
  decoding = "auto";
  draggable = true;
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private source = "";

  constructor() {
    super("img");
  }

  set src(value: string) {
    this.source = value;
    this.complete = false;
    queueMicrotask(() => {
      this.complete = true;
      if (value.startsWith("data:image/png")) {
        this.naturalWidth = 448;
        this.naturalHeight = 448;
        this.onload?.(new Event("load"));
      } else {
        this.onerror?.(new Event("error"));
      }
    });
  }

  get src(): string {
    return this.source;
  }

  decode(): Promise<void> {
    return Promise.resolve();
  }
}

function installFakeDom(): FakeElement {
  const body = new FakeElement("body");
  const document = {
    body,
    createElement: (tag: string) => tag === "img" ? new FakeImage() : new FakeElement(tag),
  };
  const target = new EventTarget();
  const fakeWindow = Object.assign(target, {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: undefined,
    matchMedia: () => ({ matches: false }),
    setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", fakeWindow);
  return body;
}

function coldThenRealImage(label: string): (preparation: VersusImagePreparation) => Promise<string> {
  let attempt = 0;
  return async ({ signal }) => {
    attempt++;
    if (attempt === 1) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "";
    }
    return `data:image/png;name=${label}`;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  ["normal", false, VERSUS_INTRO_TIMING.durationMs],
  ["reduced", true, VERSUS_REDUCED_TIMING.durationMs],
] as const)("cold %s versus intro DOM", (_label, reducedMotion, visibleDurationMs) => {
  it("mounts exactly two decoded 448px IMG nodes and never an initials fallback", async () => {
    vi.useFakeTimers();
    const body = installFakeDom();
    const result = playVersusIntro({
      player: { name: "PLAYER", image: coldThenRealImage("player") },
      opponent: { name: "OPPONENT", image: coldThenRealImage("opponent") },
      reducedMotion,
    });

    // The first (bounded) attempts time out; the uncapped retry then resolves
    // fresh real images before any versus root is appended.
    await vi.advanceTimersByTimeAsync(2000);
    const roots = body.querySelectorAll(".versus-intro");
    expect(roots).toHaveLength(1);
    const images = roots[0]!.querySelectorAll("img") as FakeImage[];
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.naturalWidth)).toEqual([448, 448]);
    expect(images.map((image) => image.naturalHeight)).toEqual([448, 448]);
    expect(images.every((image) => image.src.startsWith("data:image/png"))).toBe(true);
    expect(roots[0]!.querySelectorAll(".versus-bey-fallback")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(visibleDurationMs);
    await expect(result).resolves.toBe("completed");
    expect(body.querySelectorAll(".versus-intro")).toHaveLength(0);
  });
});
