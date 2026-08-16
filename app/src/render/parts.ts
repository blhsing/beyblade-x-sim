// Parametric Beyblade X part geometry built from the *real* measurements in
// the parts dataset (docs/MODELING.md): per-part diameters in mm, ratchet
// codes that literally encode protrusion count and height, and bit codes that
// name the tip shape. Nothing here is a guessed silhouette scaled to taste —
// where the dataset has a number, that number is the geometry.
//
// Everything is built around one primitive: a swept solid whose vertical
// cross-section is modulated by a plan-view outline function. That is how a
// real moulded part is shaped (a profile revolved around the axis, with the
// outline cut by the tooling), and it gives proper sloped faces, rims and
// undercuts instead of a flat extrusion.

import * as THREE from "three";

import type { ResolvedCombo } from "../core/derive";
import type { BeyParams, PartEntry } from "../core/types";
import {
  absPlastic,
  diecastMetal,
  paintedMetal,
  pomTranslucent,
  rubberMat,
} from "./materials";

/** Official colourway names (phstudy `part_colors`) → linear render colours. */
export const COLOR_NAMES: Record<string, number> = {
  red: 0xc22e2e, blue: 0x2e55c2, navy: 0x1d2a66, cyan: 0x2eb8c2,
  green: 0x2ea34a, yellow: 0xd8c22e, orange: 0xd8802e, purple: 0x7a3fc2,
  pink: 0xd85f9e, white: 0xe8e8f0, black: 0x22222a, gray: 0x8a8a94,
  grey: 0x8a8a94, silver: 0xc8ccd8, gold: 0xcfae4a, bronze: 0xb08048,
  brown: 0x7a5636, clear: 0xd8e0f0, lime: 0x9ed82e, magenta: 0xc22ea3,
  turquoise: 0x2ec2a3, violet: 0x8a4ad8,
};

export const TYPE_COLORS: Record<string, number> = {
  attack: 0xc23c3c,
  defense: 0x3c66c2,
  stamina: 0x3cb26a,
  balance: 0xc2a23c,
};

/** Stable per-part variation so each mould reads as its own part. */
export function partSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * Global tessellation budget. These are small objects filling a lot of the
 * screen (a blade is 48 mm across but framed close), so silhouettes and
 * specular highlights are only as good as the polygon count — the sweeps
 * below run at hundreds of angular steps rather than the tens you would use
 * for background props.
 */
export const DETAIL = {
  /** angular steps around a swept part */
  sweep: 512,
  /** angular steps around a lathe/cylinder/torus */
  radial: 128,
  /** rings on spheres and capsules */
  rings: 48,
};

/** Cross-section point: radius as a fraction of the outline, and height. */
interface SectionPt {
  f: number;
  z: number;
}

/**
 * Resample a cross-section along a closed spline so the swept surface has
 * real curvature between control points instead of hard facets — moulded
 * parts have radiused edges everywhere and the highlight rolls across them.
 */
function refineSection(section: SectionPt[], per = 4): SectionPt[] {
  const pts = section.map((p) => new THREE.Vector2(p.f, p.z));
  const curve = new THREE.SplineCurve(pts);
  // Catmull-Rom overshoots at corners, which would quietly inflate a part
  // past its measured diameter and height — clamp back to the control
  // envelope so smoothing can round an edge but never resize the part.
  let fMax = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of section) {
    fMax = Math.max(fMax, p.f);
    zMin = Math.min(zMin, p.z);
    zMax = Math.max(zMax, p.z);
  }
  const out: SectionPt[] = [];
  const n = section.length * per;
  for (let i = 0; i < n; i++) {
    const v = curve.getPoint(i / n);
    out.push({
      f: Math.min(fMax, Math.max(0, v.x)),
      z: Math.min(zMax, Math.max(zMin, v.y)),
    });
  }
  return out;
}

/**
 * Sweep a closed cross-section around the axis, scaling its radius by
 * `outline(theta)`. The section is given in order around the solid (e.g.
 * centre-top → outer top → outer bottom → centre-bottom) and is closed
 * automatically.
 */
