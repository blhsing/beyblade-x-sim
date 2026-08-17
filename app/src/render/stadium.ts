// Reference-driven Takara Tomy stadium presentation.
//
// The deterministic simulation continues to own the battle surface, rail and
// pocket coordinates in core/stadium.ts.  This module turns those same specs
// into the visible injection-moulded product: opaque ABS dish/base, a toothed
// Xtreme Line, recessed catch trays and a thickness-bearing clear-PC cover.

import * as THREE from "three";

import {
  railPointAt,
  railTangentAt,
  surfaceZ,
  type RailArc,
  type StadiumSpec,
} from "../core/stadium";
import { absPlastic, clearPanel } from "./materials";
import { markReflective } from "./rt";

const TAU = Math.PI * 2;

/** Keep pure geometry/material audits runnable in Node; the browser path adds
 * the procedural injection-mold normal map from materials.ts. */
function stadiumAbsPlastic(
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

/** Product geometry constants in metres, declared for tests and model audit. */
export const STADIUM_MODEL_DIMENSIONS = Object.freeze({
  railToothPitchM: 0.005,
  railToothHeightM: 0.0038,
  railToothBottomWidthM: 0.0044,
  railToothTopWidthM: 0.0025,
  railToothDepthM: 0.0062,
  railChannelThicknessM: 0.0012,
  casingThicknessM: 0.002,
  pocketFloorThicknessM: 0.0035,
  pocketRecessM: 0.028,
});

function productCode(s: StadiumSpec): string {
  return s.name === "wide" ? "BX-32" : "BX-10";
}

function positiveAngle(a: number): number {
  const n = a % TAU;
  return n < 0 ? n + TAU : n;
}

interface AngleSpan {
  start: number;
  end: number;
}

/** Normalize possibly-wrapped arcs into merged [0, 2π] intervals. */
function normalizedSpans(arcs: RailArc[]): AngleSpan[] {
  const split: AngleSpan[] = [];
  for (const arc of arcs) {
    if (arc.end - arc.start >= TAU - 1e-6) return [{ start: 0, end: TAU }];
    const start = positiveAngle(arc.start);
    const end = positiveAngle(arc.end);
    if (Math.abs(start - end) < 1e-8) continue;
    if (start < end) split.push({ start, end });
    else {
      split.push({ start, end: TAU });
      split.push({ start: 0, end });
    }
  }
  split.sort((a, b) => a.start - b.start);
  const merged: AngleSpan[] = [];
  for (const span of split) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end + 1e-8) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function complementSpans(arcs: RailArc[]): AngleSpan[] {
  const occupied = normalizedSpans(arcs);
  if (occupied.length === 0) return [{ start: 0, end: TAU }];
  if (occupied.length === 1 && occupied[0]!.end - occupied[0]!.start >= TAU - 1e-6) return [];
  const result: AngleSpan[] = [];
  let cursor = 0;
  for (const span of occupied) {
    if (span.start > cursor + 1e-8) result.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < TAU - 1e-8) result.push({ start: cursor, end: TAU });
  return result;
}

function spanLength(spans: AngleSpan[]): number {
  return spans.reduce((sum, span) => sum + span.end - span.start, 0);
}

/** Superellipse boundary: square/faceted BX-10, long rounded BX-32. */
function bodyEdgeRadius(s: StadiumSpec, theta: number): number {
  const a = s.deckW / 2;
  const b = s.deckH / 2;
  const exponent = s.name === "wide" ? 7 : 5.5;
  const x = Math.abs(Math.cos(theta)) / a;
  const y = Math.abs(Math.sin(theta)) / b;
  return Math.pow(Math.pow(x, exponent) + Math.pow(y, exponent), -1 / exponent);
}

function ringSegmentShape(rIn: number, rOut: number, a0: number, a1: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, rOut, a0, a1, false);
  shape.absarc(0, 0, rIn, a1, a0, true);
  shape.closePath();
  return shape;
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

function createDish(s: StadiumSpec, bodyMat: THREE.Material): THREE.Mesh {
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 192; i++) {
    const r = (s.rWall * i) / 192;
    profile.push(new THREE.Vector2(Math.max(1e-5, r), surfaceZ(s, r)));
  }
  const dish = configureMesh(new THREE.Mesh(new THREE.LatheGeometry(profile, 512), bodyMat), false, true);
  dish.rotateX(Math.PI / 2);
  // Flip the lathe's radial local Z for upward-facing normals. Its local Y,
  // which carries the physics height profile, remains the world Z axis.
  dish.scale.z = -1;
  setMeshName(dish, "stadium:dish", {
    radialSegments: 512,
    profileSegments: 192,
    physicsSurface: true,
  });
  markReflective(dish, 0.14);
  return dish;
}

