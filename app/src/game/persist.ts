// Client persistence: profiles (W/L), match records, and saved custom tops
// are kept in localStorage AND mirrored to the tier DB (/game/db/*, LWW by
// updatedAt). Both tiers sync with each other server-side, so records made
// against either URL converge. Fully offline-tolerant: failed pushes queue
// and retry on next boot.

import { getToken, isGuest } from "./auth";

export interface ReplayBattle {
  seed: number;
  launches: [unknown, unknown]; // LaunchParams pair (kept loose to avoid cycles)
  deckA: unknown; // ComboSelection
  deckB: unknown;
}

export interface ReplayData {
  rules: unknown; // full RuleSet snapshot
  stadiumKey: string;
  battles: ReplayBattle[];
}

export interface MatchRecord {
  /** doc id in the matches collection — share links reference this */
  id?: string;
  ts: number;
  mode: string;
  players: { name: string; kind: "human" | "bot" }[];
  scores: [number, number];
  winner: string;
  rules: string;
  stadium: string;
  finishes: string[];
  /** deterministic replay data (seed + launches per battle) */
  replay?: ReplayData;
}

export interface Profile {
  name: string;
  wins: number;
  losses: number;
  updatedAt: number;
}

const b64url = (s: string): string =>
  btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function apiBase(): string {
  const loc = window.location;
  if (loc.port === "5173") return "http://localhost:8080/game/db";
  let base = loc.pathname;
  if (!base.endsWith("/")) base = base.slice(0, base.lastIndexOf("/") + 1);
  return `${loc.origin}${base}game/db`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}
const writeJson = (key: string, v: unknown): void =>
  localStorage.setItem(key, JSON.stringify(v));

export function playerId(): string {
  let id = localStorage.getItem("beyblade.playerId");
  if (!id) {
    id = "p" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("beyblade.playerId", id);
  }
  return id;
}

interface Pending {
  col: string;
  id: string;
  updatedAt: number;
  data: unknown;
}

