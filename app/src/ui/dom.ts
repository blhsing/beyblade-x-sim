// Tiny DOM helpers for the zh-TW UI (no framework).

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

export function button(label: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
  const b = el("button", { class: cls }, label);
  b.addEventListener("click", onClick);
  return b;
}

export function select(
  options: { value: string; label: string }[],
  value?: string,
): HTMLSelectElement {
  const s = el("select", { class: "sel" });
  for (const o of options) {
    const opt = el("option", { value: o.value }, o.label);
    s.append(opt);
  }
  if (value !== undefined) s.value = value;
  return s;
}

export function row(...children: (Node | string)[]): HTMLDivElement {
  return el("div", { class: "row" }, ...children);
}

export function overlay(cls = ""): HTMLDivElement {
  return el("div", { class: `overlay ${cls}` });
}

export const UI_CSS = `
.overlay { position: fixed; inset: 0; width: 100dvw; height: 100dvh;
  box-sizing: border-box; display: flex; flex-direction: column;
  align-items: center; justify-content: safe center; gap: 14px;
  padding: calc(18px + env(safe-area-inset-top, 0px))
    calc(18px + env(safe-area-inset-right, 0px))
    calc(18px + env(safe-area-inset-bottom, 0px))
    calc(18px + env(safe-area-inset-left, 0px));
  background: rgba(11,16,32,.22); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch; touch-action: pan-y; z-index: 10; }
.overlay.transparent { background: transparent; pointer-events: none; overflow: hidden; touch-action: none; }
.overlay.transparent > * { pointer-events: auto; }
/* Confirmations must sit above the launch gesture surface (z 12) and the
   scoreboard (z 13). At the base overlay z-index the give-up dialog rendered
   UNDER the full-screen launchzone: visible, but every tap went to the
   launcher instead, so the match ran on with a dead-looking menu on top. */
.overlay.modal { z-index: 40; background: rgba(11,16,32,.55); }
.panel { background: rgba(20,27,58,.4); border: 1px solid rgba(74,93,168,.45);
  border-radius: 14px; backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  padding: 16px; width: min(92vw, 420px); display: flex; flex-direction: column; gap: 10px;
  max-height: calc(100vh - 36px); max-height: calc(100dvh - env(safe-area-inset-top, 0px)
    - env(safe-area-inset-bottom, 0px) - 36px); min-height: 0;
  box-sizing: border-box; flex: 0 1 auto;
  overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
  touch-action: pan-y; text-shadow: 0 1px 3px rgba(0,0,0,.65); }
.panel, .panel * { box-sizing: border-box; }
.title { font-size: 30px; font-weight: 900; letter-spacing: 3px;
  text-shadow: 0 0 18px #3f7bff88; text-align: center; }
.subtitle { opacity: .7; font-size: 13px; text-align: center; }
.btn { font: inherit; font-size: 17px; padding: 12px 20px; border-radius: 10px;
  border: 1px solid rgba(75,91,215,.8); background: rgba(26,35,80,.5); color: #e8ecff;
  width: 100%; text-shadow: 0 1px 3px rgba(0,0,0,.65); }
.btn:active { background: rgba(44,58,134,.75); }
.btn.primary { background: rgba(44,71,201,.7); border-color: #6b83ff; font-weight: 700; }
.btn.small { width: auto; font-size: 14px; padding: 7px 12px; }
.sel, input[type=text], input[type=email], input[type=password] {
  font: inherit; font-size: 15px; padding: 9px 10px;
  border-radius: 8px; border: 1px solid rgba(53,64,138,.8); background: rgba(14,20,48,.5);
  color: #e8ecff; width: 100%; }
.row { display: flex; gap: 8px; align-items: center; }
.row > * { flex: 1; }
.row > .fixed { flex: 0 0 auto; }
.label { font-size: 13px; opacity: .75; }
.card { background: rgba(14,20,48,.35); border: 1px solid rgba(42,53,110,.6);
  border-radius: 10px; padding: 10px;
  display: flex; flex-direction: column; gap: 8px; }
.scoreboard { display: flex; justify-content: center; gap: 20px; font-size: 22px;
  font-weight: 800; }
.banner-big { font-size: 34px; font-weight: 900; letter-spacing: 2px;
  text-align: center; text-shadow: 0 2px 12px #000; }
.launchzone { position: fixed; inset: 0; touch-action: none; z-index: 12;
  display: flex; flex-direction: column; align-items: center;
  justify-content: flex-start; padding-top: 14vh; }
.spmeter { position: fixed; left: 8vw; right: 8vw; bottom: 4vh; height: 14px;
  border: 1px solid #4b5bd7; border-radius: 7px; overflow: hidden; z-index: 12; }
.spfill { height: 100%; width: 0%; background: linear-gradient(90deg,#3f7bff,#ff5b4d);
  transition: width .06s linear; }
.countdown { font-size: 60px; font-weight: 900; text-shadow: 0 0 24px #3f7bffaa; }
.bracket { display: flex; flex-direction: column; gap: 6px; width: min(92vw, 420px); }
.bracket .m { display: flex; justify-content: space-between; background: #0e1430;
  border: 1px solid #2a356e; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
.bracket .win { color: #7dffa8; font-weight: 700; }
.topbar { position: fixed; top: 0; left: 0; right: 0;
  display: flex; gap: 8px;
  padding: calc(8px + env(safe-area-inset-top, 0px))
    calc(10px + env(safe-area-inset-right, 0px)) 8px
    calc(10px + env(safe-area-inset-left, 0px));
  box-sizing: border-box; z-index: 13; align-items: center; }
.topbar .spacer { flex: 1; }
.gstrip { display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x proximity;
  padding: 8px 22vw; width: 100vw; -webkit-overflow-scrolling: touch; }
.gstrip.ggrid { display: grid;
  grid-template-columns: repeat(auto-fill, minmax(124px, 1fr));
  box-sizing: border-box; align-items: start; gap: 10px;
  width: min(94vw, 960px); max-width: 100%;
  max-height: min(52dvh, 540px); padding: 8px;
  overflow-x: hidden; overflow-y: auto; scroll-snap-type: none;
  overscroll-behavior: contain; touch-action: pan-y; }
.gchips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center;
  max-width: 94vw; }
.gchip { padding: 5px 12px; border-radius: 999px; border: 1px solid rgba(53,64,138,.8);
  background: rgba(26,35,80,.5); color: #e8ecff; font: inherit; font-size: 13px; }
.gchip.on { background: rgba(44,71,201,.8); border-color: #6b83ff; font-weight: 700; }
.gcard { flex: 0 0 56vw; max-width: 230px; scroll-snap-align: center;
  background: rgba(20,27,58,.55); border: 2px solid rgba(42,53,110,.8); border-radius: 14px;
  padding: 10px; text-align: center; }
.ggrid .gcard { min-width: 0; width: auto; max-width: none; scroll-snap-align: none; }
.gcard img { width: 100%; aspect-ratio: 1/1; border-radius: 8px; background: #0e1430; }
.gcard.focus { border-color: #6b83ff; box-shadow: 0 0 18px #3f7bff66; }
.gdetail { min-height: 150px; }
.brwrap { width: min(94vw, 460px); overflow-x: auto; background: rgba(14,20,48,.55);
  border: 1px solid #2a356e; border-radius: 12px; }
.brsvg text { fill: #e8ecff; font-size: 12px; font-family: inherit; }
.brsvg text.win { fill: #7dffa8; font-weight: 700; }
.brsvg rect.node { fill: #141b3a; stroke: #35408a; }
.brsvg rect.winrect { stroke: #4dcf7a; }
.brsvg rect.nextm { stroke: #ffd766; stroke-width: 2; cursor: pointer;
  animation: brpulse 1.2s ease-in-out infinite; }
.brsvg polyline { fill: none; stroke: #35408a; }
@keyframes brpulse { 0%, 100% { stroke-opacity: 1; } 50% { stroke-opacity: .35; } }
.rrgrid { display: grid; grid-template-columns: 1fr 3.2em 3.2em; gap: 4px;
  font-size: 13px; width: min(92vw, 420px); }
.rrgrid .cell { background: #141b3a; border: 1px solid #2a356e; border-radius: 6px;
  padding: 5px 7px; text-align: center; }
.rrgrid .hd { background: #1a2350; font-weight: 700; }
.chev { animation: chevflow 1.05s ease-in infinite; opacity: 0; }
.c2 { animation-delay: .16s; }
.c3 { animation-delay: .32s; }
@keyframes chevflow {
  0% { opacity: 0; transform: translateY(-8px); }
  30% { opacity: .95; }
  100% { opacity: 0; transform: translateY(16px); }
}
.versus-intro { --versus-bey-size: 200px; --versus-travel: 500px;
  --versus-name-size: 40px; --versus-duration: 1320ms;
  position: fixed; inset: 0; width: 100dvw; height: 100dvh; z-index: 32;
  box-sizing: border-box; overflow: hidden; isolation: isolate; cursor: pointer;
  touch-action: none; user-select: none; -webkit-user-select: none; color: #fff;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
    env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  background:
    radial-gradient(ellipse at 50% 48%, rgba(255,185,36,.22), transparent 32%),
    linear-gradient(168deg, rgba(13,53,132,.72) 0 43%, rgba(5,8,19,.35) 50%, rgba(142,22,11,.68) 57% 100%);
  animation: versus-scene var(--versus-duration) linear both; }
.versus-intro.skipping { animation: none; opacity: 0; transition: opacity 40ms linear; }
.versus-vignette { position: absolute; inset: -4%; z-index: 8; pointer-events: none;
  box-shadow: inset 0 0 12vmin 3vmin rgba(0,0,0,.76);
  background: repeating-linear-gradient(117deg, transparent 0 9%, rgba(255,255,255,.035) 9.3% 9.6%); }
.versus-effects { position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: hidden; }
.versus-burn { position: absolute; left: -10%; right: -10%; height: 52%; opacity: .88;
  background:
    radial-gradient(ellipse at 12% 98%, rgba(255,238,120,.95) 0 2%, rgba(255,103,12,.72) 6%, transparent 19%),
    radial-gradient(ellipse at 48% 105%, rgba(255,248,172,.95) 0 3%, rgba(255,74,8,.68) 8%, transparent 24%),
    radial-gradient(ellipse at 82% 96%, rgba(255,225,93,.9) 0 2%, rgba(255,63,7,.68) 7%, transparent 21%);
  filter: blur(5px) saturate(1.35); mix-blend-mode: screen;
  animation: versus-burn var(--versus-duration) ease-in-out both; }
.versus-burn.player { top: -8%; transform: rotate(180deg); filter: blur(5px) hue-rotate(176deg) saturate(1.45); }
.versus-burn.opponent { bottom: -8%; }
.versus-center-flare { position: absolute; left: -10%; right: -10%; top: 43%; height: 14%;
  background: radial-gradient(ellipse, #fff 0 1%, #ffe67cbb 3%, #ff6a1666 16%, transparent 58%);
  filter: blur(2px); mix-blend-mode: screen; animation: versus-flare var(--versus-duration) ease-out both; }
.versus-light-slash { position: absolute; left: -22%; top: 49%; width: 144%; height: 4px;
  transform: rotate(-8deg); background: linear-gradient(90deg, transparent, #68c8ff, #fff 48% 52%, #ff7a3d, transparent);
  box-shadow: 0 0 8px #fff, 0 0 25px #ff9d2e; animation: versus-slash var(--versus-duration) ease-out both; }
.versus-spark { --spark-x: 50%; --spark-y: 50%; --spark-angle: 0deg;
  --spark-length: 36px; --spark-delay: 0ms; --spark-life: 520ms;
  position: absolute; left: var(--spark-x); top: var(--spark-y); display: block;
  width: var(--spark-length); height: 2px; border-radius: 50%; opacity: 0;
  transform: rotate(var(--spark-angle)); transform-origin: left center;
  background: linear-gradient(90deg, #fff, #ffd44d 32%, transparent);
  box-shadow: 0 0 7px #ff8a16; mix-blend-mode: screen;
  animation: versus-spark var(--spark-life) ease-out var(--spark-delay) 2 both; }
.versus-spark.s1 { filter: hue-rotate(170deg); }
.versus-spark.s2 { height: 3px; }
.versus-spark.s3 { animation-direction: alternate; }
.versus-bey { position: absolute; left: 50%; width: var(--versus-bey-size);
  height: var(--versus-bey-size); margin-left: calc(var(--versus-bey-size) / -2);
  z-index: 3; pointer-events: none; will-change: transform, opacity; }
.versus-bey.player { top: max(calc(env(safe-area-inset-top, 0px) + 4px), calc(25dvh - var(--versus-bey-size) / 2));
  animation: versus-player-track var(--versus-duration) cubic-bezier(.18,.78,.2,1) both; }
.versus-bey.opponent { bottom: max(calc(env(safe-area-inset-bottom, 0px) + 4px), calc(25dvh - var(--versus-bey-size) / 2));
  animation: versus-opponent-track var(--versus-duration) cubic-bezier(.18,.78,.2,1) both; }
.versus-bey-disc { position: absolute; inset: 0; border-radius: 50%; z-index: 2;
  filter: drop-shadow(0 6px 4px rgba(0,0,0,.52)) drop-shadow(0 0 15px rgba(255,244,185,.75));
  will-change: transform; }
.versus-bey.player .versus-bey-disc { animation: versus-player-spin var(--versus-duration) cubic-bezier(.15,.65,.22,1) both; }
.versus-bey.opponent .versus-bey-disc { animation: versus-opponent-spin var(--versus-duration) cubic-bezier(.15,.65,.22,1) both; }
.versus-bey-disc img { display: block; width: 100%; height: 100%; object-fit: contain; border-radius: 50%; }
.versus-bey-aura, .versus-bey-rim { position: absolute; inset: -8%; border-radius: 50%; }
.versus-bey-aura { z-index: 0; background: conic-gradient(from 20deg, transparent, #47bcff, transparent 28%, #fff, transparent 52%, #ffb22d, transparent 78%);
  filter: blur(8px); opacity: .9; animation: versus-aura 380ms linear infinite; }
.versus-bey.opponent .versus-bey-aura { animation-direction: reverse; filter: blur(8px) hue-rotate(155deg); }
.versus-bey-rim { inset: -3%; z-index: 4; border: 2px solid rgba(255,255,255,.55);
  box-shadow: inset 0 0 12px #fff9, 0 0 15px #ffb12d; }
.versus-speed-lines { position: absolute; left: -52%; right: -52%; top: 20%; bottom: 20%; z-index: 1;
  background: repeating-linear-gradient(0deg, transparent 0 7%, rgba(255,255,255,.78) 8%, transparent 10%);
  filter: blur(1px); opacity: .68; }
.versus-lockup { position: absolute; z-index: 10; left: max(calc(env(safe-area-inset-left, 0px) + 12px), 4vw);
  right: max(calc(env(safe-area-inset-right, 0px) + 12px), 4vw); top: 50%;
  transform: translateY(-50%) rotate(-2deg); display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr);
  align-items: center; gap: clamp(8px, 3vw, 28px); text-align: center;
  animation: versus-lockup var(--versus-duration) cubic-bezier(.15,.8,.2,1) both; }
.versus-name { min-width: 0; font-size: var(--versus-name-size); line-height: .94; font-weight: 1000;
  letter-spacing: clamp(1px, .5vw, 6px); overflow-wrap: anywhere; text-transform: uppercase;
  -webkit-text-stroke: 1px rgba(255,255,255,.72); }
.versus-name.player { color: #dff5ff; text-shadow: 0 3px 0 #092863, 0 0 10px #37afff, 0 0 28px #137cff; }
.versus-name.opponent { color: #fff0dc; text-shadow: 0 3px 0 #681209, 0 0 10px #ff5124, 0 0 28px #ff2c0e; }
.versus-vs { display: flex; gap: 0; font-size: clamp(54px, 15vmin, 112px); line-height: .72; font-style: italic;
  font-weight: 1000; letter-spacing: -14px; transform: skew(-10deg); filter: drop-shadow(0 0 12px #ff9a22); }
.versus-vs span:first-child { color: #8bd8ff; -webkit-text-stroke: 2px #fff; transform: translateY(-5%); }
.versus-vs span:last-child { color: #ff623e; -webkit-text-stroke: 2px #fff; transform: translateY(5%); }
.versus-battle-call { position: absolute; left: 50%; top: calc(100% + 11px); transform: translateX(-50%) skew(-12deg);
  padding: 3px 18px; border: 1px solid #fff9; background: #0a0d20cc; color: #ffd86a;
  font-size: clamp(11px, 2.5vmin, 16px); font-weight: 900; letter-spacing: .55em; text-indent: .55em;
  box-shadow: 0 0 14px #ff5b1f88; }
.versus-skip-hint { position: absolute; z-index: 11; right: calc(12px + env(safe-area-inset-right, 0px));
  bottom: calc(8px + env(safe-area-inset-bottom, 0px)); font-size: 11px; opacity: .58;
  text-shadow: 0 1px 3px #000; animation: versus-hint var(--versus-duration) linear both; }
@keyframes versus-scene { 0% { opacity: 0; } 4%, 75% { opacity: 1; } 100% { opacity: 0; } }
@keyframes versus-player-track { 0% { transform: translateX(calc(var(--versus-travel) * -1)) scale(.76); opacity: 0; }
  29% { transform: translateX(0) scale(1.08); opacity: 1; } 39%, 73% { transform: translateX(0) scale(1); opacity: 1; }
  100% { transform: translateX(var(--versus-travel)) scale(.78); opacity: 0; } }
@keyframes versus-opponent-track { 0% { transform: translateX(var(--versus-travel)) scale(.76); opacity: 0; }
  29% { transform: translateX(0) scale(1.08); opacity: 1; } 39%, 73% { transform: translateX(0) scale(1); opacity: 1; }
  100% { transform: translateX(calc(var(--versus-travel) * -1)) scale(.78); opacity: 0; } }
@keyframes versus-player-spin { 0% { transform: rotate(-760deg); } 31% { transform: rotate(0); }
  73% { transform: rotate(520deg); } 100% { transform: rotate(1080deg); } }
@keyframes versus-opponent-spin { 0% { transform: rotate(760deg); } 31% { transform: rotate(0); }
  73% { transform: rotate(-520deg); } 100% { transform: rotate(-1080deg); } }
@keyframes versus-lockup { 0%, 18% { opacity: 0; transform: translateY(-50%) scale(2.2) rotate(-8deg); }
  31%, 71% { opacity: 1; transform: translateY(-50%) scale(1) rotate(-2deg); }
  100% { opacity: 0; transform: translateY(-50%) scale(.86) rotate(3deg); filter: blur(8px); } }
@keyframes versus-burn { 0% { opacity: 0; transform: scaleY(.25); } 25%, 72% { opacity: .9; transform: scaleY(1); }
  100% { opacity: 0; transform: scaleY(1.5); } }
@keyframes versus-flare { 0%, 22% { opacity: 0; transform: scaleX(.1); } 31% { opacity: 1; transform: scaleX(1.15); }
  72% { opacity: .7; } 100% { opacity: 0; transform: scaleX(2); } }
@keyframes versus-slash { 0%, 24% { opacity: 0; transform: rotate(-8deg) scaleX(.08); } 33%, 69% { opacity: .92; transform: rotate(-8deg) scaleX(1); }
  100% { opacity: 0; transform: rotate(-8deg) scaleX(1.45); } }
@keyframes versus-spark { 0% { opacity: 0; transform: rotate(var(--spark-angle)) translateX(-14px) scaleX(.2); }
  18% { opacity: 1; } 100% { opacity: 0; transform: rotate(var(--spark-angle)) translateX(70px) scaleX(1); } }
@keyframes versus-aura { to { transform: rotate(360deg); } }
@keyframes versus-hint { 0%, 28%, 78%, 100% { opacity: 0; } 35%, 72% { opacity: .58; } }
.versus-intro.reduced { animation: versus-reduced-scene var(--versus-duration) linear both; }
.versus-intro.reduced .versus-bey, .versus-intro.reduced .versus-bey-disc,
.versus-intro.reduced .versus-lockup, .versus-intro.reduced .versus-burn,
.versus-intro.reduced .versus-center-flare, .versus-intro.reduced .versus-light-slash,
.versus-intro.reduced .versus-bey-aura { animation: none; }
.versus-intro.reduced .versus-spark, .versus-intro.reduced .versus-speed-lines { display: none; }
@keyframes versus-reduced-scene { 0% { opacity: 0; } 22%, 68% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .versus-intro:not(.reduced) .versus-bey, .versus-intro:not(.reduced) .versus-bey-disc,
  .versus-intro:not(.reduced) .versus-lockup, .versus-intro:not(.reduced) .versus-effects * { animation: none !important; }
}
@media (orientation: landscape) and (max-height: 600px) {
  .overlay { justify-content: flex-start; gap: 8px;
    padding: calc(8px + env(safe-area-inset-top, 0px))
      calc(12px + env(safe-area-inset-right, 0px))
      calc(8px + env(safe-area-inset-bottom, 0px))
      calc(12px + env(safe-area-inset-left, 0px)); }
  .panel { width: min(92vw, 620px); max-height: calc(100dvh
      - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 16px);
    padding: 10px 14px; gap: 8px; }
  .gchips { box-sizing: border-box; flex: 0 0 auto; flex-wrap: nowrap;
    justify-content: flex-start; width: min(94vw, 960px); max-width: 100%;
    overflow-x: auto; overflow-y: hidden; padding-bottom: 2px;
    -webkit-overflow-scrolling: touch; touch-action: pan-x; }
  .gstrip.ggrid { flex: 0 0 clamp(128px, 46dvh, 220px);
    min-height: 128px; max-height: 46dvh; }
  .gdetail { display: none; }
  .title { font-size: 24px; letter-spacing: 2px; }
  .btn { font-size: 14px; padding: 8px 12px; }
  .sel, input[type=text], input[type=email], input[type=password] {
    font-size: 14px; padding: 7px 9px; }
  .card { padding: 8px; gap: 6px; }
  .topbar { gap: 5px; padding-top: calc(5px + env(safe-area-inset-top, 0px)); }
  .topbar .row { gap: 5px; }
  .topbar .btn.small { font-size: 12px; padding: 6px 9px; }
  .scoreboard { gap: 8px; font-size: clamp(14px, 4.5vh, 20px); white-space: nowrap; }
  .launchzone.landscape { padding-top: calc(7vh + env(safe-area-inset-top, 0px)); }
  .launchzone.landscape .countdown { font-size: clamp(36px, 14vh, 56px); }
  .launchzone.landscape .banner-big { font-size: 16px !important; }
  .spmeter { left: calc(5vw + env(safe-area-inset-left, 0px));
    right: calc(5vw + env(safe-area-inset-right, 0px));
    bottom: calc(3vh + env(safe-area-inset-bottom, 0px)); }
}
`;
