// Ray-marched realism pass.
//
// Honest framing: no browser exposes hardware ray tracing — neither WebGL2
// nor WebGPU gives us RT cores — so a literal path tracer is not an option at
// 60 fps on a phone. What *is* available, and what this implements, is the
// same idea done in a pixel shader: rays marched through the depth buffer.
//
//   1. a G-buffer pass writes view-space normals + a reflectivity mask
//   2. a full-screen fragment shader marches rays against the depth buffer for
//      · screen-space ray-traced reflections (a metal blade reflects the dish
//        and the other blades, not just a static environment probe)
//      · ray-marched contact shadows toward the key light
//      · hemispherical ray-marched ambient occlusion in the creases
//   3. the result is composited over the physically-based beauty pass
//
// The G-buffer and the march run at a fraction of the display resolution and
// the result is upsampled, which is what keeps this affordable on a phone.

import * as THREE from "three";

/** Per-mesh reflectivity for the mask channel; set by the scene builder. */
export function markReflective(obj: THREE.Object3D, reflectivity: number): void {
  obj.userData.rtReflect = reflectivity;
  obj.traverse((o) => {
    o.userData.rtReflect = reflectivity;
  });
}

/**
 * Apply the screen-space reflection mask by physical Bey surface instead of
 * painting the whole assembly with the same value.  Reference tops already
 * contain the product photograph's highlights; reflecting the stadium over
 * that baked image a second time washes the sticker and plastic islands white.
 * Bare metal keeps a restrained dynamic reflection, coated metal keeps less,
 * and ordinary plastic relies on the forward material without a second pass.
 */
export function markBeyReflective(obj: THREE.Object3D): void {
  obj.userData.rtReflect = 0;
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      child.userData.rtReflect = 0;
      return;
    }

    const name = child.name;
    if (
      name === "blurRing" ||
      name.endsWith(":reference-top") ||
      name.endsWith(":fallback-sticker") ||
      name.endsWith(":composite-reference")
    ) {
      child.userData.rtReflect = 0;
      return;
    }

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    let metalness = 0;
    for (const material of materials) {
      const value = (material as THREE.MeshStandardMaterial).metalness;
      if (Number.isFinite(value)) metalness = Math.max(metalness, value);
    }
    child.userData.rtReflect = metalness >= 0.8 ? 0.12 : metalness >= 0.35 ? 0.06 : 0;
  });
}

