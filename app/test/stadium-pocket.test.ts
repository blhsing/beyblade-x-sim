import { describe, expect, it } from "vitest";

import {
  pocketAtPoint,
  pocketBasinPolygon,
  pocketExitTarget,
  pocketGuardCenterline,
  pocketGuardRiseAt,
  pocketPath,
  pocketPolygon,
  pocketSecureAtPoint,
  pocketSurfaceZ,
  railClosestPoint,
  railPointAt,
  railReleaseDirectionAt,
  railTangentAt,
  stadiumBoundaryRadiusAt,
  stadiumBoundarySignedDistance,
  stadiumBodyRadiusAt,
  stadiumTerrainAt,
  STADIUM_BX10,
  STADIUM_BX32,
  STADIUM_GEOMETRY,
  surfaceZAt,
  type StadiumSpec,
} from "../src/core/stadium";
import {
  createWorld,
  DT,
  hashWorld,
  POCKET_DWELL_TICKS,
  POCKET_REST_DISPLACEMENT,
  POCKET_SUPPORT_CLEARANCE_M,
  step,
} from "../src/core/sim";
import type { BeyParams, WorldConfig } from "../src/core/types";

const params: BeyParams = {
  label: "pocket-fixture",
  massKg: 0.04,
  radiusM: 0.02625, // widest authored upper part (52.5 mm)
  inertia: 0.000012,
  cogHeightM: 0.012,
  attackFactor: 1,
  attackVariance: 0,
  defenseFactor: 1,
  burstRes: 100,
  dashFactor: 0,
  grip: 0,
  muSpin: 0.08,
  muMove: 0.8,
  spinDir: 1,
  latchCount: 3,
  staminaFactor: 1,
};

function config(count = 1): WorldConfig {
  return {
    seed: 0x51ad1a,
    beys: Array.from({ length: count }, () => ({ ...params })),
    launches: Array.from({ length: count }, () => ({
      sp: 7000,
      aimDeg: 0,
      tiltDeg: 0,
      launcher: "winder" as const,
      spinDir: 1 as const,
    })),
    xtremeDashEnabled: false,
    clicksMax: 4,
    maxTicks: 20_000,
  };
}

function groundBey(cfg: WorldConfig, stadium: StadiumSpec, pocketIndex: number, omega = 0) {
  const world = createWorld(cfg);
  const bey = world.beys[0]!;
  const pocket = stadium.pockets[pocketIndex]!;
  const target = pocketExitTarget(stadium, pocket);
  Object.assign(bey, {
    x: target.x,
    y: target.y,
    vx: 0,
    vy: 0,
    z: 0,
    vz: 0,
    airborne: false,
    pendingTicks: 0,
    omega,
    pocketIndex,
    pocketDwell: 0,
    pocketLastX: target.x,
    pocketLastY: target.y,
    railTicks: -1,
  });
  return { world, bey, pocket, target };
}

function properSegmentsCross(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): boolean {
  const side = (p: typeof a, q: typeof a, r: typeof a) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = side(a, b, c);
  const abD = side(a, b, d);
  const cdA = side(c, d, a);
  const cdB = side(c, d, b);
  return abC * abD < -1e-14 && cdA * cdB < -1e-14;
}

function minimumSampledRailCurvatureRadius(stadium: StadiumSpec, sampleCount = 32_768): number {
  const delta = Math.PI * 2 / sampleCount;
  let minimum = Infinity;
  for (let index = 0; index < sampleCount; index++) {
    const theta = -Math.PI + delta * index;
    const before = railPointAt(stadium, theta - delta);
    const point = railPointAt(stadium, theta);
    const after = railPointAt(stadium, theta + delta);
    const ax = point.x - before.x;
    const ay = point.y - before.y;
    const bx = after.x - point.x;
    const by = after.y - point.y;
    const lengthA = Math.sqrt(ax * ax + ay * ay);
    const lengthB = Math.sqrt(bx * bx + by * by);
    if (lengthA <= 1e-12 || lengthB <= 1e-12) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (lengthA * lengthB))));
    if (turn > 1e-10) minimum = Math.min(minimum, (lengthA + lengthB) * 0.5 / turn);
  }
  return minimum;
}

