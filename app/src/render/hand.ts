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

/** Rounded-rectangle outline, centred — moulded shells are slabs, not lathes. */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hh = h / 2;
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  s.closePath();
  return s;
}

// ---------------------------------------------------------------------------
// CANONICAL HAND FRAME (a right hand, before any placement):
//
//   -Z → where the fingers point when the hand is open
//   +Y → the PALM side: a positive rotation about +X swings a finger tip
//        from -Z toward +Y, so that is the direction fingers close in
//   -Y → the back of the hand, where the nails are
//   +X → toward the thumb
//
// This is the bit that was wrong: the frame comment and the actual rotation
// disagreed, so nails, thumb and placement were all derived from a palm
// facing the wrong way and the fingers read as bending backwards. The
// direction is now pinned by fingertipOffset() and asserted in the tests.
// ---------------------------------------------------------------------------

const PHALANX_FRACTIONS = [0.42, 0.32, 0.26];
// A closed fist bends roughly 250° in total across the three joints. The old
// values summed to 124° — barely half-open — so at "full" curl the fingers
// still stuck out past the grip instead of wrapping it.
const PHALANX_BEND = [1.25, 1.65, 1.5];

/**
 * Where a fingertip ends up for a given curl, in the canonical hand frame.
 * Exported so the direction can be asserted in tests: an open hand points
 * its tip down -Z, and closing it must swing that tip toward +Y (the palm)
 * rather than away from it.
 */
export function fingertipOffset(len: number, curl: number): { y: number; z: number } {
  let y = 0;
  let z = 0;
  let angle = 0;
  for (let i = 0; i < 3; i++) {
    angle += curl * PHALANX_BEND[i]!;
    const l = len * PHALANX_FRACTIONS[i]!;
    // rotating (0,0,-l) about +X by `angle`
    y += l * Math.sin(angle);
    z += -l * Math.cos(angle);
  }
  return { y, z };
}

