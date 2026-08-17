import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PartsDb } from "../src/core/types";
import { publicAssetUrl } from "../src/render/materials";
import { COLOR_NAMES } from "../src/render/parts";
import stickerManifest from "../src/render/sticker-manifest.json";

const db = JSON.parse(
  readFileSync(join(process.cwd(), "public", "data", "parts.json"), "utf8"),
) as PartsDb;

describe("catalog sticker assets", () => {
  it("points every manifest entry at a bundled texture", () => {
    const urls = [
      ...Object.values(stickerManifest.blades),
      ...Object.values(stickerManifest.lockChips),
    ];
    const missing = urls.filter((url) => !existsSync(join(process.cwd(), "public", url)));
    expect(missing).toEqual([]);
  });

  it("resolves sticker paths beneath a deployed virtual-app base", () => {
    expect(
      publicAssetUrl("assets/stickers/blade-dransword.webp", "https://example.test/beyblade/"),
    ).toBe("https://example.test/beyblade/assets/stickers/blade-dransword.webp");
    expect(
      publicAssetUrl("/assets/stickers/blade-dransword.webp", "https://example.test/beyblade/"),
    ).toBe("https://example.test/beyblade/assets/stickers/blade-dransword.webp");
  });

  it("covers every CX Lock Chip in the parts catalog", () => {
    const missing = db.parts.lockChip
      .map((part) => part.key)
      .filter((key) => !(key in stickerManifest.lockChips));
    expect(missing).toEqual([]);
  });

  it("has a render color for every official part color name", () => {
    const missing = new Set<string>();
    for (const parts of Object.values(db.parts)) {
      for (const part of parts) {
        const color = part.color?.toLowerCase();
        if (color && COLOR_NAMES[color] === undefined) missing.add(color);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