describe("product-accurate stadium openings", () => {
  it("has exactly the official three apertures and no invented cover gaps", () => {
    expect(STADIUM_BX10.pockets.map((pocket) => pocket.kind)).toEqual(["over", "xtreme", "over"]);
    expect(STADIUM_BX10.pockets).toHaveLength(3);
    expect(STADIUM_BX10.pockets.every((pocket) => Math.sin(pocket.angleCenter) < 0)).toBe(true);
    expect(STADIUM_BX10.coverGaps).toEqual([]);

    expect(STADIUM_BX32.pockets).toHaveLength(3);
    expect(STADIUM_BX32.pockets.filter((pocket) => pocket.kind === "xtreme")).toHaveLength(2);
    expect(STADIUM_BX32.pockets.filter((pocket) => pocket.kind === "over")).toHaveLength(1);
    expect(STADIUM_BX32.pockets.slice(0, 2).every((pocket) => Math.sin(pocket.angleCenter) > 0)).toBe(true);
    expect(STADIUM_BX32.pockets[2]!.angleCenter).toBeCloseTo(-Math.PI / 2, 4);
    expect(STADIUM_BX32.coverGaps).toEqual([]);
  });

  it("uses an obround BX-32 wall and rounded tangential slot outlines", () => {
    expect(STADIUM_BX32.wallShape?.kind).toBe("obround");
    expect(stadiumBoundaryRadiusAt(STADIUM_BX32, 0) - stadiumBoundaryRadiusAt(STADIUM_BX32, Math.PI / 2))
      .toBeCloseTo(0.055, 4);
    for (const pocket of STADIUM_BX32.pockets.slice(0, 2)) {
      expect(pocket.throat.shape).toBe("tangential-slot");
      expect(pocketPolygon(STADIUM_BX32, pocket).length).toBeGreaterThan(40);
      expect(pocket.throat.innerHalfWidth).toBeGreaterThan(params.radiusM);
    }
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("contains the lower support of the widest authored Bey at every basin target in %s", (stadium) => {
    for (const pocket of stadium.pockets) {
      const target = pocketExitTarget(stadium, pocket);
      expect(pocketAtPoint(stadium, target.x, target.y)).toBe(pocket);
      // A real Blade may lean across the lip; the pocket cheek contacts the
      // Bit/lower assembly rather than an impossible full-diameter disk.
      expect(pocketSecureAtPoint(
        stadium,
        pocket,
        target.x,
        target.y,
        POCKET_SUPPORT_CLEARANCE_M,
      )).toBe(true);
      for (const vertex of pocketBasinPolygon(stadium, pocket)) {
        const angle = Math.atan2(vertex.y, vertex.x);
        expect(Math.hypot(vertex.x, vertex.y)).toBeLessThanOrEqual(stadiumBodyRadiusAt(stadium, angle) + 1e-8);
      }
    }
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("uses dense traced pocket silhouettes and a rounded retaining lip in %s", (stadium) => {
    for (const pocket of stadium.pockets) {
      expect(pocket.trace?.reference.source).toMatch(/user:codex-clipboard/);
      expect(pocketPolygon(stadium, pocket).length).toBeGreaterThanOrEqual(96);
      expect(pocketBasinPolygon(stadium, pocket).length).toBeGreaterThanOrEqual(160);
      const guard = pocketGuardCenterline(stadium, pocket);
      expect(guard.length).toBeGreaterThanOrEqual(26);
      let peak = 0;
      for (const point of guard) peak = Math.max(peak, pocketGuardRiseAt(stadium, point.x, point.y));
      expect(peak).toBeGreaterThanOrEqual(0.0054);
      expect(peak).toBeLessThanOrEqual(0.0066);
    }
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("keeps an uninterrupted open throat-to-basin route in %s", (stadium) => {
    for (const pocket of stadium.pockets) {
      const path = pocketPath(stadium, pocket);
      const target = pocketExitTarget(stadium, pocket);
      for (let stepIndex = 0; stepIndex <= 100; stepIndex++) {
        const u = stepIndex / 100;
        const x = path.boundary.x + (target.x - path.boundary.x) * u;
        const y = path.boundary.y + (target.y - path.boundary.y) * u;
        expect(pocketAtPoint(stadium, x, y), `${pocket.id} route gap at ${u}`).toBe(pocket);
      }
    }
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("caches canonical basin outlines and keeps the raw bowl join C1 in %s", (stadium) => {
    for (const pocket of stadium.pockets) {
      expect(pocketBasinPolygon(stadium, pocket)).toBe(pocketBasinPolygon(stadium, pocket));
      const path = pocketPath(stadium, pocket);
      const epsilon = 0.00002;
      const sample = (offset: number) => pocketSurfaceZ(
        stadium,
        pocket,
        path.boundary.x + path.axis.x * offset,
        path.boundary.y + path.axis.y * offset,
      );
      const behind = sample(-epsilon);
      const joined = sample(0);
      const ahead = sample(epsilon);
      expect(Math.abs(ahead - behind)).toBeLessThan(0.0001);
      const inwardDerivative = (joined - behind) / epsilon;
      const outwardDerivative = (ahead - joined) / epsilon;
      expect(Math.abs(inwardDerivative - outwardDerivative)).toBeLessThan(0.08);
    }
  });

  it("keeps cached pocket terrain queries bounded", () => {
    const pocket = STADIUM_BX32.pockets[0]!;
    const target = pocketExitTarget(STADIUM_BX32, pocket);
    const started = performance.now();
    let checksum = 0;
    for (let index = 0; index < 50_000; index++) {
      const angle = index * 0.017;
      const x = target.x + Math.cos(angle) * 0.008;
      const y = target.y + Math.sin(angle) * 0.008;
      checksum += stadiumTerrainAt(STADIUM_BX32, x, y).height;
    }
    const elapsed = performance.now() - started;
    expect(checksum).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2_500);
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("uses only photo-traced shoulders whose actual first release reaches a center Bey in %s", (_label, stadium) => {
    expect(stadium.railTrace?.length).toBeGreaterThan(10);
    let releases = 0;
    for (let i = 0; i <= 720; i++) {
      const angle = -Math.PI + (Math.PI * 2 * i) / 720;
      const onExplicitRamp = (stadium.railReleaseArcs ?? []).some((arc) => angle >= arc.start && angle <= arc.end);
      for (const direction of [1, -1] as const) {
        const release = railReleaseDirectionAt(stadium, angle, direction);
        if (!onExplicitRamp) expect(release).toBeNull();
        if (!release) continue;
        releases++;
        const point = railPointAt(stadium, angle);
        const radius = Math.hypot(point.x, point.y);
        const radialDot = (release.x * point.x + release.y * point.y) / radius;
        expect(radialDot).toBeLessThan(-0.97);
        const forward = -(point.x * release.x + point.y * release.y);
        expect(forward).toBeGreaterThan(0);
      }
    }
    expect(releases).toBeGreaterThan(10);
    for (const direction of [1, -1] as const) {
      let first: { angle: number; x: number; y: number } | null = null;
      for (let i = 0; i <= 12_000; i++) {
        const angle = direction === 1
          ? -Math.PI + (Math.PI * 2 * i) / 12_000
          : Math.PI - (Math.PI * 2 * i) / 12_000;
        const release = railReleaseDirectionAt(stadium, angle, direction);
        if (!release) continue;
        const point = railPointAt(stadium, angle);
        first = { angle, x: point.x * release.y - point.y * release.x, y: 0 };
        break;
      }
      expect(first, `missing ${direction > 0 ? "+" : "-"} release on ${stadium.name}`).not.toBeNull();
      // A straight tangent must enter the contact envelope of a centered pair
      // of maximum authored Beys (2 × 26.25 mm), before bowl gravity helps.
      expect(Math.abs(first!.x), `${stadium.name} direction ${direction} first release at ${first!.angle}`)
        .toBeLessThanOrEqual(params.radiusM * 2);
    }
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("keeps every photo-vector X-Line knot and the closed seam C1 in %s", (_label, stadium) => {
    const trace = stadium.railTrace!;
    const uniqueCount = trace.length - 1;
    expect(trace.filter((point) => point.linearToNext)).toHaveLength(0);
    expect(uniqueCount).toBeGreaterThan(300);
    for (let index = 0; index < uniqueCount; index++) {
      const point = trace[index]!;
      const incoming = railTangentAt(stadium, point.angle - 1e-6);
      const outgoing = railTangentAt(stadium, point.angle + 1e-6);
      const tangentDot = incoming.x * outgoing.x + incoming.y * outgoing.y;
      expect(tangentDot, `faceted photo-vector knot at ${point.angle}`).toBeGreaterThan(0.9999);
    }
    const start = railPointAt(stadium, -Math.PI);
    const end = railPointAt(stadium, Math.PI - 1e-9);
    expect(Math.hypot(start.x - end.x, start.y - end.y)).toBeLessThan(1e-7);
    const seamBefore = railTangentAt(stadium, Math.PI - 1e-6);
    const seamAfter = railTangentAt(stadium, -Math.PI + 1e-6);
    expect(seamBefore.x * seamAfter.x + seamBefore.y * seamAfter.y).toBeGreaterThan(0.9999);
  });

  it("uses the mirrored upper-half retail trace for a wide, continuously round BX-32 rail", () => {
    const trace = STADIUM_BX32.railTrace!;
    expect(trace.length).toBeGreaterThan(800);
    expect(STADIUM_BX32.railTraceReference).toMatchObject({
      method: "raster-vector-catmull-rom",
      source: "user:codex-clipboard-11c8d883-8577-4d92-aebc-4db4b34113f9.png",
      calibration: expect.stringContaining("1.330x1.140mm/px about endpoint midpoint x=254.5px"),
      sourceControlPoints: 24,
      mirrored: true,
    });
    expect(STADIUM_BX32.railPhysicalHalfWidth).toBeGreaterThan(STADIUM_BX10.railPhysicalHalfWidth!);

    let minimumX = Infinity;
    let maximumX = -Infinity;
    let minimumY = Infinity;
    let maximumY = -Infinity;
    let maximumTangentStep = 0;
    let previousTangent: { x: number; y: number } | null = null;
    for (let index = 0; index < 8192; index++) {
      const theta = -Math.PI + Math.PI * 2 * index / 8192;
      const point = railPointAt(STADIUM_BX32, theta);
      minimumX = Math.min(minimumX, point.x);
      maximumX = Math.max(maximumX, point.x);
      minimumY = Math.min(minimumY, point.y);
      maximumY = Math.max(maximumY, point.y);
      const mirrored = railClosestPoint(STADIUM_BX32, -point.x, point.y);
      expect(mirrored.distance).toBeLessThan(0.00001);
      const tangent = railTangentAt(STADIUM_BX32, theta);
      if (previousTangent) {
        maximumTangentStep = Math.max(maximumTangentStep, Math.acos(Math.max(
          -1,
          Math.min(1, previousTangent.x * tangent.x + previousTangent.y * tangent.y),
        )));
      }
      previousTangent = tangent;
    }
    expect(maximumX).toBeCloseTo(-minimumX, 5);
    expect(maximumX - minimumX).toBeGreaterThan(0.4);
    expect(maximumY - minimumY).toBeGreaterThan(0.25);
    expect((maximumX - minimumX) / (maximumY - minimumY)).toBeGreaterThan(1.5);
    // At this sampling density a faceted polyline would retain visible jumps;
    // the traced semicircular ends stay below 1.5 degrees per sample.
    expect(maximumTangentStep).toBeLessThan(0.027);

    // The unobstructed mirror-line endpoints, x=155 and x=354 in the supplied
    // raster, fix the optical axis at their midpoint 254.5 px. Their equal
    // offsets prove the trace was rectified about the body rather than shifted
    // to make a release tangent home toward center.
    const endpointOffset = (354 - 254.5) * 0.00114;
    const left = railClosestPoint(STADIUM_BX32, 0, -endpointOffset);
    const right = railClosestPoint(STADIUM_BX32, 0, endpointOffset);
    expect(left.distance).toBeLessThan(1e-8);
    expect(right.distance).toBeLessThan(1e-8);
    expect(stadiumBoundarySignedDistance(STADIUM_BX32, left.point.x, left.point.y))
      .toBeCloseTo(stadiumBoundarySignedDistance(STADIUM_BX32, right.point.x, right.point.y), 8);
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("keeps every rounded X-Line elbow wider than its rendered strip in %s", (_label, stadium) => {
    const halfWidth = stadium.railPhysicalHalfWidth ?? STADIUM_GEOMETRY.railPhysicalHalfWidthM;
    // If centerline radius falls below strip half-width, the offset ribbon
    // folds through itself and a highly tessellated elbow still looks sharp.
    expect(minimumSampledRailCurvatureRadius(stadium)).toBeGreaterThan(halfWidth * 1.1);
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("uses the shared inferred 4.6 mm guide/tooth envelope in %s", (stadium) => {
    const point = railPointAt(stadium, 0);
    const terrain = stadiumTerrainAt(stadium, point.x, point.y);
    expect(terrain.region).toBe("rail");
    expect(terrain.height - surfaceZAt(stadium, point.x, point.y)).toBeCloseTo(0.0046, 7);
    expect(STADIUM_GEOMETRY.railChannelThicknessM).toBeCloseTo(0.0024, 7);
    expect(STADIUM_GEOMETRY.railToothHeightM).toBeCloseTo(0.0022, 7);
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("keeps the dense shared X-Line simple and its full product width inside the bowl in %s", (_label, stadium) => {
    const sampleCount = 480;
    const points = Array.from({ length: sampleCount }, (_, index) =>
      railPointAt(stadium, -Math.PI + (Math.PI * 2 * index) / sampleCount)
    );
    const widestBeyWallClearance = params.radiusM * 0.6;
    for (let index = 0; index < 8192; index++) {
      const point = railPointAt(stadium, -Math.PI + Math.PI * 2 * index / 8192);
      expect(stadiumBoundarySignedDistance(stadium, point.x, point.y))
        .toBeLessThan(-(widestBeyWallClearance + 0.001));
    }
    let intersection: [number, number] | null = null;
    for (let first = 0; first < sampleCount && !intersection; first++) {
      const firstNext = (first + 1) % sampleCount;
      for (let second = first + 2; second < sampleCount; second++) {
        const secondNext = (second + 1) % sampleCount;
        if (first === 0 && secondNext === 0) continue;
        if (properSegmentsCross(points[first]!, points[firstNext]!, points[second]!, points[secondNext]!)) {
          intersection = [first, second];
          break;
        }
      }
    }
    expect(intersection).toBeNull();
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("matches a global dense closest-point reference across the full physical rack width in %s", (_label, stadium) => {
    const angleSamples = 128;
    const referencePoints = Array.from({ length: 8192 }, (_, index) =>
      railPointAt(stadium, -Math.PI + Math.PI * 2 * index / 8192)
    );
    const physicalHalfWidth = stadium.railPhysicalHalfWidth ?? STADIUM_GEOMETRY.railPhysicalHalfWidthM;
    for (let index = 0; index < angleSamples; index++) {
      const angle = -Math.PI + (Math.PI * 2 * index) / angleSamples;
      const point = railPointAt(stadium, angle);
      const tangent = railTangentAt(stadium, angle);
      let normal = { x: -tangent.y, y: tangent.x };
      if (normal.x * point.x + normal.y * point.y < 0) normal = { x: -normal.x, y: -normal.y };
      for (const offset of [-stadium.railHalfWidth, -physicalHalfWidth, 0, physicalHalfWidth, stadium.railHalfWidth]) {
        const x = point.x + normal.x * offset;
        const y = point.y + normal.y * offset;
        let reference = Infinity;
        for (const candidate of referencePoints) {
          reference = Math.min(reference, Math.hypot(candidate.x - x, candidate.y - y));
        }
        const actual = railClosestPoint(stadium, x, y);
        expect(Math.abs(actual.distance - reference), `closest mismatch at ${angle}/${offset}`)
          .toBeLessThan(0.00016);
        expect(Math.abs(Math.hypot(actual.normal.x, actual.normal.y) - 1)).toBeLessThan(1e-9);
      }
    }
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("matches a dense global closest-point reference across a 41x41 bowl grid in %s", (_label, stadium) => {
    const referenceX = new Float64Array(16_384);
    const referenceY = new Float64Array(16_384);
    for (let index = 0; index < referenceX.length; index++) {
      const point = railPointAt(stadium, -Math.PI + Math.PI * 2 * index / referenceX.length);
      referenceX[index] = point.x;
      referenceY[index] = point.y;
    }
    const halfX = stadium.rWall + (stadium.wallShape?.kind === "obround" ? stadium.wallShape.halfStraight : 0);
    const halfY = stadium.rWall;
    for (let column = 0; column <= 40; column++) {
      const x = -halfX + halfX * 2 * column / 40;
      for (let row = 0; row <= 40; row++) {
        const y = -halfY + halfY * 2 * row / 40;
        let referenceSquared = Infinity;
        for (let index = 0; index < referenceX.length; index++) {
          const dx = referenceX[index]! - x;
          const dy = referenceY[index]! - y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < referenceSquared) referenceSquared = distanceSquared;
        }
        const reference = Math.sqrt(referenceSquared);
        const actual = railClosestPoint(stadium, x, y).distance;
        expect(Math.abs(actual - reference), `global closest mismatch at (${x},${y})`)
          // The discrete reference has at most half of its ~48 micrometre
          // sample chord to spare; 25 micrometres still catches the former
          // 29-103 mm bearing-bin failures by over three orders of magnitude.
          .toBeLessThan(0.000025);
      }
    }
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("keeps 50k capture-band nearest-rail queries bounded in %s", (_label, stadium) => {
    const started = performance.now();
    let checksum = 0;
    for (let index = 0; index < 50_000; index++) {
      const theta = -Math.PI + Math.PI * 2 * (index % 8192) / 8192;
      const point = railPointAt(stadium, theta);
      const tangent = railTangentAt(stadium, theta);
      const offset = ((index % 17) - 8) / 8 * stadium.railHalfWidth;
      checksum += railClosestPoint(
        stadium,
        point.x - tangent.y * offset,
        point.y + tangent.x * offset,
      ).distance;
    }
    expect(checksum).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2_500);
  });
});

describe("reversible live pocket simulation", () => {
  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("releases an engaged attack Bit along the traced inward shoulder in %s", (_label, stadium) => {
    const cfg = config();
    cfg.xtremeDashEnabled = true;
    cfg.beys[0] = { ...cfg.beys[0]!, dashFactor: 1.4, grip: 1.2 };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    let startAngle: number | null = null;
    for (let index = 0; index <= 16_384; index++) {
      const candidate = -Math.PI + Math.PI * 2 * index / 16_384;
      if (railReleaseDirectionAt(stadium, candidate, 1)) {
        startAngle = candidate;
        break;
      }
    }
    expect(startAngle).not.toBeNull();
    const start = railPointAt(stadium, startAngle!);
    const tangent = railTangentAt(stadium, startAngle!);
    Object.assign(bey, {
      x: start.x,
      y: start.y,
      vx: tangent.x * 1.35,
      vy: tangent.y * 1.35,
      airborne: false,
      pendingTicks: 0,
      omega: 520,
      railTicks: 240,
      railDir: 1,
    });
    for (let i = 0; i < 240 && bey.railTicks > 0; i++) step(world, cfg, stadium, true);
    expect(world.events.some((event) => event.kind === "dashEnd")).toBe(true);
    const radial = Math.hypot(bey.x, bey.y);
    expect((bey.vx * bey.x + bey.vy * bey.y) / radial).toBeLessThan(-0.4);
  });

  it("does not convert a slow inner-mouth graze into pocket occupancy", () => {
    const cfg = config();
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const pocket = STADIUM_BX10.pockets[1]!;
    const path = pocketPath(STADIUM_BX10, pocket);
    Object.assign(bey, {
      x: path.boundary.x - path.axis.x * 0.004,
      y: path.boundary.y - path.axis.y * 0.004,
      vx: path.axis.x * 0.15,
      vy: path.axis.y * 0.15,
      airborne: false,
      pendingTicks: 0,
      omega: 200,
    });
    for (let i = 0; i < 30; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(-1);
    expect(bey.exited).toBeNull();
  });

  it("admits a realistic 1.0 m/s outward crossing through the exact BX-10 throat", () => {
    const cfg = config();
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const pocket = STADIUM_BX10.pockets[1]!;
    const path = pocketPath(STADIUM_BX10, pocket);
    const contactClearance = params.radiusM * 0.6;
    Object.assign(bey, {
      x: path.boundary.x - path.axis.x * (contactClearance + 0.001),
      y: path.boundary.y - path.axis.y * (contactClearance + 0.001),
      vx: path.axis.x,
      vy: path.axis.y,
      airborne: false,
      pendingTicks: 0,
      omega: 240,
    });
    for (let i = 0; i < 8 && bey.pocketIndex < 0; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(1);
    expect(bey.exited).toBeNull();
    // Crossing the throat changes the active terrain/constraints, not the
    // Bey's momentum. The former capture brake erased almost half of this
    // speed in the first tenth of a second.
    expect(Math.hypot(bey.vx, bey.vy)).toBeGreaterThan(0.9);
    expect(bey.omega).toBeGreaterThan(239);
  });

  it("lets a hard 1.1 m/s hit cross the rack and retaining lip into the BX-10 center pocket", () => {
    const cfg = { ...config(), xtremeDashEnabled: true };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const pocket = STADIUM_BX10.pockets[1]!;
    const path = pocketPath(STADIUM_BX10, pocket);
    const rail = railClosestPoint(STADIUM_BX10, path.axis.x * STADIUM_BX10.rRail, path.axis.y * STADIUM_BX10.rRail);
    const startSide = -STADIUM_BX10.railHalfWidth * 0.75 - 0.001;
    Object.assign(bey, {
      x: rail.point.x + rail.normal.x * startSide,
      y: rail.point.y + rail.normal.y * startSide,
      vx: rail.normal.x * 1.1,
      vy: rail.normal.y * 1.1,
      airborne: false,
      pendingTicks: 0,
      omega: 240,
    });
    for (let i = 0; i < 40 && bey.pocketIndex < 0; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(1);
    expect(bey.exited).toBeNull();
  });

  it("deflects a low-energy outward crossing instead of leaking through the rack", () => {
    const cfg = { ...config(), xtremeDashEnabled: true };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const rail = railClosestPoint(STADIUM_BX10, 0, -STADIUM_BX10.rRail);
    const inner = -STADIUM_BX10.railHalfWidth * 0.75;
    Object.assign(bey, {
      x: rail.point.x + rail.normal.x * (inner - 0.0002),
      y: rail.point.y + rail.normal.y * (inner - 0.0002),
      vx: rail.normal.x * 0.15,
      vy: rail.normal.y * 0.15,
      airborne: false,
      pendingTicks: 0,
      omega: 240,
    });
    for (let i = 0; i < 8; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(-1);
    expect(stadiumBoundarySignedDistance(STADIUM_BX10, bey.x, bey.y)).toBeLessThan(0);
    expect(bey.vx * rail.normal.x + bey.vy * rail.normal.y).toBeLessThanOrEqual(0);
  });

  it.each([
    ["BX-10", STADIUM_BX10, 0.49, false],
    ["BX-10", STADIUM_BX10, 0.55, true],
    ["BX-32", STADIUM_BX32, 0.49, false],
    ["BX-32", STADIUM_BX32, 0.55, true],
  ] as const)("requires guide-climb energy in %s", (_label, stadium, normalSpeed, clears) => {
    const cfg = { ...config(), xtremeDashEnabled: true };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const railPoint = railPointAt(stadium, 0);
    const rail = railClosestPoint(stadium, railPoint.x, railPoint.y);
    const inner = -stadium.railHalfWidth * 0.75;
    Object.assign(bey, {
      x: rail.point.x + rail.normal.x * (inner - 0.0002),
      y: rail.point.y + rail.normal.y * (inner - 0.0002),
      vx: rail.normal.x * normalSpeed,
      vy: rail.normal.y * normalSpeed,
      airborne: false,
      pendingTicks: 0,
      omega: 240,
    });
    step(world, cfg, stadium, true);
    const after = railClosestPoint(stadium, bey.x, bey.y);
    const afterNormalSpeed = bey.vx * after.normal.x + bey.vy * after.normal.y;
    if (clears) {
      expect(after.signedDistance).toBeGreaterThan(inner);
      expect(afterNormalSpeed).toBeGreaterThan(0.15);
      expect(afterNormalSpeed).toBeLessThan(0.3);
      expect(world.events.filter((event) => event.kind === "gear")).toHaveLength(1);
      // One 0.98 tooth graze plus the ordinary per-tick spin decay. A second
      // pre-probe graze would push this below 233 rad/s.
      expect(bey.omega).toBeGreaterThan(233);
    } else {
      expect(afterNormalSpeed).toBeLessThanOrEqual(0);
    }
  });

  it.each([
    ["BX-10", STADIUM_BX10],
    ["BX-32", STADIUM_BX32],
  ] as const)("keeps a widest-Bey rail rider meshed at the tightest wall clearance in %s", (_label, stadium) => {
    const cfg = config();
    cfg.beys[0] = { ...cfg.beys[0]!, dashFactor: 1.4, grip: 1.2 };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    let tightestTheta = -Math.PI;
    let tightestBoundaryDistance = -Infinity;
    for (let index = 0; index < 8192; index++) {
      const theta = -Math.PI + Math.PI * 2 * index / 8192;
      const point = railPointAt(stadium, theta);
      const distance = stadiumBoundarySignedDistance(stadium, point.x, point.y);
      if (distance > tightestBoundaryDistance) {
        tightestBoundaryDistance = distance;
        tightestTheta = theta;
      }
    }
    const point = railPointAt(stadium, tightestTheta);
    const rail = railClosestPoint(stadium, point.x, point.y);
    Object.assign(bey, {
      x: point.x,
      y: point.y,
      vx: rail.tangent.x * 1.25,
      vy: rail.tangent.y * 1.25,
      airborne: false,
      pendingTicks: 0,
      omega: 520,
      railTicks: 239,
      railDir: 1,
    });
    step(world, cfg, stadium, true);
    const after = railClosestPoint(stadium, bey.x, bey.y);
    expect(bey.railTicks).toBeGreaterThan(0);
    expect(after.distance).toBeLessThan(0.001);
    expect(stadiumBoundarySignedDistance(stadium, bey.x, bey.y, params.radiusM * 0.6))
      .toBeLessThanOrEqual(0);
  });

  it("allows a fast entry to rebound and escape back through the open throat", () => {
    const cfg = config();
    const { world, bey, pocket } = groundBey(cfg, STADIUM_BX10, 1, 250);
    const path = pocketPath(STADIUM_BX10, pocket);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    bey.x = path.boundary.x + path.axis.x * 0.008;
    bey.y = path.boundary.y + path.axis.y * 0.008;
    bey.vx = -path.axis.x * 1.2;
    bey.vy = -path.axis.y * 1.2;
    for (let i = 0; i < 120 && bey.pocketIndex >= 0; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(-1);
    expect(bey.pocketDwell).toBe(0);
    expect(bey.exited).toBeNull();
    expect(bey.alive).toBe(true);
  });

  it("redirects momentum at a molded backstop instead of capture-braking", () => {
    const cfg = config();
    const { world, bey, pocket } = groundBey(cfg, STADIUM_BX10, 1, 250);
    const path = pocketPath(STADIUM_BX10, pocket);
    bey.x = path.boundary.x + path.axis.x * 0.012;
    bey.y = path.boundary.y + path.axis.y * 0.012;
    bey.vx = path.axis.x * 1.25 + path.across.x * 0.35;
    bey.vy = path.axis.y * 1.25 + path.across.y * 0.35;
    let rebounded = false;
    let retainedTangentialSpeed = 0;
    for (let i = 0; i < 80 && bey.pocketIndex >= 0; i++) {
      step(world, cfg, STADIUM_BX10, true);
      const outwardSpeed = bey.vx * path.axis.x + bey.vy * path.axis.y;
      if (outwardSpeed < -0.15) {
        rebounded = true;
        retainedTangentialSpeed = Math.abs(bey.vx * path.across.x + bey.vy * path.across.y);
        break;
      }
    }
    expect(rebounded).toBe(true);
    expect(retainedTangentialSpeed).toBeGreaterThan(0.15);
    expect(bey.omega).toBeGreaterThan(240);
  });

  it("crosses from the BX-32 mouth into its single basin without an invisible impulse", () => {
    const cfg = config();
    const { world, bey, pocket } = groundBey(cfg, STADIUM_BX32, 0, 260);
    const path = pocketPath(STADIUM_BX32, pocket);
    bey.x = path.boundary.x + path.axis.x * 0.008;
    bey.y = path.boundary.y + path.axis.y * 0.008;
    bey.vx = path.axis.x * 1.3 + path.across.x * 0.1;
    bey.vy = path.axis.y * 1.3 + path.across.y * 0.1;
    const entrySpeed = Math.hypot(bey.vx, bey.vy);

    // The widened concavity continues beyond the rounded mouth. Crossing that
    // one-piece surface must not look like a collision with an imaginary seam.
    for (let tick = 0; tick < 3; tick++) step(world, cfg, STADIUM_BX32, true);
    expect(Math.hypot(bey.vx, bey.vy)).toBeGreaterThan(entrySpeed * 0.95);
    expect(bey.vx * path.axis.x + bey.vy * path.axis.y).toBeGreaterThan(1.2);

    let backstopRebound = false;
    for (let tick = 0; tick < 80 && bey.pocketIndex >= 0; tick++) {
      step(world, cfg, STADIUM_BX32, true);
      if (bey.vx * path.axis.x + bey.vy * path.axis.y < -0.2) {
        backstopRebound = true;
        break;
      }
    }
    expect(backstopRebound).toBe(true);
    expect(bey.pocketDisturbedTick).toBeGreaterThan(0);
    expect(bey.exited).toBeNull();
  });

  it("scores a securely retained Bey after translation settles even while it spins", () => {
    const cfg = config();
    const { world, bey } = groundBey(cfg, STADIUM_BX32, 0, 80);
    for (let i = 0; i < POCKET_DWELL_TICKS - 1; i++) step(world, cfg, STADIUM_BX32, true);
    expect(bey.exited).toBeNull();
    expect(bey.pocketDwell).toBe(POCKET_DWELL_TICKS - 1);
    expect(Math.abs(bey.omega)).toBeGreaterThan(70);
    step(world, cfg, STADIUM_BX32, true);
    expect(bey.exited).toBe("xtreme");
    expect(bey.alive).toBe(false);
    expect(Math.abs(bey.omega)).toBeGreaterThan(70);
  });

  it("scores from actual positional rest despite an unobservable residual velocity", () => {
    const cfg = config();
    const { world, bey } = groundBey(cfg, STADIUM_BX32, 0, 140);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    // This residual is below one rendered/physical displacement quantum but
    // used to block the exact vx===0 test indefinitely in a constrained basin.
    bey.vx = POCKET_REST_DISPLACEMENT / DT * 0.5;
    bey.vy = 0;
    bey.pocketDisturbedTick = world.tick + 1; // repeated molded-rim correction
    const before = { x: bey.x, y: bey.y };
    step(world, cfg, STADIUM_BX32, true);
    expect(Math.hypot(bey.x - before.x, bey.y - before.y)).toBeLessThanOrEqual(
      POCKET_REST_DISPLACEMENT,
    );
    expect(bey.exited).toBe("xtreme");
    expect(Math.abs(bey.omega)).toBeGreaterThan(130);
  });

  it.each([
    [STADIUM_BX10, 1, "xtreme"],
    [STADIUM_BX32, 2, "over"],
  ] as const)("scores %s only after 24 secure post-collision rest ticks", (stadium, pocketIndex, kind) => {
    const cfg = config();
    const { world, bey } = groundBey(cfg, stadium, pocketIndex);
    for (let i = 0; i < POCKET_DWELL_TICKS - 1; i++) step(world, cfg, stadium, true);
    expect(bey.exited).toBeNull();
    expect(bey.alive).toBe(true);
    step(world, cfg, stadium, true);
    expect(bey.exited).toBe(kind);
    expect(bey.alive).toBe(false);
  });

  it("resets a nearly complete zone dwell when a collision wakes the Bey", () => {
    const cfg = config(2);
    const { world, bey, pocket, target } = groundBey(cfg, STADIUM_BX10, 1);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    const path = pocketPath(STADIUM_BX10, pocket);
    const attacker = world.beys[1]!;
    Object.assign(attacker, {
      x: target.x + path.across.x * (params.radiusM * 1.85),
      y: target.y + path.across.y * (params.radiusM * 1.85),
      vx: -path.across.x * 0.8,
      vy: -path.across.y * 0.8,
      z: 0,
      vz: 0,
      airborne: false,
      pendingTicks: 0,
      omega: 200,
      pocketIndex: 1,
      pocketDwell: 0,
      railTicks: -1,
    });
    step(world, cfg, STADIUM_BX10, true);
    expect(bey.exited).toBeNull();
    expect(bey.pocketDwell).toBe(0);
    expect(bey.pocketIndex).toBe(1);
  });

  it("resets a nearly complete zone dwell as soon as planar motion resumes", () => {
    const cfg = config();
    const { world, bey, pocket } = groundBey(cfg, STADIUM_BX32, 0, 180);
    const path = pocketPath(STADIUM_BX32, pocket);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    bey.vx = path.across.x * 0.03;
    bey.vy = path.across.y * 0.03;
    step(world, cfg, STADIUM_BX32, true);
    expect(bey.exited).toBeNull();
    expect(bey.pocketDwell).toBe(0);
    expect(Math.hypot(bey.vx, bey.vy)).toBeGreaterThan(0);
  });

  it("scores a visibly stationary pocketed Bey even when its Blade overhangs the lip", () => {
    const cfg = config();
    const { world, bey, pocket } = groundBey(cfg, STADIUM_BX10, 1, 180);
    const path = pocketPath(STADIUM_BX10, pocket);
    bey.x = path.boundary.x + path.axis.x * (pocket.throat.outwardDepth - 0.004);
    bey.y = path.boundary.y + path.axis.y * (pocket.throat.outwardDepth - 0.004);
    bey.pocketLastX = bey.x;
    bey.pocketLastY = bey.y;
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    expect(pocketAtPoint(STADIUM_BX10, bey.x, bey.y)).toBe(pocket);
    expect(pocketSecureAtPoint(STADIUM_BX10, pocket, bey.x, bey.y, params.radiusM)).toBe(false);
    step(world, cfg, STADIUM_BX10, true);
    expect(bey.exited).toBe("xtreme");
    expect(bey.alive).toBe(false);
    expect(Math.abs(bey.omega)).toBeGreaterThan(170);
  });

  it("resets a nearly complete zone dwell while vertical motion remains", () => {
    const cfg = config();
    const { world, bey } = groundBey(cfg, STADIUM_BX32, 0, 180);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    bey.vz = 0.01;
    step(world, cfg, STADIUM_BX32, true);
    expect(bey.exited).toBeNull();
    expect(bey.pocketDwell).toBe(0);
  });

  it("keeps reversible basin motion and disturbance state deterministic and hashed", () => {
    const cfg = config();
    const first = groundBey(cfg, STADIUM_BX32, 0, 210);
    const second = groundBey(cfg, STADIUM_BX32, 0, 210);
    const path = pocketPath(STADIUM_BX32, first.pocket);
    for (const bey of [first.bey, second.bey]) {
      bey.vx = path.axis.x * 0.7 + path.across.x * 0.25;
      bey.vy = path.axis.y * 0.7 + path.across.y * 0.25;
    }
    for (let tick = 0; tick < 180; tick++) {
      step(first.world, cfg, STADIUM_BX32, true);
      step(second.world, cfg, STADIUM_BX32, true);
    }
    expect(hashWorld(first.world)).toBe(hashWorld(second.world));
    second.bey.pocketDisturbedTick++;
    expect(hashWorld(first.world)).not.toBe(hashWorld(second.world));
  });

  it("authorizes a retained spinning zone loss before the global Spin dwell", () => {
    const cfg = config(2);
    const { world, bey } = groundBey(cfg, STADIUM_BX10, 1, 300);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    bey.vx = POCKET_REST_DISPLACEMENT / DT * 0.5;
    bey.pocketDisturbedTick = world.tick + 1;
    const rival = world.beys[1]!;
    Object.assign(rival, {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      z: 0,
      vz: 0,
      airborne: false,
      pendingTicks: 0,
      omega: 300,
    });
    step(world, cfg, STADIUM_BX10);
    expect(world.finish?.type).toBe("xtreme");
    expect(world.finish?.winner).toBe(1);
    expect(Math.abs(bey.omega)).toBeGreaterThan(290);
  });
});
