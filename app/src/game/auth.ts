// Client-side accounts: Google Sign-In (primary), an email+password
// fallback with NO email verification, and guest play. The session token
// authorizes DB writes and identifies the player online. Works against
// whichever tier served the app.

export interface AuthState {
  token: string;
  email: string;
  nickname: string;
  /** guest: nickname only, no account, nothing persisted server-side */
  guest?: boolean;
}

const GUEST_KEY = "beyblade.guest";

function apiAuthBase(): string {
  const loc = window.location;
  if (loc.port === "5173") return "http://localhost:8080/game/auth";
  let base = loc.pathname;
  if (!base.endsWith("/")) base = base.slice(0, base.lastIndexOf("/") + 1);
  return `${loc.origin}${base}game/auth`;
}

export function getAuth(): AuthState | null {
  try {
    const s = JSON.parse(localStorage.getItem("beyblade.auth") ?? "") as AuthState;
    if (s.token) return s;
  } catch {
    /* not signed in with an account — fall through to guest */
  }
  try {
    const g = JSON.parse(sessionStorage.getItem(GUEST_KEY) ?? "") as AuthState;
    return g.nickname ? { ...g, guest: true } : null;
  } catch {
    return null;
  }
}

export function isGuest(): boolean {
  return getAuth()?.guest === true;
}

/** Guests have no session token, so they never write to the server. */
export function getToken(): string | null {
  const a = getAuth();
  return a && !a.guest && a.token ? a.token : null;
}

/**
 * Play immediately with just a nickname. Kept in sessionStorage, so it
 * lasts the current app session and leaves no account behind.
 */
export function signInAsGuest(nickname: string): AuthState {
  const s: AuthState = {
    token: "",
    email: "",
    nickname: nickname.trim() || "訪客",
    guest: true,
  };
  sessionStorage.setItem(GUEST_KEY, JSON.stringify(s));
  return s;
}

function saveAuth(s: AuthState | null): void {
  if (s) localStorage.setItem("beyblade.auth", JSON.stringify(s));
  else localStorage.removeItem("beyblade.auth");
  if (!s) sessionStorage.removeItem(GUEST_KEY);
}

export class AuthError extends Error {}

async function post(op: string, body: unknown, withToken = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withToken) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  let res: Response;
  try {
    res = await fetch(`${apiAuthBase()}/${op}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new AuthError("offline");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) throw new AuthError(data.error ?? `http-${res.status}`);
  return data;
}

/** Server-side auth config (Google client id), cached per session. */
let configCache: { googleClientId: string } | null = null;
export async function fetchAuthConfig(): Promise<{ googleClientId: string }> {
  if (configCache) return configCache;
  try {
    const res = await fetch(`${apiAuthBase()}/config`);
    configCache = res.ok ? ((await res.json()) as { googleClientId: string }) : { googleClientId: "" };
  } catch {
    configCache = { googleClientId: "" };
  }
  return configCache;
}

function adopt(r: Record<string, string>): AuthState {
  const s: AuthState = { token: r.token!, email: r.email ?? "", nickname: r.nickname ?? "" };
  saveAuth(s);
  return s;
}

/** Exchange a Google ID token for a game session. */
export async function signinWithGoogle(credential: string): Promise<AuthState> {
  return adopt(await post("google", { credential }));
}

/** Password sign-up — no verification step; signs in immediately. */
export async function signup(email: string, nickname: string, password: string): Promise<AuthState> {
  return adopt(await post("signup", { email, nickname, password }));
}

export async function signin(email: string, password: string): Promise<AuthState> {
  return adopt(await post("signin", { email, password }));
}

export async function signout(): Promise<void> {
  if (!isGuest()) {
    try {
      await post("signout", {}, true);
    } catch {
      /* best-effort */
    }
  }
  saveAuth(null); // clears both the account session and any guest identity
}

/**
 * Refresh the stored session (also slides its server-side expiry). The game
 * remembers the player until an EXPLICIT sign-out: errors — offline, server
 * hiccups, even a lost server session — never clear the stored identity.
 */
export async function refreshMe(): Promise<AuthState | null> {
  const cur = getAuth();
  if (!cur || cur.guest) return cur; // guests have no server session to refresh
  try {
    const r = await post("me", {}, true);
    const s: AuthState = { token: cur.token, email: r.email!, nickname: r.nickname! };
    saveAuth(s);
    return s;
  } catch {
    return cur; // keep the player signed in; only 登出 clears
  }
}

export async function setNickname(nickname: string): Promise<void> {
  const r = await post("nickname", { nickname }, true);
  const cur = getAuth();
  if (cur && r.nickname) saveAuth({ ...cur, nickname: r.nickname });
}

export const changePassword = (current: string, newPassword: string) =>
  post("change-password", { current, newPassword }, true);

export async function changeEmail(newEmail: string): Promise<void> {
  const r = await post("change-email", { newEmail }, true);
  const cur = getAuth();
  if (cur && r.email) saveAuth({ ...cur, email: r.email });
}
