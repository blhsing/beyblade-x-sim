import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { launcherDirection, normalizeLauncherForSpin } from "../src/core/launcher";
import { STADIUM_BX10, STADIUM_BX32 } from "../src/core/stadium";
import { LAUNCHER_KINDS, type LauncherKind } from "../src/core/types";
import {
  alignLauncherMountToWorld,
  applyLauncherPreviewPose,
  buildLauncher,
  composeLaunchedBeyOrientation,
  LAUNCHER_HAND_POSES,
  LAUNCHER_MODELS,
  launcherShellGeometry,
  launcherAimTiltFromGesture,
  launchCameraFrame,
  launcherExitOrientation,
  orientWorldLauncher,
  setLauncherPull,
  type LauncherRig,
} from "../src/render/launcher";

function meshNames(root: THREE.Object3D): string[] {
  const names: string[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) names.push(o.name);
  });
  return names;
}

function geometryStats(root: THREE.Object3D): { triangles: number; vertices: number } {
  let triangles = 0;
  let vertices = 0;
  let finite = true;
  root.traverse((o) => {
    const geometry = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return;
    const position = geometry.getAttribute("position");
    if (!position) return;
    vertices += position.count;
    triangles += geometry.index ? geometry.index.count / 3 : position.count / 3;
    for (let i = 0; i < position.count; i += 97) {
      finite &&= Number.isFinite(position.getX(i));
      finite &&= Number.isFinite(position.getY(i));
      finite &&= Number.isFinite(position.getZ(i));
    }
  });
  expect(finite).toBe(true);
  return { triangles, vertices };
}

function testRig(kind: LauncherKind): LauncherRig {
  return buildLauncher(kind, 0x3f7bff, { includeHands: false, simpleMaterials: true });
}

function dispose(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    if (Array.isArray(m.material)) m.material.forEach((material) => material.dispose());
    else m.material?.dispose();
  });
}

