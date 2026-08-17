// Reference-driven Takara Tomy stadium presentation.
//
// The deterministic simulation continues to own the battle surface, rail and
// pocket coordinates in core/stadium.ts.  This module turns those same specs
// into the visible injection-moulded product: a pale battle tray, toothed
// Xtreme Line, three real apertures and a thickness-bearing clear cover.

import * as THREE from "three";

import {
  pocketFloorTopZ as corePocketFloorTopZ,
  pocketAtPoint,
  pocketCatchPolygon,
  pocketPath,
  pocketPolygon,
  pointInConvexPolygon,
  pocketSurfaceZ as corePocketSurfaceZ,
  railPointAt,
  railTangentAt,
  stadiumBoundaryPointAt,
  stadiumBoundaryRadiusAt,
  stadiumBoundaryNormalAt,
  stadiumBoundarySignedDistance,
  stadiumBodyRadiusAt,
  STADIUM_GEOMETRY,
  surfaceZAt,
  surfaceZ,
  type RailArc,
  type StadiumSpec,
} from "../core/stadium";
import { absPlastic } from "./materials";
import { markReflective } from "./rt";

const TAU = Math.PI * 2;

interface CompiledPocketFootprint {
  polygon: readonly { x: number; y: number }[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function compilePocketFootprints(s: StadiumSpec): CompiledPocketFootprint[] {
  const polygons = s.pockets.flatMap((pocket) => {
    const throat = pocketPolygon(s, pocket);
    if (pocket.throat.catchHalfWidth === undefined || pocket.throat.catchDepth === undefined) return [throat];
    return [throat, pocketCatchPolygon(s, pocket)];
  });
  return polygons.map((polygon) => ({
    polygon,
    minX: Math.min(...polygon.map((point) => point.x)),
    maxX: Math.max(...polygon.map((point) => point.x)),
    minY: Math.min(...polygon.map((point) => point.y)),
    maxY: Math.max(...polygon.map((point) => point.y)),
  }));
}

function pointInCompiledFootprints(
  footprints: readonly CompiledPocketFootprint[],
  x: number,
  y: number,
): boolean {
  for (const footprint of footprints) {
    if (x < footprint.minX || x > footprint.maxX || y < footprint.minY || y > footprint.maxY) continue;
    if (pointInConvexPolygon(footprint.polygon, x, y)) return true;
  }
  return false;
}

/** Keep pure geometry/material audits runnable in Node; the browser path adds
 * the procedural injection-mold normal map from materials.ts. */
function stadiumMoldedPlastic(
  color: number,
  options: { rough?: number; coat?: number } = {},
): THREE.MeshPhysicalMaterial {
  if (typeof document !== "undefined") return absPlastic(color, options);
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: options.rough ?? 0.42,
    clearcoat: options.coat ?? 0.45,
    clearcoatRoughness: 0.22,
    envMapIntensity: 0.85,
  });
}

