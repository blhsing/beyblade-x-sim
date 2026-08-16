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
  // Build one canonical RIGHT hand and produce the left by mirroring the
  // whole thing. Mirroring only the finger positions (what this used to do)
  // leaves the thumb reading as the wrong hand, which is exactly what looked
  // off holding the launcher.
  const outer = new THREE.Group();
  const g = new THREE.Group();
  outer.add(g);
  if (side === "left") {
    outer.scale.x = -1; // true mirror
    // a negative determinant flips triangle winding; render both faces so
    // the mirrored hand is not lit inside-out
    outer.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.side = THREE.DoubleSide;
    });
  }
  const curl = opts.curl ?? 0.85;
  const gripR = opts.gripR ?? 0.012;
  const mat = skinMat(opts.tone ?? 0xe2ab86);
  mat.side = THREE.DoubleSide;
  const mirror = 1;

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
  outer.userData.gripR = gripR;
  return outer;
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
  // Real X launchers are dark charcoal/black shells with a coloured accent
  // and a metallic gear cover — sampled straight off the product photos.
  const shell = absPlastic(0x2b2e37, { rough: 0.34, coat: 0.6 });
  const dark = absPlastic(0x15171d, { rough: 0.45 });
  const trim = absPlastic(accent, { rough: 0.3, coat: 0.8 });
  const metal = paintedMetal(0xb9bec9, 0.26);

  // ---- body ----
  // The String Launcher is not a puck: it is a chunky rounded WEDGE with the
  // gear head at the bottom and the body sweeping up and back over the hand.
  // The Winder Launcher is the compact round head with a long flat ripcord.
  const headR = 0.032;
  const headProfile: THREE.Vector2[] = [];
  for (let i = 0; i <= 18; i++) {
    const t = i / 18;
    headProfile.push(
      new THREE.Vector2(0.001 + headR * Math.sin((t * Math.PI) / 2), 0.03 * t),
    );
  }
  const head = new THREE.Mesh(new THREE.LatheGeometry(headProfile, DETAIL.radial), shell);
  head.rotation.x = Math.PI / 2;
  head.castShadow = true;
  g.add(head);

  if (kind !== "winder") {
    // the wedge shell that carries the string spool, rising back over the grip
    const wedge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.038, 0.075, 6, 3),
      shell,
    );
    wedge.rotation.set(Math.PI / 2.1, 0, 0);
    wedge.position.set(0, 0.012, 0.036);
    wedge.castShadow = true;
    g.add(wedge);
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.062, 0.012, 6, 12, 4), trim);
    spine.position.set(0, 0.024, 0.05);
    spine.rotation.x = -0.5;
    g.add(spine);
  }

  // ring gear cover + vent slots, the visual signature of an X launcher
  const cover = new THREE.Mesh(new THREE.TorusGeometry(0.0255, 0.0044, 32, DETAIL.radial), metal);
  cover.position.z = 0.018;
  g.add(cover);
  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(0.023, 0.023, 0.004, DETAIL.radial),
    dark,
  );
  face.rotation.x = Math.PI / 2;
  face.position.z = 0.0185;
  g.add(face);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.0085, 0.0026, 0.005), trim);
    slot.position.set(Math.cos(a) * 0.0165, Math.sin(a) * 0.0165, 0.0205);
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
  // BX-11/BX-29 Launcher Grip is a long straight BAR that clips under the
  // launcher (the product photo is a plain diagonal wedge, not a pistol) —
  // "hold" fits that bar, the other two use the launcher's own short stem.
  const gripLen = kind === "hold" ? 0.105 : 0.058;
  const gripR = kind === "hold" ? 0.0155 : 0.0135;
  const grip = new THREE.Mesh(
    new THREE.CapsuleGeometry(gripR, gripLen, 24, DETAIL.radial / 2),
    kind === "hold" ? rubberMat(0x23262f) : shell,
  );
  grip.position.set(0, -0.006, 0.05 + gripLen * 0.34);
  grip.rotation.x = 1.42;
  grip.castShadow = true;
  g.add(grip);
  if (kind === "hold") {
    // the grip bar carries moulded finger ridges and an end cap
    for (let i = 0; i < 4; i++) {
      const ridge = new THREE.Mesh(
        new THREE.TorusGeometry(gripR * 1.04, 0.0022, 12, 48),
        dark,
      );
      ridge.position.set(0, -0.006 - i * 0.0035, 0.05 + 0.016 + i * 0.021);
      ridge.rotation.x = grip.rotation.x;
      g.add(ridge);
    }
    const cap = new THREE.Mesh(new THREE.SphereGeometry(gripR * 1.06, 40, 24), trim);
    cap.position.set(0, -0.006 - 0.02, 0.05 + gripLen * 0.78);
    g.add(cap);
  }

  // The holding hand is the LEFT hand wrapping the grip; the right hand
  // pulls the ripcord/string out to the player's right.
  const holdHand = buildHand("left", { curl: 0.98, gripR });
  holdHand.position.copy(grip.position).add(new THREE.Vector3(0, -0.004, 0.004));
  holdHand.rotation.set(grip.rotation.x - Math.PI / 2, 0, Math.PI / 2);
  g.add(holdHand);

  // ---- puller: ripcord bar (winder) or string handle ----
  const puller = new THREE.Group();
  if (kind === "winder") {
    // The winder is a LONG flat toothed rack — in the product photo it runs
    // most of the frame diagonally out of the head, far longer than the head
    // itself — with a coloured pull tab on the end.
    const rip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.013, 0.0034, 64, 6, 3), shell);
    rip.position.x = 0.078;
    puller.add(rip);
    const teeth = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.004, 0.0018, 60, 3, 2), dark);
    teeth.position.set(0.075, -0.0079, 0);
    puller.add(teeth);
    const tab = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.026, 0.008, 6, 10, 4), trim);
    tab.position.x = 0.158;
    puller.add(tab);
  } else {
    // string launcher: a T-handle on the end of the cord
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.006, 0.03, DETAIL.radial / 2, 4), shell);
    puller.add(stem);
    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.062, DETAIL.radial / 2, 8),
      rubberMat(0x23262f),
    );
    bar.rotation.z = Math.PI / 2;
    bar.position.y = -0.02;
    puller.add(bar);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.008, 40), trim);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(0.031, -0.02, 0);
    puller.add(cap);
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

  const rig: LauncherRig = {
    group: g,
    puller,
    cord,
    beyMount,
    pullerHome: puller.position.clone(),
    pullHand,
  };
  // Size the cord immediately. It is authored 1 m long and rescaled to fit,
  // so a rig that never called updateCord (the opponent's) rendered a
  // metre-long spike across the stadium.
  updateCord(rig);
  return rig;
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
