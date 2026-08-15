// BattleView: the 3D presentation of a battle. Consumes WorldState from the
// deterministic core (never mutates it) and SimEvents for effects/audio.
// Camera modes: "orbit" (touch), "gyro" (sensor-anchored stadium, Mode A),
// "launch" (first-person behind the launcher during the launch phase).

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

import { surfaceZ, type StadiumSpec } from "../core/stadium";
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
function lobedShape(r: number, lobes: number, depth: number, sharp: number): THREE.Shape {
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
function buildBeyMesh(rc: ResolvedCombo | null, params: BeyParams, accent: number): THREE.Group {
  const g = new THREE.Group();
  const r = params.radiusM;
  const type = rc?.parts.blade?.type ?? rc?.parts.mainBlade?.type ?? null;
  const color = type ? TYPE_COLORS[type]! : accent;
  const attack = rc?.parts.blade?.stats.attack ?? 40;

  // ---- blade: die-cast metal disc with type-dependent silhouette ----
  const silhouette =
    type === "attack"
      ? { lobes: Math.max(3, Math.round(attack / 18)), depth: 0.13, sharp: 1.6 }
      : type === "defense"
        ? { lobes: 8, depth: 0.045, sharp: 1.0 }
        : type === "stamina"
          ? { lobes: 12, depth: 0.02, sharp: 0.8 }
          : { lobes: 6, depth: 0.075, sharp: 1.2 };
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
    this.sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd766 });
    window.addEventListener("resize", () => this.resize());
    this.attachOrbitControls(container);
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

    // Xtreme Line gear rack: instanced teeth along each arc
    if (s.railArcs.length > 0) {
      const toothPitch = 0.0056; // m along circumference
      let total = 0;
      const arcs = s.railArcs.map((a) => {
        const span = a.end > a.start ? a.end - a.start : a.end + Math.PI * 2 - a.start;
        const count = Math.max(4, Math.floor((span * s.rRail) / toothPitch));
        total += count;
        return { ...a, span, count };
      });
      const toothGeo = new THREE.BoxGeometry(0.006, 0.0032, 0.0026);
      const toothMat = new THREE.MeshStandardMaterial({
        color: s.railColor,
        roughness: 0.45,
        metalness: 0.15,
      });
      const inst = new THREE.InstancedMesh(toothGeo, toothMat, total);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      let idx = 0;
      for (const a of arcs) {
        for (let i = 0; i < a.count; i++) {
          const th = a.start + (a.span * (i + 0.5)) / a.count;
          q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), th);
          m4.compose(
            new THREE.Vector3(
              Math.cos(th) * s.rRail,
              Math.sin(th) * s.rRail,
              surfaceZ(s, s.rRail) + 0.0013,
            ),
            q,
            new THREE.Vector3(1, 1, 1),
          );
          inst.setMatrixAt(idx++, m4);
        }
      }
      this.stadiumGroup.add(inst);
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
