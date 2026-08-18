// Progressive Ratchet Burst presentation. This visualizes the seated lower
// assembly slipping through its internal lock detents; it never decides
// whether a Bey bursts and it never adds fictional cracks or stress effects.

import * as THREE from "three";

import type { ResolvedCombo } from "../core/derive";
import {
  pocketAtPoint,
  pocketBasinPolygon,
  pocketGuardContactAt,
  stadiumBoundaryNormalAt,
  stadiumBoundarySignedDistance,
  stadiumTerrainAt,
  type StadiumSpec,
} from "../core/stadium";
import type { BurstReleaseState } from "../core/types";

/** Approximate twist from fully locked to the last internal detent. */
const TOTAL_UNLOCK_RAD = THREE.MathUtils.degToRad(18);
const ELASTIC_TRAVEL_FRACTION = 0.22;
const CLICK_SETTLE_FRACTION = 0.14;

export interface BurstVisualProgress {
  damage: number;
  normalized: number;
  completedClicks: number;
  fractionalClick: number;
  unlockAngleRad: number;
  elasticAngleRad: number;
  readyToSeparate: boolean;
}

export interface BurstLatchRig {
  root: THREE.Object3D;
  ratchet: THREE.Object3D;
  bit: THREE.Object3D;
  ratchetBasePosition: THREE.Vector3;
  bitBasePosition: THREE.Vector3;
  ratchetBaseQuaternion: THREE.Quaternion;
  bitBaseQuaternion: THREE.Quaternion;
  /** Mirrored for left-spin combinations. */
  unlockDirection: 1 | -1;
  /** Decaying torsional snap after a click; no axial or emissive effect. */
  clickKick: number;
  lastCompletedClicks: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smooth01(value: number): number {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

/**
 * Convert fractional core damage into seated internal-lock travel. The first
 * Ratchet digit is the count of OUTER protrusions, not internal lock teeth,
 * so this deliberately depends only on the core's click threshold.
 */
export function burstVisualProgress(
  burstDamage: number,
  clicksMax: number,
): BurstVisualProgress {
  const max = Number.isFinite(clicksMax) ? Math.max(1, Math.round(clicksMax)) : 4;
  const damage = Number.isFinite(burstDamage) ? Math.max(0, burstDamage) : 0;
  const capped = Math.min(damage, max);
  const completedClicks = Math.min(max, Math.floor(capped + 1e-9));
  const fractionalClick = completedClicks >= max ? 0 : capped - completedClicks;
  const stepAngle = TOTAL_UNLOCK_RAD / max;
  // A partial overload winds the mechanism slightly against the next detent.
  // Crossing an integer core click snaps to that detent; there is never a
  // pre-release vertical gap because the Ratchet and Bit remain fully seated.
  const elasticAngleRad = completedClicks >= max
    ? 0
    : smooth01(fractionalClick) * stepAngle * ELASTIC_TRAVEL_FRACTION;
  return {
    damage,
    normalized: capped / max,
    completedClicks,
    fractionalClick,
    unlockAngleRad: completedClicks * stepAngle + elasticAngleRad,
    elasticAngleRad,
    readyToSeparate: damage >= max,
  };
}

/** Capture the lower assembly's authored locked pose without adding geometry. */
export function buildBurstLatchRig(
  bey: THREE.Object3D,
  spinDir: 1 | -1 = 1,
): BurstLatchRig | null {
  const ratchet = bey.getObjectByName("part:ratchet");
  const bit = bey.getObjectByName("part:bit");
  if (!ratchet || !bit) return null;
  const rig: BurstLatchRig = {
    root: bey,
    ratchet,
    bit,
    ratchetBasePosition: ratchet.position.clone(),
    bitBasePosition: bit.position.clone(),
    ratchetBaseQuaternion: ratchet.quaternion.clone(),
    bitBaseQuaternion: bit.quaternion.clone(),
    unlockDirection: spinDir,
    clickKick: 0,
    lastCompletedClicks: 0,
  };
  bey.userData.burstLatch = {
    mechanicalOnly: true,
    seated: true,
    completedClicks: 0,
    normalized: 0,
    unlockAngleRad: 0,
  };
  return rig;
}

export function pulseBurstLatch(rig: BurstLatchRig, magnitude = 1): void {
  rig.clickKick = Math.max(rig.clickKick, clamp01(magnitude));
}

/** Apply detent travel without detaching any part; core `alive` owns release. */
export function updateBurstLatchRig(
  rig: BurstLatchRig,
  burstDamage: number,
  clicksMax: number,
  dt: number,
): BurstVisualProgress {
  const progress = burstVisualProgress(burstDamage, clicksMax);
  if (progress.completedClicks > rig.lastCompletedClicks) pulseBurstLatch(rig);
  rig.lastCompletedClicks = Math.max(rig.lastCompletedClicks, progress.completedClicks);
  rig.clickKick *= Math.exp(-Math.max(0, dt) * 18);

  const max = Number.isFinite(clicksMax) ? Math.max(1, Math.round(clicksMax)) : 4;
  const stepAngle = TOTAL_UNLOCK_RAD / max;
  const settleAngle = rig.clickKick * stepAngle * CLICK_SETTLE_FRACTION;
  const signedAngle = rig.unlockDirection * (progress.unlockAngleRad + settleAngle);
  const unlock = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    signedAngle,
  );

  // The complete lower stack moves as a seated unit. Copying the authored
  // positions every frame guarantees no cosmetic gap creeps in before Burst.
  rig.ratchet.position.copy(rig.ratchetBasePosition);
  rig.bit.position.copy(rig.bitBasePosition);
  rig.ratchet.quaternion.copy(rig.ratchetBaseQuaternion).multiply(unlock);
  rig.bit.quaternion.copy(rig.bitBaseQuaternion).multiply(unlock);
  rig.root.userData.burstLatch = {
    mechanicalOnly: true,
    seated: true,
    completedClicks: progress.completedClicks,
    normalized: progress.normalized,
    unlockAngleRad: signedAngle,
  };
  return progress;
}

/**
 * Reparent a released part while retaining its complete world transform.
 * This prevents the last visible detent angle from popping at disassembly.
 */
export function detachBurstPartPreservingWorld(
  scene: THREE.Scene,
  part: THREE.Object3D,
): void {
  scene.attach(part);
}

// ---- deterministic Burst disassembly --------------------------------------

export const BURST_DEBRIS_FIXED_DT = 1 / 240;
export const SEVERE_BIT_EJECTION = 0.75;
const MAX_RELEASE_IMPULSE_NS = 0.0012;

export type BurstSeparationTopology = "blade-lower" | "blade-ratchet-bit";
export type BurstBodyKind = "blade" | "lower" | "ratchet" | "bit";

export interface BurstPartMasses {
  bladeKg: number;
  ratchetKg: number;
  bitKg: number;
}

export interface BurstDebrisBody {
  kind: BurstBodyKind;
  seed: number;
  massKg: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  /** Principal moments in the carrier's authored local frame. */
  inertia: THREE.Vector3;
  inverseInertia: THREE.Vector3;
  /** Sampled convex support points in carrier-local coordinates. */
  supportPoints: THREE.Vector3[];
  restitution: number;
  friction: number;
  sleepSeconds: number;
  asleep: boolean;
  contactCount: number;
  ageSeconds: number;
}

export interface BurstDebrisVisual {
  mesh: THREE.Group;
  body: BurstDebrisBody;
}

/** Deterministic kinematic proxy for an intact Bey that remains in play.
 * Render debris responds to it, while authoritative core state is untouched. */
export interface BurstKinematicCollider {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  radiusM: number;
  restitution: number;
  friction: number;
}

/** Bounds for an intact Bey's physical parts only. Motion-blur quads and
 * other visual helpers must never inflate the debris collision proxy. */
export function intactBeyCollisionSphere(root: THREE.Object3D): THREE.Sphere {
  root.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3();
  for (const name of ["part:blade", "part:ratchet", "part:bit"]) {
    const part = root.getObjectByName(name);
    if (part) bounds.expandByObject(part, true);
  }
  if (bounds.isEmpty()) {
    root.traverse((object) => {
      if (object.name === "blurRing") return;
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) bounds.expandByObject(mesh, true);
    });
  }
  return bounds.isEmpty()
    ? new THREE.Sphere(root.getWorldPosition(new THREE.Vector3()), 0.025)
    : bounds.getBoundingSphere(new THREE.Sphere());
}