const GBUFFER_VERT = /* glsl */ `
  varying vec3 vViewNormal;
  void main() {
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const GBUFFER_FRAG = /* glsl */ `
  uniform float uReflect;
  varying vec3 vViewNormal;
  void main() {
    vec3 n = normalize(vViewNormal);
    gl_FragColor = vec4(n * 0.5 + 0.5, uReflect);
  }`;

const COMPOSITE_FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D tColor;
  uniform sampler2D tNormal;   // rgb = view normal, a = reflectivity
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uInvProj;
  uniform vec2 uRes;
  uniform float uNear;
  uniform float uFar;
  uniform vec3 uLightView;     // key light direction in view space
  uniform float uReflectStrength;
  uniform float uAoStrength;
  uniform float uShadowStrength;
  uniform int uSteps;
  varying vec2 vUv;

  float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

  float viewZAt(vec2 uv) {
    return perspectiveDepthToViewZ(rawDepth(uv), uNear, uFar);
  }

  vec3 viewPosAt(vec2 uv) {
    float d = rawDepth(uv);
    vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uInvProj * clip;
    return v.xyz / v.w;
  }

  vec2 projectUv(vec3 viewPos) {
    vec4 clip = uProj * vec4(viewPos, 1.0);
    return (clip.xy / clip.w) * 0.5 + 0.5;
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  // ---- screen-space ray march: returns hit uv, or (-1) on miss ----
  vec2 marchRay(vec3 origin, vec3 dir, float stride, float jitter, out float hitFade) {
    hitFade = 0.0;
    vec3 p = origin;
    for (int i = 0; i < 40; i++) {
      if (i >= uSteps) break;
      p += dir * stride * (1.0 + float(i) * 0.22); // widening steps
      if (p.z > -uNear) return vec2(-1.0);
      vec2 uv = projectUv(p);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec2(-1.0);
      float sceneZ = viewZAt(uv);
      float diff = sceneZ - p.z;                 // >0 → ray is behind geometry
      if (diff > 0.0 && diff < stride * 6.0) {
        // fade at screen edges and with distance, the usual SSR tells
        vec2 edge = smoothstep(vec2(0.0), vec2(0.14), uv)
                  * (1.0 - smoothstep(vec2(0.86), vec2(1.0), uv));
        hitFade = edge.x * edge.y * (1.0 - float(i) / float(uSteps));
        return uv;
      }
    }
    return vec2(-1.0);
  }

  void main() {
    vec4 color = texture2D(tColor, vUv);
    float d = rawDepth(vUv);
    if (d >= 0.9999) { gl_FragColor = color; return; }   // background

    vec4 nrm = texture2D(tNormal, vUv);
    vec3 n = normalize(nrm.rgb * 2.0 - 1.0);
    float reflectivity = nrm.a;
    vec3 pos = viewPosAt(vUv);
    vec3 viewDir = normalize(pos);
    float rnd = hash(vUv * uRes);

    // ---- ray-marched ambient occlusion ----
    float ao = 0.0;
    const int AO_DIRS = 6;
    float radius = 0.016;
    for (int i = 0; i < AO_DIRS; i++) {
      float a = (float(i) + rnd) / float(AO_DIRS) * 6.2831853;
      vec3 tangentDir = normalize(vec3(cos(a), sin(a), 0.0) - n * dot(vec3(cos(a), sin(a), 0.0), n));
      float occ = 0.0;
      for (int s = 1; s <= 4; s++) {
        vec3 sp = pos + (tangentDir * 0.7 + n * 0.35) * radius * float(s) * 0.25;
        vec2 uv = projectUv(sp);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
        float sceneZ = viewZAt(uv);
        float diff = sceneZ - sp.z;
        if (diff > 0.0005) {
          occ = max(occ, clamp(1.0 - diff / (radius * 3.0), 0.0, 1.0));
        }
      }
      ao += occ;
    }
    ao = clamp(ao / float(AO_DIRS), 0.0, 1.0) * uAoStrength;

    // ---- ray-marched contact shadow toward the key light ----
    float shade = 0.0;
    {
      float f;
      vec3 o = pos + n * 0.0012;
      vec2 hit = marchRay(o, normalize(uLightView), 0.0022 * (0.7 + rnd * 0.6), rnd, f);
      if (hit.x >= 0.0) shade = f * uShadowStrength;
    }

    // ---- screen-space ray-traced reflection ----
    vec3 refl = vec3(0.0);
    float reflAmt = 0.0;
    if (reflectivity > 0.02) {
      vec3 r = reflect(viewDir, n);
      float f;
      vec2 hit = marchRay(pos + n * 0.0015, r, 0.004 * (0.8 + rnd * 0.4), rnd, f);
      if (hit.x >= 0.0) {
        refl = texture2D(tColor, hit).rgb;
        // Schlick-ish grazing boost so edges mirror harder than face-on
        float fres = pow(1.0 - max(dot(-viewDir, n), 0.0), 3.0);
        reflAmt = f * reflectivity * (0.28 + 0.72 * fres) * uReflectStrength;
      }
    }

    vec3 outC = color.rgb * (1.0 - ao) * (1.0 - shade);
    outC = mix(outC, refl, clamp(reflAmt, 0.0, 0.9));
    gl_FragColor = vec4(outC, color.a);
  }`;

export interface RtQuality {
  /** 0 = off, 0.5 = half-res march, 1 = full-res */
  scale: number;
  steps: number;
  reflect: number;
  ao: number;
  shadow: number;
}

