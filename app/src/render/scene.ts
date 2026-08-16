// BattleView: the 3D presentation of a battle. Consumes WorldState from the
// deterministic core (never mutates it) and SimEvents for effects/audio.
// Camera modes: "orbit" (touch), "gyro" (sensor-anchored stadium, Mode A),
// "launch" (first-person behind the launcher during the launch phase).

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

import { railPointAt, railTangentAt, surfaceZ, type StadiumSpec } from "../core/stadium";
import { wrapAngle } from "../core/fxmath";
import type { BeyParams, WorldState } from "../core/types";
import type { ResolvedCombo } from "../core/derive";
import { gyro } from "../sensors/gyro";
import { sfx } from "../audio/sfx";

const TYPE_COLORS: Record<string, number> = {
  attack: 0xc23c3c,
  defense: 0x3c66c2,
  stamina: 0x3cb26a,
  balance: 0xc2a23c,
};

/** Official colorway names (phstudy part_colors) → render colors. */
const COLOR_NAMES: Record<string, number> = {
  red: 0xc22e2e, blue: 0x2e55c2, navy: 0x1d2a66, cyan: 0x2eb8c2,
  green: 0x2ea34a, yellow: 0xd8c22e, orange: 0xd8802e, purple: 0x7a3fc2,
  pink: 0xd85f9e, white: 0xe8e8f0, black: 0x22222a, gray: 0x8a8a94,
  grey: 0x8a8a94, silver: 0xc8ccd8, gold: 0xcfae4a, bronze: 0xb08048,
  brown: 0x7a5636, clear: 0xd8e0f0, lime: 0x9ed82e, magenta: 0xc22ea3,
  turquoise: 0x2ec2a3, violet: 0x8a4ad8,
};

/** Stable tiny hash so every part gets a distinct-but-repeatable look. */
function partSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// ---- procedural textures (no third-party assets) --------------------------