export function sweepSolid(
  rawSection: SectionPt[],
  outline: (theta: number) => number,
  segs = DETAIL.sweep,
): THREE.BufferGeometry {
  const section = refineSection(rawSection);
  const n = section.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s < segs; s++) {
    const th = (s / segs) * Math.PI * 2;
    const R = outline(th);
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    for (const p of section) {
      pos.push(cos * R * p.f, sin * R * p.f, p.z);
    }
  }
  for (let s = 0; s < segs; s++) {
    const a = s * n;
    const b = ((s + 1) % segs) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(a + i, b + i, b + j, a + i, b + j, a + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---- plan-view outlines ----------------------------------------------------

/** Asymmetric attack outline: N contact blades, each with a long swept
 * leading edge and an abrupt trailing undercut — the shape that actually
 * transfers momentum on impact. */
function attackOutline(R: number, blades: number, depth: number, sweep: number) {
  return (th: number): number => {
    const p = ((th * blades) / (Math.PI * 2)) % 1; // 0..1 within one blade
    const ramp = Math.pow(p, sweep); // slow rise…
    const drop = Math.pow(1 - Math.min(1, (1 - p) * 7), 3); // …sharp fall
    return R * (1 - depth + depth * Math.max(ramp * (1 - drop), 0));
  };
}

/** Defense outline: near-circular with wide, shallow, symmetric guards. */
function defenseOutline(R: number, lobes: number, depth: number) {
  return (th: number): number => R * (1 - depth * 0.5 + depth * 0.5 * Math.cos(lobes * th));
}

/** Stamina outline: a smooth circular wall with fine tooling serrations. */
function staminaOutline(R: number, teeth: number, depth: number) {
  return (th: number): number => R * (1 - depth + depth * (0.5 + 0.5 * Math.cos(teeth * th)));
}

function outlineFor(
  type: string | null,
  R: number,
  attackStat: number,
  seed: number,
): (theta: number) => number {
  if (type === "attack") {
    const blades = Math.max(3, Math.min(6, Math.round(3 + attackStat / 45)));
    return attackOutline(R, blades, 0.16 + seed * 0.06, 0.7 + seed * 0.5);
  }
  if (type === "defense") return defenseOutline(R, 6 + Math.round(seed * 4) * 2, 0.07);
  if (type === "stamina") return staminaOutline(R, 24 + Math.round(seed * 12), 0.022);
  // balance: a few broad blades on an otherwise round body
  return (th: number): number =>
    R * (0.95 + 0.05 * Math.cos(4 * th)) * (1 - 0.06 + 0.06 * Math.pow(Math.max(0, Math.cos(3 * th)), 2));
}

// ---- blade -----------------------------------------------------------------

/** Radius (m) straight from the dataset when measured, else the derived one. */
export function partRadiusM(part: PartEntry | null | undefined, fallback: number): number {
  const d = part?.diameterMm;
  return d && d > 0 ? d / 2000 : fallback;
}

function bladeColorOf(part: PartEntry | null | undefined, accent: number): number {
  const named = part?.color ? COLOR_NAMES[part.color.toLowerCase()] : undefined;
  return named ?? (part?.type ? TYPE_COLORS[part.type]! : accent);
}

/**
 * A BX/UX Blade: die-cast metal upper (the part that actually hits) sitting
 * on a moulded plastic core, with the emblem boss on top. Height ≈ 11 mm,
 * diameter from the dataset (45–52.5 mm).
 */
export function buildBlade(
  part: PartEntry | null | undefined,
  accent: number,
  R: number,
  baseZ = 0,
): THREE.Group {
  const g = new THREE.Group();
  const type = part?.type ?? null;
  const seed = partSeed(part?.key ?? "?");
  const color = bladeColorOf(part, accent);
  const outline = outlineFor(type, R, part?.stats.attack ?? 40, seed);

  // metal upper — sloped top face, square-ish striking rim, undercut below.
  // ≈ 11 mm from the blade's underside to its crown.
  const metalTop = baseZ + 0.0112;
  const upper = sweepSolid(
    [
      { f: 0.0, z: metalTop },
      { f: 0.42, z: metalTop },
      { f: 0.82, z: metalTop - 0.0012 }, // top face slopes down to the rim
      { f: 1.0, z: metalTop - 0.0035 },
      { f: 1.0, z: metalTop - 0.0072 }, // vertical striking wall
      { f: 0.86, z: metalTop - 0.0092 }, // undercut
      { f: 0.5, z: metalTop - 0.0098 },
      { f: 0.0, z: metalTop - 0.0088 },
    ],
    outline,
  );
  const bare = seed > 0.55; // some blades ship bare metal, others painted
  const metalMesh = new THREE.Mesh(
    upper,
    bare ? diecastMetal(color, { rough: 0.26 + seed * 0.1 }) : paintedMetal(color),
  );
  metalMesh.castShadow = true;
  metalMesh.receiveShadow = true;
  g.add(metalMesh);

  // plastic core beneath the metal, slightly inboard so the metal overhangs
  const core = sweepSolid(
    [
      { f: 0.0, z: metalTop - 0.0088 },
      { f: 0.9, z: metalTop - 0.0092 },
      { f: 0.9, z: baseZ + 0.0016 },
      { f: 0.34, z: baseZ + 0.0004 },
      { f: 0.0, z: baseZ + 0.0004 },
    ],
    (th) => outline(th) * 0.93,
  );
  const coreMesh = new THREE.Mesh(
    core,
    absPlastic(new THREE.Color(color).multiplyScalar(0.55).getHex(), { rough: 0.5 }),
  );
  coreMesh.castShadow = true;
  g.add(coreMesh);

  // emblem boss: the moulded character face every blade carries on top
  const bossMat = absPlastic(seed > 0.5 ? 0x1b1b24 : 0xe6e8f2, { rough: 0.3, coat: 0.8 });
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.3, R * 0.33, 0.0022, DETAIL.radial), bossMat);
  boss.rotation.x = Math.PI / 2;
  boss.position.z = metalTop + 0.0011;
  g.add(boss);
  const emblem = new THREE.Mesh(
    new THREE.TorusGeometry(R * 0.19, R * 0.035, 24, Math.max(3, 3 + Math.round(seed * 4)) * 12),
    paintedMetal(0xcfae4a, 0.28),
  );
  emblem.position.z = metalTop + 0.0024;
  g.add(emblem);
  return g;
}