function stadiumClearPlastic(s: StadiumSpec, role: "cover" | "body"): THREE.MeshPhysicalMaterial {
  const bx10 = s.name === "bx10";
  return new THREE.MeshPhysicalMaterial({
    color: role === "cover" ? 0xf7fbff : 0xf1f5f7,
    metalness: 0,
    roughness: role === "cover" ? 0.055 : 0.1,
    transmission: role === "cover" ? 0.94 : 0.76,
    thickness: role === "cover" ? STADIUM_GEOMETRY.casingThicknessM : 0.004,
    attenuationDistance: role === "cover" ? 0.65 : 0.18,
    attenuationColor: new THREE.Color(role === "cover" ? 0xeaf4f8 : 0xe5ecef),
    // BX-10 packaging identifies PVC. BX-32 resin is intentionally left
    // neutral because Takara Tomy's public page does not publish it.
    ior: bx10 ? 1.54 : 1.5,
    clearcoat: 1,
    clearcoatRoughness: role === "cover" ? 0.05 : 0.11,
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
}

/** Product geometry constants in metres, declared for tests and model audit. */
export const STADIUM_MODEL_DIMENSIONS = STADIUM_GEOMETRY;

function productCode(s: StadiumSpec): string {
  return s.name === "wide" ? "BX-32" : "BX-10";
}

/** Superellipse boundary: square/faceted BX-10, long rounded BX-32. */
function bodyEdgeRadius(s: StadiumSpec, theta: number): number {
  return stadiumBodyRadiusAt(s, theta);
}

function setMeshName(mesh: THREE.Object3D, name: string, data: Record<string, unknown> = {}): void {
  mesh.name = name;
  Object.assign(mesh.userData, data);
}

function configureMesh(mesh: THREE.Mesh, cast = true, receive = true): THREE.Mesh {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

function radialSurfaceGeometry(s: StadiumSpec, radialSegments: number, angularSegments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const pocketFootprints = compilePocketFootprints(s);
  for (let ring = 0; ring <= radialSegments; ring++) {
    const u = ring / radialSegments;
    for (let segment = 0; segment <= angularSegments; segment++) {
      const theta = (segment / angularSegments) * TAU;
      const radius = stadiumBoundaryRadiusAt(s, theta) * u;
      const x = Math.cos(theta) * radius;
      const y = Math.sin(theta) * radius;
      positions.push(x, y, surfaceZAt(s, x, y));
    }
  }
  const row = angularSegments + 1;
  let omittedApertureTriangles = 0;
  const addTriangle = (a: number, b: number, c: number): void => {
    const cx = (positions[a * 3]! + positions[b * 3]! + positions[c * 3]!) / 3;
    const cy = (positions[a * 3 + 1]! + positions[b * 3 + 1]! + positions[c * 3 + 1]!) / 3;
    if (pointInCompiledFootprints(pocketFootprints, cx, cy)) {
      omittedApertureTriangles++;
      return;
    }
    indices.push(a, b, c);
  };
  for (let ring = 0; ring < radialSegments; ring++) {
    for (let segment = 0; segment < angularSegments; segment++) {
      const a = ring * row + segment;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      // The pale tray ends at the same exact pocket union used by core
      // terrain. Leaving the old full dish here visibly roofed each ramp.
      addTriangle(a, c, b);
      addTriangle(b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData = {
    shape: s.wallShape?.kind === "obround" ? "obround-heightfield" : "circular-heightfield",
    radialSegments,
    angularSegments,
    apertureSource: "core:pocketAtPoint",
    apertureCount: s.pockets.length,
    omittedApertureTriangles,
  };
  return geometry;
}

function createDish(s: StadiumSpec, bodyMat: THREE.Material): THREE.Mesh {
  const dish = configureMesh(new THREE.Mesh(radialSurfaceGeometry(s, 192, 512), bodyMat), false, true);
  setMeshName(dish, "stadium:dish", {
    shape: s.wallShape?.kind === "obround" ? "obround" : "circle",
    angularSegments: 512,
    profileSegments: 192,
    physicsSurface: true,
  });
  markReflective(dish, 0.14);
  return dish;
}

function createDeck(s: StadiumSpec, rimZ: number, bodyMat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  setMeshName(group, "stadium:outer-deck", {
    material: s.name === "bx10" ? "PVC" : "product-plastic-unspecified",
    transparent: true,
    transmission: 0.76,
    apertureSource: "core:pocketAtPoint",
  });
  // Dense polar tessellation subtracts the actual 2-D pocket polygons. This
  // avoids the old broad sector cut-outs, especially around BX-32's skewed
  // rounded slots, while retaining a thickness-bearing molded deck.
  const angularSegments = 1024;
  const radialSegments = 18;
  const topZ = rimZ + 0.0005;
  const bottomZ = rimZ - 0.014;
  const positions: number[] = [];
  const indices: number[] = [];
  const pocketFootprints = compilePocketFootprints(s);
  let solidCells = 0;
  for (let angular = 0; angular < angularSegments; angular++) {
    const a0 = (angular / angularSegments) * TAU;
    const a1 = ((angular + 1) / angularSegments) * TAU;
    const am = (a0 + a1) / 2;
    for (let radial = 0; radial < radialSegments; radial++) {
      const u0 = radial / radialSegments;
      const u1 = (radial + 1) / radialSegments;
      const um = (u0 + u1) / 2;
      const innerMid = stadiumBoundaryRadiusAt(s, am) * 1.004;
      const outerMid = bodyEdgeRadius(s, am) - 0.002;
      const midRadius = THREE.MathUtils.lerp(innerMid, outerMid, um);
      const mx = Math.cos(am) * midRadius;
      const my = Math.sin(am) * midRadius;
      if (pointInCompiledFootprints(pocketFootprints, mx, my)) continue;
      const corners = [[a0, u0], [a1, u0], [a1, u1], [a0, u1]] as const;
      const points = corners.map(([angle, u]) => {
        const inner = stadiumBoundaryRadiusAt(s, angle) * 1.004;
        const outer = bodyEdgeRadius(s, angle) - 0.002;
        const radius = THREE.MathUtils.lerp(inner, outer, u);
        return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      });
      const base = positions.length / 3;
      for (const z of [bottomZ, topZ]) {
        for (const point of points) positions.push(point.x, point.y, z);
      }
      indices.push(
        base + 4, base + 5, base + 6, base + 4, base + 6, base + 7,
        base, base + 2, base + 1, base, base + 3, base + 2,
        base, base + 1, base + 4, base + 1, base + 5, base + 4,
        base + 1, base + 2, base + 5, base + 2, base + 6, base + 5,
        base + 2, base + 3, base + 6, base + 3, base + 7, base + 6,
        base + 3, base, base + 7, base, base + 4, base + 7,
      );
      solidCells++;
    }
  }
  const deckGeometry = new THREE.BufferGeometry();
  deckGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  deckGeometry.setIndex(indices);
  deckGeometry.computeVertexNormals();
  deckGeometry.userData = {
    shape: "polygon-subtracted-product-deck",
    source: "core:pocketAtPoint",
    angularSegments,
    radialSegments,
    solidCells,
  };
  const deck = configureMesh(new THREE.Mesh(deckGeometry, bodyMat));
  setMeshName(deck, "stadium:deck-sector:0", {
    source: "core:pocketAtPoint",
    apertureCount: s.pockets.length,
  });
  group.add(deck);

  // Molded lower skirt: a multi-level superellipse, matching the product's
  // broad base flange and chamfered corners rather than a thin flat plate.
  const segments = 768;
  const rings = [
    { inset: 0.007, z: rimZ - 0.022 },
    { inset: 0.002, z: rimZ - 0.017 },
    { inset: 0, z: rimZ - 0.006 },
    { inset: 0.0025, z: rimZ + 0.001 },
  ];
  const skirtPositions: number[] = [];
  const skirtIndices: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * TAU;
      const r = bodyEdgeRadius(s, theta) - ring.inset;
      skirtPositions.push(Math.cos(theta) * r, Math.sin(theta) * r, ring.z);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let i = 0; i < segments; i++) {
      const a = ring * (segments + 1) + i;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      skirtIndices.push(a, c, b, b, c, d);
    }
  }
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute("position", new THREE.Float32BufferAttribute(skirtPositions, 3));
  skirtGeometry.setIndex(skirtIndices);
  skirtGeometry.computeVertexNormals();
  const skirt = configureMesh(new THREE.Mesh(skirtGeometry, bodyMat));
  setMeshName(skirt, "stadium:base-skirt", {
    translucentSupport: true,
    contourSegments: segments,
    material: s.name === "bx10" ? "PVC" : "product-plastic-unspecified",
  });
  group.add(skirt);
  return group;
}

function createTornadoRidge(s: StadiumSpec, bodyMat: THREE.Material): THREE.Mesh {
  const scale = s.rDish / s.rWall;
  const ridge = configureMesh(
    new THREE.Mesh(
      new THREE.TubeGeometry(
        contourCurve(
          (theta) => stadiumBoundaryRadiusAt(s, theta) * scale,
          surfaceZ(s, s.rDish) + 0.0018,
          768,
        ),
        1024,
        0.0021,
        24,
        true,
      ),
      bodyMat,
    ),
    false,
    true,
  );
  setMeshName(ridge, "stadium:tornado-ridge", {
    diameterM: s.rDish * 2,
    shape: s.wallShape?.kind === "obround" ? "obround" : "circle",
    tubularSegments: 1024,
  });
  return ridge;
}

function railArcSpan(arc: RailArc): number {
  const direct = arc.end - arc.start;
  if (direct >= TAU - 1e-6) return TAU;
  return direct > 0 ? direct : direct + TAU;
}

function createRailToothGeometry(): THREE.BufferGeometry {
  const { railToothBottomWidthM: bw, railToothTopWidthM: tw, railToothDepthM: d, railToothHeightM: h } =
    STADIUM_MODEL_DIMENSIONS;
  const bd = d / 2;
  const td = d * 0.34;
  // Local X follows the rail tangent, Y crosses the rack, Z points up. The
  // upper rectangle is smaller in both horizontal axes, producing the real
  // molded trapezoidal rack profile rather than a cone/diamond.
  const vertices = [
    -bw / 2, -bd, 0,
    bw / 2, -bd, 0,
    bw / 2, bd, 0,
    -bw / 2, bd, 0,
    -tw / 2, -td, h,
    tw / 2, -td, h,
    tw / 2, td, h,
    -tw / 2, td, h,
  ];
  const indices = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.userData = {
    shape: "trapezoidal-rack-prism",
    pitchM: STADIUM_MODEL_DIMENSIONS.railToothPitchM,
    heightM: h,
    bottomWidthM: bw,
    topWidthM: tw,
    depthM: d,
  };
  return geometry;
}

function createRailRibbon(
  s: StadiumSpec,
  points: { p: { x: number; y: number }; tangent: { x: number; y: number }; z: number }[],
): THREE.BufferGeometry {
  // `railHalfWidth` is the Bit capture tolerance in the sim, not solid mold
  // width. The visible rack stays the narrow product-scaled band.
  const halfWidth = STADIUM_MODEL_DIMENSIONS.railPhysicalHalfWidthM;
  const zTop = STADIUM_MODEL_DIMENSIONS.railChannelThicknessM;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const point of points) {
    const nx = -point.tangent.y;
    const ny = point.tangent.x;
    positions.push(point.p.x + nx * halfWidth, point.p.y + ny * halfWidth, point.z + zTop);
    positions.push(point.p.x - nx * halfWidth, point.p.y - ny * halfWidth, point.z + zTop);
    positions.push(point.p.x + nx * halfWidth, point.p.y + ny * halfWidth, point.z);
    positions.push(point.p.x - nx * halfWidth, point.p.y - ny * halfWidth, point.z);
  }
  const samples = points.length;
  for (let i = 0; i < samples - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    // top, bottom, and both thickness-bearing channel edges
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    indices.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    indices.push(a, a + 2, b, a + 2, b + 2, b);
    indices.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData = {
    shape: "thickness-bearing-rack-channel",
    halfWidthM: halfWidth,
    thicknessM: zTop,
  };
  return geometry;
}

function createXtremeLine(s: StadiumSpec): THREE.Group {
  const group = new THREE.Group();
  setMeshName(group, "stadium:xtreme-line", {
    color: s.railColor,
    toothPitchM: STADIUM_MODEL_DIMENSIONS.railToothPitchM,
    toothHeightM: STADIUM_MODEL_DIMENSIONS.railToothHeightM,
    channelThicknessM: STADIUM_MODEL_DIMENSIONS.railChannelThicknessM,
    centerlineSource: "core:railTrace",
    releaseArcs: s.railReleaseArcs?.length ?? 0,
    resin: s.name === "bx10" ? "PA" : "product-plastic-unspecified",
  });
  const railMat = stadiumMoldedPlastic(s.railColor, { rough: 0.34, coat: 0.58 });
  railMat.name = s.name === "bx10"
    ? "stadium:material:xtreme-line-pa"
    : "stadium:material:xtreme-line-product-plastic";
  const toothGeometry = createRailToothGeometry();
  const placements: { point: THREE.Vector3; angle: number }[] = [];

  for (let arcIndex = 0; arcIndex < s.railArcs.length; arcIndex++) {
    const arc = s.railArcs[arcIndex]!;
    const span = railArcSpan(arc);
    const steps = Math.max(256, Math.ceil(span / 0.004));
    const ribbonPoints: { p: { x: number; y: number }; tangent: { x: number; y: number }; z: number }[] = [];
    let distanceSinceTooth = STADIUM_MODEL_DIMENSIONS.railToothPitchM;
    let previous = railPointAt(s, arc.start);
    for (let i = 0; i <= steps; i++) {
      const theta = arc.start + (span * i) / steps;
      const p = railPointAt(s, theta);
      const tangent = railTangentAt(s, theta);
      const z = surfaceZAt(s, p.x, p.y) + 0.0002;
      ribbonPoints.push({ p, tangent, z });
      if (i > 0) distanceSinceTooth += Math.hypot(p.x - previous.x, p.y - previous.y);
      if (distanceSinceTooth >= STADIUM_MODEL_DIMENSIONS.railToothPitchM) {
        distanceSinceTooth %= STADIUM_MODEL_DIMENSIONS.railToothPitchM;
        placements.push({
          point: new THREE.Vector3(p.x, p.y, z + STADIUM_MODEL_DIMENSIONS.railChannelThicknessM),
          angle: Math.atan2(tangent.y, tangent.x),
        });
      }
      previous = p;
    }
    const channel = configureMesh(new THREE.Mesh(createRailRibbon(s, ribbonPoints), railMat), false, true);
    setMeshName(channel, `stadium:xtreme-line-channel:${arcIndex}`, {
      arcStart: arc.start,
      arcEnd: arc.end,
      thicknessM: STADIUM_MODEL_DIMENSIONS.railChannelThicknessM,
      sampleCount: ribbonPoints.length,
    });
    group.add(channel);
  }

  const teeth = new THREE.InstancedMesh(toothGeometry, railMat, placements.length);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  placements.forEach((placement, index) => {
    rotation.setFromAxisAngle(new THREE.Vector3(0, 0, 1), placement.angle);
    matrix.compose(placement.point, rotation, scale);
    teeth.setMatrixAt(index, matrix);
  });
  teeth.instanceMatrix.needsUpdate = true;
  teeth.castShadow = true;
  teeth.receiveShadow = true;
  setMeshName(teeth, "stadium:xtreme-line-teeth", {
    shape: "trapezoidal-rack-prism",
    count: placements.length,
    pitchM: STADIUM_MODEL_DIMENSIONS.railToothPitchM,
    heightM: STADIUM_MODEL_DIMENSIONS.railToothHeightM,
    bottomWidthM: STADIUM_MODEL_DIMENSIONS.railToothBottomWidthM,
    topWidthM: STADIUM_MODEL_DIMENSIONS.railToothTopWidthM,
    depthM: STADIUM_MODEL_DIMENSIONS.railToothDepthM,
  });
  group.add(teeth);
  return group;
}

function polygonShape(points: readonly { x: number; y: number }[]): THREE.Shape {
  const shape = new THREE.Shape();
  points.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, point.y);
    else shape.lineTo(point.x, point.y);
  });
  shape.closePath();
  return shape;
}

/**
 * Thickness-bearing sloped quadrilateral generated from the same exact
 * top-view pocket polygon used by the deterministic wall test.
 */
function pocketThroatGeometry(
  points: readonly { x: number; y: number }[],
  topHeights: readonly number[],
): THREE.BufferGeometry {
  const thickness = 0.0012;
  const positions: number[] = [];
  const indices: number[] = [];
  const count = points.length;
  for (let layer = 0; layer < 2; layer++) {
    for (let i = 0; i < count; i++) {
      const point = points[i]!;
      positions.push(point.x, point.y, topHeights[i]! - layer * thickness);
    }
  }
  // All product throats are convex and clockwise, including sampled rounded
  // BX-32 slots, so a fan is stable and preserves per-vertex ramp heights.
  for (let i = 1; i < count - 1; i++) {
    indices.push(0, i + 1, i);
    indices.push(count, count + i, count + i + 1);
  }
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    indices.push(i, next, i + count, next, next + count, i + count);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData = {
    shape: "open-sloped-pocket-throat",
    bridgeFree: true,
    thicknessM: thickness,
    outlinePoints: count,
    source: "core:pocketPolygon+pocketSurfaceZ",
  };
  return geometry;
}

function edgeWall(
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  height: number,
  z: number,
  material: THREE.Material,
): THREE.Mesh {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const wall = configureMesh(
    new THREE.Mesh(new THREE.BoxGeometry(length, width, height, 12, 4, 6), material),
  );
  wall.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, z + height / 2);
  wall.rotation.z = Math.atan2(dy, dx);
  return wall;
}