export function burstSeparationTopology(severity: number): BurstSeparationTopology {
  return Number.isFinite(severity) && severity >= SEVERE_BIT_EJECTION
    ? "blade-ratchet-bit"
    : "blade-lower";
}

/** Derive lower-part masses from catalog weights and assign the remainder to
 * the complete upper assembly (including every locked CX upper component). */
export function burstPartMasses(
  totalMassKg: number,
  combo: ResolvedCombo | null,
): BurstPartMasses {
  const total = Number.isFinite(totalMassKg) ? Math.max(0.025, totalMassKg) : 0.044;
  const ratchetCatalog = (combo?.parts.ratchet?.weightG ?? 6.5) / 1000;
  const bitCatalog = (combo?.parts.bit?.weightG ?? 2.5) / 1000;
  const lowerBudget = Math.max(0.004, total * 0.4);
  const catalogLower = Math.max(0.001, ratchetCatalog + bitCatalog);
  const lowerScale = Math.min(1, lowerBudget / catalogLower);
  const ratchetKg = Math.max(0.0015, ratchetCatalog * lowerScale);
  const bitKg = Math.max(0.0008, bitCatalog * lowerScale);
  return {
    bladeKg: Math.max(0.012, total - ratchetKg - bitKg),
    ratchetKg,
    bitKg,
  };
}

