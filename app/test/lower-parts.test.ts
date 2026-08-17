import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";

// The production material factories create procedural canvases. Geometry is
// the subject of this Node test, so keep their material identities while
// replacing only the browser canvas work.
vi.mock("../src/render/materials", async () => {
  const T = await import("three");
  return {
    absPlastic: (color: number) => new T.MeshPhysicalMaterial({ color }),
    pomTranslucent: (color: number) => new T.MeshPhysicalMaterial({ color, transmission: 0.5 }),
    paintedMetal: (color: number) => new T.MeshPhysicalMaterial({ color, metalness: 1 }),
    rubberMat: (color: number) => new T.MeshPhysicalMaterial({ color, roughness: 0.95 }),
  };
});

import type { PartEntry, PartsDb, Rotation } from "../src/core/types";
import {
  bitFamily,
  bitHasGear,
  bitHeight,
  bitHeightForPart,
  bitSpec,
  bitTipHeight,
  buildBitModel,
  buildRatchetModel,
  ratchetSpec,
} from "../src/render/lower-parts";

const db: PartsDb = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/data/parts.json", import.meta.url)), "utf8"),
);

const bitExpected: Record<string, readonly [teeth: number, exposedMm: number, totalMm: number]> = {
  A: [16, 12.2, 29.6], B: [12, 12.4, 29.8], BS: [12, 13.6, 29.6],
  C: [12, 12.3, 29.8], D: [12, 12.3, 29.8], DB: [12, 14.6, 31.9],
  DS: [12, 12.3, 29.8], E: [12, 11.8, 29.0], F: [12, 12.3, 29.7],
  FB: [12, 12.3, 29.7], FF: [12, 12.7, 29.8], G: [16, 12.4, 30.2],
  GB: [12, 12.3, 29.7], GF: [12, 12.3, 29.6], GN: [12, 12.0, 29.4],
  GP: [12, 12.4, 30.0], GR: [10, 12.3, 29.7], GU: [12, 12.1, 29.7],
  H: [16, 12.2, 29.4], HN: [12, 13.3, 30.7], HT: [12, 13.3, 30.6],
  I: [16, 10.0, 27.6], J: [16, 12.2, 29.5], K: [12, 12.5, 29.6],
  L: [16, 12.5, 29.5], LF: [12, 11.3, 28.7], LO: [12, 11.2, 28.5],
  LR: [10, 11.3, 28.7], M: [18, 15.4, 33.8], MN: [12, 12.4, 29.7],
  N: [12, 12.3, 29.4], Nr: [10, 12.3, 30.0], O: [12, 12.3, 29.8],
  Op: [16, 20.5, 37.8], P: [12, 12.4, 29.8], Q: [12, 12.3, 29.6],
  R: [10, 12.3, 29.7], RA: [16, 12.3, 30.0], S: [12, 12.3, 29.8],
  T: [12, 12.3, 29.7], TK: [12, 11.2, 29.5], TP: [12, 11.5, 28.6],
  Tr: [12, 21.0, 38.3], U: [12, 12.3, 29.3], UF: [12, 10.2, 27.5],
  UN: [12, 10.2, 27.5], V: [12, 12.3, 29.4], W: [10, 12.7, 29.7],
  WB: [16, 13.0, 30.7], WW: [16, 13.2, 30.6], Y: [20, 15.0, 31.5],
  Z: [16, 11.5, 28.8],
};

function mockPart(
  code: string,
  category: "ratchet" | "bit",
  key = code,
  rotation: Rotation = null,
): PartEntry {
  return {
    key,
    group: code,
    category,
    code,
    name: { "zh-TW": code, en: code, ja: code },
    variantLabel: null,
    type: category === "bit" ? "balance" : null,
    stats: { attack: 0, defense: 0, stamina: 0, dash: 0, burst: 0, height: 0 },
    rotation,
    weightG: null,
    diameterMm: null,
    color: null,
    line: "BX",
    fixedBurst: false,
    releaseAt: null,
    variants: [],
  };
}

function meshes(group: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) out.push(object);
  });
  return out;
}

function triangles(group: THREE.Object3D): number {
  let total = 0;
  for (const mesh of meshes(group)) {
    const geometry = mesh.geometry;
    total += geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position").count / 3;
  }
  return total;
}

