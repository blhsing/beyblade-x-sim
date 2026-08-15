// Deterministic math for the simulation core.
//
// JS guarantees IEEE-754 semantics for + - * / sqrt abs floor — identical on
// every engine/device. Math.sin/cos/atan2/exp are implementation-defined, so
// the sim NEVER uses them; it uses the polynomial versions below. This is
// what makes cross-device lockstep (exchange launch params, simulate locally)
// possible. Rendering code may use native Math freely.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wrap an angle to [-π, π]. */
export function wrapAngle(x: number): number {
  const k = Math.floor(x * (1 / TAU) + 0.5);
  return x - k * TAU;
}

/** Deterministic sine (Taylor deg 15 after range reduction; |err| < 2e-6). */
export function dsin(x: number): number {
  const z = wrapAngle(x);
  const z2 = z * z;
  return (
    z *
    (1 +
      z2 *
        (-1 / 6 +
          z2 *
            (1 / 120 +
              z2 *
                (-1 / 5040 +
                  z2 *
                    (1 / 362880 +
                      z2 *
                        (-1 / 39916800 +
                          z2 * (1 / 6227020800 - z2 / 1307674368000)))))))
  );
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

function atanPoly(z: number): number {
  // minimax on [0,1], |err| ~ 1e-5
  const z2 = z * z;
  return (
    z *
    (0.99997726 +
      z2 *
        (-0.33262347 +
          z2 *
            (0.19354346 +
              z2 * (-0.11643287 + z2 * (0.05265332 - z2 * 0.0117212)))))
  );
}

/** Deterministic atan2. */
export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const swap = ay > ax;
  const a0 = atanPoly(swap ? ax / ay : ay / ax);
  const a1 = swap ? HALF_PI - a0 : a0;
  const a2 = x < 0 ? PI - a1 : a1;
  return y < 0 ? -a2 : a2;
}

/** Mulberry32 PRNG — integer ops only, fully deterministic. State is a u32. */
export function rngNext(state: number): { value: number; state: number } {
  let a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: a >>> 0 };
}

/** FNV-1a 64-bit over float64 bit patterns → 16-hex-char string. */
export function hashFloats(values: Iterable<number>): string {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const v of values) {
    dv.setFloat64(0, v);
    for (let i = 0; i < 8; i++) {
      h ^= BigInt(dv.getUint8(i));
      h = (h * prime) & mask;
    }
  }
  return h.toString(16).padStart(16, "0");
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