describe("Takara Tomy launcher catalog", () => {
  it("exposes every mechanically distinct current X launcher in the picker order", () => {
    expect(LAUNCHER_KINDS).toEqual([
      "entry",
      "winder",
      "longWinder",
      "hold",
      "string",
      "winderL",
      "stringL",
    ]);
    expect(Object.keys(LAUNCHER_MODELS).sort()).toEqual([...LAUNCHER_KINDS].sort());
    expect(LAUNCHER_MODELS.entry.product).toBe("BX-22");
    expect(LAUNCHER_MODELS.string.product).toBe("BX-18");
    expect(LAUNCHER_MODELS.winderL.product).toBe("BX-40");
    expect(LAUNCHER_MODELS.stringL.product).toBe("BX-47");
    expect(LAUNCHER_MODELS.hold.product).toBe("UX-09");
    expect(LAUNCHER_MODELS.longWinder.product).toBe("UX-14");
  });

  it("keeps left and right drive trains physically compatible", () => {
    for (const kind of LAUNCHER_KINDS) {
      expect(launcherDirection(kind)).toBe(LAUNCHER_MODELS[kind].direction);
    }
    expect(normalizeLauncherForSpin("winder", -1)).toBe("winderL");
    expect(normalizeLauncherForSpin("string", -1)).toBe("stringL");
    expect(normalizeLauncherForSpin("hold", -1)).toBe("winderL");
    expect(normalizeLauncherForSpin("winderL", 1)).toBe("winder");
    expect(normalizeLauncherForSpin("stringL", 1)).toBe("string");
    expect(normalizeLauncherForSpin("stringL", -1)).toBe("stringL");
  });

  it("uses the photographed proportions rather than one generic shell", () => {
    expect(LAUNCHER_MODELS.entry.bodyLengthM).toBeLessThan(LAUNCHER_MODELS.winder.bodyLengthM);
    expect(LAUNCHER_MODELS.hold.bodyLengthM).toBeGreaterThan(LAUNCHER_MODELS.string.bodyLengthM);
    expect(LAUNCHER_MODELS.longWinder.pullLengthM).toBeGreaterThan(
      LAUNCHER_MODELS.winder.pullLengthM * 1.3,
    );
    const signatures = new Set(
      LAUNCHER_KINDS.map((kind) => {
        const s = LAUNCHER_MODELS[kind];
        return `${s.mechanism}:${s.bodyLengthM}:${s.bodyWidthM}:${s.direction}`;
      }),
    );
    expect(signatures.size).toBeGreaterThanOrEqual(6);
  });

  it("keeps the canonical product colourways", () => {
    expect(LAUNCHER_MODELS.entry.shellColor).toBe(0xeeeeef);
    expect(LAUNCHER_MODELS.winderL.pullColor).toBe(0xb51f5b);
    expect(LAUNCHER_MODELS.longWinder.pullColor).toBe(0xefc51d);
    expect(LAUNCHER_MODELS.hold.trimColor).toBe(0x724d91);
    expect(LAUNCHER_MODELS.hold.pullColor).toBe(0x78c943);
    expect(LAUNCHER_MODELS.stringL.shellColor).toBe(0xd3181d);
    expect(LAUNCHER_MODELS.stringL.trimColor).toBe(0xbfc4c5);
  });

  it("generates finite, dense shell and mechanism meshes for every type", () => {
    for (const kind of LAUNCHER_KINDS) {
      const shell = launcherShellGeometry(kind);
      const shellPosition = shell.getAttribute("position");
      expect(shellPosition.count, `${kind} shell vertices`).toBeGreaterThan(250);
      shell.dispose();

      const rig = testRig(kind);
      const stats = geometryStats(rig.group);
      expect(stats.triangles, `${kind} triangles`).toBeGreaterThan(9_000);
      expect(stats.vertices, `${kind} vertices`).toBeGreaterThan(9_000);
      expect(rig.beyMount.name).toBe("three-prong bey mount");
      dispose(rig.group);
    }
  });

  it("builds mechanism-specific details instead of recolouring one placeholder", () => {
    const entry = testRig("entry");
    const winder = testRig("winder");
    const longWinder = testRig("longWinder");
    const hold = testRig("hold");
    const string = testRig("string");
    try {
      expect(meshNames(entry.group)).toContain("toothed winder rack");
      expect(entry.cord.visible).toBe(false);
      expect(LAUNCHER_MODELS.entry.pullLengthM).toBeLessThan(LAUNCHER_MODELS.winder.pullLengthM);

      expect(meshNames(winder.group)).toContain("winder finger loop");
      expect(meshNames(longWinder.group)).toContain("long-winder T handle");
      expect(meshNames(hold.group).filter((name) => name === "UX-09 rubber grip panel")).toHaveLength(4);

      expect(meshNames(string.group)).toContain("retractable string spool");
      expect(meshNames(string.group)).toContain("retractable launcher string");
      expect(string.cord.visible).toBe(true);
    } finally {
      for (const rig of [entry, winder, longWinder, hold, string]) dispose(rig.group);
    }
  });

  it("mirrors the three mounting claws for L launchers", () => {
    const right = testRig("winder");
    const left = testRig("winderL");
    try {
      const rightClaws = right.beyMount.children.filter((o) => o.name === "right-spin sprung mounting claw");
      const leftClaws = left.beyMount.children.filter((o) => o.name === "left-spin sprung mounting claw");
      expect(rightClaws).toHaveLength(3);
      expect(leftClaws).toHaveLength(3);
      expect(rightClaws.every((o) => o.userData.spinDirection === 1)).toBe(true);
      expect(leftClaws.every((o) => o.userData.spinDirection === -1)).toBe(true);
      expect(Math.sign(rightClaws[0]!.rotation.z)).not.toBe(Math.sign(leftClaws[0]!.rotation.z));
    } finally {
      dispose(right.group);
      dispose(left.group);
    }
  });

  it("authors both palms against a real grip surface instead of floating", () => {
    for (const kind of LAUNCHER_KINDS) {
      const rig = testRig(kind);
      try {
        const holding = rig.group.getObjectByName("launcher holding hand")!;
        const holdTarget = holding.userData.gripTarget as THREE.Vector3;
        expect(holdTarget, `${kind} holding contact`).toBeInstanceOf(THREE.Vector3);
        // The anatomical root is at the wrist/palm heel, while the authored
        // contact is at the distal palm/finger wrap on the shell.
        expect(holding.position.distanceTo(holdTarget), `${kind} palm gap`).toBeGreaterThan(0.005);
        expect(holding.position.distanceTo(holdTarget), `${kind} palm gap`).toBeLessThan(0.06);

        const pullTarget = rig.pullHand.userData.gripTarget as THREE.Vector3;
        expect(pullTarget, `${kind} pulling contact`).toBeInstanceOf(THREE.Vector3);
        expect(rig.pullHand.position.distanceTo(pullTarget), `${kind} pull-hand gap`).toBeLessThan(0.02);
      } finally {
        dispose(rig.group);
      }
    }
  });

  it("applies a distinct hold and pull pose for every launcher product", () => {
    const signatures = new Set<string>();
    for (const kind of LAUNCHER_KINDS) {
      const pose = LAUNCHER_HAND_POSES[kind];
      signatures.add(JSON.stringify(pose));
      const rig = testRig(kind);
      try {
        const holding = rig.group.getObjectByName("launcher holding hand")!;
        expect(holding.position.toArray()).toEqual([...pose.hold.position]);
        expect([holding.rotation.x, holding.rotation.y, holding.rotation.z]).toEqual([...pose.hold.rotation]);
        expect(holding.scale.x).toBe(pose.hold.scale);
        expect(holding.userData.poseSide).toBe(pose.hold.side);
        expect(holding.userData.poseCurl).toBe(pose.hold.curl);
        expect(holding.userData.poseGripR).toBe(pose.hold.gripR);
        expect((holding.userData.gripTarget as THREE.Vector3).toArray()).toEqual([...pose.hold.contact]);

        expect(rig.pullHand.position.toArray()).toEqual([...pose.pull.position]);
        expect([rig.pullHand.rotation.x, rig.pullHand.rotation.y, rig.pullHand.rotation.z]).toEqual([...pose.pull.rotation]);
        expect(rig.pullHand.scale.x).toBe(pose.pull.scale);
        expect(rig.pullHand.userData.poseSide).toBe(pose.pull.side);
        expect(rig.pullHand.userData.poseCurl).toBe(pose.pull.curl);
        expect(rig.pullHand.userData.poseGripR).toBe(pose.pull.gripR);
        expect((rig.pullHand.userData.gripTarget as THREE.Vector3).toArray()).toEqual([...pose.pull.contact]);
      } finally {
        dispose(rig.group);
      }
    }
    expect(signatures.size).toBe(LAUNCHER_KINDS.length);
  });

  it("mirrors both operating hands for left-spin launcher housings", () => {
    const winderR = LAUNCHER_HAND_POSES.winder;
    const winderL = LAUNCHER_HAND_POSES.winderL;
    const stringR = LAUNCHER_HAND_POSES.string;
    const stringL = LAUNCHER_HAND_POSES.stringL;
    for (const [right, left] of [[winderR, winderL], [stringR, stringL]] as const) {
      expect(left.hold.side).not.toBe(right.hold.side);
      expect(left.pull.side).not.toBe(right.pull.side);
      expect(left.hold.position[1]).toBeCloseTo(-right.hold.position[1], 6);
      expect(left.hold.contact[1]).toBeCloseTo(-right.hold.contact[1], 6);
      expect(left.pull.position[0]).toBeCloseTo(-right.pull.position[0], 6);
      expect(left.pull.rotation[1]).toBeCloseTo(-right.pull.rotation[1], 6);
    }
  });

  it("exposes product travel and constrains rigid racks to their authored axis", () => {
    for (const kind of ["entry", "winder", "longWinder", "hold", "winderL"] as const) {
      const rig = testRig(kind);
      try {
        expect(rig.maxPullM).toBe(LAUNCHER_MODELS[kind].maxPullM);
        expect(rig.pullAxis.toArray()).toEqual([LAUNCHER_MODELS[kind].direction, 0, 0]);
        const state = setLauncherPull(rig, rig.maxPullM * 0.6, 10);
        const delta = rig.puller.position.clone().sub(rig.pullerHome);
        expect(delta.clone().cross(rig.pullAxis).length()).toBeLessThan(1e-10);
        expect(delta.dot(rig.pullAxis)).toBeCloseTo(rig.maxPullM * 0.6, 8);
        expect(state.lateralM).toBe(0);
        expect(state.fraction).toBeCloseTo(0.6, 8);
        expect(state.energy).toBeCloseTo(0.36, 8);
      } finally {
        dispose(rig.group);
      }
    }
  });

  it("lets string handles follow a bounded pull cone while the hand stays attached", () => {
    for (const kind of ["string", "stringL"] as const) {
      const rig = testRig(kind);
      try {
        const handParent = rig.pullHand.parent;
        const state = setLauncherPull(rig, rig.maxPullM * 0.5, 1);
        expect(handParent).toBe(rig.puller);
        expect(state.lateralM).toBeGreaterThan(0);
        expect(state.lateralM).toBeLessThan(rig.maxPullM * 0.5 * 0.3);
        expect(rig.puller.position.clone().sub(rig.pullerHome).dot(rig.pullAxis)).toBeCloseTo(
          rig.maxPullM * 0.5,
          8,
        );
        expect(rig.cord.scale.y).toBeGreaterThan(0.04);
      } finally {
        dispose(rig.group);
      }
    }
  });

  it("mirrors the entire L rack and exit, not only its mounting prongs", () => {
    const right = testRig("winder");
    const left = testRig("winderL");
    try {
      expect(Math.sign(right.pullerHome.x)).toBe(1);
      expect(Math.sign(left.pullerHome.x)).toBe(-1);
      const rightRack = right.group.getObjectByName("toothed winder rack")!;
      const leftRack = left.group.getObjectByName("toothed winder rack")!;
      expect(Math.sign(rightRack.position.x)).toBe(-1);
      expect(Math.sign(leftRack.position.x)).toBe(1);
      expect(Math.abs(leftRack.position.x)).toBeCloseTo(LAUNCHER_MODELS.winderL.pullLengthM / 2, 8);
      setLauncherPull(right, right.maxPullM);
      setLauncherPull(left, left.maxPullM);
      expect(Math.sign(right.puller.position.x - right.pullerHome.x)).toBe(1);
      expect(Math.sign(left.puller.position.x - left.pullerHome.x)).toBe(-1);
    } finally {
      dispose(right.group);
      dispose(left.group);
    }
  });

  it("solves the mounted bey tip to an exact world release target", () => {
    const rig = testRig("stringL");
    const scene = new THREE.Scene();
    const bey = new THREE.Group();
    try {
      scene.add(rig.group);
      rig.group.position.set(-0.18, 0.07, 0.22);
      rig.group.rotation.set(0.08, -0.12, 2.3);
      rig.group.scale.setScalar(0.83);
      rig.beyMount.add(bey);
      bey.position.set(0.001, -0.002, -0.016);
      const target = new THREE.Vector3(0.213, -0.147, 0.14);
      const actual = alignLauncherMountToWorld(rig, bey, target);
      expect(actual.distanceTo(target)).toBeLessThan(1e-10);
      expect(bey.parent).toBe(rig.beyMount);
    } finally {
      dispose(rig.group);
    }
  });

  it("authors world launcher yaw and tilt from the canonical trajectory", () => {
    for (const kind of ["winder", "winderL"] as const) {
      const rig = testRig(kind);
      try {
        const heading = -1.13;
        const radial = 0.42;
        orientWorldLauncher(rig, heading, 47, radial);
        const physicalAxis = rig.pullAxis.clone().applyQuaternion(rig.group.quaternion);
        const topAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.group.quaternion);
        expect(Math.atan2(topAxis.y, topAxis.x)).toBeCloseTo(radial, 8);
        expect(THREE.MathUtils.radToDeg(Math.acos(topAxis.z))).toBeCloseTo(47, 8);
        const headingProjected = new THREE.Vector3(Math.cos(heading), Math.sin(heading), 0)
          .projectOnPlane(topAxis)
          .normalize();
        expect(physicalAxis.angleTo(headingProjected)).toBeLessThan(1e-8);
        expect(rig.group.userData.visualHeadingRad).toBe(heading);
        expect(rig.group.userData.visualTiltDeg).toBeCloseTo(47, 8);
        expect(rig.group.userData.visualRadialAngleRad).toBe(radial);

        const first = composeLaunchedBeyOrientation(rig.group.quaternion, 0.3);
        const later = composeLaunchedBeyOrientation(rig.group.quaternion, 4.8);
        const firstTop = new THREE.Vector3(0, 0, 1).applyQuaternion(first);
        const laterTop = new THREE.Vector3(0, 0, 1).applyQuaternion(later);
        expect(firstTop.distanceTo(laterTop)).toBeLessThan(1e-10);
        expect(firstTop.distanceTo(topAxis)).toBeLessThan(1e-10);
      } finally {
        dispose(rig.group);
      }
    }
  });

  it("shares the same full-range aim and tilt mapping with live gesture feedback", () => {
    expect(launcherAimTiltFromGesture({ gestureAngleDeg: 0, pullQuality: 1 })).toEqual({
      aimDeg: 0,
      tiltDeg: 0,
    });
    expect(launcherAimTiltFromGesture({ gestureAngleDeg: 90, pullQuality: 0 })).toEqual({
      aimDeg: 35,
      tiltDeg: 70,
    });
    expect(launcherAimTiltFromGesture({ gestureAngleDeg: -90, pullQuality: 0.5 })).toEqual({
      aimDeg: -35,
      tiltDeg: 38,
    });
  });

  it("keeps the exact live launcher pose at the first release frame", () => {
    const live = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.71, -0.43, 1.2));
    const first = launcherExitOrientation(live, 0);
    expect(first.angleTo(live)).toBeLessThan(1e-12);
    expect(launcherExitOrientation(live, 1).angleTo(live)).toBeGreaterThan(0.2);
  });

  it("keeps representative full hand rigs inside a portrait launch frustum", () => {
    const camera = new THREE.PerspectiveCamera(55, 9 / 16, 0.005, 20);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    for (const kind of ["hold", "stringL"] as const) {
      const rig = buildLauncher(kind, 0x3f7bff, { simpleMaterials: true });
      try {
        applyLauncherPreviewPose(rig);
        rig.group.updateWorldMatrix(true, true);
        const box = new THREE.Box3();
        rig.group.traverse((object) => {
          const candidate = object as THREE.Mesh;
          if (!candidate.visible || !candidate.geometry) return;
          candidate.geometry.computeBoundingBox();
          if (candidate.geometry.boundingBox) {
            box.union(candidate.geometry.boundingBox.clone().applyMatrix4(candidate.matrixWorld));
          }
        });
        let maxX = 0;
        let maxY = 0;
        let minDepth = Infinity;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const world = new THREE.Vector3(x, y, z);
              minDepth = Math.min(minDepth, -world.z);
              world.project(camera);
              maxX = Math.max(maxX, Math.abs(world.x));
              maxY = Math.max(maxY, Math.abs(world.y));
            }
          }
        }
        expect(minDepth, `${kind} in front of near plane`).toBeGreaterThan(0.005);
        expect(
          maxX,
          `${kind} horizontal NDC box=${box.min.toArray().join(",")}/${box.max.toArray().join(",")} maxY=${maxY}`,
        ).toBeLessThan(0.98);
        expect(maxY, `${kind} vertical NDC`).toBeLessThan(0.98);
      } finally {
        dispose(rig.group);
      }
    }
  }, 15_000);

  it("preserves BX-10 framing and fits the full BX-32 shell at 1280x720", () => {
    expect(launchCameraFrame(STADIUM_BX10, 0).position.toArray()).toEqual([-0.16, -0.4, 0.3]);
    expect(launchCameraFrame(STADIUM_BX10, 1).position.toArray()).toEqual([0.16, -0.4, 0.3]);

    for (const side of [0, 1] as const) {
      const frame = launchCameraFrame(STADIUM_BX32, side);
      const camera = new THREE.PerspectiveCamera(55, 1280 / 720, 0.005, 20);
      camera.up.set(0, 0, 1);
      camera.position.copy(frame.position);
      camera.lookAt(frame.target);
      camera.updateMatrixWorld(true);
      let maxX = 0;
      let maxY = 0;
      const topZ = STADIUM_BX32.dishDepth + STADIUM_BX32.rimRise +
        STADIUM_BX32.rimBaseSlope * (STADIUM_BX32.rWall - STADIUM_BX32.rDish) +
        STADIUM_BX32.coverHeight;
      for (const x of [-STADIUM_BX32.deckW / 2, STADIUM_BX32.deckW / 2]) {
        for (const y of [-STADIUM_BX32.deckH / 2, STADIUM_BX32.deckH / 2]) {
          for (const z of [0, topZ]) {
            const projected = new THREE.Vector3(x, y, z).project(camera);
            maxX = Math.max(maxX, Math.abs(projected.x));
            maxY = Math.max(maxY, Math.abs(projected.y));
          }
        }
      }
      expect(maxX, `BX-32 side ${side} horizontal`).toBeLessThan(0.98);
      expect(maxY, `BX-32 side ${side} vertical`).toBeLessThan(0.98);
    }
  });
});