function canvasTex(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const c = cv.getContext("2d")!;
  draw(c, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Injection-molded plastic: base color with fine grain + faint swirl. */
function plasticTexture(base: string, grain: string): THREE.CanvasTexture {
  return canvasTex(512, (c, s) => {
    c.fillStyle = base;
    c.fillRect(0, 0, s, s);
    c.globalAlpha = 0.05;
    for (let i = 0; i < 2600; i++) {
      c.fillStyle = Math.random() > 0.5 ? grain : "#000";
      c.fillRect(Math.random() * s, Math.random() * s, 1.4, 1.4);
    }
    c.globalAlpha = 0.045;
    c.strokeStyle = grain;
    for (let i = 0; i < 26; i++) {
      c.beginPath();
      c.arc(s / 2 + (Math.random() - 0.5) * s, s / 2 + (Math.random() - 0.5) * s, Math.random() * s * 0.6, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
  });
}

/** Spun/brushed metal: concentric arcs (used as roughness detail + color). */
function brushedMetalTexture(tint: string): THREE.CanvasTexture {
  return canvasTex(512, (c, s) => {
    c.fillStyle = tint;
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      const r = Math.random() * s * 0.72;
      const a0 = Math.random() * Math.PI * 2;
      c.globalAlpha = 0.05 + Math.random() * 0.06;
      c.strokeStyle = Math.random() > 0.45 ? "#ffffff" : "#555";
      c.lineWidth = 0.8;
      c.beginPath();
      c.arc(s / 2, s / 2, r, a0, a0 + 0.4 + Math.random() * 1.4);
      c.stroke();
    }
    c.globalAlpha = 1;
  });
}

/** Table wood for the ground plane under the stadium (gyro mode realism). */
function woodTexture(): THREE.CanvasTexture {
  return canvasTex(512, (c, s) => {
    c.fillStyle = "#8a6440";
    c.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) {
      const w = 0.5 + 0.5 * Math.sin(y * 0.11) + 0.3 * Math.sin(y * 0.037 + 2);
      c.globalAlpha = 0.1 + 0.1 * w;
      c.fillStyle = y % 64 < 3 ? "#5d4127" : "#7a5636";
      c.fillRect(0, y, s, 2);
    }
    c.globalAlpha = 0.12;
    for (let i = 0; i < 40; i++) {
      c.strokeStyle = "#4c3520";
      c.beginPath();
      const y0 = Math.random() * s;
      c.moveTo(0, y0);
      c.bezierCurveTo(s * 0.3, y0 + 8, s * 0.7, y0 - 8, s, y0 + 4);
      c.stroke();
    }
    c.globalAlpha = 1;
  });
}

function ringSegmentShape(rIn: number, rOut: number, a0: number, a1: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, rOut, a0, a1, false);
  s.absarc(0, 0, rIn, a1, a0, true);
  return s;
}

/** Star-ish 2D outline: base radius with N lobes of given depth. */
export function lobedShape(r: number, lobes: number, depth: number, sharp: number): THREE.Shape {
  const s = new THREE.Shape();
  const steps = 128;
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * Math.PI * 2;
    const wave = Math.pow(0.5 + 0.5 * Math.cos(lobes * th), sharp);
    const rr = r * (1 - depth + depth * wave);
    const x = Math.cos(th) * rr;
    const y = Math.sin(th) * rr;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  return s;
}

/** Parametric bey mesh from the resolved combo (no third-party assets). */
export function buildBeyMesh(rc: ResolvedCombo | null, params: BeyParams, accent: number): THREE.Group {
  const g = new THREE.Group();
  const r = params.radiusM;
  const bladePart = rc?.parts.blade ?? rc?.parts.mainBlade;
  const type = bladePart?.type ?? null;
  // official colorway first, then type color, then side accent
  const named = bladePart?.color ? COLOR_NAMES[bladePart.color.toLowerCase()] : undefined;
  const color = named ?? (type ? TYPE_COLORS[type]! : accent);
  const attack = bladePart?.stats.attack ?? 40;
  // per-part seeded variation → each blade silhouette is recognizably its own
  const seed = partSeed(bladePart?.key ?? "?");
  const seed2 = partSeed((bladePart?.key ?? "?") + "b");

  // ---- blade: die-cast metal disc with type-dependent silhouette ----
  const base =
    type === "attack"
      ? { lobes: Math.max(3, Math.round(attack / 18)), depth: 0.13, sharp: 1.6 }
      : type === "defense"
        ? { lobes: 8, depth: 0.045, sharp: 1.0 }
        : type === "stamina"
          ? { lobes: 12, depth: 0.02, sharp: 0.8 }
          : { lobes: 6, depth: 0.075, sharp: 1.2 };
  const silhouette = {
    lobes: Math.max(3, base.lobes + Math.round((seed - 0.5) * 4)),
    depth: Math.max(0.015, base.depth * (0.75 + seed2 * 0.6)),
    sharp: base.sharp * (0.8 + seed * 0.5),
  };
  const bladeGeo = new THREE.ExtrudeGeometry(
    lobedShape(r, silhouette.lobes, silhouette.depth, silhouette.sharp),
    { depth: 0.0075, bevelEnabled: true, bevelSize: 0.0008, bevelThickness: 0.0008, bevelSegments: 2 },
  );
  const brushTint = `#${new THREE.Color(color).multiplyScalar(0.85).getHexString()}`;
  const bladeMat = new THREE.MeshPhysicalMaterial({
    map: brushedMetalTexture(brushTint),
    metalness: 0.92,
    roughness: 0.32,
    clearcoat: 0.2,
    clearcoatRoughness: 0.3,
  });
  // anisotropic highlight: spun metal streaks tangentially like a real
  // machined disc (per-pixel BRDF feature of MeshPhysicalMaterial)
  bladeMat.anisotropy = 0.7;
  const blade = new THREE.Mesh(bladeGeo, bladeMat);
  blade.position.z = 0.0135;
  blade.castShadow = true;
  g.add(blade);

  // custom pixel shader: rotational motion-blur ring whose streaks spin with
  // ω — sells high RPM far better than rotating geometry alone
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
        float r = length(vUv) * 2.0;            // 0 center → 1 edge
        float band = smoothstep(0.45, 0.72, r) * (1.0 - smoothstep(0.9, 1.0, r));
        float a = atan(vUv.y, vUv.x);
        float streaks = 0.6 + 0.4 * sin(a * 9.0 + uPhase);
        float alpha = uIntensity * band * streaks;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor, alpha);
      }`,
  });
  const blur = new THREE.Mesh(new THREE.PlaneGeometry(r * 2.5, r * 2.5), blurMat);
  blur.position.z = 0.0185;
  blur.name = "blurRing";
  g.add(blur);

  // CX lock chip cap
  if (rc?.isCx) {
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.3, r * 0.3, 0.0035, 20),
      new THREE.MeshStandardMaterial({ color: 0x1c1c26, metalness: 0.6, roughness: 0.4 }),
    );
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.0235;
    g.add(cap);
  }

  // ---- ratchet: translucent ring with N protrusions ----
  const ratchetCode = rc?.parts.ratchet?.code ?? "3-60";
  const prot = Number.parseInt(ratchetCode, 10);
  const ratchetLobes = Number.isFinite(prot) && prot > 0 ? prot : 5;
  const ratchetH = Math.max(0.0035, (rc?.parts.ratchet?.stats.height ?? 60) / 10000);
  const ratchet = new THREE.Mesh(
    new THREE.ExtrudeGeometry(lobedShape(r * 0.44, ratchetLobes, 0.16, 1.2), {
      depth: ratchetH,
      bevelEnabled: false,
    }),
    new THREE.MeshPhysicalMaterial({
      color: 0xf2f2f8,
      roughness: 0.32,
      metalness: 0.0,
      transparent: true,
      opacity: 0.88,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
    }),
  );
  ratchet.position.z = 0.0135 - ratchetH;
  ratchet.castShadow = true;
  g.add(ratchet);

  // ---- bit: base + tip by code ----
  const bitCode = rc?.parts.bit?.code ?? "F";
  const bitType = rc?.parts.bit?.type ?? "attack";
  const bitBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0048, 0.0044, 0.0045, 16),
    new THREE.MeshStandardMaterial({
      color: TYPE_COLORS[bitType ?? "attack"] ?? 0x888888,
      roughness: 0.35,
      transparent: true,
      opacity: 0.95,
    }),
  );
  bitBase.rotation.x = Math.PI / 2;
  bitBase.position.z = 0.0075;
  g.add(bitBase);

  const tipMat = new THREE.MeshStandardMaterial({
    color: bitCode.startsWith("R") ? 0x8a2020 : 0x24242c,
    roughness: 0.8,
  });
  let tip: THREE.Mesh;
  if (/^(B|O|DB|FB|GB|WB|LO)/.test(bitCode)) {
    tip = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 12, 10), tipMat);
    tip.position.z = 0.0028;
  } else if (/N/.test(bitCode) && bitCode !== "Nr") {
    tip = new THREE.Mesh(new THREE.ConeGeometry(0.0018, 0.0052, 10), tipMat);
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = 0.0026;
  } else if (/^(P|GP|TP|D|S)/.test(bitCode)) {
    tip = new THREE.Mesh(new THREE.ConeGeometry(0.0013, 0.003, 10), tipMat);
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = 0.0015;
  } else {
    // flat family (F/LF/UF/FF/GF/R/RA/T…): wide truncated cone
    tip = new THREE.Mesh(new THREE.CylinderGeometry(0.0016, 0.0032, 0.0032, 14), tipMat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.0018;
  }
  g.add(tip);

  // white pointer spoke so spin/phase is visible
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(r * 1.6, 0.0032, 0.0014),
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2 }),
  );
  spoke.position.z = 0.0225;
  g.add(spoke);
  return g;
}

interface Spark {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

export type CameraMode = "orbit" | "gyro" | "launch";

export class BattleView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private beyMeshes: [THREE.Group | null, THREE.Group | null] = [null, null];
  private beyParams: [BeyParams | null, BeyParams | null] = [null, null];
  private sparks: Spark[] = [];
  private sparkMat: THREE.MeshBasicMaterial;
  private stadiumGroup = new THREE.Group();
  private stadium: StadiumSpec | null = null;
  mode: CameraMode = "orbit";
  private orbitYaw = -Math.PI / 2;
  private orbitPitch = 0.9;
  private orbitDist = 0.5;
  launchSide: 0 | 1 = 0;
  private ease: { p: THREE.Vector3; q: THREE.Quaternion; t: number; dur: number } | null = null;

  /** Smoothly blend the camera from its current pose to the next mode's. */
  beginCameraEase(dur = 0.9): void {
    this.ease = {
      p: this.camera.position.clone(),
      q: this.camera.quaternion.clone(),
      t: 0,
      dur,
    };
  }

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.005, 20);
    this.scene.background = new THREE.Color(0x14161c);

    // image-based lighting from three's built-in procedural room (real metal
    // reflections without shipping any HDRI asset)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;

    const key = new THREE.DirectionalLight(0xfff4e4, 2.4);
    key.position.set(0.45, -0.35, 0.85);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -0.45;
    key.shadow.camera.right = key.shadow.camera.top = 0.45;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 3;
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd0ff, 0.55);
    fill.position.set(-0.5, 0.4, 0.5);
    this.scene.add(fill);

    // the table the stadium sits on (sells the gyro anchoring)
    const wood = woodTexture();
    wood.repeat.set(3, 3);
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 1.6),
      new THREE.MeshStandardMaterial({ map: wood, roughness: 0.75, metalness: 0.02 }),
    );
    table.position.z = -0.001;
    table.receiveShadow = true;
    this.scene.add(table);

    this.scene.add(this.stadiumGroup);
    this.scene.add(this.camera); // so camera-attached rigs (launcher) render
    this.sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd766 });
    window.addEventListener("resize", () => this.resize());
    this.attachOrbitControls(container);
  }

  // ---- 3D launcher rig (launch phase) -------------------------------------

  private launcherRig: {
    group: THREE.Group;
    winder: THREE.Group;
    stringMesh: THREE.Mesh;
    beyPivot: THREE.Group;
    beySpin: THREE.Group;
    pullM: number;
  } | null = null;

  /** Camera-attached string launcher holding the player's actual bey. */
  attachLauncher(rc: ResolvedCombo | null, params: BeyParams, accent: number): void {
    this.removeLauncher();
    const g = new THREE.Group();
    const plastic = new THREE.MeshPhysicalMaterial({
      color: 0x2b3a9e,
      roughness: 0.35,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
    });
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0aa82, roughness: 0.65 });
    const red = new THREE.MeshPhysicalMaterial({ color: 0xc23434, roughness: 0.4, clearcoat: 0.4 });

    // body: rounded puck with a beveled profile
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      prof.push(new THREE.Vector2(0.036 * Math.sin((t * Math.PI) / 2) + 0.001, 0.024 * t));
    }
    const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), plastic);
    body.rotation.x = Math.PI / 2;
    body.castShadow = true;
    g.add(body);
    const capRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.024, 0.0035, 10, 32),
      new THREE.MeshStandardMaterial({ color: 0xdadff5, metalness: 0.6, roughness: 0.3 }),
    );
    capRing.position.z = 0.013;
    g.add(capRing);

    // grip below-rear + left hand wrapped around it
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.035, 6, 12), plastic);
    grip.position.set(-0.012, -0.008, 0.035);
    grip.rotation.x = 1.15;
    g.add(grip);
    for (let f = 0; f < 4; f++) {
      const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.0055, 0.02, 4, 8), skin);
      finger.position.set(-0.03 + f * 0.0025, -0.012 + f * 0.004, 0.032 + f * 0.008);
      finger.rotation.z = 1.2;
      g.add(finger);
    }
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 10), skin);
    palm.position.set(-0.028, -0.01, 0.045);
    g.add(palm);

    // string port + string + winder T-handle + right hand
    const port = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.012, 0.012), plastic);
    port.position.set(0.038, 0, 0);
    g.add(port);
    const stringMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0012, 0.0012, 1, 6),
      new THREE.MeshStandardMaterial({ color: 0xe8ecf8, roughness: 0.6 }),
    );
    g.add(stringMesh);
    const winder = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.028, 10), red);
    winder.add(stem);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.055, 10), red);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = -0.018;
    winder.add(bar);
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 10), skin);
    fist.scale.set(1, 0.8, 0.9);
    fist.position.y = -0.02;
    winder.add(fist);
    winder.position.set(0.055, 0, 0);
    g.add(winder);

    // the player's actual bey mounted underneath (tip pointing down-forward)
    const beyPivot = new THREE.Group();
    const beySpin = new THREE.Group();
    beySpin.add(buildBeyMesh(rc, params, accent));
    beyPivot.add(beySpin);
    beyPivot.rotation.x = -Math.PI / 2;
    beyPivot.position.set(0, -0.048, 0.004);
    g.add(beyPivot);

    g.position.set(0.03, -0.085, -0.24);
    g.rotation.x = -0.55;
    this.camera.add(g);
    this.launcherRig = { group: g, winder, stringMesh, beyPivot, beySpin, pullM: 0 };
    this.updateLauncherString();
  }

  private updateLauncherString(): void {
    const rig = this.launcherRig;
    if (!rig) return;
    const from = new THREE.Vector3(0.042, 0, 0);
    const to = rig.winder.position.clone();
    const mid = from.clone().add(to).multiplyScalar(0.5);
    rig.stringMesh.position.copy(mid);
    const dir = to.clone().sub(from);
    rig.stringMesh.scale.y = Math.max(0.012, dir.length());
    rig.stringMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }

  /** Pull in screen px → winder + string follow (full-screen granularity). */
  setLauncherPull(px: number): void {
    const rig = this.launcherRig;
    if (!rig) return;
    rig.pullM = Math.min(0.42, px * 0.00075);
    rig.winder.position.set(0.055 + rig.pullM * 0.25, -rig.pullM, 0.01 * rig.pullM);
    this.updateLauncherString();
  }

  /** Release: bey spins up, rips off toward the stadium; launcher lifts away. */
  releaseLauncher(): Promise<void> {
    const rig = this.launcherRig;
    if (!rig) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (): void => {
        const rigNow = this.launcherRig;
        if (!rigNow) {
          resolve();
          return;
        }
        const t = Math.min(1, (performance.now() - t0) / 650);
        rigNow.beySpin.rotation.z = t * t * 90; // visible spin-up
        rigNow.beyPivot.position.set(0, -0.048 - t * 0.45, 0.004 - t * 0.4);
        rigNow.winder.position.set(0.055, -rigNow.pullM * (1 - t), 0);
        rigNow.group.position.set(0.03, -0.085 + t * 0.22, -0.24 + t * 0.1);
        this.updateLauncherString();
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  removeLauncher(): void {
    if (this.launcherRig) {
      this.camera.remove(this.launcherRig.group);
      this.launcherRig = null;
    }
  }

  // ---- opponent launcher (world-anchored; bots launch at the countdown) ---

  private oppRigs: { group: THREE.Group; beySpin: THREE.Group; side: 0 | 1 }[] = [];

  /** Simplified launcher hovering over the opponent's entry corner, with
   * their actual bey attached — released in sync with GO SHOOT. */
  attachOpponentLauncher(rc: ResolvedCombo | null, params: BeyParams, side: 0 | 1): void {
    this.removeOpponentLauncher(side);
    const g = new THREE.Group();
    const plastic = new THREE.MeshPhysicalMaterial({
      color: side === 0 ? 0x2b3a9e : 0x8e2b2b,
      roughness: 0.35,
      clearcoat: 0.5,
    });
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      prof.push(new THREE.Vector2(0.034 * Math.sin((t * Math.PI) / 2) + 0.001, 0.022 * t));
    }
    const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 32), plastic);
    body.castShadow = true;
    g.add(body);
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.01, 0.05, 6, 10), plastic);
    grip.rotation.z = Math.PI / 2.4;
    grip.position.set(-0.045, 0.02, 0);
    g.add(grip);

    const beySpin = new THREE.Group();
    beySpin.add(buildBeyMesh(rc, params, side === 0 ? 0x3f7bff : 0xff5b4d));
    beySpin.rotation.x = Math.PI / 2; // hang under the body, tip down
    beySpin.position.y = -0.035;
    g.add(beySpin);

    const baseAngle = side === 0 ? Math.PI - 0.55 : 0.55;
    const r0 = 0.075;
    g.position.set(Math.cos(baseAngle) * r0, Math.sin(baseAngle) * r0, 0.17);
    g.rotation.x = Math.PI / 2; // body upright, bey toward the floor
    g.rotation.y = (side === 0 ? 1 : -1) * 0.25; // aimed slightly inward
    this.scene.add(g);
    this.oppRigs.push({ group: g, beySpin, side });
  }

  /** Drop the bey to the surface with spin-up, lift the launcher, remove. */
  playOpponentRelease(side?: 0 | 1): Promise<void> {
    const rigs = this.oppRigs.filter((r) => side === undefined || r.side === side);
    if (rigs.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (): void => {
        const t = Math.min(1, (performance.now() - t0) / 500);
        for (const rig of rigs) {
          rig.beySpin.rotation.y = t * t * 70; // spin-up around its axis
          rig.beySpin.position.y = -0.035 - t * 0.115; // down to the bowl
          rig.group.position.z = 0.17 + t * 0.08; // launcher lifts away
        }
        if (t < 1) requestAnimationFrame(tick);
        else {
          for (const rig of rigs) this.scene.remove(rig.group);
          this.oppRigs = this.oppRigs.filter((r) => !rigs.includes(r));
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  removeOpponentLauncher(side?: 0 | 1): void {
    this.oppRigs = this.oppRigs.filter((r) => {
      if (side === undefined || r.side === side) {
        this.scene.remove(r.group);
        return false;
      }
      return true;
    });
  }

  private attachOrbitControls(el: HTMLElement): void {
    let dragging = false;
    let px = 0;
    let py = 0;
    el.addEventListener("pointerdown", (e) => {
      if (this.mode !== "orbit") return;
      dragging = true;
      px = e.clientX;
      py = e.clientY;
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging || this.mode !== "orbit") return;
      this.orbitYaw -= (e.clientX - px) * 0.006;
      this.orbitPitch = Math.min(1.45, Math.max(0.25, this.orbitPitch + (e.clientY - py) * 0.005));
      px = e.clientX;
      py = e.clientY;
    });
    el.addEventListener("pointerup", () => (dragging = false));
    el.addEventListener("pointercancel", () => (dragging = false));
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  setStadium(s: StadiumSpec): void {
    this.stadium = s;
    this.stadiumGroup.clear();
    const rimZ = surfaceZ(s, s.rWall);
    const baseHex = `#${s.bodyColor.toString(16).padStart(6, "0")}`;
    const plastic = plasticTexture(baseHex, "#ffffff");
    plastic.repeat.set(2, 2);
    const bodyMat = new THREE.MeshPhysicalMaterial({
      map: plastic,
      roughness: 0.5,
      metalness: 0.03,
      clearcoat: 0.22,
      clearcoatRoughness: 0.55,
      envMapIntensity: 0.55,
      side: THREE.DoubleSide,
    });

    // battle bowl from the physics surface profile
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= 30; i++) {
      const r = (s.rWall * i) / 30;
      profile.push(new THREE.Vector2(Math.max(1e-4, r), surfaceZ(s, r)));
    }
    const dish = new THREE.Mesh(new THREE.LatheGeometry(profile, 96), bodyMat);
    dish.rotateX(Math.PI / 2);
    dish.scale.z = -1;
    dish.receiveShadow = true;
    this.stadiumGroup.add(dish);

    // outer deck: rectangle with circular bowl cut-out
    const deckShape = new THREE.Shape();
    const hw = s.deckW / 2;
    const hh = s.deckH / 2;
    deckShape.moveTo(-hw, -hh);
    deckShape.lineTo(hw, -hh);
    deckShape.lineTo(hw, hh);
    deckShape.lineTo(-hw, hh);
    deckShape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, s.rWall * 0.998, 0, Math.PI * 2, true);
    deckShape.holes.push(hole);
    const deck = new THREE.Mesh(
      new THREE.ExtrudeGeometry(deckShape, { depth: 0.014, bevelEnabled: false }),
      bodyMat,
    );
    deck.position.z = rimZ - 0.012;
    deck.receiveShadow = true;
    deck.castShadow = true;
    this.stadiumGroup.add(deck);

    // tornado ridge accent
    const ridge = new THREE.Mesh(
      new THREE.TorusGeometry(s.rDish, 0.0018, 8, 100),
      new THREE.MeshStandardMaterial({ color: 0x8899dd, roughness: 0.4 }),
    );
    ridge.position.z = surfaceZ(s, s.rDish);
    this.stadiumGroup.add(ridge);

    // Xtreme Line gear rack: teeth walked along the real curved path
    // (oval base + concave dips) at constant arc-length pitch, oriented to
    // the local tangent, plus a base strip so the line reads like molding.
    if (s.railArcs.length > 0) {
      const toothPitch = 0.0056;
      const placements: { p: { x: number; y: number }; rot: number }[] = [];
      const stripPts: THREE.Vector3[] = [];
      for (const a of s.railArcs) {
        const span = a.end > a.start ? a.end - a.start : a.end + Math.PI * 2 - a.start;
        const steps = Math.max(64, Math.ceil(span / 0.01));
        let acc = toothPitch; // place the first tooth immediately
        let prev = railPointAt(s, a.start);
        for (let i = 0; i <= steps; i++) {
          const th = a.start + (span * i) / steps;
          const pt = railPointAt(s, th);
          stripPts.push(new THREE.Vector3(pt.x, pt.y, surfaceZ(s, Math.hypot(pt.x, pt.y)) + 0.0011));
          acc += Math.hypot(pt.x - prev.x, pt.y - prev.y);
          if (acc >= toothPitch) {
            acc = 0;
            const t = railTangentAt(s, th);
            placements.push({ p: pt, rot: Math.atan2(t.y, t.x) });
          }
          prev = pt;
        }
      }
      const toothGeo = new THREE.BoxGeometry(0.0032, 0.006, 0.0026); // tangential × radial
      const toothMat = new THREE.MeshStandardMaterial({
        color: s.railColor,
        roughness: 0.45,
        metalness: 0.15,
      });
      const inst = new THREE.InstancedMesh(toothGeo, toothMat, placements.length);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      placements.forEach((pl, idx) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), pl.rot);
        m4.compose(
          new THREE.Vector3(pl.p.x, pl.p.y, surfaceZ(s, Math.hypot(pl.p.x, pl.p.y)) + 0.0014),
          q,
          new THREE.Vector3(1, 1, 1),
        );
        inst.setMatrixAt(idx, m4);
      });
      this.stadiumGroup.add(inst);
      const strip = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(stripPts),
        new THREE.LineBasicMaterial({ color: s.railColor }),
      );
      this.stadiumGroup.add(strip);
    }

    // walls between pockets + pocket recesses
    const wallH = 0.055;
    const sorted = [...s.pockets].sort((a, b) => wrapAngle(a.angleCenter) - wrapAngle(b.angleCenter));
    const gaps: { a0: number; a1: number }[] = [];
    if (sorted.length === 0) {
      gaps.push({ a0: 0, a1: Math.PI * 2 });
    } else {
      for (let i = 0; i < sorted.length; i++) {
        const cur = sorted[i]!;
        const nxt = sorted[(i + 1) % sorted.length]!;
        const a0 = wrapAngle(cur.angleCenter) + cur.halfWidth;
        let a1 = wrapAngle(nxt.angleCenter) - nxt.halfWidth;
        if (a1 <= a0) a1 += Math.PI * 2;
        gaps.push({ a0, a1 });
      }
    }
    for (const gseg of gaps) {
      const wall = new THREE.Mesh(
        new THREE.ExtrudeGeometry(ringSegmentShape(s.rWall - 0.002, s.rWall + 0.006, gseg.a0, gseg.a1), {
          depth: wallH,
          bevelEnabled: false,
        }),
        bodyMat,
      );
      wall.position.z = rimZ - 0.004;
      this.stadiumGroup.add(wall);
    }
    for (const p of s.pockets) {
      const a0 = p.angleCenter - p.halfWidth;
      const a1 = p.angleCenter + p.halfWidth;
      const col = p.kind === "xtreme" ? 0xd8322f : 0xd89b2f;
      const floor = new THREE.Mesh(
        new THREE.ExtrudeGeometry(ringSegmentShape(s.rWall - 0.004, s.rWall + 0.052, a0, a1), {
          depth: 0.004,
          bevelEnabled: false,
        }),
        new THREE.MeshStandardMaterial({ color: col, roughness: 0.5 }),
      );
      floor.position.z = rimZ - 0.017; // sunken catch floor
      this.stadiumGroup.add(floor);
      const back = new THREE.Mesh(
        new THREE.ExtrudeGeometry(ringSegmentShape(s.rWall + 0.052, s.rWall + 0.058, a0, a1), {
          depth: wallH,
          bevelEnabled: false,
        }),
        bodyMat,
      );
      back.position.z = rimZ - 0.017;
      this.stadiumGroup.add(back);
    }

    // mostly-transparent casing: clear walls everywhere EXCEPT the gaps
    // (loose coverage — beys can still find their way out there)
    {
      const caseMat = new THREE.MeshPhysicalMaterial({
        color: 0xdfe8ff,
        transparent: true,
        opacity: 0.16,
        roughness: 0.12,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.15,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const gaps = [...s.coverGaps].sort((a, b) => wrapAngle(a.start) - wrapAngle(b.start));
      const covered: { a0: number; a1: number }[] = [];
      if (gaps.length === 0) {
        covered.push({ a0: 0, a1: Math.PI * 2 });
      } else {
        for (let i = 0; i < gaps.length; i++) {
          const cur = gaps[i]!;
          const nxt = gaps[(i + 1) % gaps.length]!;
          const a0 = wrapAngle(cur.end);
          let a1 = wrapAngle(nxt.start);
          if (a1 <= a0) a1 += Math.PI * 2;
          covered.push({ a0, a1 });
        }
      }
      for (const seg of covered) {
        const wallSeg = new THREE.Mesh(
          new THREE.ExtrudeGeometry(
            ringSegmentShape(s.rWall + 0.007, s.rWall + 0.011, seg.a0, seg.a1),
            { depth: s.coverHeight, bevelEnabled: false },
          ),
          caseMat,
        );
        wallSeg.position.z = rimZ + 0.02;
        this.stadiumGroup.add(wallSeg);
      }
    }

    // shoot position markers on the deck
    for (const a of s.shootAngles) {
      const marker = new THREE.Mesh(
        new THREE.TorusGeometry(0.016, 0.0022, 8, 32),
        new THREE.MeshStandardMaterial({ color: 0xee4444, roughness: 0.4 }),
      );
      marker.position.set(
        Math.cos(a) * (s.rWall + 0.033),
        Math.sin(a) * (s.rWall + 0.033),
        rimZ + 0.0035,
      );
      this.stadiumGroup.add(marker);
    }
  }

  setBeys(
    a: { rc: ResolvedCombo | null; params: BeyParams },
    b: { rc: ResolvedCombo | null; params: BeyParams },
  ): void {
    for (const m of this.beyMeshes) if (m) this.scene.remove(m);
    this.beyMeshes = [buildBeyMesh(a.rc, a.params, 0x3f7bff), buildBeyMesh(b.rc, b.params, 0xff5b4d)];
    this.beyParams = [a.params, b.params];
    for (const m of this.beyMeshes) this.scene.add(m!);
    sfx.startHums(2);
  }

  clearBeys(): void {
    for (const m of this.beyMeshes) if (m) this.scene.remove(m);
    this.beyMeshes = [null, null];
    sfx.stopHums();
  }

  /** Consume sim events → effects + audio. Call once per rendered frame. */
  consumeEvents(world: WorldState): void {
    for (const e of world.events) {
      if (e.kind === "hit") {
        this.spawnSparks(e.magnitude);
        sfx.hit(e.magnitude);
        if (navigator.vibrate) navigator.vibrate(Math.min(60, 8 + e.magnitude * 400));
      } else if (e.kind === "click") {
        sfx.click();
        if (navigator.vibrate) navigator.vibrate(15);
      } else if (e.kind === "dashStart") {
        sfx.dash();
      } else if (e.kind === "gear") {
        sfx.click(0.5); // rack teeth ticking under the bit gear
      } else if (e.kind === "trip") {
        this.spawnSparks(e.magnitude * 0.6);
        sfx.hit(0.9);
        if (navigator.vibrate) navigator.vibrate([25, 30, 45]);
      } else if (e.kind === "coverHit") {
        sfx.click(1.3); // plastic clank off the casing
        sfx.hit(e.magnitude * 0.15);
      } else if (e.kind === "exit") {
        sfx.pocket();
        if (navigator.vibrate) navigator.vibrate([30, 40, 60]);
      } else if (e.kind === "wallHit" && e.magnitude > 0.35) {
        sfx.hit(e.magnitude * 0.35);
      }
    }
    world.events.length = 0;
  }

  private spawnSparks(mag: number): void {
    const [b0, b1] = this.beyMeshes;
    if (!b0 || !b1) return;
    const origin = b0.position.clone().add(b1.position).multiplyScalar(0.5);
    const n = Math.min(14, 4 + Math.floor(mag * 90));
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.0012, 0.0012), this.sparkMat);
      mesh.position.copy(origin);
      const a = Math.random() * Math.PI * 2;
      const v = 0.25 + Math.random() * 0.6;
      this.sparks.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * v, Math.sin(a) * v, 0.3 + Math.random() * 0.5),
        life: 0.35,
      });
      this.scene.add(mesh);
    }
  }

  /** Update visuals from the world state (already stepped elsewhere). */
  update(world: WorldState | null, dt: number): void {
    const s = this.stadium;
    if (world && s) {
      for (let i = 0 as 0 | 1; i <= 1; i = (i + 1) as 0 | 1) {
        const b = world.beys[i];
        const m = this.beyMeshes[i];
        const p = this.beyParams[i];
        if (!m || !p) continue;
        const r = Math.hypot(b.x, b.y);
        m.position.set(b.x, b.y, surfaceZ(s, Math.min(r, s.rWall)));
        m.rotation.z = b.phase;
        const absOmega = Math.abs(b.omega);
        const blurMesh = m.getObjectByName("blurRing") as THREE.Mesh | undefined;
        if (blurMesh) {
          const bm = blurMesh.material as THREE.ShaderMaterial;
          bm.uniforms.uPhase!.value = -b.phase * 3; // streaks counter-rotate in local frame
          bm.uniforms.uIntensity!.value = Math.min(1, Math.max(0, (absOmega - 140) / 650)) * 0.5;
        }
        if (!b.alive && !b.exited) {
          m.rotation.x = Math.min(1.35, m.rotation.x + dt * 6); // burst keel
        } else if (b.exited) {
          m.position.z -= 0.05; // sunk into pocket
        } else if (absOmega < 140) {
          m.rotation.x = Math.sin(b.phase * 0.23) * (1 - absOmega / 140) * 0.35;
        } else {
          m.rotation.x = 0;
        }
        const pan = Math.max(-1, Math.min(1, b.x / (s.rWall * 1.2)));
        sfx.updateHum(i, (absOmega * 60) / (2 * Math.PI), pan, Math.hypot(b.vx, b.vy));
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i]!;
      sp.life -= dt;
      sp.vel.z -= 3.2 * dt;
      sp.mesh.position.addScaledVector(sp.vel, dt);
      if (sp.life <= 0) {
        this.scene.remove(sp.mesh);
        this.sparks.splice(i, 1);
      }
    }
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private updateCamera(dt: number): void {
    this.applyModeCamera();
    if (this.ease) {
      this.ease.t += dt;
      const k = Math.min(1, this.ease.t / this.ease.dur);
      const s = k * k * (3 - 2 * k);
      const targetP = this.camera.position.clone();
      const targetQ = this.camera.quaternion.clone();
      this.camera.position.lerpVectors(this.ease.p, targetP, s);
      this.camera.quaternion.slerpQuaternions(this.ease.q, targetQ, s);
      if (k >= 1) this.ease = null;
    }
  }

  private applyModeCamera(): void {
    if (this.mode === "gyro" && gyro.active) {
      gyro.apply(this.camera);
      return;
    }
    const pivot = new THREE.Vector3(0, 0, 0.02);
    if (this.mode === "launch") {
      const side = this.launchSide === 0 ? 1 : -1;
      const base = new THREE.Vector3(-0.16 * side, -0.4, 0.3);
      this.camera.position.copy(base);
      this.camera.lookAt(0, 0.03, 0.02);
      return;
    }
    this.camera.position.set(
      Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDist,
      Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDist,
      Math.sin(this.orbitPitch) * this.orbitDist + 0.02,
    );
    this.camera.lookAt(pivot.x, pivot.y, pivot.z);
  }
}