/** CX main blade sits on an assist blade; both are wider, thinner discs. */
export function buildCxStack(
  rc: ResolvedCombo,
  accent: number,
  R: number,
  baseZ = 0,
): THREE.Group {
  const g = new THREE.Group();
  const main = rc.parts.mainBlade;
  const assist = rc.parts.assistBlade;
  const mainR = partRadiusM(main, R);
  // assist blade height (real, from the 0.1 mm-unit stat) lifts the main blade
  const assistH = assist ? Math.max(0.004, (assist.stats.height || 55) / 10000) : 0;
  g.add(buildBlade(main, accent, mainR, baseZ + assistH));

  if (assist) {
    const h = assistH;
    const aR = partRadiusM(assist, mainR * 0.96);
    const lobes = 4 + Math.round(partSeed(assist.key) * 5);
    const skirt = sweepSolid(
      [
        { f: 0.0, z: baseZ + h },
        { f: 1.0, z: baseZ + h },
        { f: 1.0, z: baseZ + h * 0.45 },
        { f: 0.42, z: baseZ },
        { f: 0.0, z: baseZ },
      ],
      (th) => aR * (0.93 + 0.07 * Math.cos(lobes * th)),
    );
    const mat = absPlastic(
      COLOR_NAMES[assist.color?.toLowerCase() ?? ""] ?? 0xb8bcd0,
      { rough: 0.38 },
    );
    const m = new THREE.Mesh(skirt, mat);
    m.castShadow = true;
    g.add(m);
  }
  if (rc.parts.lockChip) {
    // lock chip: the small emblem disc that locks the CX stack together
    const chip = new THREE.Mesh(
      new THREE.CylinderGeometry(mainR * 0.26, mainR * 0.29, 0.0042, DETAIL.radial),
      paintedMetal(COLOR_NAMES[rc.parts.lockChip.color?.toLowerCase() ?? ""] ?? 0xcfae4a, 0.3),
    );
    chip.rotation.x = Math.PI / 2;
    chip.position.z = baseZ + assistH + 0.0142;
    g.add(chip);
  }
  return g;
}

// ---- ratchet ---------------------------------------------------------------

/** `3-60` → 3 protrusions, 6.0 mm tall (docs/MODELING.md §1.2). */
export function ratchetSpec(code: string | undefined): { count: number; heightM: number } {
  const m = /^(\d+)-(\d+)/.exec(code ?? "");
  const count = m ? Math.max(1, Number.parseInt(m[1]!, 10)) : 3;
  const heightM = m ? Number.parseInt(m[2]!, 10) / 10000 : 0.006;
  return { count, heightM: Math.max(0.004, heightM) };
}

/**
 * Ratchet: a translucent POM disc whose N protrusions both index the blade
 * and act as the burst latch joints the physics core models. Height is the
 * real millimetre value from the code.
 */