function pocketMouthArcs(s: StadiumSpec): RailArc[] {
  return s.pockets.map((pocket) => ({
    start: pocket.angleCenter - pocket.halfWidth,
    end: pocket.angleCenter + pocket.halfWidth,
  }));
}

function createDeck(s: StadiumSpec, rimZ: number, bodyMat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  setMeshName(group, "stadium:opaque-deck", { material: "ABS", transparent: false });
  const inner = s.rWall * 1.004;
  const spans = complementSpans(pocketMouthArcs(s));
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
    const span = spans[spanIndex]!;
    const steps = Math.max(48, Math.ceil((span.end - span.start) / 0.012));
    const shape = new THREE.Shape();
    for (let i = 0; i <= steps; i++) {
      const theta = span.start + ((span.end - span.start) * i) / steps;
      const r = bodyEdgeRadius(s, theta);
      const x = Math.cos(theta) * r;
      const y = Math.sin(theta) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    for (let i = steps; i >= 0; i--) {
      const theta = span.start + ((span.end - span.start) * i) / steps;
      shape.lineTo(Math.cos(theta) * inner, Math.sin(theta) * inner);
    }
    shape.closePath();
    const mesh = configureMesh(
      new THREE.Mesh(
        new THREE.ExtrudeGeometry(shape, {
          depth: 0.015,
          steps: 2,
          bevelEnabled: true,
          bevelSize: 0.0012,
          bevelThickness: 0.001,
          bevelSegments: 4,
          curveSegments: 48,
        }),
        bodyMat,
      ),
    );
    mesh.position.z = rimZ - 0.015;
    setMeshName(mesh, `stadium:deck-sector:${spanIndex}`, { opaqueSupport: true });
    group.add(mesh);
  }

  // Molded lower skirt: a multi-level superellipse, matching the product's
  // broad base flange and chamfered corners rather than a thin flat plate.
  const segments = 768;
  const rings = [
    { inset: 0.007, z: rimZ - 0.022 },
    { inset: 0.002, z: rimZ - 0.017 },
    { inset: 0, z: rimZ - 0.006 },
    { inset: 0.0025, z: rimZ + 0.001 },
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * TAU;
      const r = bodyEdgeRadius(s, theta) - ring.inset;
      positions.push(Math.cos(theta) * r, Math.sin(theta) * r, ring.z);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let i = 0; i < segments; i++) {
      const a = ring * (segments + 1) + i;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  skirtGeometry.setIndex(indices);
  skirtGeometry.computeVertexNormals();
  const skirt = configureMesh(new THREE.Mesh(skirtGeometry, bodyMat));
  setMeshName(skirt, "stadium:base-skirt", { opaqueSupport: true, contourSegments: segments });
  group.add(skirt);
  return group;
}

function createTornadoRidge(s: StadiumSpec, bodyMat: THREE.Material): THREE.Mesh {
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    const angle = Math.PI * t;
    profile.push(
      new THREE.Vector2(
        s.rDish + Math.cos(angle) * 0.0055,
        surfaceZ(s, s.rDish) + Math.sin(angle) * 0.0021,
      ),
    );
  }
  const ridge = configureMesh(new THREE.Mesh(new THREE.LatheGeometry(profile, 512), bodyMat), false, true);
  ridge.rotateX(Math.PI / 2);
  ridge.scale.z = -1;
  setMeshName(ridge, "stadium:tornado-ridge", {
    diameterM: s.rDish * 2,
    radialSegments: 512,
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
  const halfWidth = Math.min(0.0041, s.railHalfWidth * 0.38);
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
  });
  const railMat = stadiumAbsPlastic(s.railColor, { rough: 0.34, coat: 0.58 });
  railMat.name = "stadium:material:xtreme-line-abs";
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
      const z = surfaceZ(s, Math.hypot(p.x, p.y)) + 0.00045;
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

/** Pocket tray length, clamped inside the physical product's outer body. */
export function pocketDepth(s: StadiumSpec): number {
  const margin = Math.min(s.deckW, s.deckH) / 2 - s.rWall - 0.004;
  return Math.max(0.012, Math.min(0.04, margin));
}

/**
 * Steep, open entry ramp from the bowl lip to a catch tray. Unlike a capped
 * ExtrudeGeometry sector, this cannot place a horizontal face over the mouth
 * and hide the recessed pocket floor.
 */
function pocketThroatGeometry(
  rInner: number,
  rOuter: number,
  a0: number,
  a1: number,
  zInner: number,
  zOuter: number,
): THREE.BufferGeometry {
  const segments = Math.max(32, Math.ceil((a1 - a0) / 0.008));
  const thickness = 0.0012;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const theta = a0 + ((a1 - a0) * i) / segments;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    positions.push(c * rInner, sn * rInner, zInner);
    positions.push(c * rOuter, sn * rOuter, zOuter);
    positions.push(c * rInner, sn * rInner, zInner - thickness);
    positions.push(c * rOuter, sn * rOuter, zOuter - thickness);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 4;
    const b = a + 4;
    // Sloped visible ramp and underside.
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    indices.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    // Thin inner/outer edges provide actual molded thickness.
    indices.push(a, a + 2, b, a + 2, b + 2, b);
    indices.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  // Close only the two narrow angular ends; there is deliberately no cap
  // across the pocket opening.
  for (const offset of [0, segments * 4]) {
    indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData = {
    shape: "open-sloped-pocket-throat",
    bridgeFree: true,
    thicknessM: thickness,
    segments,
  };
  return geometry;
}

function createPockets(s: StadiumSpec, rimZ: number, bodyMat: THREE.Material): THREE.Group {
  const pockets = new THREE.Group();
  setMeshName(pockets, "stadium:pockets", { count: s.pockets.length });
  const depth = pocketDepth(s);
  const floorZ = rimZ - STADIUM_MODEL_DIMENSIONS.pocketRecessM;
  const pocketMat = stadiumAbsPlastic(0x343943, { rough: 0.62, coat: 0.12 });
  pocketMat.name = "stadium:material:pocket-tray-abs";

  s.pockets.forEach((pocket, index) => {
    const group = new THREE.Group();
    const a0 = pocket.angleCenter - pocket.halfWidth;
    const a1 = pocket.angleCenter + pocket.halfWidth;
    const rOut = s.rWall + depth;
    setMeshName(group, `stadium:pocket:${index}`, {
      kind: pocket.kind,
      centerAngle: pocket.angleCenter,
      halfWidth: pocket.halfWidth,
      depthM: depth,
      recessM: STADIUM_MODEL_DIMENSIONS.pocketRecessM,
    });

    const floor = configureMesh(
      new THREE.Mesh(
        new THREE.ExtrudeGeometry(ringSegmentShape(s.rWall - 0.005, rOut, a0, a1), {
          depth: STADIUM_MODEL_DIMENSIONS.pocketFloorThicknessM,
          steps: 2,
          bevelEnabled: true,
          bevelSegments: 3,
          bevelSize: 0.0007,
          bevelThickness: 0.0005,
          curveSegments: 96,
        }),
        pocketMat,
      ),
      false,
      true,
    );
    floor.position.z = floorZ;
    setMeshName(floor, `stadium:pocket-floor:${index}`, {
      recessed: true,
      floorZ,
      thicknessM: STADIUM_MODEL_DIMENSIONS.pocketFloorThicknessM,
    });
    group.add(floor);

    // Throat is the short drop immediately behind the bowl wall. It makes a
    // real opening rather than painting a dark sector onto the deck.
    const throat = configureMesh(
      new THREE.Mesh(
        pocketThroatGeometry(
          s.rWall - 0.006,
          s.rWall + 0.003,
          a0,
          a1,
          rimZ - 0.006,
          floorZ + STADIUM_MODEL_DIMENSIONS.pocketFloorThicknessM,
        ),
        pocketMat,
      ),
      false,
      true,
    );
    setMeshName(throat, `stadium:pocket-throat:${index}`, {
      opening: true,
      bridgeFree: true,
      shape: "open-sloped-pocket-throat",
    });
    group.add(throat);

    const stopHeight = rimZ - 0.005 - floorZ;
    const backstop = configureMesh(
      new THREE.Mesh(
        new THREE.ExtrudeGeometry(ringSegmentShape(rOut, rOut + 0.006, a0, a1), {
          depth: stopHeight,
          steps: 2,
          bevelEnabled: true,
          bevelSegments: 3,
          bevelSize: 0.0008,
          bevelThickness: 0.0007,
          curveSegments: 96,
        }),
        bodyMat,
      ),
    );
    backstop.position.z = floorZ;
    setMeshName(backstop, `stadium:pocket-backstop:${index}`, { heightM: stopHeight });
    group.add(backstop);

    for (const [side, angle] of [a0, a1].entries()) {
      const cheek = configureMesh(
        new THREE.Mesh(
          new THREE.ExtrudeGeometry(ringSegmentShape(s.rWall - 0.005, rOut, angle - 0.018, angle + 0.018), {
            depth: stopHeight,
            steps: 2,
            bevelEnabled: true,
            bevelSegments: 3,
            bevelSize: 0.0007,
            bevelThickness: 0.0006,
            curveSegments: 32,
          }),
          bodyMat,
        ),
      );
      cheek.position.z = floorZ;
      setMeshName(cheek, `stadium:pocket-cheek:${index}:${side}`, { side });
      group.add(cheek);
    }
    pockets.add(group);
  });
  return pockets;
}

function createLowWall(s: StadiumSpec, rimZ: number, bodyMat: THREE.Material): THREE.Group {
  const walls = new THREE.Group();
  setMeshName(walls, "stadium:low-bowl-wall", { material: "ABS", heightM: 0.014 });
  const spans = complementSpans(pocketMouthArcs(s));
  spans.forEach((span, index) => {
    const wall = configureMesh(
      new THREE.Mesh(
        new THREE.ExtrudeGeometry(ringSegmentShape(s.rWall - 0.002, s.rWall + 0.006, span.start, span.end), {
          depth: 0.014,
          steps: 2,
          bevelEnabled: true,
          bevelSize: 0.0007,
          bevelThickness: 0.0007,
          bevelSegments: 3,
          curveSegments: 96,
        }),
        bodyMat,
      ),
    );
    wall.position.z = rimZ - 0.004;
    setMeshName(wall, `stadium:low-bowl-wall:${index}`, { opaqueSupport: true });
    walls.add(wall);
  });
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

function createCasing(s: StadiumSpec, rimZ: number): THREE.Group {
  const casing = new THREE.Group();
  const wallSpans = complementSpans(s.coverGaps);
  const code = productCode(s);
  setMeshName(casing, "stadium:casing", {
    productCode: code,
    material: "polycarbonate",
    ior: 1.585,
    transmission: 0.96,
    thicknessM: STADIUM_MODEL_DIMENSIONS.casingThicknessM,
    coverHeightM: s.coverHeight,
    canopyCoverageRadians: TAU,
    wallCoverageRadians: spanLength(wallSpans),
    gapCoverageRadians: spanLength(normalizedSpans(s.coverGaps)),
    gapAffects: "inner-barrier-only",
  });
  const material = clearPanel();
  material.name = "stadium:material:clear-polycarbonate";
  const topZ = rimZ + s.coverHeight;
  const thickness = STADIUM_MODEL_DIMENSIONS.casingThicknessM;
  const rings: CanopyRing[] = [
    { radius: (theta) => bodyEdgeRadius(s, theta) - 0.006, z: rimZ + 0.012 },
    {
      radius: (theta) => s.rWall + (bodyEdgeRadius(s, theta) - s.rWall) * 0.66,
      z: rimZ + s.coverHeight * 0.3,
    },
    {
      radius: (theta) => s.rWall + (bodyEdgeRadius(s, theta) - s.rWall) * 0.24,
      z: rimZ + s.coverHeight * 0.72,
    },
    { radius: () => s.rWall + 0.009, z: topZ },
  ];
  const panelCount = s.name === "wide" ? 12 : 8;
  for (let panelIndex = 0; panelIndex < panelCount; panelIndex++) {
    // A hairline gap gives the broad clear cover the same molded/faceted read
    // as the official single-piece part without making it visually opaque.
    const gap = 0.003;
    const start = (panelIndex / panelCount) * TAU + gap;
    const end = ((panelIndex + 1) / panelCount) * TAU - gap;
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
      transparentPolycarbonate: true,
    });
    casing.add(panel);
  }

  // Inner collision wall follows coverGaps exactly, so presentation and sim
  // agree on where a bey may clear the casing for an over-the-top replay.
  wallSpans.forEach((span, index) => {
    const wall = configureMesh(
      new THREE.Mesh(
        new THREE.ExtrudeGeometry(
          ringSegmentShape(s.rWall + 0.006, s.rWall + 0.006 + thickness, span.start, span.end),
          {
            depth: s.coverHeight - 0.006,
            steps: 4,
            bevelEnabled: true,
            bevelSegments: 4,
            bevelSize: 0.00035,
            bevelThickness: 0.00035,
            curveSegments: 128,
          },
        ),
        material,
      ),
      true,
      false,
    );
    wall.position.z = rimZ + 0.006;
    setMeshName(wall, `stadium:casing-inner-wall:${index}`, {
      startAngle: span.start,
      endAngle: span.end,
      coverageRadians: span.end - span.start,
      thicknessM: thickness,
      heightM: s.coverHeight - 0.006,
    });
    casing.add(wall);
  });

  // Thick rolled lips around the launch opening and the product's outer
  // flange catch specular highlights visible in the official photographs.
  const innerLip = configureMesh(
    new THREE.Mesh(
      new THREE.TubeGeometry(contourCurve(() => s.rWall + 0.009, topZ, 512), 768, 0.0032, 20, true),
      material,
    ),
    true,
    false,
  );
  setMeshName(innerLip, "stadium:casing-inner-lip", { radiusM: s.rWall + 0.009, tubularSegments: 768 });
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
  // facets. They are clear PC too, not opaque decorative bars.
  const ribCount = s.name === "wide" ? 12 : 8;
  for (let i = 0; i < ribCount; i++) {
    const theta = (i / ribCount) * TAU;
    const outer = bodyEdgeRadius(s, theta) - 0.007;
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(theta) * outer, Math.sin(theta) * outer, rimZ + 0.013),
      new THREE.Vector3(
        Math.cos(theta) * (s.rWall + (outer - s.rWall) * 0.58),
        Math.sin(theta) * (s.rWall + (outer - s.rWall) * 0.58),
        rimZ + s.coverHeight * 0.38,
      ),
      new THREE.Vector3(Math.cos(theta) * (s.rWall + 0.01), Math.sin(theta) * (s.rWall + 0.01), topZ),
    ]);
    const rib = configureMesh(
      new THREE.Mesh(new THREE.TubeGeometry(path, 72, 0.00125, 10, false), material),
      true,
      false,
    );
    setMeshName(rib, `stadium:casing-rib:${i}`, { transparentPolycarbonate: true });
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

