import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { PartIndex, resolveCombo } from "../src/core/derive";
import type { ComboSelection, PartEntry, PartsDb } from "../src/core/types";
import {
  MODEL_REFERENCE_MANIFEST,
  bladeSilhouetteSpec,
  buildBxUxUpper,
  buildCxUpper,
  fallbackRadialProfile,
  isMetalCoated,
  lookupModelReference,
  preloadUpperReference,
  profiledUpperGeometry,
  referenceRecolorMode,
  resolveUpperProfile,
  resolvedUpperReferenceUrl,
  sampleRadialProfile,
} from "../src/render/upper-parts";

const db = JSON.parse(
  readFileSync(join(process.cwd(), "public", "data", "parts.json"), "utf8"),
) as PartsDb;
const index = new PartIndex(db);

function part(category: keyof PartsDb["parts"], key: string): PartEntry {
  const found = db.parts[category].find((candidate) => candidate.key === key);
  if (!found) throw new Error(`missing fixture ${category}:${key}`);
  return found;
}

function comboByCode(code: string) {
  const preset = db.combos.find((candidate) => candidate.code === code);
  if (!preset) throw new Error(`missing combo fixture ${code}`);
  return resolveCombo(index, preset.parts);
}

function triangleCount(root: THREE.Object3D): number {
  let triangles = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    triangles += geometry.index
      ? geometry.index.count / 3
      : geometry.getAttribute("position").count / 3;
  });
  return triangles;
}

function objectNames(root: THREE.Object3D): string[] {
  const names: string[] = [];
  root.traverse((object) => names.push(object.name));
  return names;
}

describe("upper-part reference lookup", () => {
  it("loads the generated 256-direction reference manifest", () => {
    expect(MODEL_REFERENCE_MANIFEST.schemaVersion).toBe(1);
    expect(MODEL_REFERENCE_MANIFEST.radialSamples).toBe(256);
    const dran = lookupModelReference("blade", "DRANSWORD");
    expect(dran).not.toBeNull();
    expect(dran!.texture).toMatch(/^assets\/models\/.+\.webp$/);
    expect(dran!.radialProfile).toHaveLength(256);
    expect(dran!.radialProfile.every(Number.isFinite)).toBe(true);
  });

  it("resolves model assets beneath a deployed virtual-app base", () => {
    expect(
      resolvedUpperReferenceUrl(
        part("blade", "DRANSWORD"),
        "https://example.test/beyblade/",
      ),
    ).toMatch(/^https:\/\/example\.test\/beyblade\/assets\/models\//);
  });

  it("preloads safely in non-browser geometry tests", async () => {
    await expect(preloadUpperReference(part("blade", "DRANSWORD"))).resolves.toBeInstanceOf(
      THREE.Texture,
    );
  });

  it("periodically samples traced profiles without seams", () => {
    const profile = resolveUpperProfile(part("blade", "DRANSWORD"));
    expect(profile.source).toBe("reference");
    expect(sampleRadialProfile(profile.values, 0)).toBeCloseTo(
      sampleRadialProfile(profile.values, Math.PI * 2),
      8,
    );
    for (let angle = -8; angle <= 8; angle += 0.071) {
      expect(Number.isFinite(sampleRadialProfile(profile.values, angle))).toBe(true);
    }
  });
});

describe("named silhouettes replace stat-random outlines", () => {
  it("records the released primary contact counts", () => {
    expect(bladeSilhouetteSpec("DRANSWORD").contacts).toBe(3);
    expect(bladeSilhouetteSpec("SHARKEDGE").contacts).toBe(2);
    expect(bladeSilhouetteSpec("KNIGHTSHIELD").contacts).toBe(6);
    expect(bladeSilhouetteSpec("WIZARDARROW").contacts).toBe(2);
    expect(bladeSilhouetteSpec("DRANDAGGER").contacts).toBe(6);
    expect(bladeSilhouetteSpec("SPHINXCOWL").contacts).toBe(9);
  });

  it("keeps DranBuster deliberately asymmetric", () => {
    const spec = bladeSilhouetteSpec("DRANBUSTER");
    const profile = fallbackRadialProfile("DRANBUSTER");
    expect(spec.contacts).toBe(1);
    expect(spec.asymmetric).toBe(true);
    const halfTurnDifference = Math.abs(
      sampleRadialProfile(profile, 0) - sampleRadialProfile(profile, Math.PI),
    );
    expect(halfTurnDifference).toBeGreaterThan(0.08);
  });

  it("does not infer metal coats from a hash", () => {
    expect(isMetalCoated(part("blade", "PHOENIXWING"))).toBe(true);
    expect(isMetalCoated(part("blade", "AEROPEGASUS"))).toBe(true);
    expect(isMetalCoated(part("blade", "DRANSWORD"))).toBe(false);
  });

  it("selects release-aware top recoloring while leaving base art alone", () => {
    expect(referenceRecolorMode(part("blade", "DRANSWORD"))).toBe("none");
    expect(referenceRecolorMode(part("blade", "DRANSWORD#2"))).toBe("metal");
    expect(referenceRecolorMode(part("blade", "PHOENIXWING#2"))).toBe("plastic");
  });
});

describe("high-polygon upper geometry", () => {
  it("builds a finite, closed dense swept body", () => {
    const profile = fallbackRadialProfile("DRANSWORD");
    const geometry = profiledUpperGeometry(profile, 0.02425, 0.0112);
    expect(geometry.index!.count / 3).toBe(61_440);
    for (const attribute of [geometry.getAttribute("position"), geometry.getAttribute("normal")]) {
      for (let i = 0; i < attribute.count; i += 257) {
        expect(Number.isFinite(attribute.getX(i))).toBe(true);
        expect(Number.isFinite(attribute.getY(i))).toBe(true);
        expect(Number.isFinite(attribute.getZ(i))).toBe(true);
      }
    }
  });

  it("builds a reference-skinned BX upper at comparable density", () => {
    const dran = part("blade", "DRANSWORD");
    const upper = buildBxUxUpper(dran, 0x2e55c2, 0.02425);
    const names = objectNames(upper);
    expect(names).toContain("upper:blade:DRANSWORD:body");
    expect(names).toContain("upper:blade:DRANSWORD:reference-top");
    expect(triangleCount(upper)).toBeGreaterThan(60_000);
    expect(triangleCount(upper)).toBeLessThan(64_000);
    upper.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const positions = object.geometry.getAttribute("position");
      for (let i = 0; i < positions.count; i += 389) {
        expect(Number.isFinite(positions.getX(i))).toBe(true);
        expect(Number.isFinite(positions.getY(i))).toBe(true);
        expect(Number.isFinite(positions.getZ(i))).toBe(true);
      }
    });
  });
});

