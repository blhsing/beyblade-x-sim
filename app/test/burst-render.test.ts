import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  advanceBurstDebris,
  applyBurstReleaseImpulse,
  buildBurstDebrisBody,
  buildBurstLatchRig,
  burstPartMasses,
  burstBodyWorldBounds,
  burstSeparationTopology,
  burstVisualProgress,
  detachBurstPartPreservingWorld,
  geometrySupportPoints,
  groupBurstRigidAssembly,
  intactBeyCollisionSphere,
  pulseBurstLatch,
  resolveBurstBodyContacts,
  resolveBurstKinematicContacts,
  sampleBurstTerrain,
  stepBurstDebrisBody,
  updateBurstLatchRig,
  type BurstDebrisBody,
  type BurstKinematicCollider,
} from "../src/render/burst";
import {
  pocketFloorTopZ,
  pocketAtPoint,
  pocketCatchPolygon,
  pocketPath,
  pocketPolygon,
  stadiumBoundarySignedDistance,
  surfaceZAt,
  stadiumTerrainAt,
  STADIUM_BX10,
  STADIUM_BX32,
} from "../src/core/stadium";
import type { BurstReleaseState } from "../src/core/types";

function makeBey(): {
  root: THREE.Group;
  blade: THREE.Group;
  ratchet: THREE.Group;
  bit: THREE.Group;
} {
  const root = new THREE.Group();
  root.name = "bey";
  const blade = new THREE.Group();
  blade.name = "part:blade";
  const ratchet = new THREE.Group();
  ratchet.name = "part:ratchet";
  ratchet.position.set(0.001, -0.002, 0.018);
  ratchet.rotation.set(0.01, -0.02, 0.08);
  const bit = new THREE.Group();
  bit.name = "part:bit";
  bit.position.set(-0.001, 0.002, 0.006);
  bit.rotation.set(-0.015, 0.01, -0.04);
  root.add(bit, ratchet, blade);
  return { root, blade, ratchet, bit };
}

function expectVectorClose(actual: THREE.Vector3, expected: THREE.Vector3): void {
  expect(actual.distanceTo(expected)).toBeLessThan(1e-10);
}

function cloneBody(body: BurstDebrisBody): BurstDebrisBody {
  return {
    ...body,
    position: body.position.clone(),
    quaternion: body.quaternion.clone(),
    velocity: body.velocity.clone(),
    angularVelocity: body.angularVelocity.clone(),
    inertia: body.inertia.clone(),
    inverseInertia: body.inverseInertia.clone(),
    supportPoints: body.supportPoints.map((point) => point.clone()),
  };
}

function releaseState(severity = 0.2): BurstReleaseState {
  return {
    tick: 120,
    contactAngle: 0.7,
    normalImpulse: 0.018,
    tangentialImpulse: 0.012,
    preVx: 0.4,
    preVy: -0.1,
    postVx: 0.34,
    postVy: -0.06,
    omega: 220,
    phase: 1.2,
    severity,
    seed: 0x1234abcd,
  };
}