interface PocketWallSegment {
  a: { x: number; y: number };
  b: { x: number; y: number };
}

/** External outline of throat ∪ catch, clipped to the outside of the bowl.
 * Subdivision is required because the wider BX-32 catch overlaps only part
 * of each long throat/cheek edge. */
function externalPocketWallSegments(s: StadiumSpec, pocket: StadiumSpec["pockets"][number]): PocketWallSegment[] {
  const throat = pocketPolygon(s, pocket);
  const catchTray = pocketCatchPolygon(s, pocket);
  const footprints = pocket.throat.catchHalfWidth === undefined || pocket.throat.catchDepth === undefined
    ? [throat]
    : [throat, catchTray];
  const segments: PocketWallSegment[] = [];
  for (const polygon of footprints) {
    const divisions = polygon.length <= 4 ? 16 : 1;
    for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex++) {
      const start = polygon[edgeIndex]!;
      const end = polygon[(edgeIndex + 1) % polygon.length]!;
      for (let division = 0; division < divisions; division++) {
        const u0 = division / divisions;
        const u1 = (division + 1) / divisions;
        const a = {
          x: start.x + (end.x - start.x) * u0,
          y: start.y + (end.y - start.y) * u0,
        };
        const b = {
          x: start.x + (end.x - start.x) * u1,
          y: start.y + (end.y - start.y) * u1,
        };
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-9) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // Anything still within the battle bowl is the deliberately open
        // mouth, not a tray cheek.
        if (stadiumBoundarySignedDistance(s, mx, my) < -0.0005) continue;
        // Clockwise outlines have their exterior on the left. If a small
        // exterior probe remains in the union, this segment is an internal
        // throat/catch overlap seam and must not become a visible wall.
        const probeX = mx - (dy / length) * 0.0004;
        const probeY = my + (dx / length) * 0.0004;
        if (pocketAtPoint(s, probeX, probeY) === pocket) continue;
        segments.push({ a, b });
      }
    }
  }
  return segments;
}

