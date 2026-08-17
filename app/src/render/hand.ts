// Stable public entry point for the anatomical hand model. Launcher geometry
// lives in launcher.ts; keeping this small prevents hand and launcher detail
// work from becoming coupled again.

export {
  buildHand,
  fingertipOffset,
  handPoseMetrics,
  type FingerName,
  type HandSide,
} from "./hand-model";

// Compatibility for older scene/replay integrations that imported launcher
// symbols from this module before the catalog renderer moved to launcher.ts.
export { buildLauncher, updateCord, type LauncherRig } from "./launcher";