function expectFiniteGeometry(group: THREE.Object3D): void {
  const found = meshes(group);
  expect(found.length).toBeGreaterThan(0);
  for (const mesh of found) {
    const position = mesh.geometry.getAttribute("position");
    expect(position).toBeTruthy();
    let finite = true;
    for (let i = 0; i < position.array.length; i++) {
      if (!Number.isFinite(position.array[i])) {
        finite = false;
        break;
      }
    }
    expect(finite).toBe(true);
  }
}

function names(group: THREE.Object3D): Set<string> {
  const out = new Set<string>();
  group.traverse((object) => {
    if (object.name) out.add(object.name);
  });
  return out;
}

function zones(group: THREE.Object3D): Set<string> {
  const out = new Set<string>();
  group.traverse((object) => {
    if (object.userData.materialZone) out.add(object.userData.materialZone as string);
  });
  return out;
}

describe("reference Ratchet specs", () => {
  it("parses every numeric catalog Ratchet without inventing a default", () => {
    const valid = db.parts.ratchet.filter((part) => /^\d-\d{2}$/.test(part.code));
    expect(valid.length).toBeGreaterThan(30);
    for (const part of valid) {
      const spec = ratchetSpec(part.code);
      const [count, height] = part.code.split("-").map(Number);
      expect(spec.valid).toBe(true);
      expect(spec.count).toBe(count);
      expect(spec.heightM).toBeCloseTo(height! / 10000, 8);
      expect(spec.simple).toBe(height! % 10 === 5);
    }
  });

  it("models zero-lobe, Simple joint, M-85, and integrated exceptions", () => {
    expect(ratchetSpec("0-60")).toMatchObject({ count: 0, heightM: 0.006, profile: "zero" });
    expect(ratchetSpec("4-55")).toMatchObject({ count: 4, heightM: 0.0055, simple: true });
    expect(ratchetSpec("M-85")).toMatchObject({
      count: 5, heightM: 0.0085, simple: true, metal: true, profile: "weight-five",
    });
    expect(ratchetSpec("RATCHET-integrated")).toMatchObject({ integrated: true, heightM: 0 });
    expect(ratchetSpec("■").valid).toBe(false);
  });

  it("builds every Ratchet count as finite high-density geometry", () => {
    for (let count = 0; count <= 9; count++) {
      const part = mockPart(`${count}-60`, "ratchet", `${count}-60`,
        count === 2 ? "both-left-origin" : null);
      const model = buildRatchetModel(part, 0.02, 0x42a9ca);
      expectFiniteGeometry(model);
      expect(triangles(model)).toBeGreaterThan(24_000);
      expect(names(model).has("zone:ratchet-ring")).toBe(true);
    }
    const metal = buildRatchetModel(mockPart("M-85", "ratchet"), 0.02, 0x4aa55a);
    expect(zones(metal).has("metal")).toBe(true);
    expect(names(metal).has("joint:simple-o-ring")).toBe(true);
  }, 20_000);
});

