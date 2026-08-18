import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  pocketBasinPolygon,
  pocketExitTarget,
  pointInConvexPolygon,
  railPointAt,
  railTangentAt,
  stadiumTerrainAt,
  stadiumBodyRadiusAt,
  stadiumBoundaryRadiusAt,
  surfaceZAt,
  STADIUM_BX10,
  STADIUM_BX32,
  type StadiumSpec,
} from "../src/core/stadium";
import {
  buildStadiumModel,
  disposeStadiumModel,
  POCKET_SURFACE_STITCH_OVERLAP_M,
  RAIL_RENDER_MAX_ANGLE_STEP,
  RAIL_RENDER_MAX_TANGENT_STEP,
  STADIUM_MODEL_DIMENSIONS,
  stadiumCasingOuterRadiusAt,
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

function projectedGeometryCoversPoint(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
): boolean {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.index;
  const vertexAt = (offset: number): number => index ? index.getX(offset) : offset;
  const cross = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number =>
    (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const elementCount = index?.count ?? position.count;
  for (let offset = 0; offset < elementCount; offset += 3) {
    const a = vertexAt(offset);
    const b = vertexAt(offset + 1);
    const c = vertexAt(offset + 2);
    const ax = position.getX(a);
    const ay = position.getY(a);
    const bx = position.getX(b);
    const by = position.getY(b);
    const cx = position.getX(c);
    const cy = position.getY(c);
    const ab = cross(ax, ay, bx, by, x, y);
    const bc = cross(bx, by, cx, cy, x, y);
    const ca = cross(cx, cy, ax, ay, x, y);
    const hasNegative = ab < -1e-12 || bc < -1e-12 || ca < -1e-12;
    const hasPositive = ab > 1e-12 || bc > 1e-12 || ca > 1e-12;
    if (!(hasNegative && hasPositive)) return true;
  }
  return false;
}

describe("reference-driven stadium models", () => {
  let bx10Model: THREE.Group;
  let bx32Model: THREE.Group;
  let modelBuildMs = 0;

  beforeAll(() => {
    const started = performance.now();
    bx10Model = buildStadiumModel(STADIUM_BX10);
    bx32Model = buildStadiumModel(STADIUM_BX32);
    modelBuildMs = performance.now() - started;
  }, 120_000);

  afterAll(() => {
    disposeStadiumModel(bx32Model);
  });

  const modelFor = (spec: StadiumSpec): THREE.Group =>
    spec.name === STADIUM_BX32.name ? bx32Model : bx10Model;

  it("builds both cached-outline high-density stadiums within the render budget", () => {
    // This deliberately constructs both ~700k-triangle products in one test;
    // production builds only the selected stadium. Keep a small loaded-host
    // allowance without letting accidental topology growth go unbounded.
    expect(modelBuildMs).toBeLessThan(30_000);
  });

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
    expect(model.userData.triangleCount).toBeLessThan(900_000);
    for (let i = 0; i < panelCount; i++) object(model, `stadium:casing-panel:${i}`);
    expect(model.getObjectByName(`stadium:casing-panel:${panelCount}`)).toBeUndefined();
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("uses real trapezoidal teeth on the shared high-density photo-vector Xtreme Line in %s", (_label, spec) => {
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
      halfWidthM: spec.railPhysicalHalfWidth,
      cornerJoin: "c1-rounded-photo-vector",
      closedLoop: true,
      seamWelded: true,
      normalSource: "area-weighted-centered-ribbon-frame",
      baseHeightSource: "core:surfaceZAt-each-corner",
    });
    expect(line.userData).toMatchObject({
      centerlineInterpolation: "xy-cubic-hermite-photo-vector",
      maxAngularStepRad: RAIL_RENDER_MAX_ANGLE_STEP,
      visibleHalfWidthM: spec.railPhysicalHalfWidth,
      traceMethod: "raster-vector-catmull-rom",
      traceSource: spec.railTraceReference?.source,
      traceControlPoints: spec.railTraceReference?.generatedControlPoints,
      traceMirrored: spec.railTraceReference?.mirrored,
    });
    expect(channel.userData).toMatchObject({
      interpolation: "core:xy-cubic-hermite-photo-vector",
      cornerJoin: "c1-rounded-photo-vector",
      authoredSharpKnots: 0,
    });
    expect(channel.userData.sampleCount).toBeGreaterThan(4_000);
    expect(channel.userData.maxAngularStepRad).toBeLessThanOrEqual(RAIL_RENDER_MAX_ANGLE_STEP + 1e-12);
    expect(channel.userData.maxSmoothTangentStepRad)
      .toBeLessThanOrEqual(RAIL_RENDER_MAX_TANGENT_STEP + 1e-9);
    const channelPosition = channel.geometry.getAttribute("position") as THREE.BufferAttribute;
    const channelNormal = channel.geometry.getAttribute("normal") as THREE.BufferAttribute;
    const channelIndex = channel.geometry.index!;
    const crossSectionCount = channel.geometry.userData.crossSectionCount as number;
    let maximumChannelBaseError = 0;
    for (let vertex = 0; vertex < channelPosition.count; vertex++) {
      const top = vertex % 4 < 2;
      const expected = surfaceZAt(spec, channelPosition.getX(vertex), channelPosition.getY(vertex)) +
        (top ? STADIUM_MODEL_DIMENSIONS.railChannelThicknessM : 0);
      maximumChannelBaseError = Math.max(
        maximumChannelBaseError,
        Math.abs(channelPosition.getZ(vertex) - expected),
      );
    }
    // Every generated edge/corner sits on the same underlying heightfield as
    // physics. The remaining nanometres are Float32 storage error only.
    expect(maximumChannelBaseError).toBeLessThan(0.00000002);
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
    expect(teeth.userData).toMatchObject({
      spacingMethod: "closed-loop-arc-length",
      baseFrame: "core:surfaceZAt-tangent-plane",
      frameDifferenceStepM: 0.0001,
    });
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
    const instanceAcross = new THREE.Vector3();
    const instanceUp = new THREE.Vector3();
    const localToothPosition = teeth.geometry.getAttribute("position") as THREE.BufferAttribute;
    const worldCorner = new THREE.Vector3();
    let maximumToothBaseError = 0;
    for (let index = 0; index < teeth.count; index++) {
      teeth.getMatrixAt(index, instanceMatrix);
      instancePosition.setFromMatrixPosition(instanceMatrix);
      instanceTangent.setFromMatrixColumn(instanceMatrix, 0);
      instanceAcross.setFromMatrixColumn(instanceMatrix, 1);
      instanceUp.setFromMatrixColumn(instanceMatrix, 2);
      const theta = placementAngles[index]!;
      const corePoint = railPointAt(spec, theta);
      const coreTangent = railTangentAt(spec, theta);
      expect(Math.hypot(instancePosition.x - corePoint.x, instancePosition.y - corePoint.y)).toBeLessThan(1e-7);
      expect(instancePosition.z).toBeCloseTo(
        surfaceZAt(spec, corePoint.x, corePoint.y) + STADIUM_MODEL_DIMENSIONS.railChannelThicknessM,
        7,
      );
      expect(instanceTangent.length()).toBeCloseTo(1, 6);
      expect(instanceAcross.length()).toBeCloseTo(1, 6);
      expect(instanceUp.length()).toBeCloseTo(1, 6);
      expect(Math.abs(instanceTangent.dot(instanceAcross))).toBeLessThan(1e-6);
      expect(Math.abs(instanceTangent.dot(instanceUp))).toBeLessThan(1e-6);
      expect(Math.abs(instanceAcross.dot(instanceUp))).toBeLessThan(1e-6);
      expect(instanceTangent.clone().cross(instanceAcross).dot(instanceUp)).toBeGreaterThan(0.999999);
      expect(instanceUp.z).toBeGreaterThan(0);
      const horizontalLength = Math.sqrt(
        instanceTangent.x * instanceTangent.x + instanceTangent.y * instanceTangent.y,
      );
      expect(
        (instanceTangent.x * coreTangent.x + instanceTangent.y * coreTangent.y) / horizontalLength,
      ).toBeGreaterThan(0.999999);
      for (let corner = 0; corner < 4; corner++) {
        worldCorner.fromBufferAttribute(localToothPosition, corner).applyMatrix4(instanceMatrix);
        const expected = surfaceZAt(spec, worldCorner.x, worldCorner.y) +
          STADIUM_MODEL_DIMENSIONS.railChannelThicknessM;
        maximumToothBaseError = Math.max(maximumToothBaseError, Math.abs(worldCorner.z - expected));
      }
    }
    expect(maximumToothBaseError).toBeLessThan(spec.name === "wide" ? 0.00015 : 0.0001);
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

  it.each([STADIUM_BX10, STADIUM_BX32])("models each loss zone as one continuous concave surface on %s", (spec) => {
    const model = modelFor(spec);
    const dish = mesh(model, "stadium:dish");
    expect(dish.geometry.userData).toMatchObject({
      pocketEntryGuards: spec.pockets.length,
      guardSource: "core:pocketGuardRiseAt",
    });
    expect(object(model, "stadium:pockets").userData).toMatchObject({
      count: spec.pockets.length,
      construction: "one-piece-concave-battle-surface",
    });
    spec.pockets.forEach((pocket, index) => {
      const group = object(model, `stadium:pocket:${index}`);
      expect(group.userData).toMatchObject({
        kind: pocket.kind,
        depthM: pocket.throat.outwardDepth,
        recessM: STADIUM_MODEL_DIMENSIONS.pocketBasinDepthM,
        source: "core:pocketBasinPolygon+pocketSurfaceZ",
        continuousWithBattleSurface: true,
        separateTray: false,
        internalSeams: 0,
        topologicallyWelded: false,
      });
      const basin = mesh(model, `stadium:pocket-basin:${index}`);
      expect(basin.userData).toMatchObject({
        opening: true,
        shape: "continuous-concave-basin-heightfield",
        throatShape: pocket.throat.shape,
        source: "core:pocketBasinPolygon+pocketSurfaceZ",
        outlinePoints: pocketBasinPolygon(spec, pocket).length,
        continuousWithBattleSurface: true,
      });
      expect(basin.geometry.userData).toMatchObject({
        shape: "continuous-concave-basin-heightfield",
        source: "core:pocketBasinPolygon+pocketSurfaceZ",
        rimPositionMatched: true,
        rimNormalsFromCanonicalTerrain: true,
        topologicallyWelded: false,
        stitchOverlapM: POCKET_SURFACE_STITCH_OVERLAP_M,
        stitchMethod: "coplanar-overlap-collar",
        separateFloor: false,
        verticalInternalSeams: 0,
      });
      expect(model.getObjectByName(`stadium:pocket-floor:${index}`)).toBeUndefined();
      expect(model.getObjectByName(`stadium:pocket-throat:${index}`)).toBeUndefined();
      expect(model.getObjectByName(`stadium:pocket-backstop:${index}`)).toBeUndefined();
      expect(model.getObjectByName(`stadium:pocket-cheek:${index}:0`)).toBeUndefined();

      const guard = mesh(model, `stadium:pocket-guard:${index}`);
      expect(guard.userData).toMatchObject({
        source: "core:pocketGuardCenterline+pocketGuardRiseAt",
        heightM: pocket.trace?.guard.height,
        halfThicknessM: pocket.trace?.guard.halfThickness,
        solidBarrier: pocket.trace?.guard.collision?.kind === "solid",
      });
      const solidBarrier = pocket.trace?.guard.collision?.kind === "solid";
      const moldedWedge = pocket.trace?.guard.profile?.kind === "molded-wedge";
      expect(guard.geometry.userData).toMatchObject({
        shape: moldedWedge
          ? "molded-pocket-divider-wedge"
          : solidBarrier ? "solid-rounded-pocket-lip" : "rounded-pocket-entry-wall",
        source: "core:pocketGuardCenterline+pocketGuardRiseAt",
        acrossSegments: moldedWedge ? 64 : 32,
        solidBarrier,
        photoDerived: true,
      });
      expect(guard.geometry.userData.pathSamples).toBeGreaterThanOrEqual(26);
      const guardPosition = guard.geometry.getAttribute("position") as THREE.BufferAttribute;
      if (moldedWedge) {
        expect(guard.geometry.userData.verticalFaceTriangles).toBeGreaterThan(100);
        expect(guard.geometry.userData.vaultSpeedMps).toBe(pocket.trace?.guard.collision?.vaultSpeed);
        expect(guard.geometry.userData).toMatchObject({
          profile: "molded-wedge",
          bowlApronM: 0.026,
          pocketApronM: 0.012,
          crestWidthM: 0.015,
          footprintWidthM: 0.038,
        });
        expect(guard.geometry.userData.footprintWidthM / guard.geometry.userData.heightM)
          .toBeGreaterThan(2);
        const topVertexCount = guard.geometry.userData.pathSamples *
          (guard.geometry.userData.acrossSegments + 1);
        for (let vertex = 0; vertex < topVertexCount; vertex += Math.max(1, Math.floor(topVertexCount / 100))) {
          const x = guardPosition.getX(vertex);
          const y = guardPosition.getY(vertex);
          expect(guardPosition.getZ(vertex)).toBeCloseTo(stadiumTerrainAt(spec, x, y).height + 0.00003, 5);
        }
        guard.geometry.computeBoundingBox();
        expect(guard.geometry.boundingBox!.max.z - guard.geometry.boundingBox!.min.z)
          .toBeGreaterThan((pocket.trace?.guard.height ?? 0) * 0.9);
      } else {
        if (solidBarrier) {
          expect(guard.geometry.userData.shape).toBe("solid-rounded-pocket-lip");
          expect(guard.geometry.userData.verticalFaceTriangles).toBe(0);
          expect(guard.geometry.userData.vaultSpeedMps).toBe(pocket.trace?.guard.collision?.vaultSpeed);
          expect(pocket.trace?.guard.height).toBeGreaterThanOrEqual(0.010);
        }
        for (let vertex = 0; vertex < guardPosition.count; vertex += Math.max(1, Math.floor(guardPosition.count / 80))) {
          const x = guardPosition.getX(vertex);
          const y = guardPosition.getY(vertex);
          expect(guardPosition.getZ(vertex)).toBeCloseTo(stadiumTerrainAt(spec, x, y).height + 0.00003, 5);
        }
      }

      const position = basin.geometry.getAttribute("position") as THREE.BufferAttribute;
      const normal = basin.geometry.getAttribute("normal") as THREE.BufferAttribute;
      const outlinePoints = Number(basin.geometry.userData.outlinePoints);
      const radialSegments = Number(basin.geometry.userData.radialSegments);
      const boundaryStart = 1 + (radialSegments - 1) * outlinePoints;
      const target = pocketExitTarget(spec, pocket);
      for (let outlineIndex = 0; outlineIndex < outlinePoints; outlineIndex += Math.max(1, Math.floor(outlinePoints / 24))) {
        const vertex = boundaryStart + outlineIndex;
        const x = position.getX(vertex);
        const y = position.getY(vertex);
        const canonical = stadiumTerrainAt(spec, x, y);
        expect(position.getZ(vertex)).toBeCloseTo(canonical.height, 6);
        const normalDot = normal.getX(vertex) * canonical.normalX +
          normal.getY(vertex) * canonical.normalY +
          normal.getZ(vertex) * canonical.normalZ;
        expect(normalDot).toBeGreaterThan(0.99999);

        // Adjacent canonical normals on either side of the position-matched
        // rim remain aligned; this is the C1 lighting-seam regression.
        const dx = x - target.x;
        const dy = y - target.y;
        const length = Math.max(1e-9, Math.hypot(dx, dy));
        const epsilon = 0.00002;
        const inside = stadiumTerrainAt(spec, x - dx / length * epsilon, y - dy / length * epsilon);
        const outside = stadiumTerrainAt(spec, x + dx / length * epsilon, y + dy / length * epsilon);
        expect(
          inside.normalX * outside.normalX + inside.normalY * outside.normalY + inside.normalZ * outside.normalZ,
        ).toBeGreaterThan(0.995);
      }
    });
  });

  it("bridges every basin rim beyond the dish/deck grid cut without an open mesh sliver", () => {
    for (const spec of [STADIUM_BX10, STADIUM_BX32]) {
      const model = modelFor(spec);
      spec.pockets.forEach((pocket, pocketIndex) => {
        const basin = mesh(model, `stadium:pocket-basin:${pocketIndex}`);
        expect((basin.material as THREE.Material).polygonOffset).toBe(true);
        const outline = pocketBasinPolygon(spec, pocket);
        const target = pocketExitTarget(spec, pocket);
        for (let edgeIndex = 0; edgeIndex < outline.length; edgeIndex++) {
          const a = outline[edgeIndex]!;
          const b = outline[(edgeIndex + 1) % outline.length]!;
          for (const u of [0.2, 0.5, 0.8]) {
            const rimX = THREE.MathUtils.lerp(a.x, b.x, u);
            const rimY = THREE.MathUtils.lerp(a.y, b.y, u);
            const dx = rimX - target.x;
            const dy = rimY - target.y;
            const length = Math.max(1e-9, Math.hypot(dx, dy));
            // This covers the auditor's 0.1/0.5/1.0 mm crack probes and
            // verifies actual projected triangles, not optimistic metadata.
            for (const outward of [0.0001, 0.0005, 0.001]) {
              const x = rimX + dx / length * outward;
              const y = rimY + dy / length * outward;
              expect(
                projectedGeometryCoversPoint(basin.geometry, x, y),
                `${spec.name}/${pocket.id} leaves an uncovered rim sliver at edge ${edgeIndex}, u=${u}, offset=${outward}`,
              ).toBe(true);
            }
          }
        }
      });
    }
  }, 120_000);

  it.each([STADIUM_BX10, STADIUM_BX32])("cuts every real pocket aperture out of the visible dish on %s", (spec) => {
    const dish = mesh(modelFor(spec), "stadium:dish");
    expect(dish.geometry.userData).toMatchObject({
      apertureSource: "core:pocketAtPoint",
      apertureCount: 3,
    });
    expect(dish.geometry.userData.omittedApertureTriangles).toBeGreaterThan(0);
    const position = dish.geometry.getAttribute("position") as THREE.BufferAttribute;
    const index = dish.geometry.index!;
    const footprints = spec.pockets.map((pocket) => pocketBasinPolygon(spec, pocket));
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
      transmission: 0.985,
      thicknessM: STADIUM_MODEL_DIMENSIONS.casingThicknessM,
      coverHeightM: spec.coverHeight,
      canopyCoverageRadians: Math.PI * 2,
      apertureCount: 3,
      apertureSource: "core:pocketThroatAtPoint",
      gapAffects: "product-pocket-throats-only",
      floorGapHeightM: 0.003,
      outerContourSource: "core:boundary+pocketBasinPolygon",
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
    expect(material.transmission).toBeCloseTo(0.985, 6);
    expect(material.opacity).toBe(1);
    expect(material.ior).toBeCloseTo(ior, 6);
    expect(material.thickness).toBeCloseTo(0.002, 6);
    expect(material.roughness).toBeCloseTo(0.13, 6);
    expect(material.clearcoat).toBeCloseTo(0.22, 6);
    expect(material.clearcoatRoughness).toBeCloseTo(0.2, 6);
    expect(material.specularIntensity).toBeCloseTo(0.18, 6);
    expect(material.envMapIntensity).toBeCloseTo(0.28, 6);
    expect(material.depthWrite).toBe(true);
    const innerWall = mesh(model, "stadium:casing-inner-wall:0");
    expect(innerWall.geometry.userData).toMatchObject({
      shape: spec.name === "wide" ? "obround-aperture-wall" : "circular-aperture-wall",
      source: "core:pocketThroatAtPoint",
    });
    expect(object(model, "stadium:casing-floor-gap").userData).toMatchObject({
      shape: "thin-air-slot",
      heightM: 0.003,
      apertureSource: "core:pocketThroatAtPoint",
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

  it.each([STADIUM_BX10, STADIUM_BX32])("hugs the actual %s floor rim instead of the shipping rectangle", (spec) => {
    let largestBodyInset = 0;
    for (let sample = 0; sample < 4096; sample++) {
      const theta = sample / 4096 * Math.PI * 2;
      const casing = stadiumCasingOuterRadiusAt(spec, theta);
      const body = stadiumBodyRadiusAt(spec, theta);
      const bowl = stadiumBoundaryRadiusAt(spec, theta);
      expect(casing).toBeLessThanOrEqual(body - 0.0039);
      expect(casing).toBeGreaterThanOrEqual(bowl + 0.0069);
      largestBodyInset = Math.max(largestBodyInset, body - casing);
    }
    // This catches the old canopy, which simply followed the full packaging
    // footprint and left a broad dead shelf outside the playable molding.
    expect(largestBodyInset).toBeGreaterThan(spec.name === "wide" ? 0.03 : 0.05);
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
