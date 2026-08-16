// BattleView: the 3D presentation of a battle. Consumes WorldState from the
// deterministic core (never mutates it) and SimEvents for effects/audio.
// Camera modes: "orbit" (touch), "gyro" (sensor-anchored stadium, Mode A),
// "launch" (first-person behind the launcher during the launch phase).

import * as THREE from "three";

import { railPointAt, railTangentAt, surfaceZ, type StadiumSpec } from "../core/stadium";
import { wrapAngle } from "../core/fxmath";
import type { BeyParams, WorldState } from "../core/types";
import type { ResolvedCombo } from "../core/derive";
import { gyro } from "../sensors/gyro";
import { sfx } from "../audio/sfx";
import {
  absPlastic,
  clearPanel,
  paintedMetal,
  studioEnvironment,
  tableMaps,
} from "./materials";
import { buildBeyMesh, partRadiusM } from "./parts";
import { buildLauncher, updateCord, type LauncherRig } from "./hand";
import { RT_PRESETS, RayMarchComposer, markReflective } from "./rt";

export { buildBeyMesh } from "./parts";

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

interface Spark {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

export type CameraMode = "orbit" | "gyro" | "launch" | "cinema";

export class BattleView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private beyMeshes: (THREE.Group | null)[] = [];
  private beyParams: (BeyParams | null)[] = [];
  private sparks: Spark[] = [];
  private sparkMat: THREE.MeshBasicMaterial;
  private stadiumGroup = new THREE.Group();
  private stadium: StadiumSpec | null = null;
  mode: CameraMode = "orbit";
  private orbitYaw = -Math.PI / 2;
  private orbitPitch = 0.9;
  private orbitDist = 0.56; // frames the true-scale (wider) bowls
  launchSide: 0 | 1 = 0;
  /** silences hums/sfx/haptics (menu-background battles) */
  audioMuted = false;
  private lastBeyPos: THREE.Vector3[] = [
    new THREE.Vector3(0.06, 0.04, 0.02),
    new THREE.Vector3(-0.06, -0.04, 0.02),
  ];
  private cine = { shot: 0, t: 0, dur: 5, a0: 0, speed: 0.2, dist: 0.5, pitch: 0.9, bey: 0 };
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
    // our world is Z-up; without this, lookAt() at arbitrary yaws rolls the
    // horizon (up to 90° "sideways" shots — three.js defaults to Y-up)
    this.camera.up.set(0, 0, 1);
    this.scene.background = new THREE.Color(0x14161c);

    // image-based lighting from a procedural photo studio (docs/MODELING.md
    // §5): softboxes + bounce, so metal shows a real gradient falloff
    this.scene.environment = studioEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.85;

