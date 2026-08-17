import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";

import { STADIUM_BX10, STADIUM_BX32, type StadiumSpec } from "../src/core/stadium";
import {
  buildStadiumModel,
  disposeStadiumModel,
  pocketDepth,
  STADIUM_MODEL_DIMENSIONS,
  stadiumTriangleCount,
} from "../src/render/stadium";

function object(root: THREE.Object3D, name: string): THREE.Object3D {
  const result = root.getObjectByName(name);
  expect(result, `missing named model object ${name}`).toBeTruthy();
  return result!;
}

function mesh(root: THREE.Object3D, name: string): THREE.Mesh {
  return object(root, name) as THREE.Mesh;
}

function materialOf(target: THREE.Mesh): THREE.MeshPhysicalMaterial {
  expect(Array.isArray(target.material)).toBe(false);
  return target.material as THREE.MeshPhysicalMaterial;
}

function expectedCoveredArc(s: StadiumSpec): number {
  return Math.PI * 2 - s.coverGaps.reduce((sum, gap) => sum + (gap.end - gap.start), 0);
}

describe("reference-driven stadium models", () => {
  let bx10Model: THREE.Group;
  let bx32Model: THREE.Group;

  beforeAll(() => {
    bx10Model = buildStadiumModel(STADIUM_BX10);
    bx32Model = buildStadiumModel(STADIUM_BX32);
  }, 30_000);

  afterAll(() => {
    disposeStadiumModel(bx32Model);
  });

  const modelFor = (spec: StadiumSpec): THREE.Group =>
    spec.name === STADIUM_BX32.name ? bx32Model : bx10Model;

  it.each([
    [STADIUM_BX10, "BX-10", 8],
    [STADIUM_BX32, "BX-32", 12],
  ] as const)("builds a named high-density %s product", (spec, code, panelCount) => {
    const model = modelFor(spec);
    expect(model.name).toBe(`stadium:${code}`);
    expect(model.userData).toMatchObject({
      kind: "stadium-model",
      stadiumName: spec.name,
      productCode: code,
      deckWidthM: spec.deckW,
      deckDepthM: spec.deckH,
    });
    expect(object(model, "stadium:dish").userData.physicsSurface).toBe(true);
    expect(object(model, "stadium:opaque-deck").userData.transparent).toBe(false);
    expect(model.userData.triangleCount).toBe(stadiumTriangleCount(model));
    expect(model.userData.triangleCount).toBeGreaterThan(200_000);
    for (let i = 0; i < panelCount; i++) object(model, `stadium:casing-panel:${i}`);
    expect(model.getObjectByName(`stadium:casing-panel:${panelCount}`)).toBeUndefined();
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("uses real trapezoidal Xtreme Line rack teeth on %s", (spec) => {
    const model = modelFor(spec);
    const line = object(model, "stadium:xtreme-line");
    expect(line.userData).toMatchObject({
      toothPitchM: STADIUM_MODEL_DIMENSIONS.railToothPitchM,
      toothHeightM: STADIUM_MODEL_DIMENSIONS.railToothHeightM,
      channelThicknessM: STADIUM_MODEL_DIMENSIONS.railChannelThicknessM,
    });
    const teeth = object(model, "stadium:xtreme-line-teeth") as THREE.InstancedMesh;
    expect(teeth).toBeInstanceOf(THREE.InstancedMesh);
    expect(teeth.count).toBeGreaterThan(150);
    expect(teeth.userData).toMatchObject({
      shape: "trapezoidal-rack-prism",
      pitchM: 0.005,
      heightM: 0.0038,
      bottomWidthM: 0.0044,
      topWidthM: 0.0025,
      depthM: 0.0062,
    });
    expect(teeth.userData.bottomWidthM).toBeGreaterThan(teeth.userData.topWidthM);
    teeth.geometry.computeBoundingBox();
    const bounds = teeth.geometry.boundingBox!;
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(STADIUM_MODEL_DIMENSIONS.railToothHeightM, 5);
    expect(teeth.geometry.userData.shape).toBe("trapezoidal-rack-prism");
    const channel = mesh(model, "stadium:xtreme-line-channel:0");
    expect(channel.geometry.userData).toMatchObject({
      shape: "thickness-bearing-rack-channel",
      thicknessM: STADIUM_MODEL_DIMENSIONS.railChannelThicknessM,
    });
    expect(materialOf(channel).name).toBe("stadium:material:xtreme-line-abs");
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("models open, recessed catch trays on %s", (spec) => {
    const model = modelFor(spec);
    const rimZ = model.getObjectByName("stadium:low-bowl-wall") ? spec.dishDepth + spec.rimRise + spec.rimBaseSlope * (spec.rWall - spec.rDish) : 0;
    expect(object(model, "stadium:pockets").userData.count).toBe(spec.pockets.length);
    spec.pockets.forEach((pocket, index) => {
      const group = object(model, `stadium:pocket:${index}`);
      expect(group.userData).toMatchObject({
        kind: pocket.kind,
        depthM: pocketDepth(spec),
        recessM: STADIUM_MODEL_DIMENSIONS.pocketRecessM,
      });
      const floor = mesh(model, `stadium:pocket-floor:${index}`);
      const throat = mesh(model, `stadium:pocket-throat:${index}`);
      const backstop = object(model, `stadium:pocket-backstop:${index}`);
      object(model, `stadium:pocket-cheek:${index}:0`);
      object(model, `stadium:pocket-cheek:${index}:1`);
      expect(floor.userData.recessed).toBe(true);
      expect(floor.userData.floorZ).toBeCloseTo(rimZ - STADIUM_MODEL_DIMENSIONS.pocketRecessM, 6);
      expect(throat.userData).toMatchObject({
        opening: true,
        bridgeFree: true,
        shape: "open-sloped-pocket-throat",
      });
      expect(throat.geometry.userData.bridgeFree).toBe(true);
      expect(backstop.userData.heightM).toBeGreaterThan(0.015);
    });
  });

  it.each([
    [STADIUM_BX10, 8],
    [STADIUM_BX32, 12],
  ] as const)("uses a solid clear-polycarbonate canopy on %s", (spec, panelCount) => {
    const model = modelFor(spec);
    const casing = object(model, "stadium:casing");
    expect(casing.userData).toMatchObject({
      material: "polycarbonate",
      ior: 1.585,
      transmission: 0.96,
      thicknessM: STADIUM_MODEL_DIMENSIONS.casingThicknessM,
      coverHeightM: spec.coverHeight,
      canopyCoverageRadians: Math.PI * 2,
      gapAffects: "inner-barrier-only",
    });
    expect(casing.userData.wallCoverageRadians).toBeCloseTo(expectedCoveredArc(spec), 6);
    expect(casing.userData.wallCoverageRadians).toBeGreaterThan(2.8);
    const panel = mesh(model, "stadium:casing-panel:0");
    expect(panel.geometry.userData).toMatchObject({
      thicknessM: STADIUM_MODEL_DIMENSIONS.casingThicknessM,
      closedSolid: true,
      panelSegments: 112,
    });
    const material = materialOf(panel);
    expect(material.name).toBe("stadium:material:clear-polycarbonate");
    expect(material.transparent).toBe(true);
    expect(material.transmission).toBeCloseTo(0.96, 6);
    expect(material.opacity).toBe(1);
    expect(material.ior).toBeCloseTo(1.585, 6);
    expect(material.thickness).toBeCloseTo(0.002, 6);
    expect(material.roughness).toBeLessThan(0.06);
    expect(material.depthWrite).toBe(true);
    expect(object(model, "stadium:casing-inner-lip")).toBeTruthy();
    expect(object(model, "stadium:casing-outer-flange")).toBeTruthy();
    for (let index = 0; index < panelCount; index++) {
      expect(mesh(model, `stadium:casing-panel:${index}`).material).toBe(panel.material);
    }
    const deckMaterial = materialOf(mesh(model, "stadium:dish"));
    expect(deckMaterial.name).toBe("stadium:material:opaque-body-abs");
    expect(deckMaterial.transparent).toBe(false);
    expect(deckMaterial.transmission).toBe(0);
  });

  it("releases every unique GPU geometry and material when a stadium is replaced", () => {
    // This is deliberately the final test in the sequential suite: consume
    // the shared BX-10 fixture instead of constructing a third high-poly copy.
    const model = bx10Model;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    model.traverse((entry) => {
      const target = entry as THREE.Mesh;
      if (target.geometry) geometries.add(target.geometry);
      if (Array.isArray(target.material)) target.material.forEach((material) => materials.add(material));
      else if (target.material) materials.add(target.material);
    });
    let geometryDisposals = 0;
    let materialDisposals = 0;
    geometries.forEach((geometry) => geometry.addEventListener("dispose", () => geometryDisposals++));
    materials.forEach((material) => material.addEventListener("dispose", () => materialDisposals++));
    disposeStadiumModel(model);
    expect(geometryDisposals).toBe(geometries.size);
    expect(materialDisposals).toBe(materials.size);
    expect(geometryDisposals).toBeGreaterThan(30);
    expect(materialDisposals).toBeGreaterThanOrEqual(6);
  }, 20_000);
});