describe("reference Bit specs", () => {
  it("covers every valid catalog code with exact teeth and heights", () => {
    const catalogCodes = new Set(
      db.parts.bit.map((part) => part.code).filter((code) => /^[A-Za-z]+$/.test(code)),
    );
    expect(catalogCodes).toEqual(new Set(Object.keys(bitExpected)));
    for (const [code, [teeth, exposedMm, totalMm]] of Object.entries(bitExpected)) {
      const spec = bitSpec(code);
      expect(spec.valid, code).toBe(true);
      expect(spec.gearTeeth, code).toBe(teeth);
      expect(spec.exposedHeightM, code).toBeCloseTo(exposedMm / 1000, 8);
      expect(spec.totalHeightM, code).toBeCloseTo(totalMm / 1000, 8);
      expect(bitHeight(code), code).toBeCloseTo(exposedMm / 1000, 8);
      expect(bitTipHeight(code), code).toBeGreaterThan(0);
      expect(bitHasGear(code), code).toBe(true);
    }
  });

  it("does not confuse Rush with rubber and identifies real composite zones", () => {
    expect(bitFamily("R")).toBe("flat");
    expect(bitSpec("R").rubber).toBe(false);
    expect(bitFamily("RA")).toBe("rubberFlat");
    expect(bitSpec("RA").rubber).toBe(true);
    expect(bitFamily("M")).toBe("rubberHybrid");
    expect(bitSpec("M").rubber).toBe(true);
    expect(bitSpec("MN").metal).toBe(true);

    expect(zones(buildBitModel(mockPart("R", "bit"), 0, 0x356ed0))).not.toContain("rubber");
    expect(zones(buildBitModel(mockPart("RA", "bit"), 0, 0x8544c8))).toContain("rubber");
    expect(zones(buildBitModel(mockPart("M", "bit"), 0, 0x8544c8))).toContain("rubber");
    expect(zones(buildBitModel(mockPart("MN", "bit"), 0, 0x44a564))).toContain("metal");
  });

  it("builds every standard Bit as finite high-poly molded gear geometry", () => {
    for (const code of Object.keys(bitExpected).filter((value) => value !== "Op" && value !== "Tr")) {
      const model = buildBitModel(mockPart(code, "bit"), 0, 0x436bc8);
      expectFiniteGeometry(model);
      expect(triangles(model), code).toBeGreaterThan(24_000);
      expect(names(model), code).toContain("zone:bit-molded-body-and-gear");
      expect([...names(model)].some((name) => name.startsWith("tip:")), code).toBe(true);
    }
  }, 30_000);

  it("keeps free, spring, trans, and integrated mechanisms as visible subassemblies", () => {
    for (const code of ["FB", "FF"]) {
      expect(names(buildBitModel(mockPart(code, "bit"), 0, 0xe0bd35))).toContain(
        "mechanism:free-bearing-collar",
      );
    }
    expect(names(buildBitModel(mockPart("BS", "bit"), 0, 0x3ab9c4))).toContain(
      "mechanism:bound-spike-spring",
    );
    for (const code of ["TP", "TK"]) {
      expect(names(buildBitModel(mockPart(code, "bit"), 0, 0xc54242))).toContain(
        "mechanism:trans-height-collar",
      );
    }

    const operateDefense = buildBitModel(mockPart("Op", "bit", "Op"), 0, 0x25252b);
    const operateAttack = buildBitModel(mockPart("Op", "bit", "Op#2"), 0, 0x25252b);
    expect(names(operateDefense)).toContain("mode:operate-defense-ball");
    expect(names(operateAttack)).toContain("mode:operate-attack-hollow-flat");
    expect(triangles(operateDefense)).toBeGreaterThan(24_000);

    const turboHigh = buildBitModel(mockPart("Tr", "bit", "Tr"), 0, 0x315bc5);
    const turboLow = buildBitModel(mockPart("Tr", "bit", "Tr#2"), 0, 0x315bc5);
    expect(names(turboHigh)).toContain("mode:turbo-high-rpm-sharp");
    expect(names(turboLow)).toContain("mode:turbo-low-rpm-flat");
    expect(names(turboHigh)).toContain("mechanism:turbo-centrifugal-slider");
    expectFiniteGeometry(turboHigh);
  });

  it("changes the physical stack height for both integrated mode positions", () => {
    const byKey = (key: string) => db.parts.bit.find((part) => part.key === key)!;
    expect(bitHeightForPart(byKey("Op"))).toBeCloseTo(0.0205, 6);
    expect(bitHeightForPart(byKey("Op#2"))).toBeCloseTo(0.021, 6);
    expect(bitHeightForPart(byKey("Tr"))).toBeCloseTo(0.021, 6);
    expect(bitHeightForPart(byKey("Tr#2"))).toBeCloseTo(0.0185, 6);
  });

  it("uses the photographed rubber colors for Rubber Accel and Merge", () => {
    const rubberColor = (code: "RA" | "M", primary: number): number => {
      const part = db.parts.bit.find((entry) => entry.code === code)!;
      const rubber = meshes(buildBitModel(part, 0, primary)).find(
        (mesh) => mesh.userData.materialZone === "rubber",
      )!;
      return (rubber.material as THREE.MeshPhysicalMaterial).color.getHex();
    };
    expect(rubberColor("RA", 0x5f538b)).toBe(0xc9df80);
    expect(rubberColor("M", 0x7d388e)).toBe(0x009694);
  });
});