function createPockets(s: StadiumSpec, rimZ: number, bodyMat: THREE.Material): THREE.Group {
  const pockets = new THREE.Group();
  setMeshName(pockets, "stadium:pockets", { count: s.pockets.length });
  const floorZ = rimZ - STADIUM_MODEL_DIMENSIONS.pocketRecessM;
  const floorTopZ = corePocketFloorTopZ(s);

  s.pockets.forEach((pocket, index) => {
    const group = new THREE.Group();
    const polygon = pocketPolygon(s, pocket);
    const catchPolygon = pocketCatchPolygon(s, pocket);
    setMeshName(group, `stadium:pocket:${index}`, {
      id: pocket.id,
      kind: pocket.kind,
      centerAngle: pocket.angleCenter,
      halfWidth: pocket.halfWidth,
      throatShape: pocket.throat.shape,
      depthM: pocket.throat.outwardDepth,
      recessM: STADIUM_MODEL_DIMENSIONS.pocketRecessM,
      source: "core:pocketPolygon",
    });

    const floor = configureMesh(
      new THREE.Mesh(
        new THREE.ExtrudeGeometry(polygonShape(catchPolygon), {
          depth: STADIUM_MODEL_DIMENSIONS.pocketFloorThicknessM,
          steps: 2,
          bevelEnabled: true,
          bevelSegments: 3,
          bevelSize: 0.0007,
          bevelThickness: 0.0005,
          curveSegments: 64,
        }),
        bodyMat,
      ),
      false,
      true,
    );
    floor.position.z = floorZ;
    setMeshName(floor, `stadium:pocket-floor:${index}`, {
      recessed: true,
      floorZ,
      thicknessM: STADIUM_MODEL_DIMENSIONS.pocketFloorThicknessM,
      source: "core:pocketCatchPolygon",
      outlinePoints: catchPolygon.length,
    });
    group.add(floor);

    const heights = polygon.map((point) => corePocketSurfaceZ(s, pocket, point.x, point.y));
    const throat = configureMesh(
      new THREE.Mesh(
        pocketThroatGeometry(polygon, heights),
        bodyMat,
      ),
      false,
      true,
    );
    setMeshName(throat, `stadium:pocket-throat:${index}`, {
      opening: true,
      bridgeFree: true,
      shape: "open-sloped-pocket-throat",
      throatShape: pocket.throat.shape,
      source: "core:pocketPolygon+pocketSurfaceZ",
    });
    group.add(throat);

    const stopHeight = rimZ - 0.005 - floorTopZ;
    const path = pocketPath(s, pocket);
    const backstop = new THREE.Group();
    const cheeks = [new THREE.Group(), new THREE.Group()];
    setMeshName(backstop, `stadium:pocket-backstop:${index}`, { heightM: stopHeight, curved: true });
    cheeks.forEach((cheek, side) => setMeshName(cheek, `stadium:pocket-cheek:${index}:${side}`, { side }));
    const catchDepth = pocket.throat.catchDepth ?? pocket.throat.outwardDepth;
    const externalWalls = externalPocketWallSegments(s, pocket);
    group.userData.wallSource = "core:pocketPolygon+pocketCatchPolygon union";
    group.userData.internalSeamsRemoved = true;
    group.userData.wallSegmentCount = externalWalls.length;
    for (let edgeIndex = 0; edgeIndex < externalWalls.length; edgeIndex++) {
      const { a, b } = externalWalls[edgeIndex]!;
      const mx = (a.x + b.x) / 2 - path.boundary.x;
      const my = (a.y + b.y) / 2 - path.boundary.y;
      const along = mx * path.axis.x + my * path.axis.y;
      const across = mx * path.across.x + my * path.across.y;
      const wall = edgeWall(a, b, 0.0045, stopHeight, floorTopZ, bodyMat);
      setMeshName(wall, `stadium:pocket-wall:${index}:${edgeIndex}`, {
        alongM: along,
        midpointX: (a.x + b.x) / 2,
        midpointY: (a.y + b.y) / 2,
        externalUnionBoundary: true,
      });
      if (along > catchDepth * 0.55) backstop.add(wall);
      else cheeks[across >= 0 ? 0 : 1]!.add(wall);
    }
    group.add(backstop, ...cheeks);
    pockets.add(group);
  });
  return pockets;
}

