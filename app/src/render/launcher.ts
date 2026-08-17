// Takara Tomy BEYBLADE X launcher catalog.
//
// The dimensions and silhouettes below are traced from the official product
// photography named in LAUNCHER_MODELS.  All dimensions are metres.  A rig's
// origin is the three-prong bey mount, +Z points through the launcher body,
// and +X is the direction in which the winder/string is pulled.

import * as THREE from "three";

import type { StadiumSpec } from "../core/stadium";
import type { LauncherKind, SpinDir } from "../core/types";
import { absPlastic, paintedMetal } from "./materials";
import { buildHand, type HandSide } from "./hand-model";
import { DETAIL } from "./parts";

export type LauncherMechanism = "entry-winder" | "winder" | "long-winder" | "hold-winder" | "string";

export interface LaunchCameraFrame {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** Product-aware world framing for the camera-attached launcher preview.
 * Moving the camera does not move the hands on screen; it only determines how
 * much of the true-scale stadium remains visible behind them. */
export function launchCameraFrame(stadium: StadiumSpec | null, side: 0 | 1): LaunchCameraFrame {
  const sideSign = side === 0 ? 1 : -1;
  if (stadium?.name === "wide") {
    return {
      position: new THREE.Vector3(-0.18 * sideSign, -0.52, 0.38),
      target: new THREE.Vector3(0, 0.03, 0.02),
    };
  }
  // Preserve the established BX-10 composition byte-for-byte.
  return {
    position: new THREE.Vector3(-0.16 * sideSign, -0.4, 0.3),
    target: new THREE.Vector3(0, 0.03, 0.02),
  };
}

export interface LauncherModelSpec {
  kind: LauncherKind;
  /** Takara Tomy product establishing this physical configuration. */
  product: string;
  officialName: string;
  mechanism: LauncherMechanism;
  direction: SpinDir;
  bodyLengthM: number;
  bodyWidthM: number;
  bodyThicknessM: number;
  pullLengthM: number;
  /** Usable withdrawal/string stroke before the mechanism reaches its stop. */
  maxPullM: number;
  shellColor: number;
  trimColor: number;
  pullColor: number;
}

/**
 * Mechanically distinct launchers, not colour-only reissues.  BX-28/BX-51
 * and tournament String Launcher prizes use the BX-18 shell; limited starter
 * recolours likewise use their base Winder/Long Winder configuration.
 */
export const LAUNCHER_MODELS: Record<LauncherKind, LauncherModelSpec> = {
  entry: {
    kind: "entry",
    product: "BX-22",
    officialName: "Entry Launcher",
    mechanism: "entry-winder",
    direction: 1,
    bodyLengthM: 0.043,
    bodyWidthM: 0.031,
    bodyThicknessM: 0.016,
    pullLengthM: 0.132,
    maxPullM: 0.112,
    shellColor: 0xeeeeef,
    trimColor: 0x252a2d,
    pullColor: 0x24292c,
  },
  winder: {
    kind: "winder",
    product: "BX-01",
    officialName: "Winder Launcher",
    mechanism: "winder",
    direction: 1,
    bodyLengthM: 0.061,
    bodyWidthM: 0.052,
    bodyThicknessM: 0.024,
    pullLengthM: 0.182,
    maxPullM: 0.158,
    shellColor: 0x242a2d,
    trimColor: 0x111416,
    pullColor: 0x202528,
  },
  longWinder: {
    kind: "longWinder",
    product: "UX-14",
    officialName: "Long Winder Launcher",
    mechanism: "long-winder",
    direction: 1,
    bodyLengthM: 0.061,
    bodyWidthM: 0.052,
    bodyThicknessM: 0.024,
    pullLengthM: 0.255,
    maxPullM: 0.228,
    shellColor: 0x202528,
    trimColor: 0x111416,
    pullColor: 0xefc51d,
  },
  hold: {
    kind: "hold",
    product: "UX-09",
    officialName: "Hold Launcher + Long Winder",
    mechanism: "hold-winder",
    direction: 1,
    bodyLengthM: 0.139,
    bodyWidthM: 0.041,
    bodyThicknessM: 0.027,
    pullLengthM: 0.258,
    maxPullM: 0.232,
    shellColor: 0x171b1e,
    trimColor: 0x724d91,
    pullColor: 0x78c943,
  },
  string: {
    kind: "string",
    product: "BX-18",
    officialName: "String Launcher",
    mechanism: "string",
    direction: 1,
    bodyLengthM: 0.086,
    bodyWidthM: 0.054,
    bodyThicknessM: 0.026,
    pullLengthM: 0.22,
    maxPullM: 0.205,
    shellColor: 0x171a1c,
    trimColor: 0x30363a,
    pullColor: 0x202427,
  },
  winderL: {
    kind: "winderL",
    product: "BX-40",
    officialName: "Winder Launcher L",
    mechanism: "winder",
    direction: -1,
    bodyLengthM: 0.061,
    bodyWidthM: 0.052,
    bodyThicknessM: 0.024,
    pullLengthM: 0.184,
    maxPullM: 0.160,
    shellColor: 0x353e43,
    trimColor: 0x20262a,
    pullColor: 0xb51f5b,
  },
  stringL: {
    kind: "stringL",
    product: "BX-47",
    officialName: "String Launcher L Red Ver.",
    mechanism: "string",
    direction: -1,
    bodyLengthM: 0.086,
    bodyWidthM: 0.054,
    bodyThicknessM: 0.026,
    pullLengthM: 0.22,
    maxPullM: 0.205,
    shellColor: 0xd3181d,
    trimColor: 0xbfc4c5,
    pullColor: 0xc4c8c9,
  },
};

export interface LauncherHandPose {
  side: HandSide;
  curl: number;
  gripR: number;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  /** Actual shell/handle surface point touched by the palm/fingers. */
  contact: readonly [number, number, number];
  scale: number;
}

export interface LauncherGripPose {
  hold: LauncherHandPose;
  pull: LauncherHandPose;
}

/**
 * Product-specific grasp poses.  L launchers mirror the operating hands and
 * palm side across local Y; Long Winder T-bars use a more open transverse
 * grasp than looped short winders, and each body width has its own curl.
 */
export const LAUNCHER_HAND_POSES: Record<LauncherKind, LauncherGripPose> = {
  entry: {
    hold: { side: "left", curl: 0.94, gripR: 0.012, position: [-0.015, -0.023, 0.053], rotation: [Math.PI / 2 + 0.05, 0, Math.PI - 0.06], contact: [-0.015, -0.0155, 0.012], scale: 0.88 },
    pull: { side: "right", curl: 0.97, gripR: 0.0075, position: [0.020, 0, -0.002], rotation: [0, Math.PI / 2, 0], contact: [0.006, 0, -0.002], scale: 0.90 },
  },
  winder: {
    hold: { side: "left", curl: 0.85, gripR: 0.019, position: [-0.020, -0.034, 0.056], rotation: [Math.PI / 2 + 0.03, 0, Math.PI - 0.04], contact: [-0.020, -0.026, 0.017], scale: 1 },
    pull: { side: "right", curl: 0.96, gripR: 0.009, position: [0.021, 0, -0.002], rotation: [0, Math.PI / 2, 0], contact: [0.006, 0, -0.002], scale: 0.96 },
  },
  longWinder: {
    hold: { side: "left", curl: 0.82, gripR: 0.020, position: [-0.018, -0.035, 0.057], rotation: [Math.PI / 2 + 0.02, 0.02, Math.PI - 0.02], contact: [-0.018, -0.026, 0.017], scale: 1 },
    pull: { side: "right", curl: 0.91, gripR: 0.008, position: [0.032, 0, 0], rotation: [0, Math.PI / 2 + 0.06, 0], contact: [0.016, 0, 0], scale: 0.97 },
  },
  hold: {
    hold: { side: "left", curl: 0.87, gripR: 0.017, position: [-0.070, -0.026, 0.057], rotation: [Math.PI / 2 + 0.03, 0, Math.PI - 0.06], contact: [-0.070, -0.0205, 0.015], scale: 1 },
    pull: { side: "right", curl: 0.92, gripR: 0.0085, position: [0.032, 0, 0], rotation: [0, Math.PI / 2 + 0.06, 0], contact: [0.016, 0, 0], scale: 0.97 },
  },
  string: {
    hold: { side: "left", curl: 0.82, gripR: 0.021, position: [-0.031, -0.036, 0.058], rotation: [Math.PI / 2 + 0.04, 0, Math.PI - 0.07], contact: [-0.031, -0.027, 0.018], scale: 1 },
    pull: { side: "right", curl: 0.94, gripR: 0.008, position: [0.016, 0, -0.002], rotation: [0, Math.PI / 2, 0], contact: [0, 0, 0], scale: 0.96 },
  },
  winderL: {
    hold: { side: "right", curl: 0.84, gripR: 0.019, position: [-0.020, 0.034, 0.056], rotation: [-Math.PI / 2 - 0.03, 0, 0.04], contact: [-0.020, 0.026, 0.017], scale: 1 },
    pull: { side: "left", curl: 0.95, gripR: 0.009, position: [-0.021, 0, -0.002], rotation: [0, -Math.PI / 2, 0], contact: [-0.006, 0, -0.002], scale: 0.96 },
  },
  stringL: {
    hold: { side: "right", curl: 0.81, gripR: 0.021, position: [-0.031, 0.036, 0.058], rotation: [-Math.PI / 2 - 0.04, 0, 0.07], contact: [-0.031, 0.027, 0.018], scale: 1 },
    pull: { side: "left", curl: 0.93, gripR: 0.008, position: [-0.016, 0, -0.002], rotation: [0, -Math.PI / 2, 0], contact: [0, 0, 0], scale: 0.96 },
  },
};

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

/** Angular moulded outline seen in top-down official product photographs. */
function bodyOutline(spec: LauncherModelSpec): THREE.Shape {
  const w = spec.bodyLengthM;
  const h = spec.bodyWidthM;
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(0.008, h * 0.18);
  const hold = spec.mechanism === "hold-winder";
  const entry = spec.mechanism === "entry-winder";
  const nose = hold ? 0.009 : entry ? 0.004 : 0.006;
  const s = new THREE.Shape();
  // The stepped shoulders and chamfered nose are deliberate: none of the X
  // launchers has the generic pill/cylinder outline used by the old model.
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - nose, -hh);
  s.lineTo(hw, -hh + nose);
  s.lineTo(hw, -hh * 0.28);
  s.lineTo(hw + (hold ? 0.003 : 0.004), -hh * 0.16);
  s.lineTo(hw + (hold ? 0.003 : 0.004), hh * 0.16);
  s.lineTo(hw, hh * 0.28);
  s.lineTo(hw, hh - nose);
  s.lineTo(hw - nose, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  if (hold) {
    s.lineTo(-hw - 0.004, hh * 0.45);
    s.lineTo(-hw - 0.004, -hh * 0.45);
  }
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  s.closePath();
  return s;
}

/** Pure geometry helper used by the renderer and invariant tests. */
export function launcherShellGeometry(kind: LauncherKind): THREE.ExtrudeGeometry {
  const spec = LAUNCHER_MODELS[kind];
  const geometry = new THREE.ExtrudeGeometry(bodyOutline(spec), {
    depth: spec.bodyThicknessM,
    steps: 2,
    curveSegments: 48,
    bevelEnabled: true,
    bevelSize: Math.min(0.0023, spec.bodyWidthM * 0.045),
    bevelThickness: 0.0021,
    bevelSegments: 12,
  });
  geometry.translate(spec.mechanism === "hold-winder" ? -0.035 : -0.012, 0, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  parent: THREE.Object3D,
  name: string,
): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function addFastener(parent: THREE.Object3D, x: number, y: number, z: number, material: THREE.Material): void {
  const screw = mesh(new THREE.CylinderGeometry(0.0031, 0.0031, 0.0014, 64, 2), material, parent, "case screw");
  screw.rotation.x = Math.PI / 2;
  screw.position.set(x, y, z);
  const slot = mesh(new THREE.BoxGeometry(0.0042, 0.0007, 0.0011, 8, 2, 2), material, parent, "screw slot");
  slot.position.set(x, y, z + 0.001);
}

function addMount(parent: THREE.Group, spec: LauncherModelSpec, dark: THREE.Material): THREE.Group {
  const beyMount = new THREE.Group();
  beyMount.name = "three-prong bey mount";
  beyMount.position.z = -0.008;
  parent.add(beyMount);

  const handed = spec.direction;
  const plate = mesh(
    new THREE.CylinderGeometry(0.0205, 0.0215, 0.006, DETAIL.radial, 3),
    dark,
    beyMount,
    "launcher gear plate",
  );
  plate.rotation.x = Math.PI / 2;
  plate.position.z = 0.003;
  const gear = mesh(new THREE.TorusGeometry(0.0158, 0.0023, 24, DETAIL.radial), dark, beyMount, "drive gear ring");
  gear.position.z = -0.0004;
  for (let i = 0; i < 3; i++) {
    const a = handed * ((i / 3) * Math.PI * 2 + 0.16);
    const claw = mesh(
      new THREE.BoxGeometry(0.0105, 0.0042, 0.006, 10, 4, 4),
      dark,
      beyMount,
      spec.direction < 0 ? "left-spin sprung mounting claw" : "right-spin sprung mounting claw",
    );
    claw.userData.spinDirection = spec.direction;
    claw.position.set(Math.cos(a) * 0.0122, Math.sin(a) * 0.0122, -0.002);
    claw.rotation.z = a + handed * 0.48;
  }
  return beyMount;
}

function addTopCaseDetails(
  g: THREE.Group,
  spec: LauncherModelSpec,
  shell: THREE.Material,
  dark: THREE.Material,
  trim: THREE.Material,
): void {
  const z = spec.bodyThicknessM + 0.0022;
  const offsetX = spec.mechanism === "hold-winder" ? -0.035 : -0.012;
  const panelW = spec.bodyLengthM * (spec.mechanism === "hold-winder" ? 0.68 : 0.52);
  const panelH = spec.bodyWidthM * 0.5;
  const panel = mesh(
    new THREE.ExtrudeGeometry(roundedRect(panelW, panelH, Math.min(0.004, panelH * 0.22)), {
      depth: 0.0015,
      bevelEnabled: true,
      bevelSegments: 6,
      bevelSize: 0.0008,
      bevelThickness: 0.0007,
      curveSegments: 32,
    }),
    dark,
    g,
    "recessed top access panel",
  );
  panel.position.set(offsetX + (spec.mechanism === "string" ? -0.008 : 0), 0, z);

  // The paired square release buttons are visible on every full-size X
  // housing, while the tiny BX-22 Entry unit has a single latch.
  const buttons = spec.mechanism === "entry-winder" ? 1 : 2;
  for (let i = 0; i < buttons; i++) {
    const button = mesh(new THREE.BoxGeometry(0.0052, 0.0045, 0.002, 8, 8, 3), trim, g, "release button");
    button.position.set(offsetX + (i - (buttons - 1) / 2) * 0.0105, 0, z + 0.0022);
    button.rotation.z = i ? -0.15 : 0.15;
  }

  if (spec.mechanism !== "entry-winder") {
    addFastener(g, offsetX - spec.bodyLengthM * 0.29, spec.bodyWidthM * 0.27, z + 0.001, trim);
    addFastener(g, offsetX + spec.bodyLengthM * 0.29, -spec.bodyWidthM * 0.27, z + 0.001, trim);
  }

  // Case seam ribs reproduce the separate upper/lower injection mouldings.
  for (const sy of [-1, 1]) {
    const rail = mesh(
      new THREE.CapsuleGeometry(0.0015, spec.bodyLengthM * 0.68, 10, 48),
      shell,
      g,
      "moulded case rail",
    );
    rail.rotation.z = Math.PI / 2;
    rail.position.set(offsetX - 0.004, sy * spec.bodyWidthM * 0.39, z - 0.001);
  }
}

function addSideHardware(
  g: THREE.Group,
  spec: LauncherModelSpec,
  dark: THREE.Material,
  trim: THREE.Material,
): void {
  const ox = spec.mechanism === "hold-winder" ? -0.035 : -0.012;
  const z = spec.bodyThicknessM * 0.47;
  for (const sy of [-1, 1]) {
    const clip = mesh(
      new THREE.BoxGeometry(spec.mechanism === "hold-winder" ? 0.035 : 0.019, 0.0055, 0.010, 12, 4, 6),
      dark,
      g,
      "launcher grip attachment rail",
    );
    clip.position.set(ox - spec.bodyLengthM * 0.1, sy * (spec.bodyWidthM / 2 + 0.002), z);
    for (let i = -1; i <= 1; i++) {
      const latch = mesh(new THREE.BoxGeometry(0.005, 0.003, 0.0045, 4, 3, 3), trim, g, "rail latch");
      latch.position.set(clip.position.x + i * 0.009, clip.position.y + sy * 0.001, z + 0.002);
    }
  }

  if (spec.mechanism === "hold-winder") {
    // UX-09's four interchangeable translucent rubber grip panels.
    const rubber = new THREE.MeshPhysicalMaterial({
      color: spec.trimColor,
      roughness: 0.38,
      transmission: 0.28,
      transparent: true,
      opacity: 0.78,
      thickness: 0.004,
      clearcoat: 0.55,
    });
    for (const sy of [-1, 1]) {
      for (const x of [-0.077, -0.037]) {
        const panel = mesh(new THREE.BoxGeometry(0.032, 0.005, 0.018, 28, 5, 12), rubber, g, "UX-09 rubber grip panel");
        panel.position.set(x, sy * 0.021, 0.012);
        panel.rotation.y = sy * 0.05;
      }
    }
  }
}

function loopHandle(color: THREE.Material, compact = false): THREE.Mesh {
  const outer = roundedRect(compact ? 0.019 : 0.025, compact ? 0.028 : 0.034, 0.006);
  const hole = roundedRect(compact ? 0.009 : 0.013, compact ? 0.016 : 0.021, 0.003);
  outer.holes.push(hole);
  return new THREE.Mesh(
    new THREE.ExtrudeGeometry(outer, {
      depth: compact ? 0.004 : 0.005,
      bevelEnabled: true,
      bevelSize: 0.001,
      bevelThickness: 0.001,
      bevelSegments: 8,
      curveSegments: 40,
    }),
    color,
  );
}

function addRackPuller(
  g: THREE.Group,
  spec: LauncherModelSpec,
  pullMat: THREE.Material,
  dark: THREE.Material,
  includeHands: boolean,
  pose: LauncherHandPose,
): { puller: THREE.Group; pullHand: THREE.Group; home: THREE.Vector3; cord: THREE.Mesh; anchor: THREE.Vector3 } {
  const puller = new THREE.Group();
  puller.name = `${spec.officialName} puller`;
  const axis = spec.direction;
  const exitX = axis * (spec.mechanism === "hold-winder" ? 0.040 : spec.bodyLengthM * 0.39);
  const length = spec.pullLengthM;
  const rack = mesh(new THREE.BoxGeometry(length, 0.0062, 0.0032, 128, 5, 3), pullMat, puller, "toothed winder rack");
  // At rest the rack is inserted through the housing: its T/loop handle is
  // beside the exit and the long toothed tail projects from the far side.
  // Pulling +X slides the same rigid group out of the launcher.
  rack.position.x = -axis * length / 2;
  // Individual rack teeth make the mechanism readable in the launch closeup.
  const toothPitch = spec.mechanism === "entry-winder" ? 0.0055 : 0.0047;
  for (let d = length - toothPitch; d > 0.012; d -= toothPitch) {
    const tooth = mesh(new THREE.BoxGeometry(0.0025, 0.0032, 0.0035, 3, 3, 3), dark, puller, "rack tooth");
    tooth.position.set(-axis * d, -0.0043, 0);
    tooth.rotation.z = spec.direction * -0.22;
  }

  if (spec.mechanism === "long-winder" || spec.mechanism === "hold-winder") {
    const stem = mesh(new THREE.CylinderGeometry(0.0043, 0.0048, 0.025, 64, 5), pullMat, puller, "long-winder handle stem");
    stem.rotation.z = Math.PI / 2;
    stem.position.x = axis * 0.005;
    const bar = mesh(new THREE.CapsuleGeometry(0.0044, 0.031, 16, 64), pullMat, puller, "long-winder T handle");
    bar.position.x = axis * 0.016;
  } else {
    const loop = loopHandle(pullMat, spec.mechanism === "entry-winder");
    loop.name = "winder finger loop";
    loop.position.set(axis * 0.006, 0, -0.002);
    loop.castShadow = true;
    puller.add(loop);
  }

  const pullHand = includeHands
    ? buildHand(pose.side, { curl: pose.curl, gripR: pose.gripR })
    : new THREE.Group();
  pullHand.name = "pulling hand";
  pullHand.position.set(...pose.position);
  pullHand.userData.gripTarget = new THREE.Vector3(...pose.contact);
  pullHand.userData.poseSide = pose.side;
  pullHand.userData.poseCurl = pose.curl;
  pullHand.userData.poseGripR = pose.gripR;
  puller.userData.handleCenter = new THREE.Vector3(...pose.contact);
  pullHand.rotation.set(...pose.rotation);
  pullHand.scale.setScalar(pose.scale);
  puller.add(pullHand);

  const home = new THREE.Vector3(exitX, 0, spec.bodyThicknessM * 0.38);
  puller.position.copy(home);
  g.add(puller);

  const cord = mesh(new THREE.CylinderGeometry(0.0008, 0.0008, 1, 16), dark, g, "hidden winder cord placeholder");
  cord.visible = false;
  const anchor = new THREE.Vector3(exitX, 0, spec.bodyThicknessM * 0.38);
  return { puller, pullHand, home, cord, anchor };
}

function addStringPuller(
  g: THREE.Group,
  spec: LauncherModelSpec,
  pullMat: THREE.Material,
  dark: THREE.Material,
  includeHands: boolean,
  pose: LauncherHandPose,
): { puller: THREE.Group; pullHand: THREE.Group; home: THREE.Vector3; cord: THREE.Mesh; anchor: THREE.Vector3 } {
  const puller = new THREE.Group();
  puller.name = `${spec.officialName} string handle`;
  const handle = mesh(new THREE.CapsuleGeometry(0.0052, 0.043, 18, 72), pullMat, puller, "string T handle");
  const hub = mesh(new THREE.CylinderGeometry(0.0065, 0.0075, 0.017, 64, 5), dark, puller, "string handle hub");
  hub.rotation.z = Math.PI / 2;
  const collar = mesh(new THREE.TorusGeometry(0.006, 0.0018, 20, 64), pullMat, puller, "string handle collar");
  collar.rotation.y = Math.PI / 2;
  collar.position.x = -0.008;

  const pullHand = includeHands
    ? buildHand(pose.side, { curl: pose.curl, gripR: pose.gripR })
    : new THREE.Group();
  pullHand.name = "pulling hand";
  pullHand.position.set(...pose.position);
  pullHand.userData.gripTarget = new THREE.Vector3(...pose.contact);
  pullHand.userData.poseSide = pose.side;
  pullHand.userData.poseCurl = pose.curl;
  pullHand.userData.poseGripR = pose.gripR;
  puller.userData.handleCenter = new THREE.Vector3(...pose.contact);
  pullHand.rotation.set(...pose.rotation);
  pullHand.scale.setScalar(pose.scale);
  puller.add(pullHand);

  const anchor = new THREE.Vector3(spec.direction * 0.034, 0, spec.bodyThicknessM * 0.44);
  const home = new THREE.Vector3(spec.direction * 0.064, 0, spec.bodyThicknessM * 0.44);
  puller.position.copy(home);
  g.add(puller);
  const cord = mesh(
    new THREE.CylinderGeometry(0.00085, 0.00085, 1, 20),
    new THREE.MeshStandardMaterial({ color: spec.kind === "stringL" ? 0xe6e8e7 : 0x303437, roughness: 0.64 }),
    g,
    "retractable launcher string",
  );
  return { puller, pullHand, home, cord, anchor };
}

export interface LauncherRig {
  group: THREE.Group;
  puller: THREE.Group;
  cord: THREE.Mesh;
  beyMount: THREE.Group;
  pullerHome: THREE.Vector3;
  pullHand: THREE.Group;
  cordAnchor: THREE.Vector3;
  kind: LauncherKind;
  mechanism: LauncherMechanism;
  /** Unit local-space direction in which the rack/cord leaves the case. */
  pullAxis: THREE.Vector3;
  /** Unit local-space lateral direction used only by the flexible string. */
  pullLateralAxis: THREE.Vector3;
  /** Product-specific usable rack/string stroke. */
  maxPullM: number;
  /** Current physical stroke, independent of pointer/display dimensions. */
  pullTravelM: number;
  /** Current stroke normalised to this product's mechanical stop. */
  pullFraction: number;
  /** Normalised kinetic-energy proxy (fraction squared). */
  pullEnergy: number;
  /** Sprung mounting claws, exposed so release can visibly open them. */
  mountClaws: THREE.Object3D[];
}

export interface LauncherPullState {
  travelM: number;
  fraction: number;
  energy: number;
  lateralM: number;
}

export interface LauncherGestureDirection {
  gestureAngleDeg: number;
  pullQuality: number;
}

/** Single committed mapping used by both live preview and deterministic launch params. */
export function launcherAimTiltFromGesture(
  gesture: LauncherGestureDirection,
): { aimDeg: number; tiltDeg: number } {
  return {
    aimDeg: THREE.MathUtils.clamp(gesture.gestureAngleDeg * 0.62, -35, 35),
    tiltDeg: THREE.MathUtils.clamp((1 - gesture.pullQuality) * 76, 0, 70),
  };
}

export interface LauncherBuildOptions {
  /** Geometry/invariant tests can omit the separately-tested anatomical rig. */
  includeHands?: boolean;
  /** Avoid browser canvas-backed micro-normal maps in Node geometry tests. */
  simpleMaterials?: boolean;
}

/** Camera-local close-up authored to remain inside a 55° phone frustum. */
export const LAUNCHER_PREVIEW_POSE = Object.freeze({
  position: [0.045, 0, -0.39] as const,
  pitch: -0.48,
  scale: 0.72,
});

/** Apply the shared preview framing and map either L/R pull axis down-screen. */
export function applyLauncherPreviewPose(rig: LauncherRig): void {
  rig.group.position.set(...LAUNCHER_PREVIEW_POSE.position);
  rig.group.rotation.set(
    LAUNCHER_PREVIEW_POSE.pitch,
    0,
    -rig.pullAxis.x * Math.PI / 2,
  );
  rig.group.scale.setScalar(LAUNCHER_PREVIEW_POSE.scale);
}

/** Build the selected catalog launcher with a naturally posed two-hand rig. */
export function buildLauncher(
  kind: LauncherKind,
  _accent = 0x3f7bff,
  options: LauncherBuildOptions = {},
): LauncherRig {
  const spec = LAUNCHER_MODELS[kind];
  const gripPose = LAUNCHER_HAND_POSES[kind];
  const includeHands = options.includeHands ?? true;
  const g = new THREE.Group();
  g.name = `${spec.product} ${spec.officialName}`;
  g.userData.launcherKind = kind;
  g.userData.product = spec.product;
  g.userData.direction = spec.direction;
  g.userData.mechanism = spec.mechanism;
  g.userData.maxPullM = spec.maxPullM;

  const standard = (color: number, roughness: number): THREE.Material =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
  const shell = options.simpleMaterials
    ? standard(spec.shellColor, 0.34)
    : spec.kind === "stringL"
      ? new THREE.MeshPhysicalMaterial({
        color: spec.shellColor,
        roughness: 0.24,
        transmission: 0.24,
        thickness: 0.005,
        transparent: true,
        opacity: 0.9,
        clearcoat: 0.9,
        clearcoatRoughness: 0.12,
      })
      : absPlastic(spec.shellColor, { rough: 0.34, coat: 0.68 });
  const darkColor = spec.kind === "stringL" ? 0x282d30 : 0x111416;
  const dark = options.simpleMaterials
    ? standard(darkColor, 0.46)
    : absPlastic(darkColor, { rough: 0.46, coat: 0.3 });
  const trim = options.simpleMaterials
    ? standard(spec.trimColor, 0.3)
    : spec.kind === "stringL"
      ? paintedMetal(spec.trimColor, 0.28)
      : absPlastic(spec.trimColor, { rough: 0.3, coat: 0.78 });
  const pullMat = options.simpleMaterials
    ? standard(spec.pullColor, 0.34)
    : absPlastic(spec.pullColor, { rough: 0.34, coat: 0.5 });

  mesh(launcherShellGeometry(kind), shell, g, "faceted injection-moulded launcher shell");
  addTopCaseDetails(g, spec, shell, dark, trim);
  addSideHardware(g, spec, dark, trim);

  // The housing is centred slightly behind the drive axis in every compact
  // launcher; the UX-09 grip extends much farther behind it.
  const beyMount = addMount(g, spec, dark);

  if (spec.mechanism === "string") {
    const spool = mesh(
      new THREE.CylinderGeometry(0.0205, 0.0205, 0.009, DETAIL.radial, 4),
      dark,
      g,
      "retractable string spool",
    );
    spool.rotation.x = Math.PI / 2;
    spool.position.set(spec.direction * -0.027, 0, spec.bodyThicknessM * 0.42);
    const spoolHub = mesh(
      new THREE.CylinderGeometry(0.0065, 0.0065, 0.012, 64, 3),
      trim,
      g,
      "string spool hub",
    );
    spoolHub.rotation.x = Math.PI / 2;
    spoolHub.position.copy(spool.position);
  }

  const port = mesh(
    new THREE.BoxGeometry(0.012, 0.015, 0.011, 8, 8, 6),
    dark,
    g,
    spec.mechanism === "string" ? "string exit port" : "winder guide slot",
  );
  port.position.set(
    spec.direction * (spec.mechanism === "hold-winder" ? 0.042 : spec.bodyLengthM * 0.42 - 0.012),
    0,
    spec.bodyThicknessM * 0.44,
  );

  // A hand holds the body itself on Entry/String/Winder launchers. UX-09's
  // long integrated grip is grasped near the rear rubber panels. Every
  // product consumes its own photographed grip pose from the table above.
  const holdHand = includeHands
    ? buildHand(gripPose.hold.side, { curl: gripPose.hold.curl, gripR: gripPose.hold.gripR })
    : new THREE.Group();
  holdHand.name = "launcher holding hand";
  holdHand.position.set(...gripPose.hold.position);
  holdHand.rotation.set(...gripPose.hold.rotation);
  holdHand.scale.setScalar(gripPose.hold.scale);
  holdHand.userData.gripTarget = new THREE.Vector3(...gripPose.hold.contact);
  holdHand.userData.launcherPoseKind = kind;
  holdHand.userData.poseSide = gripPose.hold.side;
  holdHand.userData.poseCurl = gripPose.hold.curl;
  holdHand.userData.poseGripR = gripPose.hold.gripR;
  g.userData.holdGripCenter = new THREE.Vector3(...gripPose.hold.contact);
  g.add(holdHand);

  const moving = spec.mechanism === "string"
    ? addStringPuller(g, spec, pullMat, dark, includeHands, gripPose.pull)
    : addRackPuller(g, spec, pullMat, dark, includeHands, gripPose.pull);
  moving.pullHand.userData.launcherPoseKind = kind;

  const rig: LauncherRig = {
    group: g,
    puller: moving.puller,
    cord: moving.cord,
    beyMount,
    pullerHome: moving.home,
    pullHand: moving.pullHand,
    cordAnchor: moving.anchor,
    kind,
    mechanism: spec.mechanism,
    pullAxis: new THREE.Vector3(spec.direction, 0, 0),
    pullLateralAxis: new THREE.Vector3(0, 1, 0),
    maxPullM: spec.maxPullM,
    pullTravelM: 0,
    pullFraction: 0,
    pullEnergy: 0,
    mountClaws: beyMount.children.filter((child) => child.name.includes("mounting claw")),
  };
  updateCord(rig);
  return rig;
}

/**
 * Move one real launcher mechanism to a physical stroke. Rack launchers are
 * rigidly collinear with their guide. String handles may deviate inside a
 * narrow pull cone while the cord remains anchored at the case port.
 */
export function setLauncherPull(
  rig: LauncherRig,
  travelM: number,
  lateralM = 0,
): LauncherPullState {
  const travel = THREE.MathUtils.clamp(travelM, 0, rig.maxPullM);
  const isString = rig.mechanism === "string";
  // A 16 degree cone matches the small natural side play of the BX string;
  // rigid winders intentionally discard all cross-axis pointer movement.
  const lateralLimit = isString ? Math.tan(THREE.MathUtils.degToRad(16)) * travel : 0;
  const lateral = THREE.MathUtils.clamp(lateralM, -lateralLimit, lateralLimit);
  rig.puller.position
    .copy(rig.pullerHome)
    .addScaledVector(rig.pullAxis, travel)
    .addScaledVector(rig.pullLateralAxis, lateral);
  rig.pullTravelM = travel;
  rig.pullFraction = rig.maxPullM > 0 ? travel / rig.maxPullM : 0;
  rig.pullEnergy = rig.pullFraction * rig.pullFraction;
  rig.group.userData.pullTravelM = rig.pullTravelM;
  rig.group.userData.pullFraction = rig.pullFraction;
  rig.group.userData.pullEnergy = rig.pullEnergy;
  updateCord(rig);
  return { travelM: travel, fraction: rig.pullFraction, energy: rig.pullEnergy, lateralM: lateral };
}

/** Spring/open the three bayonet claws without changing their authored spin handedness. */
export function setLauncherClawOpen(rig: LauncherRig, fraction: number): void {
  const f = THREE.MathUtils.clamp(fraction, 0, 1);
  for (const claw of rig.mountClaws) {
    const rest = claw.userData.restRadius as number | undefined;
    if (rest === undefined) {
      claw.userData.restRadius = Math.hypot(claw.position.x, claw.position.y);
      claw.userData.restScaleY = claw.scale.y;
    }
    const r0 = claw.userData.restRadius as number;
    const a = Math.atan2(claw.position.y, claw.position.x);
    const r = r0 + f * 0.006;
    claw.position.x = Math.cos(a) * r;
    claw.position.y = Math.sin(a) * r;
    claw.scale.y = (claw.userData.restScaleY as number) * (1 - f * 0.35);
  }
}

/**
 * Translate a world-space launcher so an already-parented bey's tip origin
 * lands at the deterministic release point. Rotation, scale, mount depth and
 * local bey offset are all included; callers never guess a magic Z offset.
 */
export function alignLauncherMountToWorld(
  rig: LauncherRig,
  mountedBey: THREE.Object3D,
  target: THREE.Vector3,
): THREE.Vector3 {
  rig.group.updateWorldMatrix(true, true);
  const actual = mountedBey.getWorldPosition(new THREE.Vector3());
  rig.group.position.add(target.clone().sub(actual));
  rig.group.updateWorldMatrix(true, true);
  return mountedBey.getWorldPosition(new THREE.Vector3());
}

/** Compose spin around a launcher's preserved tilted top axis. */
export function composeLaunchedBeyOrientation(
  baseOrientation: THREE.Quaternion,
  spinRad: number,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spinRad);
  return target.copy(baseOrientation).multiply(spin).normalize();
}

/** Preserve the exact live pointer-up pose while the preview rig lifts away. */
export function launcherExitOrientation(
  releaseOrientation: THREE.Quaternion,
  easedProgress: number,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  const recoil = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -THREE.MathUtils.clamp(easedProgress, 0, 1) * 0.22,
  );
  return target.copy(releaseOrientation).multiply(recoil).normalize();
}

