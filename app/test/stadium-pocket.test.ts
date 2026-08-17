import { describe, expect, it } from "vitest";

import {
  pocketAtPoint,
  pocketCatchPolygon,
  pocketExitTarget,
  pocketPath,
  pocketPolygon,
  pocketSecureAtPoint,
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
  hashWorld,
  POCKET_DWELL_TICKS,
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

  it.each([STADIUM_BX10, STADIUM_BX32])("securely contains the widest authored Bey at every tray target in %s", (stadium) => {
    for (const pocket of stadium.pockets) {
      const target = pocketExitTarget(stadium, pocket);
      expect(pocketAtPoint(stadium, target.x, target.y)).toBe(pocket);
      expect(pocketSecureAtPoint(stadium, pocket, target.x, target.y, params.radiusM)).toBe(true);
      for (const vertex of pocketCatchPolygon(stadium, pocket)) {
        const angle = Math.atan2(vertex.y, vertex.x);
        expect(Math.hypot(vertex.x, vertex.y)).toBeLessThanOrEqual(stadiumBodyRadiusAt(stadium, angle) + 1e-8);
      }
    }
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("keeps an uninterrupted open throat-to-catch route in %s", (stadium) => {
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

  it.each([STADIUM_BX10, STADIUM_BX32])("uses only explicit traced ramps whose actual first release reaches a center Bey in %s", (stadium) => {
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
        expect(radialDot).toBeLessThan(-0.7);
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

  it.each([STADIUM_BX10, STADIUM_BX32])("smooths ordinary X-Line knots but preserves only the authored sharp release jogs in %s", (stadium) => {
    const trace = stadium.railTrace!;
    const uniqueCount = trace.length - 1;
    expect(trace.filter((point) => point.linearToNext)).toHaveLength(2);
    expect(trace.filter((point) => point.linearToNext).map((point) => point.angle)).toEqual(
      stadium.railReleaseArcs!.map((arc) => arc.start),
    );
    let sharpKnots = 0;
    for (let index = 0; index < uniqueCount; index++) {
      const point = trace[index]!;
      const previous = trace[(index + uniqueCount - 1) % uniqueCount]!;
      const sharp = Boolean(point.linearToNext || previous.linearToNext);
      const incoming = railTangentAt(stadium, point.angle - 1e-6);
      const outgoing = railTangentAt(stadium, point.angle + 1e-6);
      const tangentDot = incoming.x * outgoing.x + incoming.y * outgoing.y;
      if (sharp) {
        sharpKnots++;
        expect(tangentDot, `rounded authored jog at ${point.angle}`).toBeLessThan(0.9);
      } else {
        expect(tangentDot, `faceted ordinary knot at ${point.angle}`).toBeGreaterThan(0.9999);
      }
    }
    expect(sharpKnots).toBe(4);
    const start = railPointAt(stadium, -Math.PI);
    const end = railPointAt(stadium, Math.PI - 1e-9);
    expect(Math.hypot(start.x - end.x, start.y - end.y)).toBeLessThan(1e-7);
    const seamBefore = railTangentAt(stadium, Math.PI - 1e-6);
    const seamAfter = railTangentAt(stadium, -Math.PI + 1e-6);
    expect(seamBefore.x * seamAfter.x + seamBefore.y * seamAfter.y).toBeGreaterThan(0.9999);
  });

  it("uses two densely traced genuine round side lobes on BX-32", () => {
    expect(STADIUM_BX32.railRoundSides).toHaveLength(2);
    expect(STADIUM_BX32.railTrace!.length).toBeGreaterThan(250);
    for (const side of STADIUM_BX32.railRoundSides!) {
      expect(side.controlSamples).toBeGreaterThanOrEqual(128);
      expect(Math.abs(side.sweepRadians - Math.PI)).toBeLessThan(0.08);
      expect(side.radius).toBeGreaterThan(0.14);
      const span = side.end > side.start
        ? side.end - side.start
        : side.end + Math.PI * 2 - side.start;
      let maximumRadiusError = 0;
      let maximumTangentStep = 0;
      let maximumTangentStepAngle = side.start;
      let previousTangent: { x: number; y: number } | null = null;
      for (let index = 0; index < 512; index++) {
        // Half-step samples exclude the intentionally sharp release boundary.
        const theta = side.start + span * (index + 0.5) / 512;
        const point = railPointAt(STADIUM_BX32, theta);
        maximumRadiusError = Math.max(
          maximumRadiusError,
          Math.abs(Math.hypot(point.x - side.centerX, point.y - side.centerY) - side.radius),
        );
        const tangent = railTangentAt(STADIUM_BX32, theta);
        if (previousTangent) {
          const tangentStep = Math.acos(
            Math.max(-1, Math.min(1, previousTangent.x * tangent.x + previousTangent.y * tangent.y)),
          );
          if (tangentStep > maximumTangentStep) {
            maximumTangentStep = tangentStep;
            maximumTangentStepAngle = theta;
          }
        }
        previousTangent = tangent;
      }
      expect(maximumRadiusError, `${side.id} departed from its fitted circle`).toBeLessThan(0.0002);
      expect(maximumTangentStep, `${side.id} contains a faceted tangent join near ${maximumTangentStepAngle}`)
        .toBeLessThan(0.02);
    }
    const frontPoint = railPointAt(STADIUM_BX32, -Math.PI / 2);
    expect(Math.abs(frontPoint.x)).toBeLessThan(0.0002);
    expect(frontPoint.y).toBeLessThan(-0.145);
    const frontBefore = railTangentAt(STADIUM_BX32, -Math.PI / 2 - 0.0001);
    const frontAfter = railTangentAt(STADIUM_BX32, -Math.PI / 2 + 0.0001);
    expect(frontBefore.x * frontAfter.x + frontBefore.y * frontAfter.y).toBeGreaterThan(0.99999);
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("uses the shared inferred 4.6 mm guide/tooth envelope in %s", (stadium) => {
    const point = railPointAt(stadium, 0);
    const terrain = stadiumTerrainAt(stadium, point.x, point.y);
    expect(terrain.region).toBe("rail");
    expect(terrain.height - surfaceZAt(stadium, point.x, point.y)).toBeCloseTo(0.0046, 7);
    expect(STADIUM_GEOMETRY.railChannelThicknessM).toBeCloseTo(0.0024, 7);
    expect(STADIUM_GEOMETRY.railToothHeightM).toBeCloseTo(0.0022, 7);
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("keeps the dense shared X-Line simple, inside the bowl, and clear of pocket apertures in %s", (stadium) => {
    const sampleCount = 480;
    const points = Array.from({ length: sampleCount }, (_, index) =>
      railPointAt(stadium, -Math.PI + (Math.PI * 2 * index) / sampleCount)
    );
    for (const point of points) {
      expect(stadiumBoundarySignedDistance(stadium, point.x, point.y))
        .toBeLessThan(-STADIUM_GEOMETRY.railPhysicalHalfWidthM);
      expect(pocketAtPoint(stadium, point.x, point.y)).toBeNull();
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

  it.each([STADIUM_BX10, STADIUM_BX32])("matches a dense closest-point reference across the full physical rack width in %s", (stadium) => {
    const angleSamples = 72;
    for (let index = 0; index < angleSamples; index++) {
      const angle = -Math.PI + (Math.PI * 2 * index) / angleSamples;
      const point = railPointAt(stadium, angle);
      const tangent = railTangentAt(stadium, angle);
      let normal = { x: -tangent.y, y: tangent.x };
      if (normal.x * point.x + normal.y * point.y < 0) normal = { x: -normal.x, y: -normal.y };
      for (const offset of [-stadium.railHalfWidth, 0, stadium.railHalfWidth]) {
        const x = point.x + normal.x * offset;
        const y = point.y + normal.y * offset;
        let reference = Infinity;
        for (let stepIndex = -240; stepIndex <= 240; stepIndex++) {
          const candidate = railPointAt(stadium, angle + stepIndex * 0.000625);
          reference = Math.min(reference, Math.hypot(candidate.x - x, candidate.y - y));
        }
        const actual = railClosestPoint(stadium, x, y);
        expect(Math.abs(actual.distance - reference), `closest mismatch at ${angle}/${offset}`)
          .toBeLessThan(0.0002);
        expect(Math.abs(Math.hypot(actual.normal.x, actual.normal.y) - 1)).toBeLessThan(1e-9);
      }
    }
  });
});

describe("reversible live pocket simulation", () => {
  it.each([STADIUM_BX10, STADIUM_BX32])("releases an engaged attack Bit along the traced inward ramp in %s", (stadium) => {
    const cfg = config();
    cfg.xtremeDashEnabled = true;
    cfg.beys[0] = { ...cfg.beys[0]!, dashFactor: 1.4, grip: 1.2 };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const startAngle = stadium.railReleaseArcs![0]!.start - 0.2;
    const start = railPointAt(stadium, startAngle);
    const next = railPointAt(stadium, startAngle + 0.001);
    const length = Math.hypot(next.x - start.x, next.y - start.y);
    const tangent = { x: (next.x - start.x) / length, y: (next.y - start.y) / length };
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

  it("lets a realistic hit cross the low rack and continue into the BX-10 center throat", () => {
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
      vx: rail.normal.x * 0.9,
      vy: rail.normal.y * 0.9,
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
    const rail = railClosestPoint(stadium, 0, -stadium.rRail);
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

  it("crosses the BX-32 throat/catch overlap seam without an invisible impulse", () => {
    const cfg = config();
    const { world, bey, pocket } = groundBey(cfg, STADIUM_BX32, 0, 260);
    const path = pocketPath(STADIUM_BX32, pocket);
    bey.x = path.boundary.x + path.axis.x * 0.008;
    bey.y = path.boundary.y + path.axis.y * 0.008;
    bey.vx = path.axis.x * 1.3 + path.across.x * 0.1;
    bey.vy = path.axis.y * 1.3 + path.across.y * 0.1;
    const entrySpeed = Math.hypot(bey.vx, bey.vy);

    // The expanded catch begins 10.1 mm beyond the wall and overlaps the
    // rounded throat. Crossing that internal union seam must not look like a
    // collision with an imaginary narrow-slot edge.
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

  it("does not score while only the center, not the whole footprint, is retained", () => {
    const cfg = config();
    const { world, bey, pocket } = groundBey(cfg, STADIUM_BX10, 1, 180);
    const path = pocketPath(STADIUM_BX10, pocket);
    bey.x = path.boundary.x + path.axis.x * (pocket.throat.outwardDepth - 0.004);
    bey.y = path.boundary.y + path.axis.y * (pocket.throat.outwardDepth - 0.004);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    expect(pocketAtPoint(STADIUM_BX10, bey.x, bey.y)).toBe(pocket);
    expect(pocketSecureAtPoint(STADIUM_BX10, pocket, bey.x, bey.y, params.radiusM)).toBe(false);
    step(world, cfg, STADIUM_BX10, true);
    expect(bey.exited).toBeNull();
    expect(bey.pocketDwell).toBe(0);
    expect(bey.pocketDisturbedTick).toBe(world.tick);
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

  it("keeps reversible tray motion and disturbance state deterministic and hashed", () => {
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