function boundaryWallGeometry(
  s: StadiumSpec,
  bottomZ: number,
  topZ: number,
  innerOffset: number,
  outerOffset: number,
  segments = 2048,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const pocketFootprints = compilePocketFootprints(s);
  let cellCount = 0;
  for (let segment = 0; segment < segments; segment++) {
    const a0 = (segment / segments) * TAU;
    const a1 = ((segment + 1) / segments) * TAU;
    const mid = stadiumBoundaryPointAt(s, (a0 + a1) / 2);
    if (pointInCompiledFootprints(pocketFootprints, mid.x, mid.y)) continue;
    const endpoints = [a0, a1].map((angle) => {
      const point = stadiumBoundaryPointAt(s, angle);
      const normal = stadiumBoundaryNormalAt(s, point.x, point.y);
      return {
        inner: { x: point.x + normal.x * innerOffset, y: point.y + normal.y * innerOffset },
        outer: { x: point.x + normal.x * outerOffset, y: point.y + normal.y * outerOffset },
      };
    });
    const base = positions.length / 3;
    for (const z of [bottomZ, topZ]) {
      for (const endpoint of endpoints) {
        positions.push(endpoint.inner.x, endpoint.inner.y, z);
        positions.push(endpoint.outer.x, endpoint.outer.y, z);
      }
    }
    // bottom/top, inner/outer faces; adjacent cells meet without phantom caps.
    indices.push(
      base, base + 1, base + 2, base + 1, base + 3, base + 2,
      base + 4, base + 6, base + 5, base + 5, base + 6, base + 7,
      base, base + 4, base + 2, base + 2, base + 4, base + 6,
      base + 1, base + 3, base + 5, base + 3, base + 7, base + 5,
    );
    cellCount++;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData = {
    shape: s.wallShape?.kind === "obround" ? "obround-aperture-wall" : "circular-aperture-wall",
    source: "core:pocketAtPoint",
    sampleSegments: segments,
    solidCells: cellCount,
  };
  return geometry;
}

function createLowWall(s: StadiumSpec, rimZ: number, bodyMat: THREE.Material): THREE.Group {
  const walls = new THREE.Group();
  setMeshName(walls, "stadium:low-bowl-wall", {
    material: s.name === "bx10" ? "PVC" : "product-plastic-unspecified",
    heightM: 0.014,
    apertureSource: "core:pocketAtPoint",
  });
  const wall = configureMesh(
    new THREE.Mesh(
      boundaryWallGeometry(s, rimZ - 0.004, rimZ + 0.01, -0.002, 0.006),
      bodyMat,
    ),
  );
  setMeshName(wall, "stadium:low-bowl-wall:0", { opaqueSupport: true });
  walls.add(wall);
  return walls;
}

interface CanopyRing {
  radius: (theta: number) => number;
  z: number;
}

/** A solid, thickness-bearing canopy wedge (top, underside and all edges). */
function canopyPanelGeometry(
  rings: CanopyRing[],
  start: number,
  end: number,
  segments: number,
  thickness: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const ringCount = rings.length;
  const row = segments + 1;
  for (const zOffset of [0, -thickness]) {
    for (const ring of rings) {
      for (let i = 0; i <= segments; i++) {
        const theta = start + ((end - start) * i) / segments;
        const radius = ring.radius(theta);
        positions.push(Math.cos(theta) * radius, Math.sin(theta) * radius, ring.z + zOffset);
      }
    }
  }
  const layerSize = ringCount * row;
  for (let layer = 0; layer < 2; layer++) {
    const base = layer * layerSize;
    for (let ring = 0; ring < ringCount - 1; ring++) {
      for (let i = 0; i < segments; i++) {
        const a = base + ring * row + i;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        if (layer === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, b, c, b, d, c);
      }
    }
  }
  // Seal the inner and outer radial edges.
  for (const ring of [0, ringCount - 1]) {
    for (let i = 0; i < segments; i++) {
      const topA = ring * row + i;
      const topB = topA + 1;
      const bottomA = layerSize + topA;
      const bottomB = bottomA + 1;
      const reverse = ring === 0;
      if (reverse) indices.push(topA, topB, bottomA, topB, bottomB, bottomA);
      else indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
    }
  }
  // Seal both angular ends of the individually molded-looking panel.
  for (const column of [0, segments]) {
    for (let ring = 0; ring < ringCount - 1; ring++) {
      const topA = ring * row + column;
      const topB = (ring + 1) * row + column;
      const bottomA = layerSize + topA;
      const bottomB = layerSize + topB;
      indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData = { thicknessM: thickness, closedSolid: true, panelSegments: segments };
  return geometry;
}

function contourCurve(
  radiusAt: (theta: number) => number,
  z: number,
  samples = 512,
): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < samples; i++) {
    const theta = (i / samples) * TAU;
    const radius = radiusAt(theta);
    points.push(new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, z));
  }
  return new THREE.CatmullRomCurve3(points, true, "centripetal");
}