/**
 * Wrap one or more already-authored parts in a rigid carrier centred on their
 * world geometry. `attach` retains every child's exact detent/world transform.
 */
export function groupBurstRigidAssembly(
  scene: THREE.Scene,
  members: readonly THREE.Object3D[],
  name: string,
): THREE.Group | null {
  if (members.length === 0) return null;
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  const fallbackCenter = new THREE.Vector3();
  for (const member of members) {
    member.updateWorldMatrix(true, true);
    bounds.expandByObject(member, true);
    fallbackCenter.add(member.getWorldPosition(new THREE.Vector3()));
  }
  const center = bounds.isEmpty()
    ? fallbackCenter.multiplyScalar(1 / members.length)
    : bounds.getCenter(new THREE.Vector3());
  const carrier = new THREE.Group();
  carrier.name = name;
  carrier.position.copy(center);
  carrier.userData.burstRigidBody = true;
  carrier.userData.memberNames = members.map((member) => member.name);
  scene.add(carrier);
  carrier.updateWorldMatrix(true, false);
  for (const member of members) carrier.attach(member);
  return carrier;
}

function supportDirections(): THREE.Vector3[] {
  const directions: THREE.Vector3[] = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  ];
  for (const z of [-1, 0, 1]) {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      directions.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), z * 0.65).normalize());
    }
  }
  return directions;
}

const SUPPORT_DIRECTIONS = supportDirections();

/** Sample actual geometry, then retain directional extrema as a compact
 * convex support cloud. This makes tilted parts contact on their real rims
 * and faces rather than pretending their Object3D origin is the floor. */
export function geometrySupportPoints(root: THREE.Object3D): THREE.Vector3[] {
  root.updateWorldMatrix(true, true);
  const inverseRoot = root.matrixWorld.clone().invert();
  const bestDots = SUPPORT_DIRECTIONS.map(() => Number.NEGATIVE_INFINITY);
  const bestPoints = SUPPORT_DIRECTIONS.map(() => new THREE.Vector3());
  let sawVertex = false;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.getAttribute("position");
    if (!position) return;
    const toRoot = inverseRoot.clone().multiply(mesh.matrixWorld);
    const stride = Math.max(1, Math.ceil(position.count / 4096));
    const point = new THREE.Vector3();
    for (let index = 0; index < position.count; index += stride) {
      point.fromBufferAttribute(position, index).applyMatrix4(toRoot);
      sawVertex = true;
      for (let direction = 0; direction < SUPPORT_DIRECTIONS.length; direction++) {
        const dot = point.dot(SUPPORT_DIRECTIONS[direction]!);
        if (dot > bestDots[direction]!) {
          bestDots[direction] = dot;
          bestPoints[direction]!.copy(point);
        }
      }
    }
  });
  if (!sawVertex) {
    const r = 0.004;
    return [
      new THREE.Vector3(-r, -r, -r), new THREE.Vector3(r, -r, -r),
      new THREE.Vector3(-r, r, -r), new THREE.Vector3(r, r, -r),
      new THREE.Vector3(-r, -r, r), new THREE.Vector3(r, -r, r),
      new THREE.Vector3(-r, r, r), new THREE.Vector3(r, r, r),
    ];
  }
  const unique = new Map<string, THREE.Vector3>();
  for (let index = 0; index < bestPoints.length; index++) {
    if (!Number.isFinite(bestDots[index]!)) continue;
    const point = bestPoints[index]!;
    const key = `${Math.round(point.x * 1e6)}:${Math.round(point.y * 1e6)}:${Math.round(point.z * 1e6)}`;
    if (!unique.has(key)) unique.set(key, point.clone());
  }
  return [...unique.values()];
}

function bodyMaterial(kind: BurstBodyKind): { restitution: number; friction: number } {
  if (kind === "blade") return { restitution: 0.24, friction: 0.34 };
  if (kind === "bit") return { restitution: 0.3, friction: 0.2 };
  if (kind === "ratchet") return { restitution: 0.22, friction: 0.22 };
  return { restitution: 0.2, friction: 0.24 };
}

/** Build a state body with catalog mass, geometry-derived moments and rigid
 * inheritance `vPart = vBey + omega × offset` at the instant of release. */
