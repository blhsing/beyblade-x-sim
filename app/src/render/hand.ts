// Hands and launchers.
//
// Hands are built anatomically — palm, four fingers of three phalanges with
// real curl, an opposed thumb, a wrist — because a blob reads as wrong
// instantly at the bottom of the screen where the launcher lives. Launchers
// are the three real Beyblade X types (docs/MODELING.md §3): the winder
// (ripcord) launcher, the string launcher, and the pistol-style gear grip
// that clips onto either.
//
// All local units are metres. A launcher's origin is its bey mount axis, +Z
// up, +X toward the string/ripcord exit, so the rig can be posed by the
// caller without knowing the internals.

import * as THREE from "three";

import { absPlastic, paintedMetal, rubberMat, skinMat } from "./materials";
import { DETAIL } from "./parts";

export type HandSide = "left" | "right";

/** One finger: three tapering phalanges hinged with a natural curl. */
function buildFinger(
  len: number,
  radius: number,
  curl: number,
  mat: THREE.Material,
): THREE.Group {
  const root = new THREE.Group();
  const segs = [0.42, 0.32, 0.26];
  const bendPer = [0.55, 0.75, 0.62];
  let parent = root;
  for (let i = 0; i < 3; i++) {
    const joint = new THREE.Group();
    joint.rotation.x = -curl * bendPer[i]!;
    parent.add(joint);
    const l = len * segs[i]!;
    const r = radius * (1 - i * 0.16);
    const bone = new THREE.Mesh(new THREE.CapsuleGeometry(r, l * 0.72, 18, DETAIL.radial / 2), mat);
    bone.rotation.x = Math.PI / 2;
    bone.position.z = -l / 2;
    bone.castShadow = true;
    joint.add(bone);
    const next = new THREE.Group();
    next.position.z = -l;
    joint.add(next);
    parent = next;
  }
  // fingernail on the distal phalanx
  const nail = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.62, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: 0xf0d8cc, roughness: 0.32, clearcoat: 0.7 }),
  );
  nail.scale.set(1, 0.5, 0.9);
  nail.position.set(0, radius * 0.5, len * 0.08);
  parent.add(nail);
  return root;
}

/**
 * A hand gripping a cylinder of `gripR` along its local Y axis. `curl`
 * 0 = open, 1 = closed fist. Origin is the centre of the palm.
 */
export function buildHand(
  side: HandSide,
  opts: { curl?: number; gripR?: number; tone?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  const curl = opts.curl ?? 0.85;
  const gripR = opts.gripR ?? 0.012;
  const mat = skinMat(opts.tone ?? 0xe2ab86);
  const mirror = side === "left" ? -1 : 1;

  // palm: a flattened, slightly wedge-shaped box with soft edges
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.026, 0.078, 24, 16, 32), mat);
  palm.geometry.translate(0, 0, 0);
  palm.scale.set(1, 1, 1);
  palm.castShadow = true;
  g.add(palm);
  const heel = new THREE.Mesh(new THREE.SphereGeometry(0.021, DETAIL.radial / 2, DETAIL.rings), mat);
  heel.scale.set(1.25, 0.62, 1.0);
  heel.position.set(0, -0.002, 0.03);
  g.add(heel);

  // four fingers along the leading edge, curling around the grip
  const spread = [0.9, 1.0, 0.97, 0.86];
  for (let i = 0; i < 4; i++) {
    const f = buildFinger(0.072 * spread[i]!, 0.0082 - i * 0.0004, curl * (0.92 + i * 0.03), mat);
    f.position.set(mirror * (-0.019 + i * 0.0128), 0.006, -0.036);
    f.rotation.z = mirror * (0.1 - i * 0.06);
    f.rotation.x = 0.25;
    g.add(f);
  }
  // thumb: opposed, wrapping across the front of the grip
  const thumb = buildFinger(0.056, 0.0098, curl * 0.72, mat);
  thumb.position.set(mirror * -0.026, 0.004, 0.006);
  thumb.rotation.set(0.5, mirror * -1.05, mirror * 0.45);
  g.add(thumb);

  // wrist stub so the hand does not float
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.024, 0.05, DETAIL.radial / 2, 8), mat);
  wrist.rotation.x = Math.PI / 2;
  wrist.position.set(0, -0.002, 0.062);
  g.add(wrist);
  g.userData.gripR = gripR;
  return g;
}

export interface LauncherRig {
  group: THREE.Group;
  /** the moving handle (winder bar / string handle) */
  puller: THREE.Group;
  /** cord mesh between body and puller, rescaled as it is drawn */
  cord: THREE.Mesh;
  /** where the bey mounts (tip pointing down the local -Z) */
  beyMount: THREE.Group;
  /** neutral local position of the puller, for pull-distance maths */
  pullerHome: THREE.Vector3;
  /** hand that holds the puller */
  pullHand: THREE.Group;
}

/**
 * Build one of the three real launchers, with both hands: the holding hand
 * wrapped around the grip and the pulling hand on the ripcord/string handle.
 */