describe("component-correct CX upper stacks", () => {
  it("renders classic Lock/Main/Assist components", () => {
    const rc = comboByCode("DRANBRAVES");
    const upper = buildCxUpper(rc, 0x2e55c2, 0.02625);
    const names = objectNames(upper);
    expect(names.some((name) => name.startsWith("upper:mainBlade:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:assistBlade:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:lockChip:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:metalBlade:"))).toBe(false);
    expect(upper.userData.expanded).toBe(false);
    expect(triangleCount(upper)).toBeGreaterThan(58_000);
  });

  it("renders Expand Metal/Over/Assist and omits the synthetic Main placeholder", () => {
    const rc = comboByCode("BAHAMUTBLITZBK");
    const upper = buildCxUpper(rc, 0xc22ea3, 0.0255);
    const names = objectNames(upper);
    expect(names.some((name) => name.startsWith("upper:metalBlade:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:overBlade:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:assistBlade:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:lockChip:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:mainBlade:"))).toBe(false);
    expect(upper.userData.expanded).toBe(true);
    expect(triangleCount(upper)).toBeGreaterThan(63_000);
  });

  it("accepts an explicitly assembled selection without relying on preset order", () => {
    const selection: ComboSelection = {
      blade: "BAHAMUTBLITZ",
      ratchet: "1-50",
      bit: "I",
      lockChip: "BAHAMUT",
      mainBlade: "BBLITZ",
      assistBlade: "K",
      metalBlade: "BLITZ",
      overBlade: "B",
    };
    const upper = buildCxUpper(resolveCombo(index, selection), 0xc22ea3, 0.0255, 0, {
      compositeOverlay: true,
    });
    expect(objectNames(upper)).toContain("upper:cx:composite-reference");
  });

  it("does not cover valid CX components with an opaque missing-reference fallback", () => {
    const upper = buildCxUpper(comboByCode("DRANARCS"), 0x2e55c2, 0.02625, 0, {
      compositeOverlay: true,
    });
    const names = objectNames(upper);
    expect(names).not.toContain("upper:cx:composite-reference");
    expect(names.some((name) => name.startsWith("upper:mainBlade:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:assistBlade:"))).toBe(true);
    expect(names.some((name) => name.startsWith("upper:lockChip:"))).toBe(true);
  });
});