export function buildBurstDebrisBody(
  carrier: THREE.Group,
  kind: BurstBodyKind,
  massKg: number,
  beyOrigin: THREE.Vector3,
  beyVelocity: THREE.Vector3,
  beyAngularVelocity: THREE.Vector3,
  seed: number,
): BurstDebrisBody {
  const supportPoints = geometrySupportPoints(carrier);
  const bounds = new THREE.Box3().setFromPoints(supportPoints);
  const size = bounds.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.001, 0.001, 0.001));
  const mass = Math.max(0.0005, massKg);
  // Principal-box estimate from the actual assembly bounds. The different
  // masses/dimensions are what make Blade, Ratchet and Bit tumble differently.
  const inertia = new THREE.Vector3(
    mass * (size.y * size.y + size.z * size.z) / 12,
    mass * (size.x * size.x + size.z * size.z) / 12,
    mass * (size.x * size.x + size.y * size.y) / 12,
  ).max(new THREE.Vector3(1e-9, 1e-9, 1e-9));
  const position = carrier.position.clone();
  const offset = position.clone().sub(beyOrigin);
  const velocity = beyVelocity.clone().add(
    beyAngularVelocity.clone().cross(offset),
  );
  const material = bodyMaterial(kind);
  return {
    kind,
    seed: seed >>> 0,
    massKg: mass,
    position,
    quaternion: carrier.quaternion.clone(),
    velocity,
    angularVelocity: beyAngularVelocity.clone(),
    inertia,
    inverseInertia: new THREE.Vector3(1 / inertia.x, 1 / inertia.y, 1 / inertia.z),
    supportPoints,
    restitution: material.restitution,
    friction: material.friction,
    sleepSeconds: 0,
    asleep: false,
    contactCount: 0,
    ageSeconds: 0,
  };
}

function seededUnit(seed: number): number {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x100000000;
}

function inverseInertiaWorld(
  body: BurstDebrisBody,
  vector: THREE.Vector3,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const inverseRotation = body.quaternion.clone().invert();
  return target.copy(vector)
    .applyQuaternion(inverseRotation)
    .multiply(body.inverseInertia)
    .applyQuaternion(body.quaternion);
}

/** Apply a world-space impulse at an offset from the body's centre of mass. */
export function applyBurstBodyImpulse(
  body: BurstDebrisBody,
  impulse: THREE.Vector3,
  offset: THREE.Vector3,
): void {
  body.velocity.addScaledVector(impulse, 1 / body.massKg);
  const angularImpulse = offset.clone().cross(impulse);
  body.angularVelocity.add(inverseInertiaWorld(body, angularImpulse));
  body.asleep = false;
  body.sleepSeconds = 0;
}

/**
 * Add only the small equal-and-opposite impulse required to clear the lock.
 * The much larger terminal collision is already present in `postVx/postVy`;
 * applying it twice would turn Burst into a fictional explosion.
 */
export function applyBurstReleaseImpulse(
  bodies: readonly BurstDebrisBody[],
  release: BurstReleaseState,
  beyOrigin: THREE.Vector3,
  topAxis: THREE.Vector3,
): number {
  const blade = bodies.find((body) => body.kind === "blade");
  const lower = bodies.filter((body) => body.kind !== "blade");
  if (!blade || lower.length === 0) return 0;

  const severity = clamp01(release.severity);
  const loadImpulse = Math.abs(release.tangentialImpulse) * 0.06 + release.normalImpulse * 0.015;
  const impulseMagnitude = Math.min(
    MAX_RELEASE_IMPULSE_NS,
    Math.max(0.00012, loadImpulse) * (0.78 + severity * 0.22),
  );
  const radial = new THREE.Vector3(
    Math.cos(release.contactAngle),
    Math.sin(release.contactAngle),
    0,
  );
  const unlockSign = Math.sign(release.tangentialImpulse) || Math.sign(release.omega) || 1;
  const tangent = new THREE.Vector3(-radial.y, radial.x, 0).multiplyScalar(unlockSign);
  const jitter = (seededUnit(release.seed ^ 0x9e3779b9) - 0.5) * 0.16;
  const direction = tangent
    .multiplyScalar(0.9)
    .addScaledVector(radial, -0.12 + jitter)
    .addScaledVector(topAxis, 0.18)
    .normalize();
  const impulse = direction.multiplyScalar(impulseMagnitude);
  const contactPoint = beyOrigin.clone()
    .addScaledVector(radial, 0.009)
    .addScaledVector(topAxis, 0.012);
  applyBurstBodyImpulse(blade, impulse, contactPoint.clone().sub(blade.position));

  const lowerMass = lower.reduce((sum, body) => sum + body.massKg, 0);
  for (const body of lower) {
    const share = body.massKg / Math.max(1e-9, lowerMass);
    applyBurstBodyImpulse(
      body,
      impulse.clone().multiplyScalar(-share),
      contactPoint.clone().sub(body.position),
    );
  }

  // Only an explicitly severe terminal overload ejects the Bit from the
  // Ratchet. Its impulse is smaller still and momentum-balanced.
  if (burstSeparationTopology(severity) === "blade-ratchet-bit") {
    const ratchet = bodies.find((body) => body.kind === "ratchet");
    const bit = bodies.find((body) => body.kind === "bit");
    if (ratchet && bit) {
      const splitMagnitude = impulseMagnitude * 0.22 * severity;
      const splitDirection = topAxis.clone().multiplyScalar(-1)
        .addScaledVector(radial, (seededUnit(release.seed ^ 0x85ebca6b) - 0.5) * 0.24)
        .normalize();
      const splitImpulse = splitDirection.multiplyScalar(splitMagnitude);
      applyBurstBodyImpulse(bit, splitImpulse, contactPoint.clone().sub(bit.position));
      applyBurstBodyImpulse(ratchet, splitImpulse.clone().multiplyScalar(-1), contactPoint.clone().sub(ratchet.position));
    }
  }
  return impulseMagnitude;
}

