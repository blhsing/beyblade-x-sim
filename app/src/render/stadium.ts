// Reference-driven Takara Tomy stadium presentation.
//
// The deterministic simulation continues to own the battle surface, rail and
// pocket coordinates in core/stadium.ts.  This module turns those same specs
// into the visible injection-moulded product: a pale battle tray, toothed
// Xtreme Line, three real apertures and a thickness-bearing clear cover.

import * as THREE from "three";

import {
  pocketAtPoint,
  pocketBasinPolygon,
  pocketExitTarget,
  pocketGuardCenterline,
  pocketGuardRiseAt,
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
  stadiumTerrainAt,
  STADIUM_GEOMETRY,
  surfaceZAt,
  surfaceZ,
  type PocketSpec,
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

function compilePocketFootprints(
  s: StadiumSpec,
  kind: "basin" | "throat" = "basin",
): CompiledPocketFootprint[] {
  const polygons = s.pockets.map((pocket) =>
    kind === "throat" ? pocketPolygon(s, pocket) : pocketBasinPolygon(s, pocket));
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
    roughness: role === "cover" ? 0.13 : 0.1,
    transmission: role === "cover" ? 0.985 : 0.76,
    thickness: role === "cover" ? STADIUM_GEOMETRY.casingThicknessM : 0.004,
    attenuationDistance: role === "cover" ? 2.4 : 0.18,
    attenuationColor: new THREE.Color(role === "cover" ? 0xeaf4f8 : 0xe5ecef),
    // BX-10 packaging identifies PVC. BX-32 resin is intentionally left
    // neutral because Takara Tomy's public page does not publish it.
    ior: bx10 ? 1.54 : 1.5,
    clearcoat: role === "cover" ? 0.22 : 1,
    clearcoatRoughness: role === "cover" ? 0.2 : 0.11,
    specularIntensity: role === "cover" ? 0.18 : 1,
    envMapIntensity: role === "cover" ? 0.28 : 0.85,
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
}

/** Product geometry constants in metres, declared for tests and model audit. */
export const STADIUM_MODEL_DIMENSIONS = STADIUM_GEOMETRY;

/** The bowl/deck meshes use dense product grids rather than a constrained
 * polygon triangulation. This narrow, coplanar collar bridges their last
 * centroid-cut cell to the exact basin rim, preventing sub-cell cracks while
 * leaving the canonical physics outline unchanged. */
export const POCKET_SURFACE_STITCH_OVERLAP_M = 0.004;

function productCode(s: StadiumSpec): string {
  return s.name === "wide" ? "BX-32" : "BX-10";
}

/** Superellipse boundary: square/faceted BX-10, long rounded BX-32. */
function bodyEdgeRadius(s: StadiumSpec, theta: number): number {
  return stadiumBodyRadiusAt(s, theta);
}

const CASING_CONTOUR_SAMPLES = 4096;
const CASING_CONTOUR_CACHE = new WeakMap<StadiumSpec, Float64Array>();

function raySegmentRadius(
  ux: number,
  uy: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number | null {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denominator = ux * sy - uy * sx;
  if (Math.abs(denominator) <= 1e-12) return null;
  const radius = (a.x * sy - a.y * sx) / denominator;
  const edgeT = (a.x * uy - a.y * ux) / denominator;
  return radius >= 0 && edgeT >= 0 && edgeT <= 1 ? radius : null;
}

function compiledCasingContour(s: StadiumSpec): Float64Array {
  const cached = CASING_CONTOUR_CACHE.get(s);
  if (cached) return cached;
  const contour = new Float64Array(CASING_CONTOUR_SAMPLES);
  const basins = s.pockets.map((pocket) => pocketBasinPolygon(s, pocket));
  // Only a slim molded ledge surrounds the playable floor. The previous
  // shipping-footprint canopy was tens of millimetres too wide on BX-32.
  const ordinaryClearance = s.name === "wide" ? 0.016 : 0.015;
  const pocketClearance = s.name === "wide" ? 0.008 : 0.007;
  for (let index = 0; index < contour.length; index++) {
    const theta = index / contour.length * TAU;
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);
    let radius = stadiumBoundaryRadiusAt(s, theta) + ordinaryClearance;
    for (const polygon of basins) {
      for (let edge = 0; edge < polygon.length; edge++) {
        const hit = raySegmentRadius(ux, uy, polygon[edge]!, polygon[(edge + 1) % polygon.length]!);
        if (hit !== null) radius = Math.max(radius, hit + pocketClearance);
      }
    }
    // Never claim plastic outside the product's measured body envelope.
    contour[index] = Math.min(radius, bodyEdgeRadius(s, theta) - 0.004);
  }
  CASING_CONTOUR_CACHE.set(s, contour);
  return contour;
}

/** Tight photo-matched lower-cover contour, shared by cover, ribs and tests. */
export function stadiumCasingOuterRadiusAt(s: StadiumSpec, theta: number): number {
  const contour = compiledCasingContour(s);
  const wrapped = ((theta % TAU) + TAU) % TAU / TAU * contour.length;
  const index = Math.floor(wrapped) % contour.length;
  const next = (index + 1) % contour.length;
  const fraction = wrapped - Math.floor(wrapped);
  return THREE.MathUtils.lerp(contour[index]!, contour[next]!, fraction);
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
  const pocketFootprints = compilePocketFootprints(s, "basin");
  for (let ring = 0; ring <= radialSegments; ring++) {
    const u = ring / radialSegments;
    for (let segment = 0; segment <= angularSegments; segment++) {
      const theta = (segment / angularSegments) * TAU;
      const radius = stadiumBoundaryRadiusAt(s, theta) * u;
      const x = Math.cos(theta) * radius;
      const y = Math.sin(theta) * radius;
      positions.push(x, y, surfaceZAt(s, x, y) + pocketGuardRiseAt(s, x, y));
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
    pocketEntryGuards: s.pockets.filter((pocket) => pocket.trace?.guard).length,
    guardSource: "core:pocketGuardRiseAt",
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
  // The deck and bowl lip are one molded surface. Keeping them coplanar also
  // lets each concave basin meet both without a half-millimetre lighting seam.
  const topZ = rimZ;
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

/** Dense enough that the photo-vector loop parameter produces sub-0.3 mm
 * centerline chords. Rounded raster-fitted elbows are refined again by their
 * tangent turn, so neither product falls back to visible joined-line facets. */
export const RAIL_RENDER_MAX_ANGLE_STEP = 0.0015;
/** Smooth spans are subdivided again wherever the fitted XY vector turns
 * faster than its loop parameter. */
export const RAIL_RENDER_MAX_TANGENT_STEP = 0.001;

function railArcSampleAngles(s: StadiumSpec, arc: RailArc, span: number): number[] {
  const steps = Math.max(512, Math.ceil(span / RAIL_RENDER_MAX_ANGLE_STEP));
  const end = arc.start + span;
  const angles = Array.from({ length: steps + 1 }, (_, index) => arc.start + (span * index) / steps);
  const trace = s.railTrace ?? [];
  const sharpControls = trace.filter((point, index) => {
    const previous = trace[(index + trace.length - 2) % (trace.length - 1)];
    return Boolean(point.linearToNext || previous?.linearToNext);
  });
  // The cubic evaluator already passes through ordinary controls. Injecting
  // every one into an otherwise uniform mesh creates tiny uneven triangles;
  // only the four real molded elbows need an exact render cross-section.
  for (const control of sharpControls) {
    let angle = control.angle;
    while (angle < arc.start - 1e-9) angle += TAU;
    while (angle > end + 1e-9) angle -= TAU;
    if (angle > arc.start + 1e-9 && angle < end - 1e-9) angles.push(angle);
  }
  angles.sort((a, b) => a - b);
  const uniqueAngles = angles.filter(
    (angle, index) => index === 0 || angle - angles[index - 1]! > 1e-9,
  );
  const sharpAngles = sharpControls.map((point) => point.angle);
  const isSharp = (angle: number): boolean => sharpAngles.some((sharpAngle) => {
    let delta = angle - sharpAngle;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    return Math.abs(delta) <= 1e-9;
  });
  const refined = [uniqueAngles[0]!];
  const tangentTurn = (before: number, after: number): number => {
    const beforeTangent = railTangentAt(s, before);
    const afterTangent = railTangentAt(s, after);
    return Math.acos(Math.max(-1, Math.min(1,
      beforeTangent.x * afterTangent.x + beforeTangent.y * afterTangent.y,
    )));
  };
  const appendSmoothInterval = (before: number, after: number, depth: number): void => {
    const middle = (before + after) / 2;
    const maximumTurn = Math.max(
      tangentTurn(before, after),
      tangentTurn(before, middle),
      tangentTurn(middle, after),
    );
    if (maximumTurn <= RAIL_RENDER_MAX_TANGENT_STEP || depth >= 12) {
      refined.push(after);
      return;
    }
    appendSmoothInterval(before, middle, depth + 1);
    appendSmoothInterval(middle, after, depth + 1);
  };
  for (let index = 1; index < uniqueAngles.length; index++) {
    const before = uniqueAngles[index - 1]!;
    const after = uniqueAngles[index]!;
    if (isSharp(before) || isSharp(after)) refined.push(after);
    else appendSmoothInterval(before, after, 0);
  }

  if (span >= TAU - 1e-6 && refined.length >= 4) {
    // `computeVertexNormals()` weights the two triangles meeting the welded
    // seam by their areas. Match the physical chord on either side so that
    // asymmetric polar parameter speed cannot bias the shared glossy normal.
    const startAngle = refined[0]!;
    const endAngle = refined[refined.length - 1]!;
    const nextAngle = refined[1]!;
    const beforeAngle = refined[refined.length - 2]!;
    const startPoint = railPointAt(s, startAngle);
    const endPoint = railPointAt(s, endAngle);
    const chord = (angle: number, point: { x: number; y: number }): number => {
      const candidate = railPointAt(s, angle);
      return Math.hypot(candidate.x - point.x, candidate.y - point.y);
    };
    const firstChord = chord(nextAngle, startPoint);
    const lastChord = chord(beforeAngle, endPoint);
    const targetChord = Math.min(firstChord, lastChord);
    if (firstChord > targetChord * 1.01) {
      let low = startAngle;
      let high = nextAngle;
      for (let iteration = 0; iteration < 28; iteration++) {
        const middle = (low + high) / 2;
        if (chord(middle, startPoint) < targetChord) low = middle;
        else high = middle;
      }
      refined.splice(1, 0, high);
    } else if (lastChord > targetChord * 1.01) {
      let low = beforeAngle;
      let high = endAngle;
      for (let iteration = 0; iteration < 28; iteration++) {
        const middle = (low + high) / 2;
        if (chord(middle, endPoint) > targetChord) low = middle;
        else high = middle;
      }
      refined.splice(refined.length - 1, 0, high);
    }
  }
  return refined;
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
  points: {
    p: { x: number; y: number };
    tangent: { x: number; y: number };
    widthScale?: number;
  }[],
  closed = false,
): THREE.BufferGeometry {
  // `railHalfWidth` is the Bit capture tolerance, while this is the visible
  // inner/outer silhouette fitted independently from each retail photograph.
  const halfWidth = s.railPhysicalHalfWidth ?? STADIUM_MODEL_DIMENSIONS.railPhysicalHalfWidthM;
  const zTop = STADIUM_MODEL_DIMENSIONS.railChannelThicknessM;
  const positions: number[] = [];
  const indices: number[] = [];
  // A closed arc includes a terminal centerline sample coincident with the
  // first. Omit that duplicate cross-section and wrap indices back to the
  // first four vertices so generated normals average across a real welded
  // seam instead of exposing two glossy boundary-normal sets.
  const crossSectionCount = closed ? Math.max(0, points.length - 1) : points.length;
  for (let pointIndex = 0; pointIndex < crossSectionCount; pointIndex++) {
    const point = points[pointIndex]!;
    const nx = -point.tangent.y;
    const ny = point.tangent.x;
    const width = halfWidth * (point.widthScale ?? 1);
    const plusX = point.p.x + nx * width;
    const plusY = point.p.y + ny * width;
    const minusX = point.p.x - nx * width;
    const minusY = point.p.y - ny * width;
    // The bowl can change several millimetres across the BX-32 ribbon. Every
    // physical edge therefore rests on the canonical surface at its own XY;
    // reusing the centerline Z visibly buried one edge and floated the other.
    const plusBaseZ = surfaceZAt(s, plusX, plusY);
    const minusBaseZ = surfaceZAt(s, minusX, minusY);
    positions.push(plusX, plusY, plusBaseZ + zTop);
    positions.push(minusX, minusY, minusBaseZ + zTop);
    positions.push(plusX, plusY, plusBaseZ);
    positions.push(minusX, minusY, minusBaseZ);
  }
  const segmentCount = closed ? crossSectionCount : Math.max(0, crossSectionCount - 1);
  for (let i = 0; i < segmentCount; i++) {
    const a = i * 4;
    const b = ((i + 1) % crossSectionCount) * 4;
    // top, bottom, and both thickness-bearing channel edges
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    indices.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    indices.push(a, a + 2, b, a + 2, b + 2, b);
    indices.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  if (crossSectionCount >= 2) {
    // Area-weighted analytic frame normals avoid the diagonal bias produced
    // by `computeVertexNormals()` on a very dense quad strip. They follow the
    // same centered ribbon frame on both sides of the welded C1 seam while
    // leaving the authored miter geometry at the two real jogs untouched.
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normal = new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3);
    const vertex = (section: number, corner: number): THREE.Vector3 => new THREE.Vector3(
      position.getX(section * 4 + corner),
      position.getY(section * 4 + corner),
      position.getZ(section * 4 + corner),
    );
    const center = (section: number): THREE.Vector3 => {
      const plus = vertex(section, 2);
      const minus = vertex(section, 3);
      return plus.add(minus).multiplyScalar(0.5);
    };
    for (let section = 0; section < crossSectionCount; section++) {
      const previousSection = section > 0 ? section - 1 : closed ? crossSectionCount - 1 : section;
      const nextSection = section + 1 < crossSectionCount ? section + 1 : closed ? 0 : section;
      const along = center(nextSection).sub(center(previousSection)).normalize();
      const topPlus = vertex(section, 0);
      const topMinus = vertex(section, 1);
      const bottomPlus = vertex(section, 2);
      const sectionCenter = center(section);
      const across = topMinus.clone().sub(topPlus);
      const up = topPlus.clone().sub(bottomPlus);
      const top = new THREE.Vector3().crossVectors(across, along).normalize();
      if (top.z < 0) top.multiplyScalar(-1);
      const plusSide = new THREE.Vector3().crossVectors(up, along).normalize();
      if (plusSide.dot(topPlus.clone().sub(sectionCenter)) < 0) plusSide.multiplyScalar(-1);
      const topWeight = across.length();
      const sideWeight = up.length();
      const write = (
        corner: number,
        topSign: number,
        sideSign: number,
      ): void => {
        const value = top.clone().multiplyScalar(topWeight * topSign)
          .addScaledVector(plusSide, sideWeight * sideSign)
          .normalize();
        normal.setXYZ(section * 4 + corner, value.x, value.y, value.z);
      };
      write(0, 1, 1);
      write(1, 1, -1);
      write(2, -1, 1);
      write(3, -1, -1);
    }
    geometry.setAttribute("normal", normal);
  } else {
    geometry.computeVertexNormals();
  }
  geometry.userData = {
    shape: "thickness-bearing-rack-channel",
    halfWidthM: halfWidth,
    thicknessM: zTop,
    cornerJoin: "c1-rounded-photo-vector",
    closedLoop: closed,
    seamWelded: closed,
    normalSource: "area-weighted-centered-ribbon-frame",
    baseHeightSource: "core:surfaceZAt-each-corner",
    crossSectionCount,
  };
  return geometry;
}

function railRenderFrameAt(
  s: StadiumSpec,
  theta: number,
): { tangent: { x: number; y: number }; widthScale: number; sharp: boolean } {
  const tangent = railTangentAt(s, theta);
  const trace = s.railTrace;
  if (!trace || trace.length < 3) return { tangent, widthScale: 1, sharp: false };
  const uniqueCount = trace.length - 1;
  for (let index = 0; index < uniqueCount; index++) {
    const point = trace[index]!;
    const previous = trace[(index + uniqueCount - 1) % uniqueCount]!;
    if (!point.linearToNext && !previous.linearToNext) continue;
    const delta = Math.atan2(Math.sin(theta - point.angle), Math.cos(theta - point.angle));
    if (Math.abs(delta) > 1e-8) continue;
    const incoming = railTangentAt(s, theta - 1e-6);
    const outgoing = railTangentAt(s, theta + 1e-6);
    const sumX = incoming.x + outgoing.x;
    const sumY = incoming.y + outgoing.y;
    const sumLength = Math.hypot(sumX, sumY);
    if (sumLength <= 1e-8) return { tangent, widthScale: 1, sharp: true };
    const miterTangent = { x: sumX / sumLength, y: sumY / sumLength };
    const incomingNormal = { x: -incoming.y, y: incoming.x };
    const miterNormal = { x: -miterTangent.y, y: miterTangent.x };
    const projection = Math.abs(miterNormal.x * incomingNormal.x + miterNormal.y * incomingNormal.y);
    return {
      tangent: miterTangent,
      widthScale: Math.min(1.75, 1 / Math.max(0.58, projection)),
      sharp: true,
    };
  }
  return { tangent, widthScale: 1, sharp: false };
}

function createXtremeLine(s: StadiumSpec): THREE.Group {
  const group = new THREE.Group();
  setMeshName(group, "stadium:xtreme-line", {
    color: s.railColor,
    toothPitchM: STADIUM_MODEL_DIMENSIONS.railToothPitchM,
    toothHeightM: STADIUM_MODEL_DIMENSIONS.railToothHeightM,
    channelThicknessM: STADIUM_MODEL_DIMENSIONS.railChannelThicknessM,
    localPeakHeightM:
      STADIUM_MODEL_DIMENSIONS.railChannelThicknessM + STADIUM_MODEL_DIMENSIONS.railToothHeightM,
    baseSurfaceOffsetM: 0,
    centerlineSource: "core:railTrace",
    centerlineInterpolation: "xy-cubic-hermite-photo-vector",
    maxAngularStepRad: RAIL_RENDER_MAX_ANGLE_STEP,
    visibleHalfWidthM: s.railPhysicalHalfWidth ?? STADIUM_MODEL_DIMENSIONS.railPhysicalHalfWidthM,
    traceMethod: s.railTraceReference?.method,
    traceSource: s.railTraceReference?.source,
    traceControlPoints: s.railTraceReference?.generatedControlPoints,
    traceMirrored: s.railTraceReference?.mirrored,
    releaseArcs: s.railReleaseArcs?.length ?? 0,
    resin: s.name === "bx10" ? "PA" : "product-plastic-unspecified",
  });
  const railMat = stadiumMoldedPlastic(s.railColor, { rough: 0.34, coat: 0.58 });
  railMat.name = s.name === "bx10"
    ? "stadium:material:xtreme-line-pa"
    : "stadium:material:xtreme-line-product-plastic";
  const toothGeometry = createRailToothGeometry();
  const placements: {
    point: THREE.Vector3;
    angle: number;
    tangent: { x: number; y: number };
    theta: number;
    arcIndex: number;
    arcDistanceM: number;
  }[] = [];
  const arcSpacings: number[] = [];

  for (let arcIndex = 0; arcIndex < s.railArcs.length; arcIndex++) {
    const arc = s.railArcs[arcIndex]!;
    const span = railArcSpan(arc);
    const sampleAngles = railArcSampleAngles(s, arc, span);
    const ribbonPoints: {
      p: { x: number; y: number };
      tangent: { x: number; y: number };
      theta: number;
      distanceM: number;
      widthScale: number;
      sharp: boolean;
    }[] = [];
    let cumulativeDistance = 0;
    let previous: { x: number; y: number } | null = null;
    for (const theta of sampleAngles) {
      const p = railPointAt(s, theta);
      const frame = railRenderFrameAt(s, theta);
      const tangent = frame.tangent;
      if (previous) cumulativeDistance += Math.hypot(p.x - previous.x, p.y - previous.y);
      ribbonPoints.push({
        p,
        tangent,
        theta,
        distanceM: cumulativeDistance,
        widthScale: frame.widthScale,
        sharp: frame.sharp,
      });
      previous = p;
    }
    const closed = span >= TAU - 1e-6;
    const nominalPitch = STADIUM_MODEL_DIMENSIONS.railToothPitchM;
    const toothCount = closed
      ? Math.max(1, Math.round(cumulativeDistance / nominalPitch))
      : Math.max(1, Math.floor(cumulativeDistance / nominalPitch) + 1);
    const spacing = closed ? cumulativeDistance / toothCount : nominalPitch;
    arcSpacings.push(spacing);
    let sampleIndex = 1;
    for (let toothIndex = 0; toothIndex < toothCount; toothIndex++) {
      const targetDistance = toothIndex * spacing;
      while (
        sampleIndex < ribbonPoints.length - 1 &&
        ribbonPoints[sampleIndex]!.distanceM < targetDistance
      ) sampleIndex++;
      const before = ribbonPoints[Math.max(0, sampleIndex - 1)]!;
      const after = ribbonPoints[sampleIndex]!;
      const interval = after.distanceM - before.distanceM;
      const u = interval > 1e-12 ? (targetDistance - before.distanceM) / interval : 0;
      const theta = before.theta + (after.theta - before.theta) * u;
      const p = railPointAt(s, theta);
      const tangent = railTangentAt(s, theta);
      const z = surfaceZAt(s, p.x, p.y);
      placements.push({
        point: new THREE.Vector3(p.x, p.y, z + STADIUM_MODEL_DIMENSIONS.railChannelThicknessM),
        angle: Math.atan2(tangent.y, tangent.x),
        tangent,
        theta,
        arcIndex,
        arcDistanceM: targetDistance,
      });
    }
    const channel = configureMesh(new THREE.Mesh(createRailRibbon(s, ribbonPoints, closed), railMat), false, true);
    let maximumSmoothTangentStepRad = 0;
    for (let index = 1; index < ribbonPoints.length; index++) {
      const before = ribbonPoints[index - 1]!;
      const after = ribbonPoints[index]!;
      if (before.sharp || after.sharp) continue;
      maximumSmoothTangentStepRad = Math.max(
        maximumSmoothTangentStepRad,
        Math.acos(Math.max(-1, Math.min(1,
          before.tangent.x * after.tangent.x + before.tangent.y * after.tangent.y,
        ))),
      );
    }
    setMeshName(channel, `stadium:xtreme-line-channel:${arcIndex}`, {
      arcStart: arc.start,
      arcEnd: arc.end,
      thicknessM: STADIUM_MODEL_DIMENSIONS.railChannelThicknessM,
      sampleCount: ribbonPoints.length,
      maxAngularStepRad: sampleAngles.slice(1).reduce(
        (maximum, angle, index) => Math.max(maximum, angle - sampleAngles[index]!),
        0,
      ),
      maxSmoothTangentStepRad: maximumSmoothTangentStepRad,
      interpolation: "core:xy-cubic-hermite-photo-vector",
      cornerJoin: "c1-rounded-photo-vector",
      authoredSharpKnots: (s.railTrace ?? []).filter((point, index, trace) =>
        Boolean(point.linearToNext || trace[(index + trace.length - 2) % (trace.length - 1)]?.linearToNext)
      ).length,
      arcLengthM: cumulativeDistance,
      toothSpacingM: spacing,
    });
    group.add(channel);
  }

  const teeth = new THREE.InstancedMesh(toothGeometry, railMat, placements.length);
  const matrix = new THREE.Matrix4();
  const tangentAxis = new THREE.Vector3();
  const acrossAxis = new THREE.Vector3();
  const surfaceNormal = new THREE.Vector3();
  placements.forEach((placement, index) => {
    // An upright Z-only instance left tooth corners up to 1.9 mm above/below
    // the sloped BX-32 channel. Build a true local surface frame: X follows
    // the rail after projection onto the underlying terrain, Z is that
    // terrain's normal, and Y completes the right-handed tangent plane.
    const h = 0.0001;
    const dzdx = (
      surfaceZAt(s, placement.point.x + h, placement.point.y) -
      surfaceZAt(s, placement.point.x - h, placement.point.y)
    ) / (2 * h);
    const dzdy = (
      surfaceZAt(s, placement.point.x, placement.point.y + h) -
      surfaceZAt(s, placement.point.x, placement.point.y - h)
    ) / (2 * h);
    surfaceNormal.set(-dzdx, -dzdy, 1).normalize();
    // Lift the exact plan-view rail tangent by the terrain directional
    // derivative. This lies in the same tangent plane while preserving the
    // photo-traced XY direction exactly.
    tangentAxis.set(
      placement.tangent.x,
      placement.tangent.y,
      dzdx * placement.tangent.x + dzdy * placement.tangent.y,
    ).normalize();
    acrossAxis.crossVectors(surfaceNormal, tangentAxis).normalize();
    matrix.makeBasis(tangentAxis, acrossAxis, surfaceNormal);
    matrix.setPosition(placement.point);
    teeth.setMatrixAt(index, matrix);
  });
  teeth.instanceMatrix.needsUpdate = true;
  teeth.castShadow = true;
  teeth.receiveShadow = true;
  setMeshName(teeth, "stadium:xtreme-line-teeth", {
    shape: "trapezoidal-rack-prism",
    count: placements.length,
    pitchM: STADIUM_MODEL_DIMENSIONS.railToothPitchM,
    spacingMethod: "closed-loop-arc-length",
    actualPitchM: arcSpacings.length === 1 ? arcSpacings[0] : undefined,
    placementAngles: placements.map((placement) => placement.theta),
    placementArcIndices: placements.map((placement) => placement.arcIndex),
    placementArcDistancesM: placements.map((placement) => placement.arcDistanceM),
    baseFrame: "core:surfaceZAt-tangent-plane",
    frameDifferenceStepM: 0.0001,
    heightM: STADIUM_MODEL_DIMENSIONS.railToothHeightM,
    bottomWidthM: STADIUM_MODEL_DIMENSIONS.railToothBottomWidthM,
    topWidthM: STADIUM_MODEL_DIMENSIONS.railToothTopWidthM,
    depthM: STADIUM_MODEL_DIMENSIONS.railToothDepthM,
  });
  group.add(teeth);
  return group;
}

function densifyClosedPolygon(
  polygon: readonly { x: number; y: number }[],
  maximumSegmentLength = 0.0015,
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;
    const divisions = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / maximumSegmentLength));
    for (let division = 0; division < divisions; division++) {
      const u = division / divisions;
      points.push({
        x: THREE.MathUtils.lerp(a.x, b.x, u),
        y: THREE.MathUtils.lerp(a.y, b.y, u),
      });
    }
  }
  return points;
}

/** Dense concentric tessellation of the canonical pocket heightfield. The
 * outside ring is exactly the core basin outline and every vertex samples the
 * same terrain function used by motion/debris, so the molded depression joins
 * the bowl/deck without an inserted floor or vertical internal seam. */
function pocketBasinGeometry(
  s: StadiumSpec,
  pocket: StadiumSpec["pockets"][number],
  radialSegments = 64,
): THREE.BufferGeometry {
  const canonicalOutline = pocketBasinPolygon(s, pocket);
  let outline = densifyClosedPolygon(canonicalOutline);
  let signedArea = 0;
  for (let index = 0; index < outline.length; index++) {
    const a = outline[index]!;
    const b = outline[(index + 1) % outline.length]!;
    signedArea += a.x * b.y - b.x * a.y;
  }
  if (signedArea < 0) outline = outline.reverse();
  const center = pocketExitTarget(s, pocket);
  const positions: number[] = [
    center.x,
    center.y,
    corePocketSurfaceZ(s, pocket, center.x, center.y),
  ];
  for (let ring = 1; ring <= radialSegments; ring++) {
    const u = ring / radialSegments;
    for (const boundary of outline) {
      const x = THREE.MathUtils.lerp(center.x, boundary.x, u);
      const y = THREE.MathUtils.lerp(center.y, boundary.y, u);
      positions.push(x, y, corePocketSurfaceZ(s, pocket, x, y));
    }
  }
  // The dish/deck grids cannot terminate every triangle on an arbitrary
  // product polygon. Continue the same surface through a narrow coplanar
  // collar so their centroid-cut aperture and the exact basin outline always
  // overlap. The collar samples canonical surrounding terrain; it does not
  // enlarge the physical pocket used by simulation or scoring.
  for (const boundary of outline) {
    const dx = boundary.x - center.x;
    const dy = boundary.y - center.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    const x = boundary.x + dx / length * POCKET_SURFACE_STITCH_OVERLAP_M;
    const y = boundary.y + dy / length * POCKET_SURFACE_STITCH_OVERLAP_M;
    positions.push(x, y, stadiumTerrainAt(s, x, y).height);
  }
  const indices: number[] = [];
  const count = outline.length;
  for (let index = 0; index < count; index++) {
    indices.push(0, 1 + index, 1 + (index + 1) % count);
  }
  for (let ring = 2; ring <= radialSegments; ring++) {
    const inner = 1 + (ring - 2) * count;
    const outer = 1 + (ring - 1) * count;
    for (let index = 0; index < count; index++) {
      const next = (index + 1) % count;
      indices.push(
        inner + index, outer + index, outer + next,
        inner + index, outer + next, inner + next,
      );
    }
  }
  const canonicalRimStart = 1 + (radialSegments - 1) * count;
  const stitchCollarStart = 1 + radialSegments * count;
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    indices.push(
      canonicalRimStart + index, stitchCollarStart + index, stitchCollarStart + next,
      canonicalRimStart + index, stitchCollarStart + next, canonicalRimStart + next,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // BufferGeometry stores positions as Float32. Re-sample the duplicate rim at
  // those exact stored x/y coordinates so the independent basin and bowl
  // meshes remain position-identical after quantization, then match its normals
  // to the same canonical C1 terrain. The meshes are position-coincident rather
  // than falsely claiming shared topology; the canonical normals prevent a
  // visible lighting seam at that split.
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
  for (let index = 0; index < count; index++) {
    const vertex = canonicalRimStart + index;
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const terrain = stadiumTerrainAt(s, x, y);
    position.setZ(vertex, terrain.height);
    normals.setXYZ(
      vertex,
      terrain.normalX,
      terrain.normalY,
      terrain.normalZ,
    );
    const collarVertex = stitchCollarStart + index;
    const collarX = position.getX(collarVertex);
    const collarY = position.getY(collarVertex);
    const collarTerrain = stadiumTerrainAt(s, collarX, collarY);
    position.setZ(collarVertex, collarTerrain.height);
    normals.setXYZ(
      collarVertex,
      collarTerrain.normalX,
      collarTerrain.normalY,
      collarTerrain.normalZ,
    );
  }
  position.needsUpdate = true;
  normals.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData = {
    shape: "continuous-concave-basin-heightfield",
    source: "core:pocketBasinPolygon+pocketSurfaceZ",
    outlinePoints: outline.length,
    canonicalOutlinePoints: canonicalOutline.length,
    radialSegments,
    canonicalRimStart,
    stitchCollarStart,
    stitchOverlapM: POCKET_SURFACE_STITCH_OVERLAP_M,
    stitchMethod: "coplanar-overlap-collar",
    rimPositionMatched: true,
    rimNormalsFromCanonicalTerrain: true,
    topologicallyWelded: false,
    separateFloor: false,
    verticalInternalSeams: 0,
  };
  return geometry;
}

/** Dense canonical surface patch for the raised molded wall before a pocket.
 * The bowl/basin owns this same heightfield; this coplanar patch contributes
 * enough local vertices for the rounded wedge and its cast shadow to remain
 * visible instead of disappearing into the coarse pale floor grid. */
function pocketGuardGeometry(s: StadiumSpec, pocket: PocketSpec): THREE.BufferGeometry {
  const centerline = pocketGuardCenterline(s, pocket);
  const halfThickness = pocket.trace?.guard.halfThickness ?? 0;
  const acrossSegments = 32;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let pathIndex = 0; pathIndex < centerline.length; pathIndex++) {
    const previous = centerline[Math.max(0, pathIndex - 1)]!;
    const next = centerline[Math.min(centerline.length - 1, pathIndex + 1)]!;
    let tangentX = next.x - previous.x;
    let tangentY = next.y - previous.y;
    const tangentLength = Math.sqrt(tangentX * tangentX + tangentY * tangentY) || 1;
    tangentX /= tangentLength;
    tangentY /= tangentLength;
    const normalX = -tangentY;
    const normalY = tangentX;
    for (let across = 0; across <= acrossSegments; across++) {
      const offset = (across / acrossSegments * 2 - 1) * halfThickness;
      const x = centerline[pathIndex]!.x + normalX * offset;
      const y = centerline[pathIndex]!.y + normalY * offset;
      positions.push(x, y, stadiumTerrainAt(s, x, y).height + 0.00003);
    }
  }
  const row = acrossSegments + 1;
  for (let pathIndex = 0; pathIndex < centerline.length - 1; pathIndex++) {
    for (let across = 0; across < acrossSegments; across++) {
      const a = pathIndex * row + across;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData = {
    shape: "rounded-pocket-entry-wall",
    source: "core:pocketGuardCenterline+pocketGuardRiseAt",
    pathSamples: centerline.length,
    acrossSegments,
    halfThicknessM: halfThickness,
    heightM: pocket.trace?.guard.height ?? 0,
    photoDerived: true,
  };
  return geometry;
}

function createPockets(s: StadiumSpec, bodyMat: THREE.Material): THREE.Group {
  const pockets = new THREE.Group();
  setMeshName(pockets, "stadium:pockets", {
    count: s.pockets.length,
    construction: "one-piece-concave-battle-surface",
  });
  // The overlap collar is geometrically coplanar with the product grids.
  // Polygon offset resolves only depth-buffer tie-breaking; it does not alter
  // the modeled surface position or its canonical normals.
  const basinMaterial = bodyMat.clone();
  basinMaterial.name = `${bodyMat.name}:continuous-pocket-surface`;
  basinMaterial.polygonOffset = true;
  basinMaterial.polygonOffsetFactor = -1;
  basinMaterial.polygonOffsetUnits = -1;
  const guardMaterial = bodyMat.clone();
  guardMaterial.name = `${bodyMat.name}:pocket-entry-wall`;
  guardMaterial.polygonOffset = true;
  guardMaterial.polygonOffsetFactor = -2;
  guardMaterial.polygonOffsetUnits = -2;

  s.pockets.forEach((pocket, index) => {
    const group = new THREE.Group();
    const basinPolygon = pocketBasinPolygon(s, pocket);
    setMeshName(group, `stadium:pocket:${index}`, {
      id: pocket.id,
      kind: pocket.kind,
      centerAngle: pocket.angleCenter,
      halfWidth: pocket.halfWidth,
      throatShape: pocket.throat.shape,
      depthM: pocket.throat.outwardDepth,
      recessM: STADIUM_MODEL_DIMENSIONS.pocketBasinDepthM,
      source: "core:pocketBasinPolygon+pocketSurfaceZ",
      continuousWithBattleSurface: true,
      separateTray: false,
      internalSeams: 0,
      topologicallyWelded: false,
    });

    const basin = configureMesh(
      new THREE.Mesh(
        pocketBasinGeometry(s, pocket),
        basinMaterial,
      ),
      false,
      true,
    );
    setMeshName(basin, `stadium:pocket-basin:${index}`, {
      opening: true,
      shape: "continuous-concave-basin-heightfield",
      throatShape: pocket.throat.shape,
      source: "core:pocketBasinPolygon+pocketSurfaceZ",
      outlinePoints: basinPolygon.length,
      continuousWithBattleSurface: true,
    });
    markReflective(basin, 0.14);
    group.add(basin);
    if (pocket.trace?.guard) {
      const guard = configureMesh(
        new THREE.Mesh(pocketGuardGeometry(s, pocket), guardMaterial),
        true,
        true,
      );
      setMeshName(guard, `stadium:pocket-guard:${index}`, {
        source: "core:pocketGuardCenterline+pocketGuardRiseAt",
        heightM: pocket.trace.guard.height,
        halfThicknessM: pocket.trace.guard.halfThickness,
        reference: pocket.trace.reference.source,
      });
      markReflective(guard, 0.12);
      group.add(guard);
    }
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
  const pocketFootprints = compilePocketFootprints(s, "throat");
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
    source: "core:pocketThroatAtPoint",
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
    apertureSource: "core:pocketThroatAtPoint",
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
  const transmission = 0.985;
  const floorGapHeight = 0.003;
  const wallGeometry = boundaryWallGeometry(
    s,
    rimZ + 0.01 + floorGapHeight,
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
    apertureSource: "core:pocketThroatAtPoint",
    gapAffects: "product-pocket-throats-only",
    floorGapHeightM: floorGapHeight,
    outerContourSource: "core:boundary+pocketBasinPolygon",
  });
  const material = stadiumClearPlastic(s, "cover");
  material.name = s.name === "bx10"
    ? "stadium:material:cover-pvc"
    : "stadium:material:clear-product-plastic";
  const topZ = rimZ + s.coverHeight;
  const thickness = STADIUM_MODEL_DIMENSIONS.casingThicknessM;
  const rings: CanopyRing[] = [
    { radius: (theta) => stadiumCasingOuterRadiusAt(s, theta), z: rimZ + 0.014 },
    {
      radius: (theta) => {
        const wall = stadiumBoundaryRadiusAt(s, theta);
        const outer = stadiumCasingOuterRadiusAt(s, theta);
        return wall + (outer - wall) * 0.7;
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
  // polygon basin-mouth exclusions as the low wall and deterministic sim.
  const wall = configureMesh(new THREE.Mesh(wallGeometry, material), true, false);
  setMeshName(wall, "stadium:casing-inner-wall:0", {
    coverageRadians: wallCoverageRadians,
    thicknessM: thickness,
    heightM: s.coverHeight * 0.32 - 0.01 - floorGapHeight,
    apertureSource: "core:pocketThroatAtPoint",
  });
  casing.add(wall);

  // A narrow real air seam separates the lower safety wall from the molded
  // floor. A dark recessed backing makes the 3 mm slot read as a thin hole
  // through transparent plastic without inventing a Bey-sized escape route.
  const gapMaterial = new THREE.MeshBasicMaterial({
    color: 0x07101a,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const floorGap = configureMesh(
    new THREE.Mesh(
      boundaryWallGeometry(
        s,
        rimZ + 0.01,
        rimZ + 0.01 + floorGapHeight,
        0.0062,
        0.0082,
      ),
      gapMaterial,
    ),
    false,
    false,
  );
  setMeshName(floorGap, "stadium:casing-floor-gap", {
    shape: "thin-air-slot",
    heightM: floorGapHeight,
    apertureSource: "core:pocketThroatAtPoint",
  });
  casing.add(floorGap);

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
        contourCurve((theta) => stadiumCasingOuterRadiusAt(s, theta) - 0.0015, rimZ + 0.014, 512),
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
  setMeshName(outerLip, "stadium:casing-outer-flange", {
    tubularSegments: 768,
    contourSource: "core:boundary+pocketBasinPolygon",
  });
  casing.add(outerLip);

  // Mold-flow ribs divide the transparent canopy into its recognizable
  // facets. They use the same clear product resin, not opaque decoration.
  const ribCount = s.name === "wide" ? 12 : 8;
  for (let i = 0; i < ribCount; i++) {
    const theta = (i / ribCount) * TAU;
    const outer = stadiumCasingOuterRadiusAt(s, theta) - 0.003;
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
  root.add(createPockets(s, bodyMat));
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