/** One finger: three tapering phalanges hinged with a natural curl. */
function buildFinger(
  len: number,
  radius: number,
  curl: number,
  mat: THREE.Material,
): THREE.Group {
  const root = new THREE.Group();
  const segs = PHALANX_FRACTIONS;
  const bendPer = PHALANX_BEND;
  let parent = root;
  for (let i = 0; i < 3; i++) {
    const joint = new THREE.Group();
    // +X rotation takes -Z toward -Y: the fingertip closes into the palm
    joint.rotation.x = curl * bendPer[i]!;
    parent.add(joint);
    const l = len * segs[i]!;
    const r = radius * (1 - i * 0.16);
    const bone = new THREE.Mesh(new THREE.CapsuleGeometry(r, l * 0.72, 18, DETAIL.radial / 2), mat);
    bone.rotation.x = Math.PI / 2; // capsule runs along the bone (local Z)
    bone.position.z = -l / 2;
    bone.castShadow = true;
    joint.add(bone);
    // knuckle so the joints read as joints, not a smooth tube
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(r * 1.06, 24, 16), mat);
    joint.add(knuckle);
    const next = new THREE.Group();
    next.position.z = -l;
    joint.add(next);
    parent = next;
  }
  // fingernail on the OUTSIDE of the curl (-Y = back of the finger)
  const nail = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.62, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: 0xf0d8cc, roughness: 0.32, clearcoat: 0.7 }),
  );
  nail.scale.set(1, 0.5, 0.9);
  nail.rotation.x = Math.PI; // dome outward, on the back of the finger
  nail.position.set(0, -radius * 0.55, -len * 0.06);
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

  // four fingers along the leading edge, curling toward +Y (the palm)
  const spread = [0.9, 1.0, 0.97, 0.86];
  for (let i = 0; i < 4; i++) {
    const f = buildFinger(0.072 * spread[i]!, 0.0082 - i * 0.0004, curl * (0.92 + i * 0.03), mat);
    f.position.set(mirror * (-0.019 + i * 0.0128), 0.004, -0.036);
    f.rotation.z = mirror * (0.1 - i * 0.06);
    // slight forward tip so the knuckle row is not perfectly flat
    f.rotation.x = 0.12;
    g.add(f);
  }
  // thumb: opposed on the +X side, laid ACROSS the palm (+Y) to meet the
  // fingertips — that opposition is what makes a hand read as a grip
  const thumb = buildFinger(0.05, 0.0098, curl * 0.78, mat);
  thumb.position.set(mirror * 0.023, 0.009, -0.012);
  thumb.rotation.set(0.15, mirror * 1.25, mirror * -0.35);
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
  // and a metallic gear cover — colours sampled off the product photos.
  const shell = absPlastic(0x2b2e37, { rough: 0.34, coat: 0.6 });
  const dark = absPlastic(0x15171d, { rough: 0.45 });
  const trim = absPlastic(accent, { rough: 0.3, coat: 0.8 });
  const metal = paintedMetal(0xb9bec9, 0.26);

  // ---- body ----
  // The structural mistake worth naming: these are not lathed pucks. A real
  // launcher is a moulded SLAB — a thick rounded-rectangular shell held
  // upright, with the round gear head at the bottom, the string spool as a
  // big disc on the side face, and the cord leaving through a side port.
  const headR = 0.026;
  if (kind === "winder") {
    // Winder Launcher: squat round head, short collar, no tall body
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(headR, headR * 1.12, 0.03, DETAIL.radial, 3),
      shell,
    );
    body.rotation.x = Math.PI / 2;
    body.position.z = 0.017;
    body.castShadow = true;
    g.add(body);
    // horizontal slot the rack passes straight through
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.016, 0.0075, 12, 4, 3), dark);
    slot.position.set(0.008, 0, 0.016);
    g.add(slot);
  } else {
    // String Launcher / grip: upright slab shell
    const slabW = 0.055;
    const slabH = 0.092;
    const slabT = 0.03;
    const shape = roundedRect(slabW, slabH, 0.014);
    const slab = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, {
        depth: slabT,
        bevelEnabled: true,
        bevelSize: 0.0035,
        bevelThickness: 0.003,
        bevelSegments: 5,
        curveSegments: 24,
      }),
      shell,
    );
    // stand it upright above the head, thickness across Y
    slab.rotation.x = Math.PI / 2;
    slab.position.set(0, slabT / 2, 0.016 + slabH / 2);
    slab.castShadow = true;
    g.add(slab);

    // the string spool: a big disc on the slab's side face, the single most
    // recognisable feature of the String Launcher
    const spool = new THREE.Mesh(
      new THREE.CylinderGeometry(0.019, 0.019, 0.008, DETAIL.radial, 2),
      trim,
    );
    spool.rotation.x = Math.PI / 2;
    spool.position.set(0, -0.004, 0.016 + slabH * 0.56);
    g.add(spool);
    const spoolCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0075, 0.0075, 0.011, 40),
      metal,
    );
    spoolCap.rotation.x = Math.PI / 2;
    spoolCap.position.set(0, -0.007, 0.016 + slabH * 0.56);
    g.add(spoolCap);

    // moulded finger scallops down the front edge of the slab
    for (let i = 0; i < 4; i++) {
      const sc = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, slabT * 0.95, 24), dark);
      sc.rotation.z = Math.PI / 2;
      sc.rotation.x = Math.PI / 2;
      sc.position.set(-slabW / 2, slabT / 2, 0.03 + i * 0.016);
      g.add(sc);
    }
  }

  // round gear head at the bottom: the plate the bey clips under
  const head = new THREE.Mesh(
    new THREE.CylinderGeometry(headR * 1.22, headR * 1.15, 0.014, DETAIL.radial, 2),
    shell,
  );
  head.rotation.x = Math.PI / 2;
  head.position.z = 0.007;
  head.castShadow = true;
  g.add(head);
  const cover = new THREE.Mesh(new THREE.TorusGeometry(headR * 1.2, 0.0038, 32, DETAIL.radial), metal);
  cover.position.z = 0.0135;
  g.add(cover);
  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(headR * 0.94, headR * 0.94, 0.004, DETAIL.radial),
    dark,
  );
  face.rotation.x = Math.PI / 2;
  face.position.z = 0.0145;
  g.add(face);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.0085, 0.0026, 0.005), trim);
    vent.position.set(Math.cos(a) * headR * 0.7, Math.sin(a) * headR * 0.7, 0.0165);
    vent.rotation.z = a;
    g.add(vent);
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

  // ---- what the hand actually holds ----
  // String launcher: the slab body IS the grip. Winder: a short stem under
  // the head. "hold": the BX-11 Launcher Grip, a straight bar that clips on
  // below (the product photo is a plain bar, not a pistol grip).
  let gripCentre: THREE.Vector3;
  let gripR: number;
  if (kind === "hold") {
    gripR = 0.016;
    gripCentre = new THREE.Vector3(0, 0.012, 0.072);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.03, 0.01, 8, 6, 3), shell);
    plate.position.set(0, 0.012, 0.026);
    g.add(plate);
    const bar = new THREE.Mesh(
      new THREE.CapsuleGeometry(gripR, 0.1, 24, DETAIL.radial / 2),
      rubberMat(0x23262f),
    );
    bar.rotation.x = Math.PI / 2; // the bar lies along Z, under the launcher
    bar.position.copy(gripCentre);
    bar.castShadow = true;
    g.add(bar);
    for (let i = 0; i < 5; i++) {
      const ridge = new THREE.Mesh(new THREE.TorusGeometry(gripR * 1.05, 0.0022, 12, 48), dark);
      ridge.position.set(0, 0.012, 0.038 + i * 0.017);
      g.add(ridge);
    }
    const cap = new THREE.Mesh(new THREE.SphereGeometry(gripR * 1.05, 40, 24), trim);
    cap.position.set(0, 0.012, 0.126);
    g.add(cap);
  } else if (kind === "winder") {
    gripR = 0.014;
    gripCentre = new THREE.Vector3(0, 0.004, 0.062);
    const stem = new THREE.Mesh(
      new THREE.CapsuleGeometry(gripR, 0.05, 24, DETAIL.radial / 2),
      shell,
    );
    stem.rotation.x = Math.PI / 2;
    stem.position.copy(gripCentre);
    stem.castShadow = true;
    g.add(stem);
  } else {
    gripR = 0.019; // the slab is held directly, so the fingers open wider
    gripCentre = new THREE.Vector3(0, 0.014, 0.048);
  }

  // The LEFT hand holds the launcher; the right hand pulls the cord out to
  // the player's right. The grip bar lies along WORLD Z, and the hand's palm
  // is local +Y with fingers pointing local -Z, so a single quarter turn
  // about Y aims the fingers across the bar (world -X) while keeping the
  // palm on +Y — the hand then sits just below the bar so the palm faces it.
  const holdHand = buildHand("left", { curl: 0.96, gripR });
  holdHand.position.copy(gripCentre).add(new THREE.Vector3(0, -gripR * 0.75, 0));
  holdHand.rotation.set(0, Math.PI / 2, 0);
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
  // The pulling hand wraps the handle the same way: the winder's rack and
  // the string T-bar both run along local X, so the palm (+Y) faces down
  // onto them and the fingers close underneath.
  const pullHand = buildHand("right", { curl: 0.98, gripR: 0.009 });
  if (kind === "winder") {
    pullHand.position.set(0.006, 0.016, 0);
    pullHand.rotation.set(Math.PI, 0, 0); // palm down onto the flat rack
  } else {
    pullHand.position.set(0, -0.004, 0);
    pullHand.rotation.set(Math.PI, 0, 0); // palm down onto the T-bar
  }
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