export interface BurstTerrainSample {
  height: number;
  normal: THREE.Vector3;
  inPocket: boolean;
  onRail: boolean;
}

/** Bowl, raised X-Line and lowered pocket floor sampled at a support point. */
export function sampleBurstTerrain(
  stadium: StadiumSpec | null,
  x: number,
  y: number,
): BurstTerrainSample {
  if (!stadium) {
    return { height: 0, normal: new THREE.Vector3(0, 0, 1), inPocket: false, onRail: false };
  }
  const sample = stadiumTerrainAt(stadium, x, y);
  return {
    height: sample.height,
    normal: new THREE.Vector3(sample.normalX, sample.normalY, sample.normalZ),
    inPocket: sample.region === "pocket",
    onRail: sample.region === "rail",
  };
}

function worldSupportPoint(
  body: BurstDebrisBody,
  local: THREE.Vector3,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.copy(local).applyQuaternion(body.quaternion).add(body.position);
}

function contactVelocity(
  body: BurstDebrisBody,
  offset: THREE.Vector3,
): THREE.Vector3 {
  return body.angularVelocity.clone().cross(offset).add(body.velocity);
}

function effectiveInverseMass(
  body: BurstDebrisBody,
  offset: THREE.Vector3,
  direction: THREE.Vector3,
): number {
  const rotational = inverseInertiaWorld(
    body,
    offset.clone().cross(direction),
  ).cross(offset);
  return 1 / body.massKg + direction.dot(rotational);
}

function resolveStaticContact(
  body: BurstDebrisBody,
  offset: THREE.Vector3,
  normal: THREE.Vector3,
  restitution: number,
): number {
  const velocity = contactVelocity(body, offset);
  const vn = velocity.dot(normal);
  if (vn >= 0) return 0;
  // Do not inject a fresh bounce for resting micro-contacts.
  const bounce = vn < -0.16 ? restitution : 0;
  const denominator = Math.max(1e-9, effectiveInverseMass(body, offset, normal));
  const normalImpulseMagnitude = -(1 + bounce) * vn / denominator;
  const normalImpulse = normal.clone().multiplyScalar(normalImpulseMagnitude);
  applyBurstBodyImpulse(body, normalImpulse, offset);

  const afterNormal = contactVelocity(body, offset);
  const tangent = afterNormal.addScaledVector(normal, -afterNormal.dot(normal));
  const tangentSpeed = tangent.length();
  if (tangentSpeed > 1e-8) {
    tangent.multiplyScalar(1 / tangentSpeed);
    const tangentDenominator = Math.max(1e-9, effectiveInverseMass(body, offset, tangent));
    const freeFriction = tangentSpeed / tangentDenominator;
    const frictionMagnitude = Math.min(
      freeFriction,
      body.friction * normalImpulseMagnitude,
    );
    applyBurstBodyImpulse(body, tangent.multiplyScalar(-frictionMagnitude), offset);
  }
  return normalImpulseMagnitude;
}

function resolveBowlFloor(body: BurstDebrisBody, stadium: StadiumSpec | null): boolean {
  let contacted = false;
  // Two sequential support contacts stabilize broad Blade faces without an
  // origin-height shortcut or a frame-dependent positional teleport.
  for (let iteration = 0; iteration < 2; iteration++) {
    let lowestClearance = Number.POSITIVE_INFINITY;
    let lowestPoint: THREE.Vector3 | null = null;
    let terrain: BurstTerrainSample | null = null;
    for (const local of body.supportPoints) {
      const point = worldSupportPoint(body, local);
      const sample = sampleBurstTerrain(stadium, point.x, point.y);
      const clearance = point.z - sample.height;
      if (clearance < lowestClearance) {
        lowestClearance = clearance;
        lowestPoint = point;
        terrain = sample;
      }
    }
    if (!lowestPoint || !terrain || lowestClearance > 0) break;
    contacted = true;
    // `lowestClearance` is vertical while the constraint normal is sloped.
    // Divide by normal.z so the correction clears the actual shared terrain
    // plane instead of leaving a support point embedded in a pocket ramp.
    const correction = (-lowestClearance + 1e-7) / Math.max(0.1, terrain.normal.z);
    body.position.addScaledVector(terrain.normal, correction);
    const correctedPoint = lowestPoint.addScaledVector(terrain.normal, correction);
    const offset = correctedPoint.sub(body.position);
    resolveStaticContact(body, offset, terrain.normal, body.restitution);
  }
  return contacted;
}