function launchApertureRadiusAt(s: StadiumSpec, theta: number): number {
  const scale = s.name === "wide" ? 0.7 : 0.69;
  return stadiumBoundaryRadiusAt(s, theta) * scale;
}

function createCasing(s: StadiumSpec, rimZ: number): THREE.Group {
  const casing = new THREE.Group();
  const code = productCode(s);
  const resin = s.name === "bx10" ? "PVC" : "product-plastic-unspecified";
  const ior = s.name === "bx10" ? 1.54 : 1.5;
  const transmission = 0.94;
  const wallGeometry = boundaryWallGeometry(
    s,
    rimZ + 0.006,
    rimZ + s.coverHeight * 0.32,
    0.0055,
    0.0075,
  );
  const solidCells = Number(wallGeometry.userData.solidCells ?? 0);
  const sampleSegments = Number(wallGeometry.userData.sampleSegments ?? 1);
  const wallCoverageRadians = TAU * solidCells / sampleSegments;
  setMeshName(casing, "stadium:casing", {
    productCode: code,
    material: resin,
    ior,
    transmission,
    thicknessM: STADIUM_MODEL_DIMENSIONS.casingThicknessM,
    coverHeightM: s.coverHeight,
    canopyCoverageRadians: TAU,
    wallCoverageRadians,
    gapCoverageRadians: TAU - wallCoverageRadians,
    apertureCount: s.pockets.length,
    apertureSource: "core:pocketAtPoint",
    gapAffects: "product-pocket-throats-only",
  });
  const material = stadiumClearPlastic(s, "cover");
  material.name = s.name === "bx10"
    ? "stadium:material:cover-pvc"
    : "stadium:material:clear-product-plastic";
  const topZ = rimZ + s.coverHeight;
  const thickness = STADIUM_MODEL_DIMENSIONS.casingThicknessM;
  const rings: CanopyRing[] = [
    { radius: (theta) => bodyEdgeRadius(s, theta) - 0.006, z: rimZ + 0.012 },
    {
      radius: (theta) => {
        const wall = stadiumBoundaryRadiusAt(s, theta);
        return wall + (bodyEdgeRadius(s, theta) - wall) * 0.58;
      },
      z: rimZ + s.coverHeight * 0.3,
    },
    {
      radius: (theta) => {
        const aperture = launchApertureRadiusAt(s, theta);
        const wall = stadiumBoundaryRadiusAt(s, theta);
        return aperture + (wall - aperture) * 0.38;
      },
      z: rimZ + s.coverHeight * 0.72,
    },
    { radius: (theta) => launchApertureRadiusAt(s, theta), z: topZ },
  ];
  const panelCount = s.name === "wide" ? 12 : 8;
  for (let panelIndex = 0; panelIndex < panelCount; panelIndex++) {
    // These are tessellation panels of one continuous molded cover. Shared
    // edges preserve the facets without inventing air slits in the casing.
    const start = (panelIndex / panelCount) * TAU;
    const end = ((panelIndex + 1) / panelCount) * TAU;
    const panel = configureMesh(
      new THREE.Mesh(canopyPanelGeometry(rings, start, end, 112, thickness), material),
      true,
      false,
    );
    setMeshName(panel, `stadium:casing-panel:${panelIndex}`, {
      panelIndex,
      panelCount,
      startAngle: start,
      endAngle: end,
      thicknessM: thickness,
      transparentProductPlastic: true,
      resin,
      continuousMoldedShell: true,
    });
    casing.add(panel);
  }

  // The lower clear barrier uses the same obround/circular boundary and exact
  // polygon throat exclusions as the low tray wall and deterministic sim.
  const wall = configureMesh(new THREE.Mesh(wallGeometry, material), true, false);
  setMeshName(wall, "stadium:casing-inner-wall:0", {
    coverageRadians: wallCoverageRadians,
    thicknessM: thickness,
    heightM: s.coverHeight * 0.32 - 0.006,
    apertureSource: "core:pocketAtPoint",
  });
  casing.add(wall);

  // Thick rolled lips around the launch opening and the product's outer
  // flange catch specular highlights visible in the official photographs.
  const innerLip = configureMesh(
    new THREE.Mesh(
      new THREE.TubeGeometry(
        contourCurve((theta) => launchApertureRadiusAt(s, theta), topZ, 512),
        768,
        0.0032,
        20,
        true,
      ),
      material,
    ),
    true,
    false,
  );
  setMeshName(innerLip, "stadium:casing-inner-lip", {
    shape: s.wallShape?.kind === "obround" ? "obround" : "circle",
    scaleFromBowl: s.name === "wide" ? 0.7 : 0.69,
    tubularSegments: 768,
  });
  casing.add(innerLip);

  const outerLip = configureMesh(
    new THREE.Mesh(
      new THREE.TubeGeometry(
        contourCurve((theta) => bodyEdgeRadius(s, theta) - 0.004, rimZ + 0.01, 512),
        768,
        0.0028,
        16,
        true,
      ),
      material,
    ),
    true,
    false,
  );
  setMeshName(outerLip, "stadium:casing-outer-flange", { tubularSegments: 768 });
  casing.add(outerLip);

  // Mold-flow ribs divide the transparent canopy into its recognizable
  // facets. They use the same clear product resin, not opaque decoration.
  const ribCount = s.name === "wide" ? 12 : 8;
  for (let i = 0; i < ribCount; i++) {
    const theta = (i / ribCount) * TAU;
    const outer = bodyEdgeRadius(s, theta) - 0.007;
    const wallRadius = stadiumBoundaryRadiusAt(s, theta);
    const aperture = launchApertureRadiusAt(s, theta);
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(theta) * outer, Math.sin(theta) * outer, rimZ + 0.013),
      new THREE.Vector3(
        Math.cos(theta) * (wallRadius + (outer - wallRadius) * 0.58),
        Math.sin(theta) * (wallRadius + (outer - wallRadius) * 0.58),
        rimZ + s.coverHeight * 0.38,
      ),
      new THREE.Vector3(Math.cos(theta) * aperture, Math.sin(theta) * aperture, topZ),
    ]);
    const rib = configureMesh(
      new THREE.Mesh(new THREE.TubeGeometry(path, 72, 0.00125, 10, false), material),
      true,
      false,
    );
    setMeshName(rib, `stadium:casing-rib:${i}`, { transparentProductPlastic: true, resin });
    casing.add(rib);
  }
  return casing;
}

