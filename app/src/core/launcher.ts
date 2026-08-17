import type { LauncherKind, SpinDir } from "./types";

/** Physical drive direction of each Takara Tomy launcher configuration. */
export function launcherDirection(kind: LauncherKind): SpinDir {
  return kind === "winderL" || kind === "stringL" ? -1 : 1;
}
/**
 * A right-spin drive cannot engage an L bey (and vice versa).  Old saved
 * preferences and network replays can therefore select any launcher safely:
 * at the actual launch we substitute the closest compatible mechanism.
 */
export function normalizeLauncherForSpin(kind: LauncherKind, spinDir: SpinDir): LauncherKind {
  if (launcherDirection(kind) === spinDir) return kind;
  if (spinDir < 0) return kind === "string" ? "stringL" : "winderL";
  return kind === "stringL" ? "string" : "winder";
}