interface PlanarWallContact {
  penetration: number;
  inward: THREE.Vector3;
}

function nearestPointOnSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number; distance: number } {
  const ex = bx - ax;
  const ey = by - ay;
  const lengthSq = ex * ex + ey * ey;
  const t = lengthSq > 1e-15
    ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / lengthSq))
    : 0;
  const px = ax + ex * t;
  const py = ay + ey * t;
  return { x: px, y: py, distance: Math.hypot(px - x, py - y) };
}

/** Contact against the exact top-view union of bowl and molded pockets. */
function planarWallContactAt(
  stadium: StadiumSpec,
  x: number,
  y: number,
): PlanarWallContact | null {
  const guard = pocketGuardContactAt(stadium, x, y);
  if (guard) {
    return {
      penetration: guard.penetration,
      inward: new THREE.Vector3(guard.normal.x, guard.normal.y, 0),
    };
  }
  const bowlDistance = stadiumBoundarySignedDistance(stadium, x, y);
  if (bowlDistance <= 0 || pocketAtPoint(stadium, x, y)) return null;

  const bowlNormal = stadiumBoundaryNormalAt(stadium, x, y);
  const candidates: PlanarWallContact[] = [];
  const bowlClosest = {
    x: x - bowlNormal.x * bowlDistance,
    y: y - bowlNormal.y * bowlDistance,
  };
  // A bowl-wall point covered by either passable footprint is an opening,
  // not a casing surface.
  if (!pocketAtPoint(stadium, bowlClosest.x, bowlClosest.y)) {
    candidates.push({
      penetration: bowlDistance,
      inward: new THREE.Vector3(-bowlNormal.x, -bowlNormal.y, 0),
    });
  }

  // Outside the finite concave-basin outline, resolve against its rising rim.
  // The canonical basin is one convex surface, so there is no internal
  // throat/floor overlap seam to invent a debris collision.
  for (const pocket of stadium.pockets) {
    const polygon = pocketBasinPolygon(stadium, pocket);
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index]!;
      const b = polygon[(index + 1) % polygon.length]!;
      const candidate = nearestPointOnSegment(x, y, a.x, a.y, b.x, b.y);
      if (candidate.distance <= 1e-12) continue;
      if (stadiumBoundarySignedDistance(stadium, candidate.x, candidate.y) < -1e-8) continue;
      candidates.push({
        penetration: candidate.distance,
        inward: new THREE.Vector3(candidate.x - x, candidate.y - y, 0)
          .multiplyScalar(1 / candidate.distance),
      });
      }
  }
  if (candidates.length === 0) {
    // Defensive fallback for a degenerate product polygon.
    return {
      penetration: bowlDistance,
      inward: new THREE.Vector3(-bowlNormal.x, -bowlNormal.y, 0),
    };
  }
  return candidates.reduce((best, candidate) =>
    candidate.penetration < best.penetration ? candidate : best
  );
}

function resolveStadiumWall(body: BurstDebrisBody, stadium: StadiumSpec | null): boolean {
  if (!stadium) return false;
  let contacted = false;
  // Re-evaluate after each correction because a broad tilted Blade can touch
  // a pocket cheek and backstop at different support points simultaneously.
  for (let iteration = 0; iteration < 3; iteration++) {
    let deepestPoint: THREE.Vector3 | null = null;
    let deepest: PlanarWallContact | null = null;
    for (const local of body.supportPoints) {
      const point = worldSupportPoint(body, local);
      const contact = planarWallContactAt(stadium, point.x, point.y);
      if (contact && (!deepest || contact.penetration > deepest.penetration)) {
        deepestPoint = point;
        deepest = contact;
      }
    }
    if (!deepestPoint || !deepest) break;
    contacted = true;
    const correction = deepest.penetration + 1e-7;
    body.position.addScaledVector(deepest.inward, correction);
    const correctedPoint = deepestPoint.addScaledVector(deepest.inward, correction);
    const offset = correctedPoint.sub(body.position);
    resolveStaticContact(
      body,
      offset,
      deepest.inward,
      body.restitution * stadium.wallRestitution,
    );
  }
  return contacted;
}

/** Conservative oriented-body bounds from the actual support cloud. */
export function burstBodyWorldBounds(body: BurstDebrisBody): THREE.Box3 {
  const bounds = new THREE.Box3();
  for (const local of body.supportPoints) bounds.expandByPoint(worldSupportPoint(body, local));
  return bounds;
}

