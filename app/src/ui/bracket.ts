// Tournament visualization: a drawn SVG bracket tree (single elimination —
// rounds as columns, connector elbows, winners highlighted, the next match
// pulsing and tappable, champion crowned) or a standings grid (round robin).

import { Tournament, type TourMatch } from "../game/tournament";
import { ZH, fmt } from "../i18n/zh";
import { button, el, overlay } from "./dom";
import type { GameApp } from "./app";
import { runMatch } from "./match";
import type { SlotConfig } from "./setup";

const SVGNS = "http://www.w3.org/2000/svg";

function svgEl(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): SVGElement {
  const n = document.createElementNS(SVGNS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...children);
  return n;
}

const NODE_W = 148;
const NODE_H = 44;
const COL_W = 178;
const ROW_H = 58;

function bracketSvg(
  tour: Tournament,
  nameOf: (i: number | null) => string,
  next: TourMatch | null,
  onTapNext: (() => void) | null,
): HTMLElement {
  const mains = tour.matches.filter((m) => !m.isThirdPlace);
  const rounds = [...new Set(mains.map((m) => m.round))].sort((a, b) => a - b);
  const byRound = rounds.map((r) => mains.filter((m) => m.round === r));
  const n0 = byRound[0]?.length ?? 1;
  const H = Math.max(1, n0) * ROW_H;
  const third = tour.matches.find((m) => m.isThirdPlace) ?? null;
  const W = 12 + rounds.length * COL_W + 80;
  const totalH = H + (third ? NODE_H + 34 : 16);

  const svg = svgEl("svg", {
    class: "brsvg",
    width: String(W),
    height: String(totalH),
    viewBox: `0 0 ${W} ${totalH}`,
  });

  const yOf = (r: number, i: number): number => {
    const nR = byRound[r]!.length;
    return (H / nR) * (i + 0.5) - NODE_H / 2;
  };

  byRound.forEach((ms, r) => {
    ms.forEach((m, i) => {
      const x = 12 + r * COL_W;
      const y = yOf(r, i);
      const isNext = next !== null && m.id === next.id;
      const rect = svgEl("rect", {
        class: `node${m.winner !== null ? " winrect" : ""}${isNext ? " nextm" : ""}`,
        x: String(x),
        y: String(y),
        width: String(NODE_W),
        height: String(NODE_H),
        rx: "8",
      });
      if (isNext && onTapNext) rect.addEventListener("click", onTapNext);
      svg.append(rect);
      const rowCls = (slot: number | null): string =>
        m.winner !== null && m.winner === slot ? "win" : "";
      svg.append(
        svgEl("text", { x: String(x + 8), y: String(y + 17), class: rowCls(m.a) }, nameOf(m.a)),
        svgEl("line", {
          x1: String(x + 4),
          y1: String(y + NODE_H / 2),
          x2: String(x + NODE_W - 4),
          y2: String(y + NODE_H / 2),
          stroke: "#2a356e",
        }),
        svgEl("text", { x: String(x + 8), y: String(y + 37), class: rowCls(m.b) }, nameOf(m.b)),
      );
      // connector elbow to the parent match
      if (r < rounds.length - 1) {
        const py = yOf(r + 1, Math.floor(i / 2)) + NODE_H / 2;
        const cy = y + NODE_H / 2;
        const x0 = x + NODE_W;
        const xm = x + COL_W - 14;
        svg.append(
          svgEl("polyline", { points: `${x0},${cy} ${xm},${cy} ${xm},${py} ${12 + (r + 1) * COL_W},${py}` }),
        );
      }
    });
  });

  // champion tag at the right of the final
  if (rounds.length > 0) {
    const fx = 12 + (rounds.length - 1) * COL_W + NODE_W + 10;
    const fy = yOf(rounds.length - 1, 0) + NODE_H / 2 + 4;
    svg.append(
      svgEl(
        "text",
        { x: String(fx), y: String(fy), class: tour.champion !== null ? "win" : "" },
        tour.champion !== null ? `👑 ${nameOf(tour.champion)}` : "👑 ？",
      ),
    );
  }

  // third-place match under the tree
  if (third) {
    const x = 12 + Math.max(0, rounds.length - 1) * COL_W;
    const y = H + 10;
    svg.append(
      svgEl("rect", { class: `node${third.winner !== null ? " winrect" : ""}`, x: String(x), y: String(y), width: String(NODE_W), height: String(NODE_H), rx: "8" }),
      svgEl("text", { x: String(x + 8), y: String(y + 17), class: third.winner !== null && third.winner === third.a ? "win" : "" }, nameOf(third.a)),
      svgEl("text", { x: String(x + 8), y: String(y + 37), class: third.winner !== null && third.winner === third.b ? "win" : "" }, nameOf(third.b)),
      svgEl("text", { x: String(x - 4), y: String(y - 4) }, "季軍賽"),
    );
  }

  const wrap = el("div", { class: "brwrap" });
  wrap.append(svg);
  // auto-scroll toward the active round
  if (next) {
    requestAnimationFrame(() => {
      wrap.scrollLeft = Math.max(0, next.round * COL_W - 40);
    });
  }
  return wrap;
}

