import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { buildHand, fingertipOffset, handPoseMetrics } from "../src/render/hand";

function objectsNamed(root: THREE.Object3D, pattern: RegExp): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (pattern.test(object.name)) found.push(object);
  });
  return found;
}

function triangleCount(root: THREE.Object3D): number {
  let triangles = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    triangles += geometry.index
      ? geometry.index.count / 3
      : geometry.getAttribute("position").count / 3;
  });
  return triangles;
}

function assertFiniteGeometry(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute("position") as THREE.BufferAttribute;
    // One assertion per mesh keeps this exhaustive raw-buffer scan cheap;
    // thousands of Vitest matcher calls made the high-poly test itself slow.
    const values = position.array;
    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i])) {
        throw new Error(`${object.name} contains a non-finite position at component ${i}`);
      }
    }
  });
}

describe("anatomical launcher hand", () => {
  it("contains named anatomy instead of a palm box and five identical tubes", () => {
    const hand = buildHand("right", { curl: 0.88, gripR: 0.014 });

    expect(hand.name).toBe("hand:right");
    expect(hand.userData.anatomical).toBe(true);
    expect(hand.getObjectByName("hand:palm")).toBeInstanceOf(THREE.Mesh);
    expect(hand.getObjectByName("hand:thenar")).toBeInstanceOf(THREE.Mesh);
    expect(hand.getObjectByName("hand:hypothenar")).toBeInstanceOf(THREE.Mesh);
    expect(hand.getObjectByName("hand:wrist-transition")).toBeInstanceOf(THREE.Mesh);
    expect(hand.getObjectByName("hand:forearm")).toBeInstanceOf(THREE.Mesh);
    expect(hand.getObjectByName("thumb")).toBeInstanceOf(THREE.Group);

    for (const name of ["index", "middle", "ring", "little"]) {
      expect(hand.getObjectByName(`finger:${name}`)).toBeInstanceOf(THREE.Group);
      expect(hand.getObjectByName(`finger:${name}:proximal`)).toBeInstanceOf(THREE.Mesh);
      expect(hand.getObjectByName(`finger:${name}:middle`)).toBeInstanceOf(THREE.Mesh);
      expect(hand.getObjectByName(`finger:${name}:distal`)).toBeInstanceOf(THREE.Mesh);
      expect(hand.getObjectByName(`finger:${name}:nail`)).toBeInstanceOf(THREE.Mesh);
      expect(hand.getObjectByName(`finger:${name}:tip`)).toBeInstanceOf(THREE.Group);
    }

    expect(objectsNamed(hand, /^hand:web:/)).toHaveLength(3);
    expect(objectsNamed(hand, /:nail$/)).toHaveLength(5);
    expect(objectsNamed(hand, /:crease-/).length).toBeGreaterThanOrEqual(13);
    expect(objectsNamed(hand, /^hand:crease:/)).toHaveLength(4);
  });

  it("keeps a high-poly, finite and watertight-quality render mesh", () => {
    const hand = buildHand("right", { curl: 0.9 });
    assertFiniteGeometry(hand);
    expect(triangleCount(hand)).toBeGreaterThan(70_000);

    const palm = hand.getObjectByName("hand:palm") as THREE.Mesh;
    const position = palm.geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(position.count).toBeGreaterThan(2_000);
    expect(palm.geometry.index?.count ?? 0).toBeGreaterThan(12_000);
  });

  it("uses human proportions and the correct radial-to-ulnar digit order", () => {
    const open = buildHand("right", { curl: 0.05 });
    const metrics = handPoseMetrics(0.05, 0.012);
    expect(metrics.palmLength).toBeCloseTo(0.09, 5);
    expect(metrics.palmWidth).toBeCloseTo(0.079, 5);
    expect(metrics.palmWidth / metrics.palmLength).toBeGreaterThan(0.82);
    expect(metrics.palmWidth / metrics.palmLength).toBeLessThan(0.92);

    const index = open.getObjectByName("finger:index")!;
    const middle = open.getObjectByName("finger:middle")!;
    const ring = open.getObjectByName("finger:ring")!;
    const little = open.getObjectByName("finger:little")!;
    const thumb = open.getObjectByName("thumb")!;
    expect(thumb.position.x).toBeGreaterThan(index.position.x);
    expect(index.position.x).toBeGreaterThan(middle.position.x);
    expect(middle.position.x).toBeGreaterThan(ring.position.x);
    expect(ring.position.x).toBeGreaterThan(little.position.x);
    expect(middle.userData.length).toBeGreaterThan(index.userData.length);
    expect(index.userData.length).toBeGreaterThan(little.userData.length);

    const palm = open.getObjectByName("hand:palm") as THREE.Mesh;
    palm.geometry.computeBoundingBox();
    const size = palm.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeGreaterThan(0.078);
    expect(size.x).toBeLessThan(0.084);
    expect(size.y).toBeGreaterThan(0.027);
    expect(size.y).toBeLessThan(0.036);
    expect(size.z).toBeCloseTo(0.09, 4);
  });

  it("mirrors the complete thumb and anatomy for a true left hand", () => {
    const right = buildHand("right", { curl: 0.82, gripR: 0.013 });
    const left = buildHand("left", { curl: 0.82, gripR: 0.013 });
    right.updateMatrixWorld(true);
    left.updateMatrixWorld(true);

    const rt = right.getObjectByName("thumb")!.getWorldPosition(new THREE.Vector3());
    const lt = left.getObjectByName("thumb")!.getWorldPosition(new THREE.Vector3());
    expect(rt.x).toBeGreaterThan(0);
    expect(lt.x).toBeLessThan(0);
    expect(Math.abs(lt.x)).toBeCloseTo(rt.x, 6);
    expect(lt.y).toBeCloseTo(rt.y, 6);
    expect(lt.z).toBeCloseTo(rt.z, 6);

    const rb = new THREE.Box3().setFromObject(right);
    const lb = new THREE.Box3().setFromObject(left);
    expect(lb.min.x).toBeCloseTo(-rb.max.x, 5);
    expect(lb.max.x).toBeCloseTo(-rb.min.x, 5);
    expect(left.scale.x).toBe(-1);
  });

  it("forms a palm-side grasp and opens for a larger launcher shell", () => {
    const len = 0.068;
    const openTip = fingertipOffset(len, 0);
    const closedTip = fingertipOffset(len, 0.94);
    expect(openTip.y).toBeCloseTo(0, 8);
    expect(openTip.z).toBeCloseTo(-len, 6);
    expect(closedTip.y).toBeGreaterThan(0);
    expect(Math.hypot(closedTip.y, closedTip.z)).toBeLessThan(len * 0.55);

    const smallGrip = handPoseMetrics(0.94, 0.009);
    const largeGrip = handPoseMetrics(0.94, 0.023);
    const smallReach = Math.hypot(smallGrip.fingertipReach.index.y, smallGrip.fingertipReach.index.z);
    const largeReach = Math.hypot(largeGrip.fingertipReach.index.y, largeGrip.fingertipReach.index.z);
    expect(largeReach).toBeGreaterThan(smallReach);

    const hand = buildHand("right", { curl: 0.94, gripR: 0.014 });
    hand.updateMatrixWorld(true);
    for (const name of ["index", "middle", "ring", "little"]) {
      const root = hand.getObjectByName(`finger:${name}`)!;
      const tip = hand.getObjectByName(`finger:${name}:tip`)!.getWorldPosition(new THREE.Vector3());
      const rootWorld = root.getWorldPosition(new THREE.Vector3());
      expect(tip.y, `${name} closes toward palm`).toBeGreaterThan(rootWorld.y);
      expect(Number.isFinite(tip.x + tip.y + tip.z)).toBe(true);
    }

    const indexMcp = hand.getObjectByName("finger:index:mcp-joint")!;
    const indexPip = hand.getObjectByName("finger:index:pip-joint")!;
    const indexDip = hand.getObjectByName("finger:index:dip-joint")!;
    expect(indexMcp.userData.flexion).toBeGreaterThan(0.9);
    expect(indexPip.userData.flexion).toBeGreaterThan(indexMcp.userData.flexion);
    expect(indexDip.userData.flexion).toBeLessThan(indexPip.userData.flexion);
    expect(hand.getObjectByName("thumb")!.userData.opposition).toBeGreaterThan(0.65);
  });
});