function resolveBurstBodyPair(a: BurstDebrisBody, b: BurstDebrisBody): boolean {
  const aBounds = burstBodyWorldBounds(a);
  const bBounds = burstBodyWorldBounds(b);
  if (!aBounds.intersectsBox(bBounds)) return false;
  const overlaps = [
    Math.min(aBounds.max.x, bBounds.max.x) - Math.max(aBounds.min.x, bBounds.min.x),
    Math.min(aBounds.max.y, bBounds.max.y) - Math.max(aBounds.min.y, bBounds.min.y),
    Math.min(aBounds.max.z, bBounds.max.z) - Math.max(aBounds.min.z, bBounds.min.z),
  ];
  let axis = 0;
  if (overlaps[1]! < overlaps[axis]!) axis = 1;
  if (overlaps[2]! < overlaps[axis]!) axis = 2;
  if (overlaps[axis]! <= 0) return false;
  const delta = b.position.clone().sub(a.position);
  let sign = Math.sign(delta.getComponent(axis));
  if (sign === 0) sign = seededUnit(a.seed ^ b.seed ^ axis) < 0.5 ? -1 : 1;
  const normal = new THREE.Vector3().setComponent(axis, sign);
  const overlapCenter = new THREE.Vector3(
    (Math.max(aBounds.min.x, bBounds.min.x) + Math.min(aBounds.max.x, bBounds.max.x)) / 2,
    (Math.max(aBounds.min.y, bBounds.min.y) + Math.min(aBounds.max.y, bBounds.max.y)) / 2,
    (Math.max(aBounds.min.z, bBounds.min.z) + Math.min(aBounds.max.z, bBounds.max.z)) / 2,
  );

  // Clear the interlocking launch pose over several fixed ticks rather than
  // converting initial geometric overlap into a violent artificial blast.
  const correction = Math.min(overlaps[axis]! * 0.55, 0.00035);
  const inverseA = 1 / a.massKg;
  const inverseB = 1 / b.massKg;
  const inverseTotal = inverseA + inverseB;
  a.position.addScaledVector(normal, -correction * inverseA / inverseTotal);
  b.position.addScaledVector(normal, correction * inverseB / inverseTotal);

  const offsetA = overlapCenter.clone().sub(a.position);
  const offsetB = overlapCenter.clone().sub(b.position);
  const relativeVelocity = contactVelocity(b, offsetB).sub(contactVelocity(a, offsetA));
  const normalSpeed = relativeVelocity.dot(normal);
  if (normalSpeed < 0) {
    const denominator = Math.max(
      1e-9,
      effectiveInverseMass(a, offsetA, normal) + effectiveInverseMass(b, offsetB, normal),
    );
    const restitution = Math.min(a.restitution, b.restitution);
    const magnitude = -(1 + restitution) * normalSpeed / denominator;
    const impulse = normal.clone().multiplyScalar(magnitude);
    applyBurstBodyImpulse(a, impulse.clone().multiplyScalar(-1), offsetA);
    applyBurstBodyImpulse(b, impulse, offsetB);
  }
  return true;
}

/** Resolve all rigid pieces against each other once per fixed substep. */
export function resolveBurstBodyContacts(bodies: readonly BurstDebrisBody[]): number {
  let contacts = 0;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      if (resolveBurstBodyPair(bodies[i]!, bodies[j]!)) contacts++;
    }
  }
  return contacts;
}

function burstBodyBoundingRadius(body: BurstDebrisBody): number {
  let radius = 0.001;
  for (const point of body.supportPoints) radius = Math.max(radius, point.length());
  return radius;
}

function resolveBurstKinematicPair(
  body: BurstDebrisBody,
  collider: BurstKinematicCollider,
): boolean {
  const bodyRadius = burstBodyBoundingRadius(body);
  const colliderRadius = Math.max(0.001, collider.radiusM);
  const delta = body.position.clone().sub(collider.position);
  let distance = delta.length();
  const minimumDistance = bodyRadius + colliderRadius;
  if (distance >= minimumDistance) return false;
  if (distance <= 1e-12) {
    const angle = seededUnit(body.seed ^ 0x51ed270b) * Math.PI * 2;
    delta.set(Math.cos(angle), Math.sin(angle), 0.2).normalize();
    distance = 0;
  } else {
    delta.multiplyScalar(1 / distance);
  }
  const normal = delta;
  body.position.addScaledVector(normal, minimumDistance - distance + 1e-7);

  const bodyOffset = normal.clone().multiplyScalar(-bodyRadius);
  const colliderOffset = normal.clone().multiplyScalar(colliderRadius);
  const colliderContactVelocity = collider.angularVelocity.clone()
    .cross(colliderOffset)
    .add(collider.velocity);
  const relativeVelocity = contactVelocity(body, bodyOffset).sub(colliderContactVelocity);
  const normalSpeed = relativeVelocity.dot(normal);
  if (normalSpeed < 0) {
    const denominator = Math.max(1e-9, effectiveInverseMass(body, bodyOffset, normal));
    const restitution = Math.min(body.restitution, Math.max(0, collider.restitution));
    const normalMagnitude = -(1 + restitution) * normalSpeed / denominator;
    applyBurstBodyImpulse(body, normal.clone().multiplyScalar(normalMagnitude), bodyOffset);

    const afterNormal = contactVelocity(body, bodyOffset).sub(colliderContactVelocity);
    const tangent = afterNormal.addScaledVector(normal, -afterNormal.dot(normal));
    const tangentSpeed = tangent.length();
    if (tangentSpeed > 1e-8) {
      tangent.multiplyScalar(1 / tangentSpeed);
      const tangentDenominator = Math.max(
        1e-9,
        effectiveInverseMass(body, bodyOffset, tangent),
      );
      const freeFriction = tangentSpeed / tangentDenominator;
      const frictionMagnitude = Math.min(
        freeFriction,
        Math.min(body.friction, Math.max(0, collider.friction)) * normalMagnitude,
      );
      applyBurstBodyImpulse(body, tangent.multiplyScalar(-frictionMagnitude), bodyOffset);
    }
  }
  return true;
}