async function tryPut(p: Pending): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const tok = getToken();
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`${apiBase()}/${p.col}/${p.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ updatedAt: p.updatedAt, data: p.data }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function push(col: string, id: string, data: unknown): void {
  if (isGuest()) return; // guest play leaves nothing on the server
  const p: Pending = { col, id, updatedAt: Date.now(), data };
  void tryPut(p).then((ok) => {
    if (!ok) {
      const q = readJson<Pending[]>("beyblade.pendingPush", []);
      q.push(p);
      writeJson("beyblade.pendingPush", q.slice(-100));
    }
  });
}

export async function flushPending(): Promise<void> {
  if (isGuest()) return;
  const q = readJson<Pending[]>("beyblade.pendingPush", []);
  if (q.length === 0) return;
  const left: Pending[] = [];
  for (const p of q) {
    if (!(await tryPut(p))) left.push(p);
  }
  writeJson("beyblade.pendingPush", left);
}

/** Pull server changes and merge into the local caches (LWW). */
export async function pull(): Promise<void> {
  try {
    const since = Number(localStorage.getItem("beyblade.dbCursor") ?? 0);
    const res = await fetch(`${apiBase()}/changes?since=${since}`);
    if (!res.ok) return;
    const out = (await res.json()) as {
      docs: { col: string; id: string; updatedAt: number; data: unknown }[];
      now: number;
    };
    const profiles = readJson<Record<string, Profile>>("beyblade.profiles", {});
    const matches = readJson<MatchRecord[]>("beyblade.matches", []);
    const combos = readJson<{ name: string; combo: unknown; updatedAt?: number }[]>(
      "beyblade.customCombos",
      [],
    );
    const matchIds = new Set(matches.map((m) => m.ts + m.winner));
    for (const d of out.docs) {
      if (d.col === "profiles") {
        const p = d.data as Profile;
        const cur = profiles[p.name];
        if (!cur || d.updatedAt > (cur.updatedAt ?? 0)) profiles[p.name] = { ...p, updatedAt: d.updatedAt };
      } else if (d.col === "matches") {
        const m = d.data as MatchRecord;
        if (!matchIds.has(m.ts + m.winner)) {
          matches.push(m);
          matchIds.add(m.ts + m.winner);
        }
      } else if (d.col === "combos") {
        const c = d.data as { name: string; combo: unknown };
        const idx = combos.findIndex((x) => x.name === c.name);
        if (idx < 0) combos.push({ ...c, updatedAt: d.updatedAt });
        else if (d.updatedAt > (combos[idx]!.updatedAt ?? 0)) combos[idx] = { ...c, updatedAt: d.updatedAt };
      } else if (d.col === "prefs" && d.id === playerId()) {
        mergePrefsDoc(d.updatedAt, d.data);
      }
    }
    matches.sort((a, b) => b.ts - a.ts);
    writeJson("beyblade.profiles", profiles);
    writeJson("beyblade.matches", matches.slice(0, 200));
    writeJson("beyblade.customCombos", combos);
    localStorage.setItem("beyblade.dbCursor", String(out.now));
  } catch {
    /* offline — local caches remain authoritative */
  }
}

export function recordMatch(rec: MatchRecord): string {
  const id = `${playerId()}.${rec.ts.toString(36)}`;
  rec.id = id;
  const matches = readJson<MatchRecord[]>("beyblade.matches", []);
  matches.unshift(rec);
  writeJson("beyblade.matches", matches.slice(0, 200));
  push("matches", id, rec);
  return id;
}

/** Fetch one shared match record by doc id (works unauthenticated). */
export async function fetchMatchDoc(id: string): Promise<MatchRecord | null> {
  try {
    const res = await fetch(`${apiBase()}/matches`);
    if (!res.ok) return null;
    const out = (await res.json()) as { docs: { id: string; data: MatchRecord }[] };
    const local = localMatches().find((m) => m.id === id);
    return out.docs.find((d) => d.id === id)?.data ?? local ?? null;
  } catch {
    return localMatches().find((m) => m.id === id) ?? null;
  }
}

// ---- launch-tendency history (feeds adaptive bot strategies) --------------

export function recordLaunch(sp: number, aimDeg: number): void {
  const h = readJson<{ sp: number; aim: number }[]>("beyblade.launchHistory", []);
  h.push({ sp, aim: aimDeg });
  writeJson("beyblade.launchHistory", h.slice(-30));
}

export function launchStats(): { avgSp: number; n: number } | null {
  const h = readJson<{ sp: number; aim: number }[]>("beyblade.launchHistory", []);
  if (h.length < 3) return null;
  return { avgSp: h.reduce((a, x) => a + x.sp, 0) / h.length, n: h.length };
}

export function bumpProfile(name: string, won: boolean): void {
  const profiles = readJson<Record<string, Profile>>("beyblade.profiles", {});
  const p = profiles[name] ?? { name, wins: 0, losses: 0, updatedAt: 0 };
  if (won) p.wins++;
  else p.losses++;
  p.updatedAt = Date.now();
  profiles[name] = p;
  writeJson("beyblade.profiles", profiles);
  push("profiles", b64url(name), p);
}

export function pushCombo(name: string, combo: unknown): void {
  push("combos", `${playerId()}.${b64url(name)}`, { name, combo });
}

export const localProfiles = (): Record<string, Profile> =>
  readJson("beyblade.profiles", {});
export const localMatches = (): MatchRecord[] => readJson("beyblade.matches", []);

// ---- player preferences (persist across sessions + devices) ---------------

export interface Prefs {
  name: string;
  launcher: "winder" | "string" | "hold";
  rulesPreset: string;
  pointsToWin: number;
  stadium: string;
  musicOn: boolean;
  /** last quick-match setup (both slots), restored on reopen */
  quickSlots?: unknown[];
  /** the bey/deck this player brings to online rooms */
  onlineSlot?: unknown;
  /** last tournament setup (count, format, slots), restored on reopen */
  tourSetup?: { count: number; format: string; slots: unknown[] };
  updatedAt: number;
}

const DEFAULT_PREFS: Prefs = {
  name: "玩家 1",
  launcher: "string",
  rulesPreset: "official",
  pointsToWin: 4,
  stadium: "bx10",
  musicOn: true,
  updatedAt: 0,
};

export function getPrefs(): Prefs {
  return { ...DEFAULT_PREFS, ...readJson<Partial<Prefs>>("beyblade.prefs", {}) };
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...getPrefs(), ...patch, updatedAt: Date.now() };
  writeJson("beyblade.prefs", next);
  push("prefs", playerId(), next);
  return next;
}

/** Merge a prefs doc arriving from the server (called from pull()). */
export function mergePrefsDoc(updatedAt: number, data: unknown): void {
  const local = getPrefs();
  if (updatedAt > local.updatedAt) {
    writeJson("beyblade.prefs", { ...local, ...(data as Partial<Prefs>), updatedAt });
    const p = data as Partial<Prefs>;
    if (p.musicOn !== undefined) {
      localStorage.setItem("beyblade.music", p.musicOn ? "1" : "0");
    }
  }
}