export const RT_PRESETS: Record<string, RtQuality> = {
  off: { scale: 0, steps: 0, reflect: 0, ao: 0, shadow: 0 },
  low: { scale: 0.45, steps: 12, reflect: 0.55, ao: 0.4, shadow: 0.3 },
  high: { scale: 0.7, steps: 26, reflect: 0.85, ao: 0.55, shadow: 0.45 },
};

/**
 * Owns the render targets and drives beauty → G-buffer → composite.
 * Falls back to a plain forward render when disabled or unsupported.
 */
export class RayMarchComposer {
  quality: RtQuality = RT_PRESETS.high!;
  private colorRT: THREE.WebGLRenderTarget;
  private normalRT: THREE.WebGLRenderTarget;
  private gbufMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private composite: THREE.ShaderMaterial;
  private size = new THREE.Vector2(1, 1);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {
    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    this.colorRT = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: depth,
      type: THREE.HalfFloatType,
      samples: 0,
    });
    this.colorRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.normalRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });

    this.gbufMat = new THREE.ShaderMaterial({
      uniforms: { uReflect: { value: 0 } },
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
    });

    this.composite = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.colorRT.texture },
        tNormal: { value: this.normalRT.texture },
        tDepth: { value: depth },
        uProj: { value: new THREE.Matrix4() },
        uInvProj: { value: new THREE.Matrix4() },
        uRes: { value: new THREE.Vector2() },
        uNear: { value: 0.01 },
        uFar: { value: 20 },
        uLightView: { value: new THREE.Vector3(0.4, 0.4, 1) },
        uReflectStrength: { value: 0.85 },
        uAoStrength: { value: 0.55 },
        uShadowStrength: { value: 0.45 },
        uSteps: { value: 26 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.size.set(Math.max(1, Math.floor(w * pixelRatio)), Math.max(1, Math.floor(h * pixelRatio)));
    this.colorRT.setSize(this.size.x, this.size.y);
    const s = Math.max(0.2, this.quality.scale || 0.5);
    this.normalRT.setSize(Math.floor(this.size.x * s), Math.floor(this.size.y * s));
    this.composite.uniforms.uRes!.value.copy(this.size);
  }

  /** Key light direction (world space) used for the contact-shadow march. */
  lightWorld = new THREE.Vector3(0.45, -0.35, 0.85).normalize();

  render(): void {
    if (this.quality.scale <= 0) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // 1. beauty pass into the colour target (keeps depth for the march)
    this.renderer.setRenderTarget(this.colorRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // 2. G-buffer: view normals + per-mesh reflectivity mask. One shared
    // material; each mesh pokes its own reflectivity in before its draw.
    const prevOverride = this.scene.overrideMaterial;
    const mat = this.gbufMat;
    this.scene.overrideMaterial = mat;
    const restore: { obj: THREE.Object3D; fn: THREE.Object3D["onBeforeRender"] }[] = [];
    this.scene.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      restore.push({ obj: o, fn: o.onBeforeRender });
      o.onBeforeRender = () => {
        mat.uniforms.uReflect!.value = (o.userData.rtReflect as number | undefined) ?? 0;
      };
    });
    this.renderer.setRenderTarget(this.normalRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    for (const r of restore) r.obj.onBeforeRender = r.fn;
    this.scene.overrideMaterial = prevOverride;

    // 3. composite: march the depth buffer and blend over the beauty pass
    const u = this.composite.uniforms;
    u.uProj!.value.copy(this.camera.projectionMatrix);
    u.uInvProj!.value.copy(this.camera.projectionMatrixInverse);
    u.uNear!.value = this.camera.near;
    u.uFar!.value = this.camera.far;
    u.uSteps!.value = this.quality.steps;
    u.uReflectStrength!.value = this.quality.reflect;
    u.uAoStrength!.value = this.quality.ao;
    u.uShadowStrength!.value = this.quality.shadow;
    u.uLightView!.value
      .copy(this.lightWorld)
      .transformDirection(this.camera.matrixWorldInverse)
      .normalize();
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  dispose(): void {
    this.colorRT.dispose();
    this.normalRT.dispose();
    this.composite.dispose();
    this.gbufMat.dispose();
    this.quad.geometry.dispose();
  }
}