/** Prevent released parts from ghosting through a surviving, still-spinning
 * opponent during the post-finish afterglow/replay. */
export function resolveBurstKinematicContacts(
  bodies: readonly BurstDebrisBody[],
  colliders: readonly BurstKinematicCollider[],
): number {
  let contacts = 0;
  for (const body of bodies) {
    for (const collider of colliders) {
      if (resolveBurstKinematicPair(body, collider)) contacts++;
    }
  }
  return contacts;
}

function integrateOrientation(body: BurstDebrisBody, dt: number): void {
  const speed = body.angularVelocity.length();
  if (speed <= 1e-10) return;
  const delta = new THREE.Quaternion().setFromAxisAngle(
    body.angularVelocity.clone().multiplyScalar(1 / speed),
    speed * dt,
  );
  body.quaternion.premultiply(delta).normalize();
}

/** One deterministic rigid-body tick. */
export function stepBurstDebrisBody(
  body: BurstDebrisBody,
  stadium: StadiumSpec | null,
  dt = BURST_DEBRIS_FIXED_DT,
): void {
  if (body.asleep || !Number.isFinite(dt) || dt <= 0) return;
  body.ageSeconds += dt;
  body.velocity.z -= 9.81 * dt;
  body.velocity.multiplyScalar(Math.exp(-0.06 * dt));
  body.angularVelocity.multiplyScalar(Math.exp(-0.035 * dt));
  body.position.addScaledVector(body.velocity, dt);
  integrateOrientation(body, dt);

  const wallContact = resolveStadiumWall(body, stadium);
  const floorContact = resolveBowlFloor(body, stadium);
  const contacted = wallContact || floorContact;
  if (contacted) {
    body.contactCount++;
    // Rolling/sliding resistance after the impulse solve. POM lower parts
    // retain more motion than the broad painted-metal Blade assembly.
    body.velocity.multiplyScalar(Math.exp(-body.friction * 2.2 * dt));
    body.angularVelocity.multiplyScalar(Math.exp(-body.friction * 1.5 * dt));
  }
  const linearSpeed = body.velocity.length();
  const angularSpeed = body.angularVelocity.length();
  if (floorContact && linearSpeed < 0.025 && angularSpeed < 1.2) {
    body.sleepSeconds += dt;
    if (body.sleepSeconds >= 0.6) {
      body.asleep = true;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
    }
  } else {
    body.sleepSeconds = 0;
  }
}

/** Advance by an arbitrary render delta using fixed 240 Hz substeps. */
export function advanceBurstDebris(
  bodies: readonly BurstDebrisBody[],
  stadium: StadiumSpec | null,
  elapsedSeconds: number,
  accumulatorSeconds = 0,
  colliders: readonly BurstKinematicCollider[] = [],
): number {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return accumulatorSeconds;
  const total = Math.max(0, accumulatorSeconds) + elapsedSeconds;
  const steps = Math.floor((total + 1e-12) / BURST_DEBRIS_FIXED_DT);
  for (let step = 0; step < steps; step++) {
    for (const body of bodies) stepBurstDebrisBody(body, stadium, BURST_DEBRIS_FIXED_DT);
    resolveBurstBodyContacts(bodies);
    // Callers provide the intact Bey pose at the END of this render slice.
    // Reconstruct its linear path at every fixed tick instead of freezing the
    // end pose across the slice (which would differ at 60 vs 120 Hz).
    const secondsBeforeEnd = Math.max(
      0,
      total - (step + 1) * BURST_DEBRIS_FIXED_DT,
    );
    const sampledColliders = secondsBeforeEnd > 0
      ? colliders.map((collider) => ({
          ...collider,
          position: collider.position.clone().addScaledVector(
            collider.velocity,
            -secondsBeforeEnd,
          ),
        }))
      : colliders;
    resolveBurstKinematicContacts(bodies, sampledColliders);
  }
  return Math.max(0, total - steps * BURST_DEBRIS_FIXED_DT);
}