function triangleMarkerGeometry(): THREE.ExtrudeGeometry {
  const outer = new THREE.Shape();
  const r = 0.013;
  for (let i = 0; i < 3; i++) {
    const theta = Math.PI / 2 + (i * TAU) / 3;
    const x = Math.cos(theta) * r;
    const y = Math.sin(theta) * r;
    if (i === 0) outer.moveTo(x, y);
    else outer.lineTo(x, y);
  }
  outer.closePath();
  const hole = new THREE.Path();
  const inner = r * 0.55;
  for (let i = 2; i >= 0; i--) {
    const theta = Math.PI / 2 + (i * TAU) / 3;
    const x = Math.cos(theta) * inner;
    const y = Math.sin(theta) * inner;
    if (i === 2) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  hole.closePath();
  outer.holes.push(hole);
  return new THREE.ExtrudeGeometry(outer, {
    depth: 0.001,
    steps: 2,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.0004,
    bevelThickness: 0.00035,
    curveSegments: 24,
  });
}

function chevronMarkerGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const points = [
    [-0.013, 0.002], [0, 0.012], [0.013, 0.002],
    [0.009, -0.002], [0, 0.005], [-0.009, -0.002],
  ] as const;
  points.forEach(([x, y], index) => index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y));
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.0008,
    steps: 2,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.00035,
    bevelThickness: 0.0003,
  });
}