/** Point the physical withdrawal axis along the core flight heading and lean the mount. */
export function orientWorldLauncher(
  rig: LauncherRig,
  headingRad: number,
  tiltDeg: number,
  radialAngleRad = headingRad,
): void {
  const tilt = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(tiltDeg, -30, 70));
  // The sim's tilt impulse points world-radially from the fixed mount. Build
  // the same leaned local +Z axis, then project the launch heading onto that
  // plane so the physical L/R withdrawal axis keeps the correct yaw.
  const localZWorld = new THREE.Vector3(
    Math.cos(radialAngleRad) * Math.sin(tilt),
    Math.sin(radialAngleRad) * Math.sin(tilt),
    Math.cos(tilt),
  ).normalize();
  const heading = new THREE.Vector3(Math.cos(headingRad), Math.sin(headingRad), 0);
  const pullWorld = heading.addScaledVector(localZWorld, -heading.dot(localZWorld)).normalize();
  const localXWorld = pullWorld.multiplyScalar(rig.pullAxis.x);
  const localYWorld = new THREE.Vector3().crossVectors(localZWorld, localXWorld).normalize();
  const basis = new THREE.Matrix4().makeBasis(localXWorld, localYWorld, localZWorld);
  rig.group.quaternion.setFromRotationMatrix(basis);
  rig.group.userData.visualHeadingRad = headingRad;
  rig.group.userData.visualTiltDeg = THREE.MathUtils.radToDeg(tilt);
  rig.group.userData.visualRadialAngleRad = radialAngleRad;
}

/** Restretch a retractable string between its case port and moving handle. */
export function updateCord(rig: LauncherRig): void {
  if (!rig.cord.visible) return;
  const from = rig.cordAnchor;
  const to = rig.puller.position;
  const dir = to.clone().sub(from);
  rig.cord.position.copy(from).addScaledVector(dir, 0.5);
  rig.cord.scale.y = Math.max(0.004, dir.length());
  rig.cord.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
}
