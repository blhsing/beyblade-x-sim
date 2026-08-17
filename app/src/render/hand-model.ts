// Anatomical hand model used by every launcher rig.
//
// The canonical model is a RIGHT hand with the palm facing +Y, fingertips
// pointing toward -Z and the thumb on +X. A left hand is a true X mirror of
// the complete anatomy. Dimensions are in metres and follow ordinary adult
// hand proportions rather than being fitted independently to each launcher.

import * as THREE from "three";

import { skinMat } from "./materials";
import { DETAIL } from "./parts";

export type HandSide = "left" | "right";
export type FingerName = "index" | "middle" | "ring" | "little";

const PALM_LENGTH = 0.09;
const PALM_HALF_LENGTH = PALM_LENGTH / 2;
const PHALANX_FRACTIONS = [0.44, 0.32, 0.24] as const;

// MCP, PIP and DIP flexion. The DIP remains coupled to the PIP instead of
// folding through the fingertip like the previous three-identical-hinge rig.
const PHALANX_BEND = [1.28, 1.7, 1.12] as const;

interface FingerSpec {
  name: FingerName;
  x: number;
  z: number;
  len: number;
  radius: number;
  splay: number;
  curlScale: number;
}

// Radial-to-ulnar order: index is next to the +X thumb and the little finger
// is on -X. The staggered MCP row and unequal lengths are important to the
// silhouette both open and wrapped around a launcher grip.
const FINGERS: readonly FingerSpec[] = [
  { name: "index", x: 0.0255, z: -0.042, len: 0.068, radius: 0.0081, splay: -0.045, curlScale: 0.98 },
  { name: "middle", x: 0.0083, z: -0.045, len: 0.075, radius: 0.0084, splay: -0.006, curlScale: 1 },
  { name: "ring", x: -0.0094, z: -0.0435, len: 0.071, radius: 0.008, splay: 0.038, curlScale: 1.025 },
  { name: "little", x: -0.0255, z: -0.0385, len: 0.058, radius: 0.0069, splay: 0.12, curlScale: 1.065 },
] as const;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smoothstep = (v: number): number => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/**
 * Fingertip position relative to an MCP joint in the canonical flexion plane.
 * This remains public because launcher-pose tests use it to prevent a hand
 * from ever bending its fingers through the back of the palm.
 */
export function fingertipOffset(len: number, curl: number): { y: number; z: number } {
  let y = 0;
  let z = 0;
  let angle = 0;
  const c = clamp01(curl);
  for (let i = 0; i < 3; i++) {
    angle += c * PHALANX_BEND[i]!;
    const l = len * PHALANX_FRACTIONS[i]!;
    y += l * Math.sin(angle);
    z += -l * Math.cos(angle);
  }
  return { y, z };
}

/** Geometry-only pose description, useful to align hands without rendering. */
export function handPoseMetrics(curl = 0.85, gripR = 0.012): {
  palmLength: number;
  palmWidth: number;
  gripRadius: number;
  fingertipReach: Record<FingerName, { y: number; z: number }>;
} {
  const gripOpening = clamp01((gripR - 0.009) / 0.014);
  const fingertipReach = Object.fromEntries(
    FINGERS.map((f) => {
      const fingerCurl = clamp01(curl * f.curlScale - gripOpening * 0.045);
      return [f.name, fingertipOffset(f.len, fingerCurl)];
    }),
  ) as Record<FingerName, { y: number; z: number }>;
  return { palmLength: PALM_LENGTH, palmWidth: 0.079, gripRadius: gripR, fingertipReach };
}

function handSkin(tone: number): THREE.MeshPhysicalMaterial {
  // Geometry tests run without a DOM; the browser path retains the procedural
  // pore/crease normal supplied by the shared skin material library.
  if (typeof document !== "undefined") return skinMat(tone);
  return new THREE.MeshPhysicalMaterial({
    color: tone,
    metalness: 0,
    roughness: 0.62,
    sheen: 0.5,
    sheenColor: new THREE.Color(0xff9a76),
    sheenRoughness: 0.7,
  });
}