function addProductDetails(root: THREE.Group, s: StadiumSpec, rimZ: number): void {
  if (s.shootAngles.length > 0) {
    const markerMat = stadiumMoldedPlastic(0xd13c3b, { rough: 0.38, coat: 0.52 });
    markerMat.name = "stadium:material:shoot-marker-product-plastic";
    const chevronMat = stadiumMoldedPlastic(0xc9cdd2, { rough: 0.34, coat: 0.42 });
    chevronMat.name = "stadium:material:molded-shoot-chevron";
    const markerGeometry = triangleMarkerGeometry();
    const chevronGeometry = chevronMarkerGeometry();
    s.shootAngles.forEach((angle, index) => {
      const style = s.shootMarkerStyles?.[index] ?? "red-triangle";
      const marker = configureMesh(
        new THREE.Mesh(style === "molded-chevron" ? chevronGeometry : markerGeometry, style === "molded-chevron" ? chevronMat : markerMat),
        false,
        true,
      );
      const markerRadius = stadiumBoundaryRadiusAt(s, angle) + 0.034;
      marker.position.set(
        Math.cos(angle) * markerRadius,
        Math.sin(angle) * markerRadius,
        rimZ + 0.003,
      );
      marker.rotation.z = angle - Math.PI / 2;
      setMeshName(marker, `stadium:shoot-marker:${index}`, { shape: style, angle });
      root.add(marker);
    });
  }

  // Four snap catches are explicit in Takara Tomy's BX-10 assembly sheet.
  // BX-32 uses the same corner-fastened cover construction.
  const snapMat = stadiumMoldedPlastic(0x262a30, { rough: 0.5, coat: 0.18 });
  snapMat.name = s.name === "bx10"
    ? "stadium:material:fastener-pp"
    : "stadium:material:fastener-product-plastic";
  const snapGeometry = new THREE.BoxGeometry(0.018, 0.011, 0.006, 8, 6, 4);
  const latchAngles = [0.42, -0.42, Math.PI - 0.42, -Math.PI + 0.42];
  latchAngles.forEach((angle, index) => {
    const radius = bodyEdgeRadius(s, angle) - 0.013;
    const latch = configureMesh(new THREE.Mesh(snapGeometry, snapMat), true, true);
    latch.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, rimZ + 0.004);
    latch.rotation.z = angle;
    setMeshName(latch, `stadium:casing-snap:${index}`, { fastener: true });
    root.add(latch);
  });

  // A small raised X mark captures the molded BEYBLADE X branding visible on
  // the front clear panel without loading a font or flattening it to a decal.
  const logoMat = stadiumClearPlastic(s, "cover");
  logoMat.name = s.name === "bx10"
    ? "stadium:material:embossed-logo-pvc"
    : "stadium:material:embossed-logo-product-plastic";
  const logo = new THREE.Group();
  setMeshName(logo, "stadium:embossed-x-logo", { embossed: true });
  for (const rotation of [Math.PI / 4, -Math.PI / 4]) {
    const bar = configureMesh(new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.004, 0.002, 16, 4, 4), logoMat), true, false);
    bar.rotation.z = rotation;
    logo.add(bar);
  }
  logo.position.set(0, -s.deckH / 2 + 0.034, rimZ + 0.019);
  logo.rotation.x = Math.PI / 12;
  root.add(logo);
}

/** Count actual rendered triangles, including every InstancedMesh instance. */
export function stadiumTriangleCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    const geometry = mesh.geometry;
    const triangles = geometry.index
      ? Math.floor(geometry.index.count / 3)
      : Math.floor((geometry.getAttribute("position")?.count ?? 0) / 3);
    const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
    count += triangles * instances;
  });
  return count;
}

/** Build a named, inspectable high-density stadium model for BattleView. */
export function buildStadiumModel(s: StadiumSpec): THREE.Group {
  const root = new THREE.Group();
  const code = productCode(s);
  setMeshName(root, `stadium:${code}`, {
    kind: "stadium-model",
    stadiumName: s.name,
    productCode: code,
    deckWidthM: s.deckW,
    deckDepthM: s.deckH,
    source: "Takara Tomy official product photography and assembly instructions",
  });
  const bodyMat = stadiumMoldedPlastic(s.bodyColor, { rough: 0.46, coat: 0.3 });
  bodyMat.name = s.name === "bx10"
    ? "stadium:material:pale-tray-pvc"
    : "stadium:material:pale-tray-product-plastic";
  bodyMat.side = THREE.DoubleSide;
  bodyMat.envMapIntensity = 0.7;
  bodyMat.ior = s.name === "bx10" ? 1.54 : 1.5;
  const outerBodyMat = stadiumClearPlastic(s, "body");
  outerBodyMat.name = s.name === "bx10"
    ? "stadium:material:body-pvc"
    : "stadium:material:clear-body-product-plastic";
  const rimZ = surfaceZ(s, s.rWall);

  root.add(createDish(s, bodyMat));
  root.add(createDeck(s, rimZ, outerBodyMat));
  root.add(createTornadoRidge(s, bodyMat));
  root.add(createXtremeLine(s));
  root.add(createLowWall(s, rimZ, bodyMat));
  root.add(createPockets(s, rimZ, bodyMat));
  root.add(createCasing(s, rimZ));
  addProductDetails(root, s, rimZ);
  root.userData.triangleCount = stadiumTriangleCount(root);
  return root;
}

/** Dispose a replaced high-density stadium without touching cached textures. */
export function disposeStadiumModel(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) materials.add(material);
    } else if (mesh.material) materials.add(mesh.material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
