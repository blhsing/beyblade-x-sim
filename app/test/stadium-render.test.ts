import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  pocketCatchPolygon,
  pocketPolygon,
  pointInConvexPolygon,
  railPointAt,
  railTangentAt,
  stadiumBoundarySignedDistance,
  STADIUM_BX10,
  STADIUM_BX32,
  type StadiumSpec,
} from "../src/core/stadium";
import {
  buildStadiumModel,
  disposeStadiumModel,
  RAIL_RENDER_MAX_ANGLE_STEP,
  RAIL_RENDER_MAX_TANGENT_STEP,
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

function strictlyInsideConvex(
  polygon: readonly { x: number; y: number }[],
  x: number,
  y: number,
): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) <= 1e-8) return false;
    const current = cross > 0 ? 1 : -1;
    if (sign && sign !== current) return false;
    sign = current;
  }
  return sign !== 0;
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
    const deck = object(model, "stadium:outer-deck");
    expect(deck.userData).toMatchObject({
      transparent: true,
      apertureSource: "core:pocketAtPoint",
    });
    expect(materialOf(mesh(model, "stadium:deck-sector:0")).transparent).toBe(true);
    expect(model.userData.triangleCount).toBe(stadiumTriangleCount(model));
    // Dense enough for close launch cameras, but kept below the budget that
    // would make two live stadium previews impractical on midrange hardware.
    expect(model.userData.triangleCount).toBeGreaterThan(600_000);
    expect(model.userData.triangleCount).toBeLessThan(800_000);
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
      localPeakHeightM: 0.0046,
      baseSurfaceOffsetM: 0,
    });
    const teeth = object(model, "stadium:xtreme-line-teeth") as THREE.InstancedMesh;
    expect(teeth).toBeInstanceOf(THREE.InstancedMesh);
    expect(teeth.count).toBeGreaterThan(150);
    expect(teeth.userData).toMatchObject({
      shape: "trapezoidal-rack-prism",
      pitchM: STADIUM_MODEL_DIMENSIONS.railToothPitchM,
      heightM: STADIUM_MODEL_DIMENSIONS.railToothHeightM,
      bottomWidthM: STADIUM_MODEL_DIMENSIONS.railToothBottomWidthM,
      topWidthM: STADIUM_MODEL_DIMENSIONS.railToothTopWidthM,
      depthM: STADIUM_MODEL_DIMENSIONS.railToothDepthM,
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
      cornerJoin: "bounded-miter",
      closedLoop: true,
      seamWelded: true,
      normalSource: "area-weighted-centered-ribbon-frame",
    });
    expect(line.userData).toMatchObject({
      centerlineInterpolation: "xy-cubic-hermite-with-authored-linear-jogs",
      maxAngularStepRad: RAIL_RENDER_MAX_ANGLE_STEP,
      roundSideCount: spec.name === "wide" ? 2 : 0,
    });
    expect(line.userData.roundSideControlSamples).toEqual(spec.name === "wide" ? [192, 192] : []);
    expect(channel.userData).toMatchObject({
      interpolation: "core:xy-cubic-hermite-with-authored-linear-jogs",
      cornerJoin: "bounded-miter",
      authoredSharpKnots: 4,
    });
    expect(channel.userData.sampleCount).toBeGreaterThan(4_000);
    expect(channel.userData.maxAngularStepRad).toBeLessThanOrEqual(RAIL_RENDER_MAX_ANGLE_STEP + 1e-12);
    expect(channel.userData.maxSmoothTangentStepRad)
      .toBeLessThanOrEqual(RAIL_RENDER_MAX_TANGENT_STEP + 1e-9);
    const channelPosition = channel.geometry.getAttribute("position") as THREE.BufferAttribute;
    const channelNormal = channel.geometry.getAttribute("normal") as THREE.BufferAttribute;
    const channelIndex = channel.geometry.index!;
    const crossSectionCount = channel.geometry.userData.crossSectionCount as number;
    const closingFaceOffset = (crossSectionCount - 1) * 24;
    const wrappedSeamVertex = channelIndex.getX(closingFaceOffset + 1);
    expect(wrappedSeamVertex).toBe(0);
    expect(Math.hypot(
      channelPosition.getX(wrappedSeamVertex) - channelPosition.getX(0),
      channelPosition.getY(wrappedSeamVertex) - channelPosition.getY(0),
      channelPosition.getZ(wrappedSeamVertex) - channelPosition.getZ(0),
    )).toBeLessThan(1e-9);
    let minimumSeamNormalDot = 1;
    for (let vertex = 0; vertex < 4; vertex++) {
      const before = (crossSectionCount - 1) * 4 + vertex;
      const after = 4 + vertex;
      minimumSeamNormalDot = Math.min(
        minimumSeamNormalDot,
        channelNormal.getX(before) * channelNormal.getX(vertex) +
          channelNormal.getY(before) * channelNormal.getY(vertex) +
          channelNormal.getZ(before) * channelNormal.getZ(vertex),
        channelNormal.getX(after) * channelNormal.getX(vertex) +
          channelNormal.getY(after) * channelNormal.getY(vertex) +
          channelNormal.getZ(after) * channelNormal.getZ(vertex),
      );
    }
    expect(minimumSeamNormalDot).toBeGreaterThan(0.99999);
    let minimumTriangleArea2 = Infinity;
    const edgeA = new THREE.Vector3();
    const edgeB = new THREE.Vector3();
    const cross = new THREE.Vector3();
    for (let triangle = 0; triangle < channelIndex.count; triangle += 3) {
      const a = channelIndex.getX(triangle);
      const b = channelIndex.getX(triangle + 1);
      const c = channelIndex.getX(triangle + 2);
      edgeA.set(
        channelPosition.getX(b) - channelPosition.getX(a),
        channelPosition.getY(b) - channelPosition.getY(a),
        channelPosition.getZ(b) - channelPosition.getZ(a),
      );
      edgeB.set(
        channelPosition.getX(c) - channelPosition.getX(a),
        channelPosition.getY(c) - channelPosition.getY(a),
        channelPosition.getZ(c) - channelPosition.getZ(a),
      );
      minimumTriangleArea2 = Math.min(minimumTriangleArea2, cross.crossVectors(edgeA, edgeB).length());
    }
    expect(minimumTriangleArea2).toBeGreaterThan(1e-14);
    expect(
      STADIUM_MODEL_DIMENSIONS.railChannelThicknessM + STADIUM_MODEL_DIMENSIONS.railToothHeightM,
    ).toBeCloseTo(0.0046, 7);
    const placementAngles = teeth.userData.placementAngles as number[];
    const placementDistances = teeth.userData.placementArcDistancesM as number[];
    expect(teeth.userData.spacingMethod).toBe("closed-loop-arc-length");
    expect(placementAngles).toHaveLength(teeth.count);
    expect(placementDistances).toHaveLength(teeth.count);
    expect(teeth.userData.actualPitchM).toBeCloseTo(channel.userData.arcLengthM / teeth.count, 12);
    for (let index = 1; index < placementDistances.length; index++) {
      expect(placementDistances[index]! - placementDistances[index - 1]!)
        .toBeCloseTo(teeth.userData.actualPitchM, 10);
    }
    const instanceMatrix = new THREE.Matrix4();
    const instancePosition = new THREE.Vector3();
    const instanceTangent = new THREE.Vector3();
    for (let index = 0; index < teeth.count; index += 11) {
      teeth.getMatrixAt(index, instanceMatrix);
      instancePosition.setFromMatrixPosition(instanceMatrix);
      instanceTangent.set(1, 0, 0).transformDirection(instanceMatrix);
      const theta = placementAngles[index]!;
      const corePoint = railPointAt(spec, theta);
      const coreTangent = railTangentAt(spec, theta);
      expect(Math.hypot(instancePosition.x - corePoint.x, instancePosition.y - corePoint.y)).toBeLessThan(1e-7);
      expect(instanceTangent.x * coreTangent.x + instanceTangent.y * coreTangent.y).toBeGreaterThan(0.999999);
    }
    expect(materialOf(channel).name).toBe(
      spec.name === "bx10"
        ? "stadium:material:xtreme-line-pa"
        : "stadium:material:xtreme-line-product-plastic",
    );
    expect(line.userData).toMatchObject({
      centerlineSource: "core:railTrace",
      resin: spec.name === "bx10" ? "PA" : "product-plastic-unspecified",
    });
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("models open, recessed catch trays on %s", (spec) => {
    const model = modelFor(spec);
    const rimZ = spec.dishDepth + spec.rimRise + spec.rimBaseSlope * (spec.rWall - spec.rDish);
    expect(object(model, "stadium:pockets").userData.count).toBe(spec.pockets.length);
    spec.pockets.forEach((pocket, index) => {
      const group = object(model, `stadium:pocket:${index}`);
      expect(group.userData).toMatchObject({
        kind: pocket.kind,
        depthM: pocket.throat.outwardDepth,
        recessM: STADIUM_MODEL_DIMENSIONS.pocketRecessM,
        source: "core:pocketPolygon",
      });
      const floor = mesh(model, `stadium:pocket-floor:${index}`);
      const throat = mesh(model, `stadium:pocket-throat:${index}`);
      const backstop = object(model, `stadium:pocket-backstop:${index}`);
      object(model, `stadium:pocket-cheek:${index}:0`);
      object(model, `stadium:pocket-cheek:${index}:1`);
      expect(floor.userData.recessed).toBe(true);
      expect(floor.userData.floorZ).toBeCloseTo(rimZ - STADIUM_MODEL_DIMENSIONS.pocketRecessM, 6);
      expect(floor.userData).toMatchObject({
        source: "core:pocketCatchPolygon",
        outlinePoints: pocketCatchPolygon(spec, pocket).length,
      });
      expect(throat.userData).toMatchObject({
        opening: true,
        bridgeFree: true,
        shape: "open-sloped-pocket-throat",
        throatShape: pocket.throat.shape,
        source: "core:pocketPolygon+pocketSurfaceZ",
      });
      expect(throat.geometry.userData).toMatchObject({
        bridgeFree: true,
        outlinePoints: pocketPolygon(spec, pocket).length,
        source: "core:pocketPolygon+pocketSurfaceZ",
      });
      if (pocket.throat.shape === "tangential-slot") {
        expect(throat.geometry.userData.outlinePoints).toBeGreaterThan(4);
      } else {
        expect(throat.geometry.userData.outlinePoints).toBe(4);
      }
      expect(backstop.userData.heightM).toBeGreaterThan(0.015);
      expect(group.userData).toMatchObject({
        wallSource: "core:pocketPolygon+pocketCatchPolygon union",
        internalSeamsRemoved: true,
      });
      expect(group.userData.wallSegmentCount).toBeGreaterThan(0);
      const throatPolygon = pocketPolygon(spec, pocket);
      const catchPolygon = pocketCatchPolygon(spec, pocket);
      group.traverse((entry) => {
        if (!entry.name.startsWith(`stadium:pocket-wall:${index}:`)) return;
        expect(entry.userData.externalUnionBoundary).toBe(true);
        const x = Number(entry.userData.midpointX);
        const y = Number(entry.userData.midpointY);
        expect(strictlyInsideConvex(throatPolygon, x, y)).toBe(false);
        expect(strictlyInsideConvex(catchPolygon, x, y)).toBe(false);
        expect(stadiumBoundarySignedDistance(spec, x, y)).toBeGreaterThanOrEqual(-0.00051);
      });
    });
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("cuts every real pocket aperture out of the visible dish on %s", (spec) => {
    const dish = mesh(modelFor(spec), "stadium:dish");
    expect(dish.geometry.userData).toMatchObject({
      apertureSource: "core:pocketAtPoint",
      apertureCount: 3,
    });
    expect(dish.geometry.userData.omittedApertureTriangles).toBeGreaterThan(0);
    const position = dish.geometry.getAttribute("position") as THREE.BufferAttribute;
    const index = dish.geometry.index!;
    const footprints = spec.pockets.flatMap((pocket) => {
      const throat = pocketPolygon(spec, pocket);
      if (pocket.throat.catchHalfWidth === undefined || pocket.throat.catchDepth === undefined) return [throat];
      return [throat, pocketCatchPolygon(spec, pocket)];
    });
    for (let triangle = 0; triangle < index.count; triangle += 3) {
      const a = index.getX(triangle);
      const b = index.getX(triangle + 1);
      const c = index.getX(triangle + 2);
      const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
      const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
      expect(footprints.some((polygon) => pointInConvexPolygon(polygon, x, y))).toBe(false);
    }
  }, 60_000);

  it.each([
    [STADIUM_BX10, 8, "PVC", 1.54, "stadium:material:cover-pvc"],
    [STADIUM_BX32, 12, "product-plastic-unspecified", 1.5, "stadium:material:clear-product-plastic"],
  ] as const)("uses a product-specific transparent canopy on %s", (spec, panelCount, resin, ior, materialName) => {
    const model = modelFor(spec);
    const casing = object(model, "stadium:casing");
    expect(casing.userData).toMatchObject({
      material: resin,
      ior,
      transmission: 0.94,
      thicknessM: STADIUM_MODEL_DIMENSIONS.casingThicknessM,
      coverHeightM: spec.coverHeight,
      canopyCoverageRadians: Math.PI * 2,
      apertureCount: 3,
      apertureSource: "core:pocketAtPoint",
      gapAffects: "product-pocket-throats-only",
    });
    expect(casing.userData.wallCoverageRadians).toBeGreaterThan(4);
    expect(casing.userData.wallCoverageRadians).toBeLessThan(Math.PI * 2);
    expect(casing.userData.gapCoverageRadians).toBeGreaterThan(0);
    const panel = mesh(model, "stadium:casing-panel:0");
    expect(panel.geometry.userData).toMatchObject({
      thicknessM: STADIUM_MODEL_DIMENSIONS.casingThicknessM,
      closedSolid: true,
      panelSegments: 112,
    });
    expect(panel.userData).toMatchObject({ transparentProductPlastic: true, resin });
    const material = materialOf(panel);
    expect(material.name).toBe(materialName);
    expect(material.transparent).toBe(true);
    expect(material.transmission).toBeCloseTo(0.94, 6);
    expect(material.opacity).toBe(1);
    expect(material.ior).toBeCloseTo(ior, 6);
    expect(material.thickness).toBeCloseTo(0.002, 6);
    expect(material.roughness).toBeLessThan(0.07);
    expect(material.depthWrite).toBe(true);
    const innerWall = mesh(model, "stadium:casing-inner-wall:0");
    expect(innerWall.geometry.userData).toMatchObject({
      shape: spec.name === "wide" ? "obround-aperture-wall" : "circular-aperture-wall",
      source: "core:pocketAtPoint",
    });
    const innerLip = object(model, "stadium:casing-inner-lip");
    expect(innerLip.userData).toMatchObject({
      shape: spec.name === "wide" ? "obround" : "circle",
      scaleFromBowl: spec.name === "wide" ? 0.7 : 0.69,
    });
    expect(object(model, "stadium:casing-outer-flange")).toBeTruthy();
    for (let index = 0; index < panelCount; index++) {
      const current = mesh(model, `stadium:casing-panel:${index}`);
      expect(current.material).toBe(panel.material);
      expect(current.userData).toMatchObject({
        continuousMoldedShell: true,
        startAngle: (index / panelCount) * Math.PI * 2,
        endAngle: ((index + 1) / panelCount) * Math.PI * 2,
      });
      if (index > 0) {
        const previous = mesh(model, `stadium:casing-panel:${index - 1}`);
        expect(current.userData.startAngle).toBeCloseTo(previous.userData.endAngle, 12);
      }
    }
    const trayMaterial = materialOf(mesh(model, "stadium:dish"));
    expect(trayMaterial.name).toBe(
      spec.name === "bx10"
        ? "stadium:material:pale-tray-pvc"
        : "stadium:material:pale-tray-product-plastic",
    );
    expect(trayMaterial.transparent).toBe(false);
    expect(trayMaterial.transmission).toBe(0);
    const outerMaterial = materialOf(mesh(model, "stadium:deck-sector:0"));
    expect(outerMaterial.name).toBe(
      spec.name === "bx10"
        ? "stadium:material:body-pvc"
        : "stadium:material:clear-body-product-plastic",
    );
    expect(outerMaterial.transparent).toBe(true);
  });

  it("uses only the verified BX-10 PVC / PA / PP material assignments", () => {
    expect(materialOf(mesh(bx10Model, "stadium:dish")).name).toBe("stadium:material:pale-tray-pvc");
    expect(materialOf(mesh(bx10Model, "stadium:deck-sector:0")).name).toBe("stadium:material:body-pvc");
    expect(materialOf(mesh(bx10Model, "stadium:xtreme-line-channel:0")).name).toBe("stadium:material:xtreme-line-pa");
    expect(materialOf(mesh(bx10Model, "stadium:casing-snap:0")).name).toBe("stadium:material:fastener-pp");
    const names = new Set<string>();
    bx10Model.traverse((entry) => {
      const target = entry as THREE.Mesh;
      if (Array.isArray(target.material)) target.material.forEach((material) => names.add(material.name));
      else if (target.material) names.add(target.material.name);
    });
    expect([...names].some((name) => /abs|polycarbonate/i.test(name))).toBe(false);
  });

  it("renders exactly the official openings and shoot-position markers", () => {
    for (const [model, spec] of [[bx10Model, STADIUM_BX10], [bx32Model, STADIUM_BX32]] as const) {
      expect(object(model, "stadium:pockets").children).toHaveLength(3);
      expect(model.getObjectByName("stadium:pocket:3")).toBeUndefined();
      expect(spec.coverGaps).toEqual([]);
    }
    expect(bx10Model.getObjectByName("stadium:shoot-marker:0")).toBeUndefined();
    expect(object(bx32Model, "stadium:shoot-marker:0").userData.shape).toBe("red-triangle");
    expect(object(bx32Model, "stadium:shoot-marker:1").userData.shape).toBe("red-triangle");
    expect(object(bx32Model, "stadium:shoot-marker:2").userData.shape).toBe("molded-chevron");
    expect(bx32Model.getObjectByName("stadium:shoot-marker:3")).toBeUndefined();
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