function palmGeometry(): THREE.BufferGeometry {
  const longitudinal = 36;
  const radial = Math.max(64, DETAIL.radial / 2);
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let iz = 0; iz <= longitudinal; iz++) {
    const t = iz / longitudinal;
    const distalToBody = smoothstep(t / 0.43);
    const bodyToWrist = smoothstep((t - 0.43) / 0.57);
    const halfW = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(0.0375, 0.0395, distalToBody),
      0.0265,
      bodyToWrist,
    );
    const halfD = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(0.0134, 0.0156, smoothstep(t / 0.58)),
      0.0122,
      smoothstep((t - 0.62) / 0.38),
    );
    const z = -PALM_HALF_LENGTH + t * PALM_LENGTH;

    for (let ia = 0; ia <= radial; ia++) {
      const u = ia / radial;
      const a = u * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // A superellipse produces the broad dorsal/palmar planes and rounded
      // margins of a palm without reverting to a bevelled box.
      const sx = Math.sign(ca) * Math.pow(Math.abs(ca), 0.69);
      const sy = Math.sign(sa) * Math.pow(Math.abs(sa), 0.76);
      const radialThenar = ca > 0 ? 0.0018 * Math.sin(Math.PI * t) * Math.pow(ca, 3) : 0;
      const palmarDepth = sy >= 0 ? halfD * 1.08 : halfD * 0.92;
      vertices.push(halfW * sx + radialThenar, palmarDepth * sy, z);
      uvs.push(u, t);
    }
  }

  const row = radial + 1;
  for (let iz = 0; iz < longitudinal; iz++) {
    for (let ia = 0; ia < radial; ia++) {
      const a = iz * row + ia;
      const b = a + row;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  // Close the proximal and distal surfaces. They are largely hidden by the
  // MCP webbing and wrist, but caps keep the model watertight for shadows.
  const distalCentre = vertices.length / 3;
  vertices.push(0, 0, -PALM_HALF_LENGTH);
  uvs.push(0.5, 0);
  const wristCentre = vertices.length / 3;
  vertices.push(0, 0, PALM_HALF_LENGTH);
  uvs.push(0.5, 1);
  const wristRow = longitudinal * row;
  for (let ia = 0; ia < radial; ia++) {
    indices.push(distalCentre, ia + 1, ia);
    indices.push(wristCentre, wristRow + ia, wristRow + ia + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function taperedCapsuleGeometry(
  length: number,
  radius: number,
  distalScale: number,
  depthScale: number,
): THREE.CapsuleGeometry {
  const body = Math.max(0.001, length - radius * 2);
  const geometry = new THREE.CapsuleGeometry(radius, body, 18, Math.max(48, DETAIL.radial / 2));
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const half = length / 2;
  for (let i = 0; i < position.count; i++) {
    const axis = position.getY(i);
    // Capsule +Y becomes the proximal end once the mesh is rotated onto -Z.
    const distal = clamp01((half - axis) / length);
    const taper = THREE.MathUtils.lerp(1, distalScale, smoothstep(distal));
    position.setX(i, position.getX(i) * taper);
    position.setZ(i, position.getZ(i) * taper * depthScale);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function ellipsoid(
  name: string,
  radii: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
  segments = Math.max(48, DETAIL.radial / 2),
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segments, 32), material);
  mesh.name = name;
  mesh.scale.set(...radii);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function creaseMaterial(tone: number): THREE.MeshPhysicalMaterial {
  const c = new THREE.Color(tone).multiplyScalar(0.7);
  return new THREE.MeshPhysicalMaterial({
    color: c,
    roughness: 0.92,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
}

function nailMaterial(tone: number): THREE.MeshPhysicalMaterial {
  const c = new THREE.Color(tone).lerp(new THREE.Color(0xffeee7), 0.58);
  return new THREE.MeshPhysicalMaterial({
    color: c,
    roughness: 0.3,
    clearcoat: 0.55,
    clearcoatRoughness: 0.35,
  });
}

function lineCrease(
  name: string,
  from: THREE.Vector3,
  through: THREE.Vector3,
  to: THREE.Vector3,
  material: THREE.Material,
  radius = 0.00025,
): THREE.Mesh {
  const curve = new THREE.QuadraticBezierCurve3(from, through, to);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 6, false), material);
  mesh.name = name;
  mesh.userData.anatomicalRole = "crease";
  return mesh;
}

function addJointCrease(
  joint: THREE.Group,
  name: string,
  radius: number,
  material: THREE.Material,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const z = -(i + 1) * 0.00115;
    const crease = lineCrease(
      `${name}:crease-${i + 1}`,
      new THREE.Vector3(-radius * 0.68, radius * 0.72, z),
      new THREE.Vector3(0, radius * 0.82, z - 0.00035),
      new THREE.Vector3(radius * 0.68, radius * 0.72, z),
      material,
      0.00019,
    );
    joint.add(crease);
  }
}

function fingernail(
  fingerName: string,
  length: number,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  // A shallow half-ellipsoid follows the dorsal surface of the distal
  // phalanx. It is positioned on the phalanx itself, not beyond the tip.
  const geometry = new THREE.SphereGeometry(1, 40, 18, 0, Math.PI * 2, 0, Math.PI / 2);
  const nail = new THREE.Mesh(geometry, material);
  nail.name = `finger:${fingerName}:nail`;
  nail.scale.set(radius * 0.68, radius * 0.19, Math.min(length * 0.34, radius * 1.18));
  nail.rotation.z = Math.PI;
  nail.position.set(0, -radius * 0.73, -length * 0.72);
  nail.userData.anatomicalRole = "nail";
  nail.castShadow = true;
  return nail;
}

function buildFinger(
  spec: Pick<FingerSpec, "name" | "len" | "radius">,
  curl: number,
  skin: THREE.Material,
  nails: THREE.Material,
  creases: THREE.Material,
): THREE.Group {
  const root = new THREE.Group();
  root.name = `finger:${spec.name}`;
  root.userData.finger = spec.name;
  root.userData.curl = curl;
  root.userData.length = spec.len;
  root.userData.radius = spec.radius;
  let parent = root;

  const jointNames = ["mcp", "pip", "dip"] as const;
  const segmentNames = ["proximal", "middle", "distal"] as const;
  for (let i = 0; i < 3; i++) {
    const joint = new THREE.Group();
    joint.name = `finger:${spec.name}:${jointNames[i]}-joint`;
    joint.rotation.x = curl * PHALANX_BEND[i]!;
    joint.userData.anatomicalRole = "joint";
    joint.userData.flexion = joint.rotation.x;
    parent.add(joint);

    const length = spec.len * PHALANX_FRACTIONS[i]!;
    const radius = spec.radius * [1, 0.88, 0.76][i]!;
    const segment = new THREE.Mesh(
      taperedCapsuleGeometry(length, radius, i === 0 ? 0.9 : 0.84, 0.82),
      skin,
    );
    segment.name = `finger:${spec.name}:${segmentNames[i]}`;
    segment.rotation.x = Math.PI / 2;
    segment.position.z = -length / 2;
    segment.userData.anatomicalRole = "phalanx";
    segment.userData.segment = segmentNames[i];
    segment.castShadow = true;
    segment.receiveShadow = true;
    joint.add(segment);

    // The PIP normally shows two transverse flexion creases and the DIP one.
    if (i === 1) addJointCrease(joint, `finger:${spec.name}:pip`, radius, creases, 2);
    if (i === 2) addJointCrease(joint, `finger:${spec.name}:dip`, radius, creases, 1);
    if (i === 2) joint.add(fingernail(spec.name, length, radius, nails));

    if (i > 0) {
      const knuckle = ellipsoid(
        `finger:${spec.name}:${jointNames[i]}-knuckle`,
        [radius * 1.04, radius * 0.84, radius * 0.95],
        [0, 0, 0],
        skin,
        40,
      );
      knuckle.userData.anatomicalRole = "knuckle";
      joint.add(knuckle);
    }

    const next = new THREE.Group();
    next.position.z = -length;
    joint.add(next);
    parent = next;
  }
  parent.name = `finger:${spec.name}:tip`;
  parent.userData.anatomicalRole = "fingertip";
  return root;
}

function buildThumb(
  curl: number,
  gripR: number,
  skin: THREE.Material,
  nails: THREE.Material,
  creases: THREE.Material,
): THREE.Group {
  const root = new THREE.Group();
  root.name = "thumb";
  root.position.set(0.034, 0.003, 0.006);
  // CMC opposition points the thumb diagonally across the palm; larger grips
  // retain a little more abduction instead of burying the thumb in the hand.
  const gripOpening = clamp01((gripR - 0.009) / 0.014);
  root.rotation.set(0.2 + curl * 0.12, 0.86 - gripOpening * 0.12, -0.48);
  root.userData.anatomicalRole = "opposed-thumb";
  root.userData.opposition = root.rotation.y;

  const lengths = [0.021, 0.019, 0.017] as const; // metacarpal, proximal, distal
  const radii = [0.0094, 0.0085, 0.0075] as const;
  const flexion = [0.42, 1.0, 0.92] as const;
  const names = ["metacarpal", "proximal", "distal"] as const;
  const joints = ["cmc", "mcp", "ip"] as const;
  let parent = root;
  for (let i = 0; i < 3; i++) {
    const joint = new THREE.Group();
    joint.name = `thumb:${joints[i]}-joint`;
    joint.rotation.x = curl * flexion[i]!;
    joint.userData.anatomicalRole = "joint";
    joint.userData.flexion = joint.rotation.x;
    parent.add(joint);

    const segment = new THREE.Mesh(
      taperedCapsuleGeometry(lengths[i]!, radii[i]!, i === 0 ? 0.94 : 0.84, 0.84),
      skin,
    );
    segment.name = `thumb:${names[i]}`;
    segment.rotation.x = Math.PI / 2;
    segment.position.z = -lengths[i]! / 2;
    segment.userData.anatomicalRole = i === 0 ? "metacarpal" : "phalanx";
    segment.castShadow = true;
    segment.receiveShadow = true;
    joint.add(segment);

    if (i > 0) addJointCrease(joint, `thumb:${joints[i]}`, radii[i]!, creases, i === 1 ? 2 : 1);
    if (i === 2) joint.add(fingernail("thumb", lengths[i]!, radii[i]!, nails));

    const next = new THREE.Group();
    next.position.z = -lengths[i]!;
    joint.add(next);
    parent = next;
  }
  parent.name = "thumb:tip";
  parent.userData.anatomicalRole = "fingertip";
  return root;
}

function addPalmCreases(group: THREE.Group, material: THREE.Material): void {
  group.add(lineCrease(
    "hand:crease:distal-transverse",
    new THREE.Vector3(-0.029, 0.0162, -0.022),
    new THREE.Vector3(-0.002, 0.0172, -0.027),
    new THREE.Vector3(0.026, 0.0155, -0.02),
    material,
    0.0003,
  ));
  group.add(lineCrease(
    "hand:crease:proximal-transverse",
    new THREE.Vector3(-0.027, 0.016, 0.006),
    new THREE.Vector3(-0.004, 0.018, -0.005),
    new THREE.Vector3(0.017, 0.016, -0.008),
    material,
    0.00029,
  ));
  group.add(lineCrease(
    "hand:crease:thenar",
    new THREE.Vector3(0.029, 0.0158, -0.011),
    new THREE.Vector3(0.016, 0.0202, 0.008),
    new THREE.Vector3(0.008, 0.016, 0.029),
    material,
    0.00028,
  ));
  group.add(lineCrease(
    "hand:crease:wrist",
    new THREE.Vector3(-0.023, 0.0128, 0.043),
    new THREE.Vector3(0, 0.014, 0.041),
    new THREE.Vector3(0.023, 0.0128, 0.043),
    material,
    0.00025,
  ));
}

function addDorsalTendons(group: THREE.Group, material: THREE.Material): void {
  const destinations = [0.023, 0.008, -0.009, -0.024];
  for (let i = 0; i < destinations.length; i++) {
    const x = destinations[i]!;
    const tendon = lineCrease(
      `hand:dorsal-tendon:${i + 1}`,
      new THREE.Vector3(x * 0.5, -0.0142, 0.038),
      new THREE.Vector3(x * 0.75, -0.0154, -0.004),
      new THREE.Vector3(x, -0.0134, -0.035),
      material,
      0.00034,
    );
    tendon.material = material;
    group.add(tendon);
  }
}

/**
 * Build a high-detail hand gripping a launcher handle.
 *
 * `curl` is 0 for open and 1 for a closed grasp. `gripR` is the radius of
 * the held object; it slightly opens the joint chain and thumb opposition so
 * fingers contact a large string-launcher shell instead of intersecting it.
 * The group's origin remains the centre of the palm for existing animation.
 */
export function buildHand(
  side: HandSide,
  opts: { curl?: number; gripR?: number; tone?: number } = {},
): THREE.Group {
  const curl = clamp01(opts.curl ?? 0.85);
  const gripR = Math.max(0.004, opts.gripR ?? 0.012);
  const tone = opts.tone ?? 0xe2ab86;
  const skin = handSkin(tone);
  const nails = nailMaterial(tone);
  const creases = creaseMaterial(tone);
  skin.side = nails.side = creases.side = THREE.DoubleSide;

  const outer = new THREE.Group();
  outer.name = `hand:${side}`;
  outer.userData.side = side;
  outer.userData.gripR = gripR;
  outer.userData.curl = curl;
  outer.userData.anatomical = true;
  if (side === "left") outer.scale.x = -1;

  const hand = new THREE.Group();
  hand.name = "hand:anatomy";
  outer.add(hand);

  const palm = new THREE.Mesh(palmGeometry(), skin);
  palm.name = "hand:palm";
  palm.userData.anatomicalRole = "palm";
  palm.castShadow = true;
  palm.receiveShadow = true;
  hand.add(palm);

  // Major palmar soft-tissue masses: thenar (thumb side), hypothenar (little
  // finger side) and the central heel. They overlap the watertight palm and
  // create a cupped, living surface rather than a uniform slab.
  hand.add(ellipsoid("hand:thenar", [0.0205, 0.0092, 0.0305], [0.0205, 0.011, 0.008], skin));
  hand.add(ellipsoid("hand:hypothenar", [0.014, 0.0072, 0.0305], [-0.027, 0.0105, 0.009], skin));
  hand.add(ellipsoid("hand:heel", [0.029, 0.009, 0.023], [-0.002, 0.007, 0.031], skin));

  const gripOpening = clamp01((gripR - 0.009) / 0.014);
  for (const spec of FINGERS) {
    const fingerCurl = clamp01(curl * spec.curlScale - gripOpening * 0.045);
    const finger = buildFinger(spec, fingerCurl, skin, nails, creases);
    finger.position.set(spec.x, 0.0015, spec.z);
    finger.rotation.y = spec.splay * (1 - curl * 0.68);
    finger.rotation.z = -spec.x * 0.65; // shallow knuckle arch/cupping
    finger.userData.rootPosition = finger.position.toArray();
    hand.add(finger);

    const mcp = ellipsoid(
      `finger:${spec.name}:mcp-knuckle`,
      [spec.radius * 1.12, spec.radius * 0.9, spec.radius],
      [spec.x, -0.0005, spec.z + 0.001],
      skin,
      44,
    );
    mcp.userData.anatomicalRole = "knuckle";
    hand.add(mcp);
  }

  // Interdigital webs fill the valleys but end short of the proximal
  // phalanges, avoiding both hard gaps and the old fused mitten silhouette.
  for (let i = 0; i < FINGERS.length - 1; i++) {
    const a = FINGERS[i]!;
    const b = FINGERS[i + 1]!;
    const web = ellipsoid(
      `hand:web:${a.name}-${b.name}`,
      [Math.abs(a.x - b.x) * 0.46, 0.0062, 0.009],
      [(a.x + b.x) / 2, 0.001, Math.max(a.z, b.z) - 0.003],
      skin,
      40,
    );
    web.userData.anatomicalRole = "interdigital-web";
    hand.add(web);
  }

  hand.add(buildThumb(clamp01(curl * 0.9), gripR, skin, nails, creases));
  addPalmCreases(hand, creases);
  addDorsalTendons(hand, skin);

  const wrist = ellipsoid("hand:wrist-transition", [0.027, 0.014, 0.025], [0, 0, 0.045], skin);
  wrist.userData.anatomicalRole = "wrist";
  hand.add(wrist);

  // Elliptical truncated forearm, broader away from the wrist. Cylinder Y is
  // rotated onto +Z; its local Z scale creates the natural shallow depth.
  const forearm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0305, 0.0235, 0.092, Math.max(64, DETAIL.radial / 2), 18),
    skin,
  );
  forearm.name = "hand:forearm";
  forearm.rotation.x = Math.PI / 2;
  forearm.scale.z = 0.72;
  forearm.position.z = 0.09;
  forearm.userData.anatomicalRole = "forearm";
  forearm.castShadow = true;
  forearm.receiveShadow = true;
  hand.add(forearm);

  outer.updateMatrixWorld(true);
  return outer;
}
