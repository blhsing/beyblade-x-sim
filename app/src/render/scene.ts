// BattleView: the 3D presentation of a battle. Consumes WorldState from the
// deterministic core (never mutates it) and SimEvents for effects/audio.
// Camera modes: "orbit" (touch), "gyro" (sensor-anchored stadium, Mode A),
// "launch" (first-person behind the launcher during the launch phase).

import * as THREE from "three";

import {
  pocketAtPoint,
  pocketExitTarget,
  stadiumTerrainAt,
  type StadiumSpec,
} from "../core/stadium";
import { normalizeLauncherForSpin } from "../core/launcher";
import { launchKinematics, STOP_DWELL_TICKS } from "../core/sim";
import type { BeyParams, BeyState, LauncherKind, LaunchParams, WorldState } from "../core/types";
import type { ResolvedCombo } from "../core/derive";
import { gyro } from "../sensors/gyro";
import { sfx } from "../audio/sfx";
import { studioEnvironment, tableMaps } from "./materials";
import { buildBeyMesh, partRadiusM } from "./parts";
import {
  advanceBurstDebris,
  applyBurstReleaseImpulse,
  buildBurstDebrisBody,
  buildBurstLatchRig,
  burstPartMasses,
  burstSeparationTopology,
  groupBurstRigidAssembly,
  intactBeyCollisionSphere,
  pulseBurstLatch,
  updateBurstLatchRig,
  type BurstDebrisVisual,
  type BurstKinematicCollider,
  type BurstLatchRig,
  type BurstPartMasses,
} from "./burst";
import {
  alignLauncherMountToWorld,
  applyLauncherPreviewPose,
  buildLauncher,
  composeLaunchedBeyOrientation,
  LAUNCHER_PREVIEW_POSE,
  launcherAimTiltFromGesture,
  launchCameraFrame,
  launcherExitOrientation,
  orientWorldLauncher,
  setLauncherClawOpen,
  setLauncherPull,
  type LauncherRig,
  type LauncherPullState,
} from "./launcher";
import { RT_PRESETS, RayMarchComposer, markReflective } from "./rt";
import { buildStadiumModel, disposeStadiumModel } from "./stadium";
import { applyStopTopplePose, persistentStopToppleDwell, pocketToppleDwell } from "./topple";

export { buildBeyMesh } from "./parts";

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

export interface LauncherGestureVisual {
  axialPx: number;
  pullPx: number;
  perpendicularPx: number;
  maxTravelPx: number;
  gestureAngleDeg: number;
  pullQuality: number;
}

interface PreviewLauncher extends LauncherRig {
  beyPivot: THREE.Group;
  beySpin: THREE.Group;
  basePitch: number;
  baseYaw: number;
  baseRoll: number;
  generation: number;
}

interface StagedLauncher extends LauncherRig {
  mesh: THREE.Group;
  side: number;
  released: boolean;
  liftT: number;
  generation: number;
}

