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
.overlay { position: fixed; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px; padding: 18px;
  background: rgba(11,16,32,.86); overflow-y: auto; z-index: 10; }
.overlay.transparent { background: transparent; pointer-events: none; }
.overlay.transparent > * { pointer-events: auto; }
.panel { background: #141b3a; border: 1px solid #35408a; border-radius: 14px;
  padding: 16px; width: min(92vw, 420px); display: flex; flex-direction: column; gap: 10px; }
.title { font-size: 30px; font-weight: 900; letter-spacing: 3px;
  text-shadow: 0 0 18px #3f7bff88; text-align: center; }
.subtitle { opacity: .7; font-size: 13px; text-align: center; }
.btn { font: inherit; font-size: 17px; padding: 12px 20px; border-radius: 10px;
  border: 1px solid #4b5bd7; background: #1a2350; color: #e8ecff; width: 100%; }
.btn:active { background: #2c3a86; }
.btn.primary { background: #2c47c9; border-color: #6b83ff; font-weight: 700; }
.btn.small { width: auto; font-size: 14px; padding: 7px 12px; }
.sel, input[type=text] { font: inherit; font-size: 15px; padding: 9px 10px;
  border-radius: 8px; border: 1px solid #35408a; background: #0e1430; color: #e8ecff;
  width: 100%; }
.row { display: flex; gap: 8px; align-items: center; }
.row > * { flex: 1; }
.row > .fixed { flex: 0 0 auto; }
.label { font-size: 13px; opacity: .75; }
.card { background: #0e1430; border: 1px solid #2a356e; border-radius: 10px; padding: 10px;
  display: flex; flex-direction: column; gap: 8px; }
.scoreboard { display: flex; justify-content: center; gap: 20px; font-size: 22px;
  font-weight: 800; }
.banner-big { font-size: 34px; font-weight: 900; letter-spacing: 2px;
  text-align: center; text-shadow: 0 2px 12px #000; }
.launchzone { position: fixed; left: 0; right: 0; bottom: 0; height: 58vh;
  touch-action: none; z-index: 12; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; padding-bottom: 8vh; }
.spmeter { position: fixed; left: 8vw; right: 8vw; bottom: 4vh; height: 14px;
  border: 1px solid #4b5bd7; border-radius: 7px; overflow: hidden; z-index: 12; }
.spfill { height: 100%; width: 0%; background: linear-gradient(90deg,#3f7bff,#ff5b4d);
  transition: width .06s linear; }
.countdown { font-size: 60px; font-weight: 900; text-shadow: 0 0 24px #3f7bffaa; }
.bracket { display: flex; flex-direction: column; gap: 6px; width: min(92vw, 420px); }
.bracket .m { display: flex; justify-content: space-between; background: #0e1430;
  border: 1px solid #2a356e; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
.bracket .win { color: #7dffa8; font-weight: 700; }
.topbar { position: fixed; top: env(safe-area-inset-top, 0); left: 0; right: 0;
  display: flex; gap: 8px; padding: 8px 10px; z-index: 11; align-items: center; }
.topbar .spacer { flex: 1; }
.chev { animation: chevflow 1.05s ease-in infinite; opacity: 0; }
.c2 { animation-delay: .16s; }
.c3 { animation-delay: .32s; }
@keyframes chevflow {
  0% { opacity: 0; transform: translateY(-8px); }
  30% { opacity: .95; }
  100% { opacity: 0; transform: translateY(16px); }
}
`;
