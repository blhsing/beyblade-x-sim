// Google Sign-In via Google Identity Services.
//
// Google only accepts registered HTTPS origins (plus localhost) as OAuth
// JavaScript origins, so this is unavailable on plain-HTTP/bare-IP hosting;
// callers hide the button there and fall back to password or guest sign-in.

interface GsiCredentialResponse {
  credential: string;
}

interface GsiId {
  initialize(o: {
    client_id: string;
    callback: (r: GsiCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }): void;
  renderButton(parent: HTMLElement, o: Record<string, unknown>): void;
  prompt(): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GsiId } };
  }
}

let scriptPromise: Promise<boolean> | null = null;

/** True when this origin can host Google Sign-In at all. */
export function googleOriginSupported(): boolean {
  const loc = window.location;
  return (
    loc.protocol === "https:" || loc.hostname === "localhost" || loc.hostname === "127.0.0.1"
  );
}

function loadGis(): Promise<boolean> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve) => {
    if (window.google?.accounts?.id) {
      resolve(true);
      return;
    }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(Boolean(window.google?.accounts?.id));
    s.onerror = () => resolve(false);
    document.head.append(s);
  });
  return scriptPromise;
}

/** Renders the official button; resolves false if GIS is unavailable. */
export async function renderGoogleButton(
  container: HTMLElement,
  clientId: string,
  onCredential: (credential: string) => void,
): Promise<boolean> {
  if (!googleOriginSupported()) return false;
  if (!(await loadGis())) return false;
  const id = window.google!.accounts.id;
  try {
    id.initialize({
      client_id: clientId,
      callback: (r) => onCredential(r.credential),
      cancel_on_tap_outside: true,
    });
    id.renderButton(container, {
      theme: "filled_blue",
      size: "large",
      shape: "pill",
      text: "continue_with",
      locale: "zh_TW",
      width: 280,
    });
    return true;
  } catch {
    return false;
  }
}

export function googleDisableAutoSelect(): void {
  try {
    window.google?.accounts.id.disableAutoSelect();
  } catch {
    /* GIS not loaded */
  }
}