describe("progressive Ratchet Burst presentation", () => {
  it("maps fractional damage to monotonic internal detent travel", () => {
    const samples = [0, 0.2, 0.8, 0.999, 1, 1.4, 1.999, 2, 2.8, 3, 3.999, 4, 8];
    const progress = samples.map((damage) => burstVisualProgress(damage, 4));
    expect(progress[0]).toMatchObject({
      normalized: 0,
      completedClicks: 0,
      unlockAngleRad: 0,
      readyToSeparate: false,
    });
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.unlockAngleRad).toBeGreaterThanOrEqual(
        progress[i - 1]!.unlockAngleRad,
      );
    }
    expect(burstVisualProgress(0.8, 4).elasticAngleRad).toBeGreaterThan(0);
    expect(burstVisualProgress(1, 4).completedClicks).toBe(1);
    expect(burstVisualProgress(3.999, 4).readyToSeparate).toBe(false);
    expect(burstVisualProgress(4, 4).readyToSeparate).toBe(true);
    expect(burstVisualProgress(8, 4).normalized).toBe(1);
    const detents = [0, 1, 2, 3, 4].map(
      (damage) => burstVisualProgress(damage, 4).unlockAngleRad,
    );
    expect(detents).toEqual([...detents].sort((a, b) => a - b));
    expect(new Set(detents).size).toBe(5);
  });

  it("uses the rule click threshold, never the Ratchet's outer protrusion count", () => {
    const threeClickMode = burstVisualProgress(1, 3);
    const fiveClickMode = burstVisualProgress(1, 5);
    expect(threeClickMode.completedClicks).toBe(1);
    expect(fiveClickMode.completedClicks).toBe(1);
    expect(threeClickMode.unlockAngleRad).toBeGreaterThan(fiveClickMode.unlockAngleRad);
    // There is intentionally no latch-count argument in the render contract.
    expect(burstVisualProgress.length).toBe(2);
  });

  it("keeps Ratchet and Bit flush while rotating them together through clicks", () => {
    const { root, ratchet, bit } = makeBey();
    const childrenBefore = [...root.children];
    const ratchetPosition = ratchet.position.clone();
    const bitPosition = bit.position.clone();
    const rig = buildBurstLatchRig(root, 1)!;

    updateBurstLatchRig(rig, 2.45, 4, 1 / 60);

    expectVectorClose(ratchet.position, ratchetPosition);
    expectVectorClose(bit.position, bitPosition);
    expect(root.children).toEqual(childrenBefore);
    expect(ratchet.parent).toBe(root);
    expect(bit.parent).toBe(root);
    expect(ratchet.quaternion.angleTo(rig.ratchetBaseQuaternion)).toBeGreaterThan(0.05);
    expect(bit.quaternion.angleTo(rig.bitBaseQuaternion)).toBeGreaterThan(0.05);
    expect(root.userData.burstLatch).toMatchObject({
      mechanicalOnly: true,
      seated: true,
      completedClicks: 2,
    });
    const names: string[] = [];
    root.traverse((object) => names.push(object.name.toLowerCase()));
    expect(names.some((name) => name.includes("crack") || name.includes("indicator"))).toBe(false);
  });

  it("mirrors unlock travel for left spin and limits click feedback to torsion", () => {
    const rightBey = makeBey();
    const leftBey = makeBey();
    const right = buildBurstLatchRig(rightBey.root, 1)!;
    const left = buildBurstLatchRig(leftBey.root, -1)!;
    const rightRatchetPosition = right.ratchet.position.clone();
    const leftRatchetPosition = left.ratchet.position.clone();

    pulseBurstLatch(right);
    pulseBurstLatch(left);
    updateBurstLatchRig(right, 1, 4, 0);
    updateBurstLatchRig(left, 1, 4, 0);

    const rightAngle = right.root.userData.burstLatch.unlockAngleRad as number;
    const leftAngle = left.root.userData.burstLatch.unlockAngleRad as number;
    expect(rightAngle).toBeCloseTo(-leftAngle, 10);
    expectVectorClose(right.ratchet.position, rightRatchetPosition);
    expectVectorClose(left.ratchet.position, leftRatchetPosition);
    expect(right.root.children).toHaveLength(3);
    expect(left.root.children).toHaveLength(3);
  });

  it("reseats deterministically when a replay state seeks backward", () => {
    const { root } = makeBey();
    const rig = buildBurstLatchRig(root)!;
    updateBurstLatchRig(rig, 2, 4, 10);
    const twoClicks = root.userData.burstLatch.unlockAngleRad as number;
    updateBurstLatchRig(rig, 1, 4, 10);
    const oneClick = root.userData.burstLatch.unlockAngleRad as number;
    expect(oneClick).toBeLessThan(twoClicks);
    expect(oneClick).toBeCloseTo(burstVisualProgress(1, 4).unlockAngleRad, 10);
    expect(rig.ratchet.position).toEqual(rig.ratchetBasePosition);
    expect(rig.bit.position).toEqual(rig.bitBasePosition);
  });

  it("finds direct BX/UX parts, nested CX parts, and no-ops on incomplete models", () => {
    const direct = makeBey();
    expect(buildBurstLatchRig(direct.root)).not.toBeNull();

    const cxRoot = new THREE.Group();
    const cxStack = new THREE.Group();
    cxStack.name = "cx composite stack";
    const cxRatchet = new THREE.Group();
    cxRatchet.name = "part:ratchet";
    const cxBit = new THREE.Group();
    cxBit.name = "part:bit";
    cxStack.add(cxRatchet, cxBit);
    cxRoot.add(cxStack);
    const cxRig = buildBurstLatchRig(cxRoot);
    expect(cxRig?.ratchet).toBe(cxRatchet);
    expect(cxRig?.bit).toBe(cxBit);

    const incomplete = new THREE.Group();
    const loneRatchet = new THREE.Group();
    loneRatchet.name = "part:ratchet";
    incomplete.add(loneRatchet);
    expect(buildBurstLatchRig(incomplete)).toBeNull();
    expect(incomplete.children).toEqual([loneRatchet]);
  });

  it("excludes the visual-only blur quad from intact-Bey collision bounds", () => {
    const { root, blade, ratchet, bit } = makeBey();
    blade.add(new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.008, 32),
      new THREE.MeshBasicMaterial(),
    ));
    ratchet.add(new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.009, 0.007, 24),
      new THREE.MeshBasicMaterial(),
    ));
    bit.add(new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.002, 0.018, 24),
      new THREE.MeshBasicMaterial(),
    ));
    const blur = new THREE.Mesh(
      new THREE.PlaneGeometry(0.12, 0.12),
      new THREE.MeshBasicMaterial(),
    );
    blur.name = "blurRing";
    root.add(blur);
    const sphere = intactBeyCollisionSphere(root);
    expect(sphere.radius).toBeGreaterThan(0.024);
    expect(sphere.radius).toBeLessThan(0.04);
  });

  it("never disassembles on visual progress alone, even at full travel", () => {
    const { root, ratchet, bit } = makeBey();
    const rig = buildBurstLatchRig(root)!;
    const progress = updateBurstLatchRig(rig, 4, 4, 1 / 60);
    expect(progress.readyToSeparate).toBe(true);
    expect(ratchet.parent).toBe(root);
    expect(bit.parent).toBe(root);
    expect(root.children).toHaveLength(3);
  });

  it("preserves the complete part pose when the authorized Burst detaches", () => {
    const scene = new THREE.Scene();
    const bey = new THREE.Group();
    const part = new THREE.Group();
    scene.add(bey);
    bey.position.set(0.14, -0.08, 0.032);
    bey.rotation.set(0.35, -0.22, 1.4);
    // Production Bey roots are uniformly scaled; non-uniform parent scale
    // plus rotation creates shear that no Object3D TRS can exactly retain.
    bey.scale.setScalar(1.2);
    part.position.set(0.004, -0.003, 0.018);
    part.rotation.set(-0.12, 0.18, 0.31);
    part.scale.set(0.8, 1.1, 0.95);
    bey.add(part);
    scene.updateMatrixWorld(true);
    const uuid = part.uuid;
    const beforePosition = part.getWorldPosition(new THREE.Vector3());
    const beforeQuaternion = part.getWorldQuaternion(new THREE.Quaternion());
    const beforeScale = part.getWorldScale(new THREE.Vector3());

    detachBurstPartPreservingWorld(scene, part);

    const afterPosition = part.getWorldPosition(new THREE.Vector3());
    const afterQuaternion = part.getWorldQuaternion(new THREE.Quaternion());
    const afterScale = part.getWorldScale(new THREE.Vector3());
    expect(part.parent).toBe(scene);
    expect(part.uuid).toBe(uuid);
    expect(afterPosition.distanceTo(beforePosition)).toBeLessThan(1e-10);
    expect(afterQuaternion.angleTo(beforeQuaternion)).toBeLessThan(1e-10);
    expect(afterScale.distanceTo(beforeScale)).toBeLessThan(1e-10);
  });

  it("uses the TT topology: coupled lower assembly normally, rare Bit ejection only", () => {
    expect(burstSeparationTopology(0)).toBe("blade-lower");
    expect(burstSeparationTopology(0.749)).toBe("blade-lower");
    expect(burstSeparationTopology(0.75)).toBe("blade-ratchet-bit");
    expect(burstSeparationTopology(1)).toBe("blade-ratchet-bit");

    const masses = burstPartMasses(0.044, null);
    expect(masses.bladeKg + masses.ratchetKg + masses.bitKg).toBeCloseTo(0.044, 10);
    expect(masses.bladeKg).toBeGreaterThan(masses.ratchetKg);
    expect(masses.ratchetKg).toBeGreaterThan(masses.bitKg);
  });

  it("keeps a complete CX upper rigid and groups Ratchet+Bit as one normal body", () => {
    const scene = new THREE.Scene();
    const bey = new THREE.Group();
    const blade = new THREE.Group();
    blade.name = "part:blade";
    for (const name of ["CX lock chip", "CX main blade", "CX assist blade"]) {
      const component = new THREE.Mesh(
        new THREE.BoxGeometry(0.01, 0.01, 0.003),
        new THREE.MeshBasicMaterial(),
      );
      component.name = name;
      blade.add(component);
    }
    const ratchet = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006), new THREE.MeshBasicMaterial());
    ratchet.name = "part:ratchet";
    const bit = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.002, 0.018), new THREE.MeshBasicMaterial());
    bit.name = "part:bit";
    scene.add(bey);
    bey.add(blade, ratchet, bit);
    scene.updateMatrixWorld(true);

    const upper = groupBurstRigidAssembly(scene, [blade], "upper")!;
    const lower = groupBurstRigidAssembly(scene, [ratchet, bit], "lower")!;

    expect(upper.children).toEqual([blade]);
    expect(blade.children.map((child) => child.name)).toEqual([
      "CX lock chip",
      "CX main blade",
      "CX assist blade",
    ]);
    expect(lower.children).toEqual([ratchet, bit]);
    expect(scene.children.filter((child) => child.userData.burstRigidBody)).toHaveLength(2);
    expect(bey.children.filter((child) => child.name.startsWith("part:"))).toHaveLength(0);
  });

  it("derives support points and inherits translational plus tangential velocity", () => {
    const carrier = new THREE.Group();
    carrier.position.set(0.1, 0, 0.03);
    carrier.add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.008), new THREE.MeshBasicMaterial()));
    carrier.updateMatrixWorld(true);
    const support = geometrySupportPoints(carrier);
    expect(support.length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...support.map((point) => point.z))).toBeLessThan(0);
    const body = buildBurstDebrisBody(
      carrier,
      "blade",
      0.034,
      new THREE.Vector3(),
      new THREE.Vector3(1, 2, 0),
      new THREE.Vector3(0, 0, 10),
      7,
    );
    expect(body.velocity.x).toBeCloseTo(1, 10);
    expect(body.velocity.y).toBeCloseTo(3, 10); // omega × (0.1, 0, 0)
    expect(body.inertia.x).toBeGreaterThan(0);
    expect(body.inertia.z).toBeGreaterThan(body.inertia.x);
  });

  it("uses a seeded, capped, momentum-balanced release impulse", () => {
    const makeBodies = (): BurstDebrisBody[] => {
      const bladeCarrier = new THREE.Group();
      bladeCarrier.position.set(0, 0, 0.02);
      const lowerCarrier = new THREE.Group();
      lowerCarrier.position.set(0, 0, 0.01);
      return [
        buildBurstDebrisBody(bladeCarrier, "blade", 0.035, new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(0, 0, 180), 1),
        buildBurstDebrisBody(lowerCarrier, "lower", 0.009, new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(0, 0, 180), 2),
      ];
    };
    const first = makeBodies();
    const second = makeBodies();
    const momentumBefore = first.reduce(
      (sum, body) => sum.addScaledVector(body.velocity, body.massKg),
      new THREE.Vector3(),
    );
    const magnitude = applyBurstReleaseImpulse(
      first,
      releaseState(),
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, 1),
    );
    applyBurstReleaseImpulse(second, releaseState(), new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    const momentumAfter = first.reduce(
      (sum, body) => sum.addScaledVector(body.velocity, body.massKg),
      new THREE.Vector3(),
    );
    expect(magnitude).toBeLessThanOrEqual(0.0012);
    expect(momentumAfter.distanceTo(momentumBefore)).toBeLessThan(1e-10);
    for (let i = 0; i < first.length; i++) {
      expectVectorClose(first[i]!.velocity, second[i]!.velocity);
      expectVectorClose(first[i]!.angularVelocity, second[i]!.angularVelocity);
    }
  });

  it("advances identically across render frame partitions at fixed 240 Hz", () => {
    const carrier = new THREE.Group();
    carrier.position.set(0.03, 0.02, 0.045);
    const original = buildBurstDebrisBody(
      carrier,
      "ratchet",
      0.0065,
      new THREE.Vector3(),
      new THREE.Vector3(0.16, -0.08, 0.04),
      new THREE.Vector3(5, 8, 35),
      42,
    );
    const at60 = cloneBody(original);
    const at120 = cloneBody(original);
    let acc60 = 0;
    let acc120 = 0;
    for (let i = 0; i < 60; i++) acc60 = advanceBurstDebris([at60], STADIUM_BX10, 1 / 60, acc60);
    for (let i = 0; i < 120; i++) acc120 = advanceBurstDebris([at120], STADIUM_BX10, 1 / 120, acc120);
    expect(at60.position.distanceTo(at120.position)).toBeLessThan(1e-9);
    expect(at60.quaternion.angleTo(at120.quaternion)).toBeLessThan(1e-9);
    expect(at60.velocity.distanceTo(at120.velocity)).toBeLessThan(1e-9);
    expect(at60.angularVelocity.distanceTo(at120.angularVelocity)).toBeLessThan(1e-9);
    expect(acc60).toBeCloseTo(acc120, 12);
  });

  it("sweeps a moving intact-Bey proxy identically at 60 and 120 Hz", () => {
    const makeBody = (): BurstDebrisBody => {
      const carrier = new THREE.Group();
      carrier.position.set(0, 0, 0.05);
      carrier.add(new THREE.Mesh(
        new THREE.BoxGeometry(0.018, 0.018, 0.006),
        new THREE.MeshBasicMaterial(),
      ));
      carrier.updateMatrixWorld(true);
      return buildBurstDebrisBody(
        carrier,
        "ratchet",
        0.0065,
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3(),
        73,
      );
    };
    const at60 = makeBody();
    const at120 = makeBody();
    const run = (body: BurstDebrisBody, fps: number): number => {
      const frameDt = 1 / fps;
      let accumulator = 0;
      for (let frame = 1; frame <= fps / 10; frame++) {
        const endTime = frame * frameDt;
        const collider: BurstKinematicCollider = {
          position: new THREE.Vector3(-0.06 + endTime, 0, 0.05),
          velocity: new THREE.Vector3(1, 0, 0),
          angularVelocity: new THREE.Vector3(0, 0, 150),
          radiusM: 0.025,
          restitution: 0.2,
          friction: 0.28,
        };
        accumulator = advanceBurstDebris(
          [body],
          null,
          frameDt,
          accumulator,
          [collider],
        );
      }
      return accumulator;
    };
    const acc60 = run(at60, 60);
    const acc120 = run(at120, 120);
    expect(at60.position.distanceTo(at120.position)).toBeLessThan(1e-9);
    expect(at60.quaternion.angleTo(at120.quaternion)).toBeLessThan(1e-9);
    expect(at60.velocity.distanceTo(at120.velocity)).toBeLessThan(1e-9);
    expect(at60.position.x).toBeGreaterThan(0.001); // the swept proxy made contact
    expect(acc60).toBeCloseTo(acc120, 12);
  });

  it("clears initial upper/lower interpenetration without tunnelling through", () => {
    const upperCarrier = new THREE.Group();
    upperCarrier.position.set(0, 0, 0.019);
    upperCarrier.add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.01), new THREE.MeshBasicMaterial()));
    const lowerCarrier = new THREE.Group();
    lowerCarrier.position.set(0, 0, 0.013);
    lowerCarrier.add(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.012, 32), new THREE.MeshBasicMaterial()));
    upperCarrier.updateMatrixWorld(true);
    lowerCarrier.updateMatrixWorld(true);
    const upper = buildBurstDebrisBody(upperCarrier, "blade", 0.035, new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), 11);
    const lower = buildBurstDebrisBody(lowerCarrier, "lower", 0.009, new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), 12);
    const initialOrder = Math.sign(upper.position.z - lower.position.z);
    const initialOverlap = burstBodyWorldBounds(upper).intersect(burstBodyWorldBounds(lower)).getSize(new THREE.Vector3()).z;
    expect(initialOverlap).toBeGreaterThan(0);
    let contacts = 0;
    for (let i = 0; i < 80; i++) contacts += resolveBurstBodyContacts([upper, lower]);
    const finalIntersection = burstBodyWorldBounds(upper).intersect(burstBodyWorldBounds(lower));
    const finalOverlap = finalIntersection.isEmpty() ? 0 : finalIntersection.getSize(new THREE.Vector3()).z;
    expect(contacts).toBeGreaterThan(0);
    expect(finalOverlap).toBeLessThan(1e-6);
    expect(Math.sign(upper.position.z - lower.position.z)).toBe(initialOrder);
  });

  it("cannot ghost through the surviving Bey at the release contact", () => {
    const carrier = new THREE.Group();
    carrier.position.set(0.045, 0, 0.018);
    carrier.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.04, 0.008),
      new THREE.MeshBasicMaterial(),
    ));
    carrier.updateMatrixWorld(true);
    const body = buildBurstDebrisBody(
      carrier,
      "blade",
      0.035,
      new THREE.Vector3(),
      new THREE.Vector3(0.4, 0, 0),
      new THREE.Vector3(0, 0, 180),
      81,
    );
    const collider: BurstKinematicCollider = {
      position: new THREE.Vector3(0.065, 0, 0.018),
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(0, 0, -160),
      radiusM: 0.026,
      restitution: 0.2,
      friction: 0.28,
    };
    const before = body.position.distanceTo(collider.position);
    expect(resolveBurstKinematicContacts([body], [collider])).toBe(1);
    const bodyRadius = Math.max(...body.supportPoints.map((point) => point.length()));
    expect(body.position.distanceTo(collider.position)).toBeGreaterThanOrEqual(
      bodyRadius + collider.radiusM - 1e-8,
    );
    expect(body.position.distanceTo(collider.position)).toBeGreaterThan(before);
    expect(body.velocity.x).toBeLessThan(0);
  });

  it("contacts finite pocket backstops and BX-32's obround casing", () => {
    const pocket = STADIUM_BX10.pockets[0]!;
    const polygon = pocketPolygon(STADIUM_BX10, pocket);
    const inner = new THREE.Vector2(
      (polygon[0]!.x + polygon[3]!.x) / 2,
      (polygon[0]!.y + polygon[3]!.y) / 2,
    );
    const outer = new THREE.Vector2(
      (polygon[1]!.x + polygon[2]!.x) / 2,
      (polygon[1]!.y + polygon[2]!.y) / 2,
    );
    const axis = outer.clone().sub(inner).normalize();
    const pocketCarrier = new THREE.Group();
    pocketCarrier.position.set(
      outer.x + axis.x * 0.008,
      outer.y + axis.y * 0.008,
      0.04,
    );
    const pocketBody = buildBurstDebrisBody(
      pocketCarrier,
      "bit",
      0.0025,
      new THREE.Vector3(),
      new THREE.Vector3(axis.x * 0.4, axis.y * 0.4, 0),
      new THREE.Vector3(),
      93,
    );
    stepBurstDebrisBody(pocketBody, STADIUM_BX10);
    // The backstop leaves the settled part in the tray outside the bowl; it
    // must not snap to the old circular `rWall` approximation.
    expect(stadiumBoundarySignedDistance(
      STADIUM_BX10,
      pocketBody.position.x,
      pocketBody.position.y,
    )).toBeGreaterThan(0.01);
    for (const point of pocketBody.supportPoints) {
      const world = point.clone().applyQuaternion(pocketBody.quaternion).add(pocketBody.position);
      expect(
        stadiumBoundarySignedDistance(STADIUM_BX10, world.x, world.y) <= 1e-6 ||
        pocketAtPoint(STADIUM_BX10, world.x, world.y) !== null,
      ).toBe(true);
    }

    const halfStraight = STADIUM_BX32.wallShape?.kind === "obround"
      ? STADIUM_BX32.wallShape.halfStraight
      : 0;
    const bx32Carrier = new THREE.Group();
    bx32Carrier.position.set(halfStraight + STADIUM_BX32.rWall - 0.001, 0, 0.05);
    const bx32Body = buildBurstDebrisBody(
      bx32Carrier,
      "ratchet",
      0.0065,
      new THREE.Vector3(),
      new THREE.Vector3(0.5, 0, 0),
      new THREE.Vector3(),
      94,
    );
    stepBurstDebrisBody(bx32Body, STADIUM_BX32);
    for (const point of bx32Body.supportPoints) {
      const world = point.clone().applyQuaternion(bx32Body.quaternion).add(bx32Body.position);
      expect(stadiumBoundarySignedDistance(STADIUM_BX32, world.x, world.y)).toBeLessThanOrEqual(1e-6);
    }
  });

  it("retains debris in BX-32's widened catch instead of snapping to its narrow throat", () => {
    const pocket = STADIUM_BX32.pockets.find((entry) => entry.kind === "xtreme")!;
    expect(pocket.throat.catchHalfWidth).toBeTypeOf("number");
    expect(pocket.throat.catchDepth).toBeTypeOf("number");
    const path = pocketPath(STADIUM_BX32, pocket);
    const throat = pocketPolygon(STADIUM_BX32, pocket);
    const catchTray = pocketCatchPolygon(STADIUM_BX32, pocket);
    const along = (point: { x: number; y: number }): number =>
      (point.x - path.boundary.x) * path.axis.x +
      (point.y - path.boundary.y) * path.axis.y;
    const throatBack = Math.max(...throat.map(along));
    const catchBack = Math.max(...catchTray.map(along));
    expect(catchBack).toBeGreaterThan(throatBack + 0.01);
    const outerMidpoint = new THREE.Vector2(
      (catchTray[1]!.x + catchTray[2]!.x) / 2,
      (catchTray[1]!.y + catchTray[2]!.y) / 2,
    );
    const carrier = new THREE.Group();
    carrier.position.set(
      outerMidpoint.x + path.axis.x * 0.008,
      outerMidpoint.y + path.axis.y * 0.008,
      0.04,
    );
    const body = buildBurstDebrisBody(
      carrier,
      "bit",
      0.0025,
      new THREE.Vector3(),
      new THREE.Vector3(path.axis.x * 0.4, path.axis.y * 0.4, 0),
      new THREE.Vector3(),
      95,
    );
    stepBurstDebrisBody(body, STADIUM_BX32);
    const bodyAlong = along(body.position);
    expect(bodyAlong).toBeGreaterThan(throatBack + 0.005);
    expect(bodyAlong).toBeLessThan(catchBack);
    for (const point of body.supportPoints) {
      const world = point.clone().applyQuaternion(body.quaternion).add(body.position);
      expect(
        stadiumBoundarySignedDistance(STADIUM_BX32, world.x, world.y) <= 1e-6 ||
        pocketAtPoint(STADIUM_BX32, world.x, world.y) !== null,
      ).toBe(true);
    }
  });

  it("collides oriented support points with bowl, raised X-Line, wall, and pocket", () => {
    const rail = sampleBurstTerrain(STADIUM_BX10, STADIUM_BX10.rRail, 0);
    expect(rail.onRail).toBe(true);
    expect(rail.height).toBeGreaterThan(surfaceZAt(STADIUM_BX10, STADIUM_BX10.rRail, 0));
    const pocket = STADIUM_BX10.pockets[0]!;
    const polygon = pocketPolygon(STADIUM_BX10, pocket);
    const outerMidpoint = {
      x: (polygon[1]!.x + polygon[2]!.x) / 2,
      y: (polygon[1]!.y + polygon[2]!.y) / 2,
    };
    const pocketTerrain = sampleBurstTerrain(
      STADIUM_BX10,
      outerMidpoint.x,
      outerMidpoint.y,
    );
    expect(pocketTerrain.inPocket).toBe(true);
    expect(pocketTerrain.height).toBeCloseTo(pocketFloorTopZ(STADIUM_BX10), 8);
    const canonical = stadiumTerrainAt(STADIUM_BX10, outerMidpoint.x, outerMidpoint.y);
    expect(pocketTerrain.height).toBe(canonical.height);
    expect(pocketTerrain.normal.x).toBe(canonical.normalX);
    expect(pocketTerrain.normal.y).toBe(canonical.normalY);
    expect(pocketTerrain.normal.z).toBe(canonical.normalZ);

    const carrier = new THREE.Group();
    const body = buildBurstDebrisBody(
      carrier,
      "bit",
      0.0025,
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
      9,
    );
    body.position.set(0, 0, 0.001); // origin above floor, lower support penetrates
    stepBurstDebrisBody(body, STADIUM_BX10);
    const lowest = Math.min(
      ...body.supportPoints.map((point) => point.clone().applyQuaternion(body.quaternion).add(body.position).z),
    );
    expect(lowest).toBeGreaterThanOrEqual(-1e-8);

    body.position.set(STADIUM_BX10.rWall - 0.001, 0, 0.04);
    body.velocity.set(1, 0, 0);
    body.asleep = false;
    stepBurstDebrisBody(body, STADIUM_BX10);
    const outer = Math.max(
      ...body.supportPoints.map((point) => {
        const world = point.clone().applyQuaternion(body.quaternion).add(body.position);
        return Math.hypot(world.x, world.y);
      }),
    );
    expect(outer).toBeLessThanOrEqual(STADIUM_BX10.rWall + 1e-6);
    expect(body.velocity.x).toBeLessThan(1);
  });
});