export function buildLauncher(
  kind: "winder" | "string" | "hold",
  accent: number,
): LauncherRig {
  const g = new THREE.Group();
  const shell = absPlastic(accent, { rough: 0.3, coat: 0.7 });
  const dark = absPlastic(0x22252e, { rough: 0.42 });
  const metal = paintedMetal(0xc9ccd8, 0.28);

  // ---- body: the geared launcher head the bey clips under ----
  const bodyProfile: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    bodyProfile.push(new THREE.Vector2(0.001 + 0.031 * Math.sin((t * Math.PI) / 2), 0.026 * t));
  }
  const body = new THREE.Mesh(new THREE.LatheGeometry(bodyProfile, DETAIL.radial), shell);
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  g.add(body);
  // ring gear cover + vent slots, the visual signature of an X launcher
  const cover = new THREE.Mesh(new THREE.TorusGeometry(0.0245, 0.0042, 32, DETAIL.radial), metal);
  cover.position.z = 0.0155;
  g.add(cover);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.0075, 0.0028, 0.014), dark);
    slot.position.set(Math.cos(a) * 0.019, Math.sin(a) * 0.019, 0.012);
    slot.rotation.z = a;
    g.add(slot);
  }

  // ---- bey mount: sprung claw under the head ----
  const beyMount = new THREE.Group();
  beyMount.position.z = -0.006;
  g.add(beyMount);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const claw = new THREE.Mesh(new THREE.BoxGeometry(0.0035, 0.0035, 0.011), dark);
    claw.position.set(Math.cos(a) * 0.0125, Math.sin(a) * 0.0125, 0.004);
    g.add(claw);
  }

  // ---- grip ----
  const gripLen = kind === "hold" ? 0.088 : 0.062;
  const grip = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.0135, gripLen, 24, DETAIL.radial / 2),
    kind === "hold" ? rubberMat(0x2a2d38) : shell,
  );
  grip.position.set(0, -0.004, 0.052 + gripLen * 0.32);
  grip.rotation.x = kind === "hold" ? 1.32 : 1.5;
  grip.castShadow = true;
  g.add(grip);
  if (kind === "hold") {
    // pistol-style gear grip has a finger guard and a flared heel
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.0045, 24, 64, Math.PI), dark);
    guard.position.set(0, -0.022, 0.056);
    guard.rotation.set(Math.PI / 2, 0, 0);
    g.add(guard);
  }

  // holding hand around the grip
  const holdHand = buildHand("left", { curl: 0.95, gripR: 0.0135 });
  holdHand.position.copy(grip.position);
  holdHand.rotation.set(grip.rotation.x - Math.PI / 2, 0, 0);
  g.add(holdHand);

  // ---- puller: ripcord bar (winder) or string handle ----
  const puller = new THREE.Group();
  if (kind === "winder") {
    // a flat toothed ripcord that slides straight out through the side port
    const rip = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.011, 0.0032, 40, 6, 3), shell);
    rip.position.x = 0.04;
    puller.add(rip);
    const teeth = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.0035, 0.0016), dark);
    teeth.position.set(0.04, -0.0068, 0);
    puller.add(teeth);
    const tab = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.022, 0.006), paintedMetal(0xc23434, 0.35));
    tab.position.x = 0.085;
    puller.add(tab);
  } else {
    // string launcher: a T-handle on the end of the cord
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.006, 0.03, DETAIL.radial / 2, 4), shell);
    puller.add(stem);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.058, DETAIL.radial / 2, 8), rubberMat(0x9c2323));
    bar.rotation.z = Math.PI / 2;
    bar.position.y = -0.018;
    puller.add(bar);
  }
  const pullHand = buildHand("right", { curl: 0.98, gripR: 0.008 });
  pullHand.position.set(0, kind === "winder" ? -0.004 : -0.019, 0);
  pullHand.rotation.set(Math.PI / 2, 0, kind === "winder" ? 0 : Math.PI / 2);
  pullHand.scale.setScalar(0.96);
  puller.add(pullHand);
  puller.position.set(kind === "winder" ? 0.052 : 0.058, 0, 0.004);
  g.add(puller);

  // side port the cord exits through
  const port = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.016, 0.014), dark);
  port.position.set(0.03, 0, 0.004);
  g.add(port);

  // cord (string launchers only show it; the winder's rack is the puller)
  const cord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0011, 0.0011, 1, 16),
    new THREE.MeshStandardMaterial({ color: 0xeef1fb, roughness: 0.55 }),
  );
  cord.visible = kind !== "winder";
  g.add(cord);

  return { group: g, puller, cord, beyMount, pullerHome: puller.position.clone(), pullHand };
}

/** Restretch the cord between the launcher port and the puller. */
export function updateCord(rig: LauncherRig): void {
  const from = new THREE.Vector3(0.034, 0, 0.004);
  const to = rig.puller.position;
  const dir = to.clone().sub(from);
  rig.cord.position.copy(from).addScaledVector(dir, 0.5);
  rig.cord.scale.y = Math.max(0.01, dir.length());
  rig.cord.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
}