function addProductDetails(root: THREE.Group, s: StadiumSpec, rimZ: number): void {
  const markerMat = stadiumAbsPlastic(0xd13c3b, { rough: 0.38, coat: 0.52 });
  markerMat.name = "stadium:material:shoot-marker-abs";
  const markerGeometry = triangleMarkerGeometry();
  s.shootAngles.forEach((angle, index) => {
    const marker = configureMesh(new THREE.Mesh(markerGeometry, markerMat), false, true);
    marker.position.set(
      Math.cos(angle) * (s.rWall + 0.034),
      Math.sin(angle) * (s.rWall + 0.034),
      rimZ + 0.003,
    );
    marker.rotation.z = angle - Math.PI / 2;
    setMeshName(marker, `stadium:shoot-marker:${index}`, { shape: "red-triangle", angle });
    root.add(marker);
  });

  // Four snap catches are explicit in Takara Tomy's BX-10 assembly sheet.
  // BX-32 uses the same corner-fastened cover construction.
  const snapMat = stadiumAbsPlastic(0x262a30, { rough: 0.5, coat: 0.18 });
  snapMat.name = "stadium:material:snap-latch";
  const snapGeometry = new THREE.BoxGeometry(0.018, 0.011, 0.006, 8, 6, 4);
  const latchAngles = [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2];
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
  const logoMat = clearPanel();
  logoMat.name = "stadium:material:embossed-logo-polycarbonate";
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
  const bodyMat = stadiumAbsPlastic(s.bodyColor, { rough: 0.46, coat: 0.3 });
  bodyMat.name = "stadium:material:opaque-body-abs";
  bodyMat.side = THREE.DoubleSide;
  bodyMat.envMapIntensity = 0.7;
  const rimZ = surfaceZ(s, s.rWall);

  root.add(createDish(s, bodyMat));
  root.add(createDeck(s, rimZ, bodyMat));
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