export function buildRatchet(part: PartEntry | null | undefined, topZ: number): THREE.Group {
  const g = new THREE.Group();
  const { count, heightM } = ratchetSpec(part?.code);
  const R = 0.013; // ≈ 26 mm across, measured
  const baseZ = topZ - heightM;
  const outline = (th: number): number => {
    // rounded protrusions on a cylindrical body
    const lobe = Math.pow(Math.max(0, Math.cos(count * th)), 0.6);
    return R * (0.84 + 0.16 * lobe);
  };
  const body = sweepSolid(
    [
      { f: 0.0, z: topZ },
      { f: 1.0, z: topZ },
      { f: 1.0, z: baseZ + heightM * 0.25 },
      { f: 0.86, z: baseZ },
      { f: 0.3, z: baseZ },
      { f: 0.0, z: baseZ + heightM * 0.2 },
    ],
    outline,
  );
  const mat = pomTranslucent(
    COLOR_NAMES[part?.color?.toLowerCase() ?? ""] ?? 0xf2f2f8,
  );
  const mesh = new THREE.Mesh(body, mat);
  mesh.castShadow = true;
  g.add(mesh);

  // burst latch ring: the sprung teeth that click out under impact
  const teeth = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.46, R * 0.46, 0.0016, Math.max(24, count * 12), 2, true),
    paintedMetal(0xb9bfd2, 0.32),
  );
  teeth.rotation.x = Math.PI / 2;
  teeth.position.z = topZ - 0.0008;
  g.add(teeth);
  return g;
}

// ---- bit -------------------------------------------------------------------

type BitFamily = "flat" | "ball" | "needle" | "point" | "taper" | "rubberFlat";

export function bitFamily(code: string): BitFamily {
  const c = code.replace(/^G/, ""); // gear variants share the base shape
  if (/^(R|RA|RS)$/.test(code)) return "rubberFlat";
  if (/^(B|O|DB|FB|WB|LO|Q)/.test(c)) return "ball";
  if (/^(N|HN|MN)/.test(c)) return "needle";
  if (/^(P|TP|D|S|BS)/.test(c)) return "point";
  if (/^(T|HT)/.test(c)) return "taper";
  return "flat";
}

/** Gear-ringed bits (`GF`, `GB`, `GN`, `GP`, `GR`, `GU`) mesh with the
 * stadium's Xtreme Line — the ring is real teeth, not a decal. */
export function bitHasGear(code: string): boolean {
  return /^G[A-Z]/.test(code) || code === "G";
}

/** Height of a bit's tip: contact point → the flange's underside. */
export function bitTipHeight(code: string): number {
  switch (bitFamily(code)) {
    case "ball":
      return 0.0044;
    case "needle":
      return 0.0058;
    case "point":
      return 0.0034;
    case "taper":
      return 0.0052;
    default:
      return 0.0028;
  }
}

/** Total bit height: contact point → the face the ratchet screws onto. */
export function bitHeight(code: string): number {
  return bitTipHeight(code) + 0.0062;
}

/**
 * Build a bit with its CONTACT POINT at `baseZ` (the sim places a bey's mesh
 * origin on the dish surface, so the tip has to be the local zero).
 */