function roundRobinGrid(tour: Tournament, nameOf: (i: number | null) => string): HTMLElement {
  const grid = el("div", { class: "rrgrid" });
  grid.append(
    el("div", { class: "cell hd" }, "選手"),
    el("div", { class: "cell hd" }, "勝"),
    el("div", { class: "cell hd" }, "敗"),
  );
  for (const s of tour.standings()) {
    const losses = tour.matches.filter(
      (m) => m.winner !== null && (m.a === s.slot || m.b === s.slot) && m.winner !== s.slot,
    ).length;
    grid.append(
      el("div", { class: "cell", style: "text-align:left" }, nameOf(s.slot)),
      el("div", { class: "cell win" }, String(s.wins)),
      el("div", { class: "cell" }, String(losses)),
    );
  }
  return grid;
}

export function showBracket(app: GameApp, tour: Tournament, slots: SlotConfig[]): void {
  const o = overlay();
  const panel = el("div", { class: "panel", style: "max-height:86vh; overflow-y:auto; width:min(94vw,470px)" });
  panel.append(el("div", { class: "title", style: "font-size:22px" }, ZH.menu.tournament));

  const nameOf = (i: number | null): string => (i === null ? "—" : tour.slots[i]!.name);
  const next = tour.next();

  const startNext = next
    ? (): void => {
        app.enableGyroByDefault();
        const a = slots[next.a!]!;
        const b = slots[next.b!]!;
        void runMatch(app, [a, b], (winner) => {
          tour.report(next.id, winner === 0 ? next.a! : next.b!);
          showBracket(app, tour, slots);
        }, {}, "錦標賽");
      }
    : null;

  if (tour.format === "roundRobin") {
    panel.append(roundRobinGrid(tour, nameOf));
    if (next) {
      panel.append(
        el("div", { class: "subtitle" }, `下一場：${nameOf(next.a)} vs ${nameOf(next.b)}`),
      );
    }
  } else {
    panel.append(bracketSvg(tour, nameOf, next, startNext));
  }

  if (tour.champion !== null && (tour.format === "roundRobin" || next === null)) {
    panel.append(
      el("div", { class: "banner-big", style: "font-size:24px" }, fmt(ZH.champion, { name: nameOf(tour.champion) })),
    );
    if (tour.third !== null) {
      panel.append(el("div", { class: "subtitle" }, `季軍：${nameOf(tour.third)}`));
    }
    panel.append(button(ZH.back, () => app.showMenu(), "btn primary"));
  } else if (next && startNext) {
    panel.append(
      button(`${ZH.next}：${nameOf(next.a)} vs ${nameOf(next.b)}`, startNext, "btn primary"),
      button(ZH.back, () => app.showMenu()),
    );
  }

  o.append(panel);
  app.setScreen(o);
}
