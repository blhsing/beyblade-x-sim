import { describe, expect, it } from "vitest";

import { UI_CSS } from "../src/ui/dom";
import { galleryLayoutClass } from "../src/ui/gallery";
import { renderViewportSize } from "../src/render/scene";

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return UI_CSS.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("responsive mobile UI contract", () => {
  it("keeps menu overlays and panels vertically touch-scrollable", () => {
    expect(rule(".overlay")).toContain("overflow-y: auto");
    expect(rule(".overlay")).toContain("overflow-x: hidden");
    expect(rule(".overlay")).toContain("touch-action: pan-y");
    expect(rule(".panel")).toContain("overflow-y: auto");
    expect(rule(".panel")).toContain("touch-action: pan-y");
    expect(rule(".panel")).toContain("100dvh");
  });

  it("keeps the menu glass light enough to see live background action", () => {
    expect(rule(".panel")).toContain("backdrop-filter: blur(3px)");
    expect(rule(".panel")).not.toContain("blur(7px)");
  });

  it("uses a responsive, vertically scrollable grid for Bey galleries", () => {
    expect(galleryLayoutClass("grid")).toBe("gstrip ggrid");
    expect(galleryLayoutClass("strip")).toBe("gstrip");
    expect(rule(".gstrip.ggrid")).toContain("display: grid");
    expect(rule(".gstrip.ggrid")).toContain("box-sizing: border-box");
    expect(rule(".gstrip.ggrid")).toContain("max-width: 100%");
    expect(rule(".gstrip.ggrid")).toContain("repeat(auto-fill, minmax(124px, 1fr))");
    expect(rule(".gstrip.ggrid")).toContain("overflow-y: auto");
  });

  it("has an explicit compact-landscape layout with safe-area padding", () => {
    expect(UI_CSS).toContain("@media (orientation: landscape) and (max-height: 600px)");
    expect(UI_CSS).toContain("env(safe-area-inset-top, 0px)");
    expect(UI_CSS).toContain("env(safe-area-inset-right, 0px)");
    expect(UI_CSS).toContain("env(safe-area-inset-bottom, 0px)");
    expect(UI_CSS).toContain("env(safe-area-inset-left, 0px)");
    expect(UI_CSS).toContain("flex: 0 0 clamp(128px, 46dvh, 220px)");
    expect(UI_CSS).toContain(".gdetail { display: none; }");
    expect(UI_CSS).toContain("touch-action: pan-x");
  });

  it("keeps the launch surface gesture-owned while menus can pan", () => {
    expect(rule(".launchzone")).toContain("touch-action: none");
    expect(rule(".overlay.transparent")).toContain("touch-action: none");
  });

  it("uses the live visual viewport for mobile renderer dimensions", () => {
    expect(renderViewportSize({ width: 844, height: 390 }, 1200, 900)).toEqual({
      width: 844,
      height: 390,
    });
    expect(renderViewportSize(null, 390, 844)).toEqual({ width: 390, height: 844 });
  });
});