export function buildBit(part: PartEntry | null | undefined, baseZ = 0): THREE.Group {
  const g = new THREE.Group();
  const code = part?.code ?? "F";
  const fam = bitFamily(code);
  const flangeR = 0.0095; // ≈ 19 mm flange, measured
  const color = COLOR_NAMES[part?.color?.toLowerCase() ?? ""] ?? TYPE_COLORS[part?.type ?? "attack"]!;
  const shellMat = absPlastic(color, { rough: 0.34 });
  const tipTop = baseZ + bitTipHeight(code); // where the shell starts
  const mountZ = tipTop + 0.0062;

  // flange + shaft: the body that bolts up into the ratchet
  const shell = sweepSolid(
    [
      { f: 0.0, z: mountZ },
      { f: 1.0, z: mountZ },
      { f: 1.0, z: mountZ - 0.0022 },
      { f: 0.55, z: mountZ - 0.0042 },
      { f: 0.5, z: tipTop },
      { f: 0.0, z: tipTop },
    ],
    () => flangeR,
    DETAIL.sweep,
  );
  const shellMesh = new THREE.Mesh(shell, shellMat);
  shellMesh.castShadow = true;
  g.add(shellMesh);

  if (bitHasGear(code)) {
    // the Xtreme Dash gear ring: visible teeth around the flange
    const teeth = 16;
    const ringMat = paintedMetal(0xd8d8e4, 0.3);
    const geo = new THREE.BoxGeometry(0.0011, 0.0016, 0.0022);
    const inst = new THREE.InstancedMesh(geo, ringMat, teeth);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
      m4.compose(
        new THREE.Vector3(Math.cos(a) * flangeR * 0.98, Math.sin(a) * flangeR * 0.98, mountZ - 0.0034),
        q,
        new THREE.Vector3(1, 1, 1),
      );
      inst.setMatrixAt(i, m4);
    }
    g.add(inst);
  }

  // tip — the part that touches the dish
  const hard = new THREE.MeshPhysicalMaterial({
    color: code === "MN" ? 0xc9ccd8 : 0x23232b,
    metalness: code === "MN" ? 1 : 0.05,
    roughness: code === "MN" ? 0.24 : 0.42,
    clearcoat: 0.5,
    clearcoatRoughness: 0.25,
  });
  const tipMat = fam === "rubberFlat" ? rubberMat(0x7e1c1c) : hard;
  // every tip is built so its lowest point lands exactly on baseZ
  const h = bitTipHeight(code);
  let tip: THREE.Mesh;
  switch (fam) {
    case "ball": {
      // a hemisphere-ish ball: the contact point is the bottom of the sphere
      const rBall = 0.0032;
      tip = new THREE.Mesh(new THREE.SphereGeometry(rBall, DETAIL.radial, DETAIL.rings), tipMat);
      tip.position.z = baseZ + rBall;
      break;
    }
    case "needle":
      tip = new THREE.Mesh(new THREE.ConeGeometry(0.0016, h, DETAIL.radial, 6), tipMat);
      tip.rotation.x = -Math.PI / 2; // apex down
      tip.position.z = baseZ + h / 2;
      break;
    case "point":
      tip = new THREE.Mesh(new THREE.ConeGeometry(0.0009, h, DETAIL.radial, 6), tipMat);
      tip.rotation.x = -Math.PI / 2;
      tip.position.z = baseZ + h / 2;
      break;
    case "taper":
      tip = new THREE.Mesh(new THREE.CylinderGeometry(0.0036, 0.0012, h, DETAIL.radial, 6), tipMat);
      tip.rotation.x = Math.PI / 2;
      tip.position.z = baseZ + h / 2;
      break;
    default: {
      // flat family: wide skidding disc with a crisp edge
      const wide = code.startsWith("W") || code === "LF" ? 0.0042 : 0.0034;
      tip = new THREE.Mesh(new THREE.CylinderGeometry(wide, wide * 0.9, h, DETAIL.radial, 4), tipMat);
      tip.rotation.x = Math.PI / 2;
      tip.position.z = baseZ + h / 2;
      break;
    }
  }
  tip.castShadow = true;
  g.add(tip);
  return g;
}

// ---- whole bey -------------------------------------------------------------

/**
 * Assemble a full top from its resolved parts. Local +Z is up; the tip sits
 * at z ≈ 0 so the sim's contact point and the mesh's agree.
 */
export function buildBeyMesh(
  rc: ResolvedCombo | null,
  params: BeyParams,
  accent: number,
): THREE.Group {
  const g = new THREE.Group();
  const bladePart = rc?.parts.blade ?? rc?.parts.mainBlade;
  const R = partRadiusM(bladePart, params.radiusM);

  // stack upward from the tip, which sits at local z = 0 because the sim
  // places the mesh origin on the dish surface: bit → ratchet → blade
  const bitCode = rc?.parts.bit?.code ?? "F";
  const bitTop = bitHeight(bitCode);
  const { heightM } = ratchetSpec(rc?.parts.ratchet?.code);
  const ratchetTopZ = bitTop + heightM;

  g.add(buildBit(rc?.parts.bit, 0));
  g.add(buildRatchet(rc?.parts.ratchet, ratchetTopZ));
  if (rc?.isCx) g.add(buildCxStack(rc, accent, R, ratchetTopZ));
  else g.add(buildBlade(bladePart, accent, R, ratchetTopZ));

  // spin-blur shader ring: streaks that counter-rotate in the local frame,
  // which is what sells 1000+ rpm far better than geometry alone
  const color = bladeColorOf(bladePart, accent);
  const blurMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(color).multiplyScalar(1.15) },
      uPhase: { value: 0 },
      uIntensity: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv - 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uPhase;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        float r = length(vUv) * 2.0;
        float band = smoothstep(0.55, 0.82, r) * (1.0 - smoothstep(0.94, 1.0, r));
        float a = atan(vUv.y, vUv.x);
        float streaks = 0.55 + 0.45 * sin(a * 9.0 + uPhase);
        float alpha = uIntensity * band * streaks;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor, alpha);
      }`,
  });
  const blur = new THREE.Mesh(new THREE.PlaneGeometry(R * 2.3, R * 2.3, 2, 2), blurMat);
  blur.position.z = ratchetTopZ + 0.005;
  blur.name = "blurRing";
  g.add(blur);
  return g;
}
