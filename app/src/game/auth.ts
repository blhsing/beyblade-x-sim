// Client-side accounts: session token storage + /game/auth API wrapper.
// Every player signs up (email + nickname + password, email verified by
// code) or signs in; the token authorizes DB writes and identifies the
// player online. Works against whichever tier served the app.

export interface AuthState {
  token: string;
  email: string;
  nickname: string;
}

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
    return s.token ? s : null;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return getAuth()?.token ?? null;
}

function saveAuth(s: AuthState | null): void {
  if (s) localStorage.setItem("beyblade.auth", JSON.stringify(s));
  else localStorage.removeItem("beyblade.auth");
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

export const signup = (email: string, nickname: string, password: string) =>
  post("signup", { email, nickname, password });
export const verify = (email: string, code: string) => post("verify", { email, code });

export async function signin(email: string, password: string): Promise<AuthState> {
  const r = await post("signin", { email, password });
  const s: AuthState = { token: r.token!, email: r.email!, nickname: r.nickname! };
  saveAuth(s);
  return s;
}

export async function signout(): Promise<void> {
  try {
    await post("signout", {}, true);
  } catch {
    /* best-effort */
  }
  saveAuth(null);
}

/** Validate the stored session against the server (offline keeps it). */
export async function refreshMe(): Promise<AuthState | null> {
  const cur = getAuth();
  if (!cur) return null;
  try {
    const r = await post("me", {}, true);
    const s: AuthState = { token: cur.token, email: r.email!, nickname: r.nickname! };
    saveAuth(s);
    return s;
  } catch (e) {
    if (e instanceof AuthError && e.message === "offline") return cur;
    saveAuth(null);
    return null;
  }
}

export const changePassword = (current: string, newPassword: string) =>
  post("change-password", { current, newPassword }, true);
export const changeEmail = (newEmail: string) => post("change-email", { newEmail }, true);
export async function confirmEmail(code: string): Promise<void> {
  const r = await post("confirm-email", { code }, true);
  const cur = getAuth();
  if (cur && r.email) saveAuth({ ...cur, email: r.email });
}