    const key = new THREE.DirectionalLight(0xfff4e4, 2.6);
    key.position.set(0.45, -0.35, 0.85);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -0.45;
    key.shadow.camera.right = key.shadow.camera.top = 0.45;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 3;
    key.shadow.bias = -0.00025;
    key.shadow.normalBias = 0.0015;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5);
    fill.position.set(-0.5, 0.4, 0.5);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffd9b0, 0.35);
    rim.position.set(-0.2, 0.7, 0.15);
    this.scene.add(rim);

    // the table the stadium sits on (sells the anchored AR view)
    const tm = tableMaps();
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 1.6, 64, 64),
      new THREE.MeshStandardMaterial({
        map: tm.map,
        normalMap: tm.normalMap,
        roughness: 0.62,
        metalness: 0.02,
      }),
    );
    table.position.z = -0.001;
    table.receiveShadow = true;
    this.scene.add(table);

    this.scene.add(this.stadiumGroup);
    this.scene.add(this.camera); // so camera-attached rigs (launcher) render
    this.sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd766 });
    this.rt = new RayMarchComposer(this.renderer, this.scene, this.camera);
    this.rt.lightWorld.copy(key.position).normalize();
    this.applyRtQuality();
    window.addEventListener("resize", () => this.resize());
    this.attachOrbitControls(container);
  }

  // ---- ray-marched realism pass -------------------------------------------

  private rt: RayMarchComposer;
  /** "off" | "low" | "high"; auto-drops to low on slow devices. */
  rtQuality: keyof typeof RT_PRESETS = "high";
  private frameMs = 16;

  private applyRtQuality(): void {
    this.rt.quality = RT_PRESETS[this.rtQuality] ?? RT_PRESETS.high!;
    this.rt.setSize(window.innerWidth, window.innerHeight, this.renderer.getPixelRatio());
  }

  setRtQuality(q: keyof typeof RT_PRESETS): void {
    this.rtQuality = q;
    this.applyRtQuality();
  }

  /** Draw one frame through the ray-march composer, with a frame-time
   * governor that steps quality down rather than dropping frames. */
  renderFrame(dtMs: number): void {
    this.frameMs = this.frameMs * 0.9 + dtMs * 0.1;
    if (this.rtQuality === "high" && this.frameMs > 26) this.setRtQuality("low");
    else if (this.rtQuality === "low" && this.frameMs > 40) this.setRtQuality("off");
    this.rt.render();
  }

  // ---- held launcher rig (launch phase) -----------------------------------
  //
  // The launcher is held in the hands at the BOTTOM CENTRE of the screen, the
  // way you actually see it over your own hands when you launch — camera
  // attached, so it stays put while the anchored stadium view moves behind it.

  private launcherRig: (LauncherRig & { beyPivot: THREE.Group; beySpin: THREE.Group; pullM: number }) | null =
    null;

  /** neutral rig pose in camera space: centred, low, close */
  private static readonly RIG_HOME = new THREE.Vector3(0, -0.105, -0.235);
  private static readonly RIG_PITCH = -0.62;

  /** Camera-attached launcher (real type) with both hands and the player's
   * actual bey clipped underneath. */
  attachLauncher(
    rc: ResolvedCombo | null,
    params: BeyParams,
    accent: number,
    kind: "winder" | "string" | "hold" = "string",
  ): void {
    this.removeLauncher();
    const rig = buildLauncher(kind, accent);
    const g = rig.group;

    // the player's own bey clipped under the head, tip pointing down
    const beyPivot = new THREE.Group();
    const beySpin = new THREE.Group();
    beySpin.add(buildBeyMesh(rc, params, accent));
    beyPivot.add(beySpin);
    beyPivot.position.set(0, 0, -0.014);
    rig.beyMount.add(beyPivot);

    g.position.copy(BattleView.RIG_HOME);
    g.rotation.set(BattleView.RIG_PITCH, 0, 0);
    g.scale.setScalar(0.92);
    this.camera.add(g);
    this.launcherRig = { ...rig, beyPivot, beySpin, pullM: 0 };
    updateCord(this.launcherRig);
  }

  /** The puller tracks the ACTUAL finger: screen-pixel deltas from the touch
   * origin map through camera space into the rig, so the string/ripcord
   * visibly follows the hand in real time. */
  setLauncherPointer(dxPx: number, dyPx: number): void {
    const rig = this.launcherRig;
    if (!rig) return;
    const k = 0.3 / Math.max(320, window.innerHeight); // px → metres at rig depth
    const camOff = new THREE.Vector3(dxPx * k, -dyPx * k, 0);
    if (camOff.length() > 0.5) camOff.setLength(0.5);
    const local = camOff.applyAxisAngle(new THREE.Vector3(1, 0, 0), -BattleView.RIG_PITCH);
    rig.pullM = Math.min(0.42, local.length());
    rig.puller.position.copy(rig.pullerHome).add(local);
    updateCord(rig);
  }

  /** Release: bey spins up, rips off toward the stadium; launcher lifts away. */
  releaseLauncher(): Promise<void> {
    const rig = this.launcherRig;
    if (!rig) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = performance.now();
      const home = BattleView.RIG_HOME;
      const tick = (): void => {
        const r = this.launcherRig;
        if (!r) {
          resolve();
          return;
        }
        const t = Math.min(1, (performance.now() - t0) / 650);
        r.beySpin.rotation.z = t * t * 90; // visible spin-up
        r.beyPivot.position.set(0, t * 0.4, -0.014 - t * 0.5);
        r.puller.position.copy(r.pullerHome).addScaledVector(
          new THREE.Vector3(1, 0, 0),
          r.pullM * (1 - t),
        );
        r.group.position.set(home.x, home.y - t * 0.05, home.z + t * 0.12);
        r.group.rotation.x = BattleView.RIG_PITCH - t * 0.35;
        updateCord(r);
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

  /** The opponent's real launcher, held in their hands over their entry
   * corner with their actual bey clipped under it — released on GO SHOOT. */
  attachOpponentLauncher(
    rc: ResolvedCombo | null,
    params: BeyParams,
    side: 0 | 1,
    kind: "winder" | "string" | "hold" = "string",
  ): void {
    this.removeOpponentLauncher(side);
    const accent = side === 0 ? 0x2b3a9e : 0x8e2b2b;
    const rig = buildLauncher(kind, accent);
    const g = rig.group;

    const beySpin = new THREE.Group();
    beySpin.add(buildBeyMesh(rc, params, side === 0 ? 0x3f7bff : 0xff5b4d));
    beySpin.position.z = -0.016; // hangs under the head, tip down
    rig.beyMount.add(beySpin);

    const baseAngle = side === 0 ? Math.PI - 0.55 : 0.55;
    const r0 = 0.075;
    g.position.set(Math.cos(baseAngle) * r0, Math.sin(baseAngle) * r0, 0.19);
    g.rotation.z = baseAngle + Math.PI; // launcher faces the bowl
    g.rotation.y = (side === 0 ? 1 : -1) * 0.12;
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
          rig.beySpin.rotation.z = t * t * 70; // spin-up around its own axis
          rig.beySpin.position.z = -0.016 - t * 0.13; // down to the bowl
          rig.group.position.z = 0.19 + t * 0.08; // launcher lifts away
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
    // ABS shell, moulded and lightly polished — the real stadiums are a matte
    // white body with a coloured X-Line (docs/MODELING.md §2)
    const bodyMat = absPlastic(s.bodyColor, { rough: 0.46, coat: 0.3 });
    bodyMat.side = THREE.DoubleSide;
    bodyMat.envMapIntensity = 0.7;

    // battle bowl from the physics surface profile — same curve the sim
    // integrates, so what you see is literally what the beys roll on
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= 160; i++) {
      const r = (s.rWall * i) / 160;
      profile.push(new THREE.Vector2(Math.max(1e-4, r), surfaceZ(s, r)));
    }
    const dish = new THREE.Mesh(new THREE.LatheGeometry(profile, 384), bodyMat);
    dish.rotateX(Math.PI / 2);
    dish.scale.z = -1;
    dish.receiveShadow = true;
    markReflective(dish, 0.14); // polished ABS picks up the beys above it
    this.stadiumGroup.add(dish);

    // outer deck: the moulded shell around the bowl, with rounded corners
    // like the real 440 × 455 mm (BX-10) / 600 × 440 mm (BX-32) body
    const deckShape = new THREE.Shape();
    const hw = s.deckW / 2;
    const hh = s.deckH / 2;
    const cr = Math.min(hw, hh) * 0.22; // corner radius
    deckShape.moveTo(-hw + cr, -hh);
    deckShape.lineTo(hw - cr, -hh);
    deckShape.quadraticCurveTo(hw, -hh, hw, -hh + cr);
    deckShape.lineTo(hw, hh - cr);
    deckShape.quadraticCurveTo(hw, hh, hw - cr, hh);
    deckShape.lineTo(-hw + cr, hh);
    deckShape.quadraticCurveTo(-hw, hh, -hw, hh - cr);
    deckShape.lineTo(-hw, -hh + cr);
    deckShape.quadraticCurveTo(-hw, -hh, -hw + cr, -hh);
    deckShape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, s.rWall * 0.998, 0, Math.PI * 2, true);
    deckShape.holes.push(hole);
    const deck = new THREE.Mesh(
      new THREE.ExtrudeGeometry(deckShape, {
        depth: 0.014,
        bevelEnabled: true,
        bevelSize: 0.0015,
        bevelThickness: 0.0015,
        bevelSegments: 4,
        curveSegments: 64,
      }),
      bodyMat,
    );
    deck.position.z = rimZ - 0.012;
    deck.receiveShadow = true;
    deck.castShadow = true;
    this.stadiumGroup.add(deck);

    // Tornado Ridge: the raised circular lip (⌀210 mm on BX-10) that turns
    // tops back toward the centre — a moulded swell in the body, not a decal
    const ridgeSection: THREE.Vector2[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const a = Math.PI * t;
      ridgeSection.push(
        new THREE.Vector2(s.rDish + Math.cos(a) * 0.0055, surfaceZ(s, s.rDish) + Math.sin(a) * 0.0021),
      );
    }
    const ridge = new THREE.Mesh(new THREE.LatheGeometry(ridgeSection, 384), bodyMat);
    ridge.rotateX(Math.PI / 2);
    ridge.scale.z = -1;
    ridge.receiveShadow = true;
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
      // real rack teeth: trapezoidal, cut across the line of travel
      const toothGeo = new THREE.CylinderGeometry(0.0018, 0.0026, 0.006, 4, 4);
      toothGeo.rotateX(Math.PI / 2);
      toothGeo.rotateZ(Math.PI / 4);
      const toothMat = absPlastic(s.railColor, { rough: 0.38, coat: 0.5 });
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
      // the moulded channel the rack sits in, swept along the same curve
      if (stripPts.length > 2) {
        const curve = new THREE.CatmullRomCurve3(stripPts, true);
        const channel = new THREE.Mesh(
          new THREE.TubeGeometry(curve, Math.min(600, stripPts.length), 0.0038, 20, true),
          absPlastic(s.railColor, { rough: 0.5, coat: 0.35 }),
        );
        channel.position.z = -0.0026;
        channel.receiveShadow = true;
        this.stadiumGroup.add(channel);
      }
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
      // Xtreme Zone (3 pt) is the wide red catch; Over Zones (2 pt) amber
      const col = p.kind === "xtreme" ? 0xd8322f : 0xd89b2f;
      const floor = new THREE.Mesh(
        new THREE.ExtrudeGeometry(ringSegmentShape(s.rWall - 0.004, s.rWall + 0.052, a0, a1), {
          depth: 0.004,
          bevelEnabled: false,
        }),
        absPlastic(col, { rough: 0.44, coat: 0.35 }),
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
      // real clear polycarbonate (IOR 1.585), not a faded plane
      const caseMat = clearPanel();
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

    // shoot position markers moulded into the deck
    for (const a of s.shootAngles) {
      const marker = new THREE.Mesh(
        new THREE.TorusGeometry(0.016, 0.0022, 24, 128),
        absPlastic(0xd83c3c, { rough: 0.4 }),
      );
      marker.position.set(
        Math.cos(a) * (s.rWall + 0.033),
        Math.sin(a) * (s.rWall + 0.033),
        rimZ + 0.0035,
      );
      this.stadiumGroup.add(marker);
    }
  }

  /** side accents (free-for-all can hold many beys) */
  static readonly SIDE_COLORS = [0x3f7bff, 0xff5b4d, 0x3cb26a, 0xd8c22e, 0x8a4ad8, 0x2eb8c2, 0xd8802e, 0xd85f9e];

  setBeys(
    a: { rc: ResolvedCombo | null; params: BeyParams },
    b: { rc: ResolvedCombo | null; params: BeyParams },
  ): void {
    this.setBeysList([a, b]);
  }

  setBeysList(list: { rc: ResolvedCombo | null; params: BeyParams }[]): void {
    for (const m of this.beyMeshes) if (m) this.scene.remove(m);
    this.beyMeshes = list.map((e, i) => {
      const m = buildBeyMesh(e.rc, e.params, BattleView.SIDE_COLORS[i % BattleView.SIDE_COLORS.length]!);
      markReflective(m, 0.72); // die-cast metal mirrors the dish and rivals
      return m;
    });
    this.beyParams = list.map((e) => e.params);
    while (this.lastBeyPos.length < list.length) {
      const a = (this.lastBeyPos.length / Math.max(2, list.length)) * Math.PI * 2;
      this.lastBeyPos.push(new THREE.Vector3(Math.cos(a) * 0.06, Math.sin(a) * 0.06, 0.02));
    }
    for (const m of this.beyMeshes) if (m) this.scene.add(m);
    sfx.startHums(list.length);
  }

  clearBeys(): void {
    for (const m of this.beyMeshes) if (m) this.scene.remove(m);
    this.beyMeshes = [];
    this.beyParams = [];
    sfx.stopHums();
  }

  /** Consume sim events → effects + audio. Call once per rendered frame.
   * When audioMuted (menu-background battles), sparks still fly but no
   * sound or haptics play. */
  consumeEvents(world: WorldState): void {
    const m = this.audioMuted;
    for (const e of world.events) {
      if (e.kind === "hit") {
        this.spawnSparks(e.magnitude, e.bey);
        if (!m) sfx.hit(e.magnitude);
        if (!m && navigator.vibrate) navigator.vibrate(Math.min(60, 8 + e.magnitude * 400));
      } else if (e.kind === "click") {
        if (!m) sfx.click();
        if (!m && navigator.vibrate) navigator.vibrate(15);
      } else if (e.kind === "dashStart") {
        if (!m) sfx.dash();
      } else if (e.kind === "gear") {
        if (!m) sfx.click(0.5); // rack teeth ticking under the bit gear
      } else if (e.kind === "trip") {
        this.spawnSparks(e.magnitude * 0.6);
        if (!m) sfx.hit(0.9);
        if (!m && navigator.vibrate) navigator.vibrate([25, 30, 45]);
      } else if (e.kind === "coverHit") {
        if (!m) {
          sfx.click(1.3); // plastic clank off the casing
          sfx.hit(e.magnitude * 0.15);
        }
      } else if (e.kind === "land") {
        if (!m) {
          sfx.click(1.5); // tip touchdown
          sfx.hit(Math.min(0.4, e.magnitude * 0.3));
          if (navigator.vibrate) navigator.vibrate(12);
        }
      } else if (e.kind === "exit") {
        if (!m) sfx.pocket();
        if (!m && navigator.vibrate) navigator.vibrate([30, 40, 60]);
      } else if (e.kind === "wallHit" && e.magnitude > 0.35) {
        if (!m) sfx.hit(e.magnitude * 0.35);
      }
    }
    world.events.length = 0;
  }

  private spawnSparks(mag: number, at = 0): void {
    const m = this.beyMeshes[at] ?? this.beyMeshes[0];
    if (!m) return;
    const origin = m.position.clone();
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
      const n = Math.min(world.beys.length, this.beyMeshes.length);
      for (let i = 0; i < n; i++) {
        const b = world.beys[i]!;
        const m = this.beyMeshes[i];
        const p = this.beyParams[i];
        if (!m || !p) continue;
        const r = Math.hypot(b.x, b.y);
        m.position.set(
          b.x,
          b.y,
          b.airborne ? b.z : surfaceZ(s, Math.min(r, s.rWall)),
        );
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
        this.lastBeyPos[i]?.set(b.x, b.y, m.position.z);
        const pan = Math.max(-1, Math.min(1, b.x / (s.rWall * 1.2)));
        sfx.updateHum(
          i,
          this.audioMuted ? 0 : (absOmega * 60) / (2 * Math.PI),
          pan,
          Math.hypot(b.vx, b.vy),
        );
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
    this.renderFrame(dt * 1000);
  }

  private updateCamera(dt: number): void {
    this.applyModeCamera(dt);
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

  /** Pick the next cinematic shot (movie-style menu backgrounds).
   * All shots stay at ≤ ~30° elevation — steeper angles read as
   * "sideways"/disorienting behind the menus. */
  private nextCineShot(): void {
    const c = this.cine;
    c.shot = Math.floor(Math.random() * 4);
    c.t = 0;
    c.dur = 3.5 + Math.random() * 3;
    c.a0 = Math.random() * Math.PI * 2;
    c.speed = (0.12 + Math.random() * 0.25) * (Math.random() < 0.5 ? -1 : 1);
    c.dist = 0.38 + Math.random() * 0.25;
    c.pitch = 0.12 + Math.random() * 0.4; // 7°..30° above the stadium plane
    c.bey = Math.random() < 0.5 ? 0 : 1;
  }

  /** Hard-cut the cinema camera to a launch-watching shot. */
  cineLaunchShot(side: 0 | 1): void {
    const c = this.cine;
    c.shot = 4; // launch framing
    c.t = 0;
    c.dur = 2.2;
    c.bey = side;
    c.a0 = (side === 0 ? Math.PI - 0.55 : 0.55) + (Math.random() - 0.5) * 0.5;
    c.dist = 0.2 + Math.random() * 0.08;
  }

  private applyModeCamera(dt: number): void {
    if (this.mode === "cinema") {
      const c = this.cine;
      c.t += dt;
      if (c.t > c.dur) this.nextCineShot();
      const target = new THREE.Vector3();
      const lookAt = new THREE.Vector3(0, 0, 0.02);
      const yaw = c.a0 + c.t * c.speed;
      if (c.shot === 1) {
        // close-up: slow arc around one bey, low to the surface
        const bp = this.lastBeyPos[c.bey] ?? lookAt;
        target.set(bp.x + Math.cos(yaw) * 0.085, bp.y + Math.sin(yaw) * 0.085, 0.05);
        lookAt.copy(bp);
      } else if (c.shot === 2) {
        // low dolly across the rim, watching the action
        const t01 = Math.min(1, c.t / c.dur);
        target.set(
          Math.cos(c.a0) * 0.34 * (1 - t01) + Math.cos(c.a0 + 1.4) * 0.34 * t01,
          Math.sin(c.a0) * 0.34 * (1 - t01) + Math.sin(c.a0 + 1.4) * 0.34 * t01,
          0.07,
        );
        lookAt.copy(this.lastBeyPos[c.bey] ?? lookAt).multiplyScalar(0.6);
      } else if (c.shot === 3) {
        // wide establishing arc: far out, still under the 30° elevation cap
        const p = 0.42 + (c.pitch % 0.1); // ~24°..30°
        target.set(
          Math.cos(yaw * 0.6) * Math.cos(p) * 0.62,
          Math.sin(yaw * 0.6) * Math.cos(p) * 0.62,
          Math.sin(p) * 0.62 + 0.02,
        );
      } else if (c.shot === 4) {
        // launch framing: watch the launcher corner from just inside the bowl
        target.set(Math.cos(c.a0) * c.dist * 0.4, Math.sin(c.a0) * c.dist * 0.4, 0.1);
        lookAt.set(Math.cos(c.a0) * 0.075, Math.sin(c.a0) * 0.075, 0.15);
      } else {
        // classic orbit sweep
        target.set(
          Math.cos(yaw) * Math.cos(c.pitch) * c.dist,
          Math.sin(yaw) * Math.cos(c.pitch) * c.dist,
          Math.sin(c.pitch) * c.dist + 0.02,
        );
      }
      // smooth dolly toward the shot target; hard cut when a shot begins
      if (c.t < dt * 1.5) this.camera.position.copy(target);
      else this.camera.position.lerp(target, 1 - Math.exp(-dt * 3.2));
      this.camera.lookAt(lookAt);
      return;
    }
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