/** Release one transient model without destroying globally cached textures. */
function disposeModel(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) materials.add(material);
    } else if (mesh.material) {
      materials.add(mesh.material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

/** |ω| where a bey starts visibly wobbling, well above OMEGA_STOP so the
 * wind-down is watchable rather than an abrupt stop. */
const WOBBLE_OMEGA = 55;

export type CameraMode = "orbit" | "gyro" | "launch" | "cinema";

export class BattleView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private beyMeshes: (THREE.Group | null)[] = [];
  private beyParams: (BeyParams | null)[] = [];
  /** Staged world sticker phase retained across scene.attach ownership hand-off. */
  private launchPhaseOffsets: number[] = [];
  /** Full non-spinning world orientation of the tilted launcher mount. */
  private launchOrientationBases: (THREE.Quaternion | null)[] = [];
  /** 0..1 transition from launcher tilt to free upright ground spin. */
  private launchLandingBlend: number[] = [];
  /** In-place fall angle for a bey that touched down outside the casing. */
  private launchMissTumble: number[] = [];
  private launchMissElapsed: number[] = [];
  private launchMissSpin: (number | null)[] = [];
  private sparks: Spark[] = [];
  private sparkMat: THREE.MeshBasicMaterial;
  private stadiumGroup = new THREE.Group();
  private stadium: StadiumSpec | null = null;
  mode: CameraMode = "orbit";
  private orbitYaw = -Math.PI / 2;
  private orbitPitch = 0.9;
  private orbitDist = 0.56; // frames the true-scale (wider) bowls
  /** look-at point, moved by two-finger pan */
  private orbitTarget = new THREE.Vector3(0, 0, 0.02);
  /** per-bey knock-out flights, so a KO'd bey lands and stays visible */
  private koFlights: ({
    t: number;
    from: THREE.Vector3;
    to: THREE.Vector3;
    spin: number;
    pocket: boolean;
    orientation: THREE.Quaternion;
  } | null)[] = [];
  /** Beys whose latch has already released, so separation runs only once. */
  private burstSeparated: boolean[] = [];
  /** Seated lower-assembly detent pose before the core authorizes separation. */
  private burstLatchRigs: (BurstLatchRig | null)[] = [];
  /** Current rules use four internal slip events; kept configurable for modes. */
  private burstClicksMax = 4;
  /** rendered blade radius per bey (m) */
  private beyRadius: number[] = [];
  /** Monotonic physical fall progress; a wake-up hit cannot stand it back up. */
  private stopToppleDwell: number[] = [];
  /** Authored whole-Bey bounds used as kinematic debris collision proxies. */
  private beyCollisionSpheres: ({ center: THREE.Vector3; radiusM: number } | null)[] = [];
  /** Catalog-derived mass allocation for complete upper/Ratchet/Bit bodies. */
  private burstMasses: BurstPartMasses[] = [];
  /** Deterministic rigid Blade/lower bodies from authorized Burst releases. */
  private debris: BurstDebrisVisual[] = [];
  private debrisAccumulator = 0;

  /**
   * A normal X Burst releases the complete Blade assembly while Ratchet+Bit
   * stay coupled. Only a severe terminal overload ejects the Bit as a third
   * body. Every body inherits the terminal collision's real motion.
   */
  private separateBurstBey(i: number, state: BeyState): void {
    const m = this.beyMeshes[i];
    if (!m || this.burstSeparated[i]) return;
    this.burstSeparated[i] = true;
    if (!this.audioMuted) sfx.burst();
    m.updateWorldMatrix(true, true);
    const beyOrigin = m.getWorldPosition(new THREE.Vector3());
    const beyQuaternion = m.getWorldQuaternion(new THREE.Quaternion());
    const topAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(beyQuaternion).normalize();
    const release = state.burstRelease ?? {
      tick: 0,
      contactAngle: Math.atan2(state.y, state.x),
      normalImpulse: 0,
      tangentialImpulse: 0,
      preVx: state.vx,
      preVy: state.vy,
      postVx: state.vx,
      postVy: state.vy,
      omega: state.omega,
      phase: state.phase,
      severity: state.burstOverload,
      seed: ((i + 1) * 0x9e3779b9) >>> 0,
    };
    const beyVelocity = new THREE.Vector3(release.postVx, release.postVy, state.vz);
    const beyAngularVelocity = topAxis.clone().multiplyScalar(release.omega);
    const blade = m.children.find((part) => part.name === "part:blade");
    const ratchet = m.children.find((part) => part.name === "part:ratchet");
    const bit = m.children.find((part) => part.name === "part:bit");
    const masses = this.burstMasses[i] ?? burstPartMasses(this.beyParams[i]?.massKg ?? 0.044, null);
    const topology = burstSeparationTopology(release.severity);
    const bodySpecs: { mesh: THREE.Group; kind: "blade" | "lower" | "ratchet" | "bit"; massKg: number }[] = [];
    const bladeBody = blade
      ? groupBurstRigidAssembly(this.scene, [blade], "burst body:complete blade assembly")
      : null;
    if (bladeBody) bodySpecs.push({ mesh: bladeBody, kind: "blade", massKg: masses.bladeKg });
    if (topology === "blade-lower") {
      const members = [ratchet, bit].filter((part): part is THREE.Object3D => Boolean(part));
      const lowerBody = groupBurstRigidAssembly(
        this.scene,
        members,
        "burst body:coupled ratchet and bit",
      );
      if (lowerBody) {
        bodySpecs.push({
          mesh: lowerBody,
          kind: "lower",
          massKg: masses.ratchetKg + masses.bitKg,
        });
      }
    } else {
      const ratchetBody = ratchet
        ? groupBurstRigidAssembly(this.scene, [ratchet], "burst body:ratchet")
        : null;
      const bitBody = bit
        ? groupBurstRigidAssembly(this.scene, [bit], "burst body:bit")
        : null;
      if (ratchetBody) bodySpecs.push({ mesh: ratchetBody, kind: "ratchet", massKg: masses.ratchetKg });
      if (bitBody) bodySpecs.push({ mesh: bitBody, kind: "bit", massKg: masses.bitKg });
    }
    const releasedBodies = bodySpecs.map((spec, bodyIndex) => {
      const body = buildBurstDebrisBody(
        spec.mesh,
        spec.kind,
        spec.massKg,
        beyOrigin,
        beyVelocity,
        beyAngularVelocity,
        (release.seed ^ Math.imul(bodyIndex + 1, 0x85ebca6b)) >>> 0,
      );
      const visual = { mesh: spec.mesh, body };
      this.debris.push(visual);
      return body;
    });
    applyBurstReleaseImpulse(releasedBodies, release, beyOrigin, topAxis);
    m.visible = false;
  }

  private burstKinematicColliders(world: WorldState | null): BurstKinematicCollider[] {
    if (!world) return [];
    const colliders: BurstKinematicCollider[] = [];
    const count = Math.min(world.beys.length, this.beyMeshes.length);
    for (let index = 0; index < count; index++) {
      const state = world.beys[index]!;
      const mesh = this.beyMeshes[index];
      const authored = this.beyCollisionSpheres[index];
      if (!mesh || !authored || !state.alive || state.exited || state.pendingTicks > 0) continue;
      mesh.updateWorldMatrix(true, true);
      const position = authored.center.clone().applyMatrix4(mesh.matrixWorld);
      const scale = mesh.getWorldScale(new THREE.Vector3());
      const radiusM = authored.radiusM * Math.max(scale.x, scale.y, scale.z);
      const topAxis = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
      colliders.push({
        position,
        velocity: new THREE.Vector3(state.vx, state.vy, state.vz),
        angularVelocity: topAxis.multiplyScalar(state.omega),
        radiusM,
        restitution: 0.2,
        friction: 0.28,
      });
    }
    return colliders;
  }

  private stepDebris(dt: number, world: WorldState | null): void {
    this.debrisAccumulator = advanceBurstDebris(
      this.debris.map((debris) => debris.body),
      this.stadium,
      dt,
      this.debrisAccumulator,
      this.burstKinematicColliders(world),
    );
    for (const debris of this.debris) {
      debris.mesh.position.copy(debris.body.position);
      debris.mesh.quaternion.copy(debris.body.quaternion);
    }
  }

  private clearDebris(): void {
    for (const d of this.debris) {
      this.scene.remove(d.mesh);
      disposeModel(d.mesh);
    }
    this.debris = [];
    this.debrisAccumulator = 0;
  }

  private clearSparks(): void {
    for (const spark of this.sparks) {
      this.scene.remove(spark.mesh);
      spark.mesh.geometry.dispose();
    }
    this.sparks = [];
  }
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

  private launcherRig: PreviewLauncher | null = null;
  /** Invalidates every outstanding preview/staging animation callback. */
  private launcherGeneration = 0;

  /** Camera-attached launcher (real type) with both hands and the player's
   * actual bey clipped underneath. */
  attachLauncher(
    rc: ResolvedCombo | null,
    params: BeyParams,
    accent: number,
    kind: LauncherKind = "string",
  ): void {
    this.removeLauncher();
    const rig = buildLauncher(normalizeLauncherForSpin(kind, params.spinDir), accent);
    const g = rig.group;

    // the player's own bey clipped under the head, tip pointing down
    const beyPivot = new THREE.Group();
    const beySpin = new THREE.Group();
    beySpin.add(buildBeyMesh(rc, params, accent));
    beyPivot.add(beySpin);
    beyPivot.position.set(0, 0, -0.014);
    rig.beyMount.add(beyPivot);

    // Rotate each drive handedness so its real local withdrawal axis projects
    // down-screen. This keeps an L rack mechanically mirrored while giving
    // either hand the familiar downward launch gesture.
    applyLauncherPreviewPose(rig);
    const roll = g.rotation.z;
    this.camera.add(g);
    setLauncherClawOpen(rig, 0);
    this.launcherRig = {
      ...rig,
      beyPivot,
      beySpin,
      basePitch: LAUNCHER_PREVIEW_POSE.pitch,
      baseYaw: 0,
      baseRoll: roll,
      generation: this.launcherGeneration,
    };
    setLauncherPull(this.launcherRig, 0);
  }

  private applyLaunchCameraFrame(): void {
    const frame = launchCameraFrame(this.stadium, this.launchSide);
    this.camera.position.copy(frame.position);
    this.camera.lookAt(frame.target);
  }

  /** BX-32's 600 mm shell needs its final launch framing before the expensive
   * Hold launcher/hands are attached. Otherwise the browser can composite one
   * stale cinema frame from inside the wide casing during setup. */
  synchronizeWideLaunchCamera(): void {
    if (this.mode !== "launch" || this.stadium?.name !== "wide") return;
    this.ease = null;
    this.applyLaunchCameraFrame();
    this.camera.updateMatrixWorld(true);
  }

  /**
   * Apply the same axis-projected gesture credited by the input model. A
   * rigid winder can only slide collinearly through its guide. A string may
   * bow laterally inside its physical cone, with its hand still parented to
   * the handle. Cross-axis error leans/yaws the whole launcher rather than
   * teleporting the rack away from its slot.
   */
  setLauncherGesture(progress: LauncherGestureVisual): LauncherPullState | null {
    const rig = this.launcherRig;
    if (!rig) return null;
    const denom = Math.max(1, progress.maxTravelPx);
    const physicalAxial = rig.mechanism === "string" ? progress.axialPx : progress.pullPx;
    const travel = THREE.MathUtils.clamp(physicalAxial / denom, 0, 1) * rig.maxPullM;
    const lateral = THREE.MathUtils.clamp(progress.perpendicularPx / denom, -1, 1) * rig.maxPullM;
    const state = setLauncherPull(rig, travel, lateral);
    const direction = launcherAimTiltFromGesture(progress);
    rig.group.rotation.set(
      rig.basePitch + THREE.MathUtils.degToRad(direction.tiltDeg),
      rig.baseYaw + THREE.MathUtils.degToRad(direction.aimDeg),
      rig.baseRoll,
    );
    rig.group.userData.visualAimDeg = direction.aimDeg;
    rig.group.userData.visualTiltDeg = direction.tiltDeg;

    // Rack teeth/string spool drive the mounted bey continuously during the
    // credited outward stroke. Pointer-up does not invent a second spin-up.
    const signedTurns = rig.pullAxis.x * state.fraction * Math.PI * 34;
    rig.beySpin.rotation.z = signedTurns;
    const gear = rig.beyMount.getObjectByName("launcher gear plate");
    if (gear) gear.rotation.z = -signedTurns * 0.34;
    return state;
  }

  /**
   * Finish the camera-space feedback. The real battle bey is staged later at
   * the deterministic world mount; the extracted rack/string never rewinds
   * or teleports while this preview rig leaves frame.
   */
  releaseLauncher(): Promise<void> {
    const rig = this.launcherRig;
    if (!rig) return Promise.resolve();
    const generation = rig.generation;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const start = rig.group.position.clone();
      const releaseOrientation = rig.group.quaternion.clone();
      const tick = (): void => {
        const r = this.launcherRig;
        if (!r || r.generation !== generation || generation !== this.launcherGeneration) {
          resolve();
          return;
        }
        const t = Math.min(1, (performance.now() - t0) / 220);
        const eased = t * t * (3 - 2 * t);
        r.group.position.copy(start).add(new THREE.Vector3(0, -eased * 0.16, eased * 0.08));
        launcherExitOrientation(releaseOrientation, eased, r.group.quaternion);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  removeLauncher(): void {
    this.launcherGeneration++;
    if (this.launcherRig) {
      this.camera.remove(this.launcherRig.group);
      disposeModel(this.launcherRig.group);
      this.launcherRig = null;
    }
  }

  // ---- opponent launcher (world-anchored; bots launch at the countdown) ---

  private oppRigs: {
    rig: LauncherRig;
    group: THREE.Group;
    beySpin: THREE.Group;
    side: 0 | 1;
    generation: number;
  }[] = [];

  /** The opponent's real launcher, held in their hands over their entry
   * corner with their actual bey clipped under it — released on GO SHOOT. */
  attachOpponentLauncher(
    rc: ResolvedCombo | null,
    params: BeyParams,
    side: 0 | 1,
    kind: LauncherKind = "string",
  ): void {
    this.removeOpponentLauncher(side);
    const accent = side === 0 ? 0x2b3a9e : 0x8e2b2b;
    const rig = buildLauncher(normalizeLauncherForSpin(kind, params.spinDir), accent);
    const g = rig.group;

    const beySpin = new THREE.Group();
    beySpin.add(buildBeyMesh(rc, params, side === 0 ? 0x3f7bff : 0xff5b4d));
    beySpin.position.z = -0.016; // hangs under the head, tip down
    rig.beyMount.add(beySpin);

    const baseAngle = side === 0 ? Math.PI - 0.55 : 0.55;
    const r0 = 0.18;
    g.position.set(Math.cos(baseAngle) * r0, Math.sin(baseAngle) * r0, 0.19);
    g.rotation.z = baseAngle - (rig.pullAxis.x < 0 ? Math.PI : 0);
    g.rotation.y = (side === 0 ? 1 : -1) * 0.12;
    g.scale.setScalar(0.74);
    setLauncherPull(rig, rig.maxPullM * 0.82);
    beySpin.rotation.z = rig.pullAxis.x * Math.PI * 26;
    setLauncherClawOpen(rig, 0);
    this.scene.add(g);
    this.oppRigs.push({ rig, group: g, beySpin, side, generation: this.launcherGeneration });
  }

  /** Lift the mechanical opponent preview; canonical world staging follows. */
  playOpponentRelease(side?: 0 | 1): Promise<void> {
    const rigs = this.oppRigs.filter((r) => side === undefined || r.side === side);
    if (rigs.length === 0) return Promise.resolve();
    const starts = rigs.map((rig) => rig.group.position.clone());
    const generation = this.launcherGeneration;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (): void => {
        if (generation !== this.launcherGeneration) {
          resolve();
          return;
        }
        const t = Math.min(1, (performance.now() - t0) / 240);
        const eased = t * t * (3 - 2 * t);
        for (let i = 0; i < rigs.length; i++) {
          const rig = rigs[i]!;
          const radial = starts[i]!.clone().setZ(0).normalize();
          rig.group.position.copy(starts[i]!).addScaledVector(radial, eased * 0.09);
          rig.group.position.z += eased * 0.11;
        }
        if (t < 1) requestAnimationFrame(tick);
        else {
          for (const rig of rigs) {
            this.scene.remove(rig.group);
            disposeModel(rig.group);
          }
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
        disposeModel(r.group);
        return false;
      }
      return true;
    });
  }

  // ---- canonical world launch staging -----------------------------------

  private stagedLaunchers: (StagedLauncher | null)[] = [];
  private stageGeneration = 0;

  /**
   * Remove launcher shells without ever disposing a canonical battle mesh.
   * A still-mounted bey is first reparented into the scene with its world
   * transform preserved, then the now-empty launcher can be released safely.
   */
  private clearStagedLaunchers(): void {
    this.stageGeneration++;
    for (const staged of this.stagedLaunchers) {
      if (!staged) continue;
      if (staged.mesh.parent && staged.mesh.parent !== this.scene) this.scene.attach(staged.mesh);
      this.scene.remove(staged.group);
      disposeModel(staged.group);
    }
    this.stagedLaunchers = [];
  }

  /**
   * Parent the ONE canonical battle mesh for each side under its real world
   * launcher. The deterministic core's release origin is solved exactly,
   * including model mount depth and the bey's local tip offset. A brief
   * mounted pre-roll lets the viewer read the mechanism before simulation
   * ticks begin; pendingTicks then controls each actual detach moment.
   */
  stageLaunchers(launches: readonly LaunchParams[], preRollMs = 200): Promise<void> {
    this.clearStagedLaunchers();
    const generation = this.stageGeneration;
    const total = Math.min(launches.length, this.beyMeshes.length, this.beyParams.length);
    this.stagedLaunchers = Array.from({ length: this.beyMeshes.length }, () => null);

    for (let i = 0; i < total; i++) {
      const mesh = this.beyMeshes[i];
      const params = this.beyParams[i];
      const launch = launches[i];
      if (!mesh || !params || !launch) continue;
      const rig = buildLauncher(normalizeLauncherForSpin(launch.launcher, launch.spinDir));
      const kinematics = launchKinematics(params, launch, i, total);
      orientWorldLauncher(
        rig,
        kinematics.heading,
        launch.tiltDeg,
        Math.atan2(kinematics.y, kinematics.x),
      );
      rig.group.userData.stageSide = i;
      rig.group.userData.releaseTarget = new THREE.Vector3(
        kinematics.x,
        kinematics.y,
        kinematics.z,
      );
      rig.group.userData.landingTarget = new THREE.Vector3(
        kinematics.landingX,
        kinematics.landingY,
        0,
      );
      setLauncherClawOpen(rig, 0);

      this.scene.add(rig.group);
      rig.beyMount.add(mesh);
      mesh.position.set(0, 0, -0.016);
      mesh.rotation.set(0, 0, 0);
      mesh.visible = true;
      const target = new THREE.Vector3(kinematics.x, kinematics.y, kinematics.z);
      const actual = alignLauncherMountToWorld(rig, mesh, target);
      mesh.userData.launchStageTarget = target.clone();
      mesh.userData.launchStageErrorM = actual.distanceTo(target);

      const pullFraction = THREE.MathUtils.clamp(launch.sp / 11000, 0.18, 1);
      setLauncherPull(rig, rig.maxPullM * pullFraction);
      const signedTurns = launch.spinDir * pullFraction * Math.PI * 34;
      mesh.rotation.z = signedTurns;
      const gear = rig.beyMount.getObjectByName("launcher gear plate");
      if (gear) gear.rotation.z = -signedTurns * 0.34;
      this.stagedLaunchers[i] = {
        ...rig,
        mesh,
        side: i,
        released: false,
        liftT: 0,
        generation,
      };
    }

    if (preRollMs <= 0 || this.stagedLaunchers.every((staged) => !staged)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      let previous = start;
      const tick = (): void => {
        if (generation !== this.stageGeneration) {
          resolve();
          return;
        }
        const now = performance.now();
        const elapsedS = Math.max(0, (now - previous) / 1000);
        previous = now;
        for (const staged of this.stagedLaunchers) {
          if (!staged) continue;
          const launch = launches[staged.side];
          if (!launch) continue;
          staged.mesh.rotation.z += launch.spinDir * elapsedS * 0.18;
        }
        if (now - start < preRollMs) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  private releaseStagedLauncher(index: number, mesh: THREE.Group, simPhase: number): void {
    const staged = this.stagedLaunchers[index];
    if (!staged || staged.released || staged.mesh !== mesh) return;
    // scene.attach() is the single ownership hand-off. The canonical mesh is
    // never cloned, hidden/replaced, or disposed with its launcher shell.
    const mountedSpin = mesh.rotation.z;
    this.scene.attach(mesh);
    const inverseSpin = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -mountedSpin,
    );
    this.launchOrientationBases[index] = mesh.quaternion.clone().multiply(inverseSpin).normalize();
    this.launchPhaseOffsets[index] = mountedSpin - simPhase;
    staged.released = true;
    setLauncherClawOpen(staged, 1);
  }

  /** Detach zero-delay canonical meshes before the first fixed simulation step. */
  primeStagedLaunches(world: WorldState): void {
    const n = Math.min(world.beys.length, this.beyMeshes.length);
    for (let i = 0; i < n; i++) {
      const state = world.beys[i]!;
      const mesh = this.beyMeshes[i];
      if (!mesh || state.pendingTicks > 0) continue;
      this.releaseStagedLauncher(i, mesh, state.phase);
      mesh.position.set(state.x, state.y, state.z);
      const base = this.launchOrientationBases[i];
      if (base) {
        composeLaunchedBeyOrientation(
          base,
          state.phase + (this.launchPhaseOffsets[i] ?? 0),
          mesh.quaternion,
        );
      }
      mesh.visible = true;
    }
  }

  private updateStagedLauncher(index: number, dt: number): void {
    const staged = this.stagedLaunchers[index];
    if (!staged || !staged.released) return;
    staged.liftT += dt;
    const radial = staged.group.position.clone().setZ(0).normalize();
    staged.group.position.addScaledVector(radial, dt * 0.23);
    staged.group.position.z += dt * 0.3;
    if (staged.liftT < 0.42) return;
    this.scene.remove(staged.group);
    disposeModel(staged.group);
    this.stagedLaunchers[index] = null;
  }

  /**
   * Touch camera: one finger orbits, two fingers pinch to zoom and drag to
   * pan (and the wheel zooms on desktop). Pan moves the orbit target across
   * the stadium plane in the camera's own screen axes, so dragging feels
   * like moving the stadium under your finger.
   */
  private attachOrbitControls(el: HTMLElement): void {
    const pts = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let pinchMid = { x: 0, y: 0 };

    const centreAndSpread = (): { cx: number; cy: number; d: number } => {
      const list = [...pts.values()];
      const cx = list.reduce((s, p) => s + p.x, 0) / list.length;
      const cy = list.reduce((s, p) => s + p.y, 0) / list.length;
      const d =
        list.length > 1 ? Math.hypot(list[0]!.x - list[1]!.x, list[0]!.y - list[1]!.y) : 0;
      return { cx, cy, d };
    };

    el.addEventListener("pointerdown", (e) => {
      if (this.mode !== "orbit") return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const c = centreAndSpread();
      pinchDist = c.d;
      pinchMid = { x: c.cx, y: c.cy };
    });

    el.addEventListener("pointermove", (e) => {
      if (this.mode !== "orbit" || !pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId)!;
      if (pts.size === 1) {
        this.orbitYaw -= (e.clientX - prev.x) * 0.006;
        this.orbitPitch = Math.min(
          1.45,
          Math.max(0.12, this.orbitPitch + (e.clientY - prev.y) * 0.005),
        );
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        return;
      }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const c = centreAndSpread();
      if (pinchDist > 0 && c.d > 0) this.zoomBy(pinchDist / c.d);
      this.panBy(c.cx - pinchMid.x, c.cy - pinchMid.y);
      pinchDist = c.d;
      pinchMid = { x: c.cx, y: c.cy };
    });

    const lift = (e: PointerEvent): void => {
      pts.delete(e.pointerId);
      const c = centreAndSpread();
      pinchDist = c.d;
      pinchMid = { x: c.cx, y: c.cy };
    };
    el.addEventListener("pointerup", lift);
    el.addEventListener("pointercancel", lift);
    el.addEventListener(
      "wheel",
      (e) => {
        if (this.mode !== "orbit") return;
        e.preventDefault();
        this.zoomBy(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
  }

  /** factor > 1 pulls the camera back */
  zoomBy(factor: number): void {
    this.orbitDist = Math.min(1.6, Math.max(0.09, this.orbitDist * factor));
  }

  /** Drag the look-at point across the stadium plane, in screen axes. */
  panBy(dxPx: number, dyPx: number): void {
    const k = (this.orbitDist * 1.4) / Math.max(320, window.innerHeight);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.orbitTarget
      .addScaledVector(right, -dxPx * k)
      .addScaledVector(up, dyPx * k);
    const lim = 0.4;
    this.orbitTarget.x = Math.max(-lim, Math.min(lim, this.orbitTarget.x));
    this.orbitTarget.y = Math.max(-lim, Math.min(lim, this.orbitTarget.y));
    this.orbitTarget.z = Math.max(-0.05, Math.min(0.3, this.orbitTarget.z));
  }

  /** Recentre the touch camera (used when a new battle starts). */
  resetView(): void {
    this.orbitTarget.set(0, 0, 0.02);
    this.orbitDist = 0.56;
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  setStadium(s: StadiumSpec): void {
    this.stadium = s;
    // Stadiums contain well over 100k triangles. Clearing the Group alone
    // leaves their GPU buffers/material programs alive, so always release the
    // previous product before installing the new one.
    disposeStadiumModel(this.stadiumGroup);
    this.stadiumGroup.clear();
    const model = buildStadiumModel(s);
    this.stadiumGroup.add(model);
    this.stadiumGroup.name = "stadium:host";
    this.stadiumGroup.userData = {
      stadiumName: s.name,
      productCode: model.userData.productCode,
      triangleCount: model.userData.triangleCount,
    };
  }
  /** side accents (free-for-all can hold many beys) */
  static readonly SIDE_COLORS = [0x3f7bff, 0xff5b4d, 0x3cb26a, 0xd8c22e, 0x8a4ad8, 0x2eb8c2, 0xd8802e, 0xd85f9e];

  setBeys(
    a: { rc: ResolvedCombo | null; params: BeyParams },
    b: { rc: ResolvedCombo | null; params: BeyParams },
  ): void {
    this.setBeysList([a, b]);
  }

  /** Match the renderer's detent steps to the core rule configuration. */
  setBurstClickThreshold(clicksMax: number): void {
    this.burstClicksMax = Number.isFinite(clicksMax)
      ? Math.max(1, Math.round(clicksMax))
      : 4;
  }

  setBeysList(list: { rc: ResolvedCombo | null; params: BeyParams }[]): void {
    this.clearStagedLaunchers();
    for (const m of this.beyMeshes) {
      if (!m) continue;
      this.scene.remove(m);
      disposeModel(m);
    }
    this.beyMeshes = list.map((e, i) => {
      const m = buildBeyMesh(e.rc, e.params, BattleView.SIDE_COLORS[i % BattleView.SIDE_COLORS.length]!);
      markReflective(m, 0.72); // die-cast metal mirrors the dish and rivals
      return m;
    });
    this.beyParams = list.map((e) => e.params);
    this.launchPhaseOffsets = list.map(() => 0);
    this.launchOrientationBases = list.map(() => null);
    this.launchLandingBlend = list.map(() => 0);
    this.launchMissTumble = list.map(() => 0);
    this.launchMissElapsed = list.map(() => 0);
    this.launchMissSpin = list.map(() => null);
    // the radius actually rendered (dataset diameter, not the derived one) —
    // used to sit a toppled bey ON the dish instead of through it
    this.beyRadius = list.map((e) =>
      partRadiusM(e.rc?.parts.blade ?? e.rc?.parts.mainBlade, e.params.radiusM),
    );
    this.stopToppleDwell = list.map(() => 0);
    this.beyCollisionSpheres = this.beyMeshes.map((mesh) => {
      if (!mesh) return null;
      mesh.updateMatrixWorld(true);
      const sphere = intactBeyCollisionSphere(mesh);
      return { center: sphere.center.clone(), radiusM: sphere.radius };
    });
    this.burstMasses = list.map((entry) => burstPartMasses(entry.params.massKg, entry.rc));
    this.burstLatchRigs = this.beyMeshes.map((mesh, i) =>
      mesh ? buildBurstLatchRig(mesh, list[i]!.params.spinDir) : null,
    );
    this.koFlights = list.map(() => null);
    this.burstSeparated = list.map(() => false);
    this.clearDebris();
    while (this.lastBeyPos.length < list.length) {
      const a = (this.lastBeyPos.length / Math.max(2, list.length)) * Math.PI * 2;
      this.lastBeyPos.push(new THREE.Vector3(Math.cos(a) * 0.06, Math.sin(a) * 0.06, 0.02));
    }
    for (const m of this.beyMeshes) if (m) this.scene.add(m);
    sfx.startHums(list.length);
  }

  clearBeys(): void {
    this.clearStagedLaunchers();
    for (const m of this.beyMeshes) {
      if (!m) continue;
      this.scene.remove(m);
      disposeModel(m);
    }
    this.beyMeshes = [];
    this.beyParams = [];
    this.launchPhaseOffsets = [];
    this.launchOrientationBases = [];
    this.launchLandingBlend = [];
    this.launchMissTumble = [];
    this.launchMissElapsed = [];
    this.launchMissSpin = [];
    this.burstSeparated = [];
    this.burstLatchRigs = [];
    this.burstMasses = [];
    this.beyCollisionSpheres = [];
    this.stopToppleDwell = [];
    this.clearDebris();
    this.clearSparks();
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
        const latch = this.burstLatchRigs[e.bey];
        if (latch) pulseBurstLatch(latch);
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
        // still in its owner's launcher — not in the stadium yet
        if (b.pendingTicks > 0) {
          const staged = this.stagedLaunchers[i];
          // Canonical staged meshes remain visibly mounted. A replay/menu
          // path that chose not to stage keeps the historical hidden delay.
          m.visible = Boolean(staged && !staged.released);
          sfx.updateHum(i, 0, 0, 0);
          continue;
        }
        this.releaseStagedLauncher(i, m, b.phase);
        this.updateStagedLauncher(i, dt);
        if (!m.visible && !this.burstSeparated[i]) m.visible = true;
        const latch = this.burstLatchRigs[i];
        if (latch && !this.burstSeparated[i]) {
          updateBurstLatchRig(latch, b.burstDamage, this.burstClicksMax, dt);
        }
        const r = Math.hypot(b.x, b.y);

        // A bad launch already followed the canonical ballistic path and
        // touched down outside the casing. Keep it at that exact miss point;
        // the generic KO arc below would invent a second, unrelated flight.
        if (b.exited === "launchMiss") {
          const fall = Math.min(Math.PI / 2, (this.launchMissTumble[i] ?? 0) + dt * 3.4);
          this.launchMissTumble[i] = fall;
          const elapsed = (this.launchMissElapsed[i] ?? 0) + dt;
          this.launchMissElapsed[i] = elapsed;
          const initialSpin = b.phase + (this.launchPhaseOffsets[i] ?? 0);
          const missSpin = (this.launchMissSpin[i] ?? initialSpin) +
            b.omega * Math.exp(-elapsed * 4.2) * dt;
          this.launchMissSpin[i] = missSpin;
          const radius = this.beyRadius[i] ?? 0.024;
          m.position.set(b.x, b.y, Math.max(0, b.z) + radius * Math.sin(fall));
          const base = this.launchOrientationBases[i] ?? new THREE.Quaternion();
          const spinning = composeLaunchedBeyOrientation(
            base,
            missSpin,
          );
          const speed = Math.hypot(b.vx, b.vy);
          const fallAxis = speed > 1e-8
            ? new THREE.Vector3(-b.vy / speed, b.vx / speed, 0)
            : new THREE.Vector3(1, 0, 0);
          const falling = new THREE.Quaternion().setFromAxisAngle(fallAxis, fall);
          m.quaternion.copy(falling).multiply(spinning).normalize();
          this.lastBeyPos[i]?.copy(m.position);
          sfx.updateHum(i, 0, 0, 0);
          continue;
        }

        // A knocked-out bey does not vanish. Pocket finishes follow the exact
        // product throat/skew to a deterministic catch-tray target; top exits
        // land outside the rectangular product body. Neither path invents
        // random replay-only scatter or assumes BX-32 is circular.
        if (b.exited) {
          let ko = this.koFlights[i];
          if (!ko) {
            const pocket = pocketAtPoint(s, b.x, b.y);
            if (pocket) {
              // The authoritative pocket dwell has completed, so capture a
              // genuinely side-resting zero-spin pose before freezing it.
              applyStopTopplePose(
                m,
                STOP_DWELL_TICKS,
                this.beyRadius[i] ?? 0.024,
                b.phase + (this.launchPhaseOffsets[i] ?? 0),
                stadiumTerrainAt(s, b.x, b.y).height,
              );
            }
            let target: { x: number; y: number };
            let targetZ: number;
            if (pocket) {
              target = pocketExitTarget(s, pocket);
              targetZ = stadiumTerrainAt(s, target.x, target.y).height;
            } else {
              const dir = r > 1e-8
                ? { x: b.x / r, y: b.y / r }
                : { x: 0, y: -1 };
              const scaleX = Math.abs(dir.x) > 1e-8
                ? (s.deckW / 2 + 0.035) / Math.abs(dir.x)
                : Number.POSITIVE_INFINITY;
              const scaleY = Math.abs(dir.y) > 1e-8
                ? (s.deckH / 2 + 0.035) / Math.abs(dir.y)
                : Number.POSITIVE_INFINITY;
              const distance = Math.min(scaleX, scaleY);
              target = { x: dir.x * distance, y: dir.y * distance };
              targetZ = 0;
            }
            ko = {
              t: 0,
              from: m.position.clone(),
              to: new THREE.Vector3(target.x, target.y, targetZ),
              spin: m.rotation.z,
              pocket: Boolean(pocket),
              orientation: m.quaternion.clone(),
            };
            this.koFlights[i] = ko;
          }
          ko.t = Math.min(1, ko.t + dt * 1.6);
          const k = ko.t;
          if (ko.pocket) {
            // A pocket result is authorized only after the core has observed
            // zero spin and a fully settled footprint for its complete dwell.
            // Preserve that exact pose: replaying a flight/tumble here made a
            // stopped Bey visibly re-spin after the result was announced.
            m.position.copy(ko.from);
            m.quaternion.copy(ko.orientation);
            this.lastBeyPos[i]?.copy(m.position);
            sfx.updateHum(i, 0, 0, 0);
            continue;
          }
          m.position.lerpVectors(ko.from, ko.to, k);
          m.position.z += Math.sin(k * Math.PI) * 0.05; // only a true top exit clears the casing
          m.rotation.z = ko.spin + k * 9; // still spinning as it flies
          m.rotation.x = Math.min(Math.PI / 2, k * 2.2); // comes to rest on its side
          // same tip-pivot correction as the topple: lie ON the floor, not in it
          m.position.z += (this.beyRadius[i] ?? 0.024) * Math.sin(m.rotation.x);
          this.lastBeyPos[i]?.copy(m.position);
          sfx.updateHum(i, 0, 0, 0);
          continue;
        }
        this.koFlights[i] = null;

        const groundHeight = stadiumTerrainAt(s, b.x, b.y).height;
        m.position.set(
          b.x,
          b.y,
          b.airborne ? b.z : groundHeight,
        );
        const visualSpin = b.phase + (this.launchPhaseOffsets[i] ?? 0);
        const launchBase = this.launchOrientationBases[i];
        let preservesLaunchAxis = false;
        if (b.airborne && launchBase) {
          composeLaunchedBeyOrientation(launchBase, visualSpin, m.quaternion);
          preservesLaunchAxis = true;
        } else if (launchBase && (this.launchLandingBlend[i] ?? 0) < 1) {
          const blend = Math.min(1, (this.launchLandingBlend[i] ?? 0) + dt / 0.14);
          this.launchLandingBlend[i] = blend;
          const smooth = blend * blend * (3 - 2 * blend);
          const groundBase = launchBase.clone().slerp(new THREE.Quaternion(), smooth);
          composeLaunchedBeyOrientation(groundBase, visualSpin, m.quaternion);
          preservesLaunchAxis = blend < 1;
        } else {
          m.rotation.set(0, 0, visualSpin);
        }
        const absOmega = Math.abs(b.omega);
        const visualStopDwell = persistentStopToppleDwell(
          this.stopToppleDwell[i] ?? 0,
          Math.max(b.stopDwell, pocketToppleDwell(b.pocketDwell)),
        );
        this.stopToppleDwell[i] = visualStopDwell;
        const blurMesh = m.getObjectByName("blurRing") as THREE.Mesh | undefined;
        if (blurMesh) {
          const bm = blurMesh.material as THREE.ShaderMaterial;
          bm.uniforms.uPhase!.value = -visualSpin * 3; // streaks counter-rotate in local frame
          bm.uniforms.uIntensity!.value = Math.min(1, Math.max(0, (absOmega - 140) / 650)) * 0.5;
        }
        if (b.airborne || preservesLaunchAxis) {
          // Preserve the full tilted top axis composed above until touchdown.
        } else if (!b.alive) {
          // If a zero-spin Bey was already falling when the terminal latch
          // hit arrived, release from that real side-lying pose.
          if (visualStopDwell > 0) {
            applyStopTopplePose(
              m,
              visualStopDwell,
              this.beyRadius[i] ?? 0.024,
              visualSpin,
              groundHeight,
            );
          }
          this.separateBurstBey(i, b);
        } else if (visualStopDwell > 0 || b.stoppedTick >= 0) {
          // The core now requires exactly zero spin plus a 0.6 s static dwell.
          // Use that same progress, so the finish never freezes an upright Bey
          // and render-frame rate cannot change how far it has toppled.
          applyStopTopplePose(
            m,
            visualStopDwell,
            this.beyRadius[i] ?? 0.024,
            visualSpin,
            groundHeight,
          );
        } else if (absOmega < WOBBLE_OMEGA) {
          // wobble grows as the bey winds down, so the moment it is called
          // stopped it has visibly been dying for a while (not a sudden cut)
          const t = 1 - absOmega / WOBBLE_OMEGA;
          m.rotation.x = Math.sin(b.phase * 0.23) * t * t * 0.5;
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
    this.stepDebris(dt, world);
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i]!;
      sp.life -= dt;
      sp.vel.z -= 3.2 * dt;
      sp.mesh.position.addScaledVector(sp.vel, dt);
      if (sp.life <= 0) {
        this.scene.remove(sp.mesh);
        sp.mesh.geometry.dispose();
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
    if (this.mode === "launch") {
      this.applyLaunchCameraFrame();
      return;
    }
    // orbit around the (pannable) target at the (pinchable) distance
    const t = this.orbitTarget;
    this.camera.position.set(
      t.x + Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDist,
      t.y + Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDist,
      t.z + Math.sin(this.orbitPitch) * this.orbitDist,
    );
    this.camera.lookAt(t.x, t.y, t.z);
  }
}
