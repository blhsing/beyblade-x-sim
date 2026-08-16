// Account screens: the sign-in gate (Google Sign-In, password fallback,
// guest play) and profile management. There is no email verification step.

import {
  AuthError,
  changeEmail,
  changePassword,
  fetchAuthConfig,
  getAuth,
  setNickname,
  signInAsGuest,
  signin,
  signinWithGoogle,
  signout,
  signup,
} from "../game/auth";
import { googleDisableAutoSelect, googleOriginSupported, renderGoogleButton } from "../game/google";
import { getPrefs, savePrefs } from "../game/persist";
import { ZH } from "../i18n/zh";
import { button, el, overlay, row } from "./dom";
import type { GameApp } from "./app";

const errText = (e: unknown): string =>
  e instanceof AuthError ? (ZH.auth.errors[e.message] ?? e.message) : String(e);

function field(placeholder: string, type = "text"): HTMLInputElement {
  return el("input", { type, placeholder, autocapitalize: "none" });
}

/** Blocking gate: resolves once the player is signed in (or plays as guest). */
export function showAuthGate(app: GameApp, onDone: () => void): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  const msg = el("div", { class: "subtitle", style: "color:#ff9a90" }, "");
  const emailIn = field(ZH.auth.email, "email");
  const passIn = field(ZH.auth.password, "password");
  const nickIn = field(ZH.auth.nickname);
  const guestNick = field(ZH.auth.nickname);
  guestNick.value = getPrefs().name || "";
  const googleBox = el("div", { style: "display:flex; justify-content:center; min-height:4px" });
  const googleNote = el("div", { class: "label", style: "line-height:1.6" }, "");
  let mode: "signin" | "signup" = "signin";

  const finish = (nickname: string): void => {
    savePrefs({ name: nickname }); // account nickname becomes the player name
    o.remove();
    onDone();
  };

  // Google Sign-In: only where Google permits the origin and a client id is set
  void (async () => {
    const cfg = await fetchAuthConfig();
    if (!cfg.googleClientId) {
      googleNote.textContent = ZH.auth.googleNotConfigured;
      return;
    }
    if (!googleOriginSupported()) {
      googleNote.textContent = ZH.auth.googleUnavailable;
      return;
    }
    const okBtn = await renderGoogleButton(googleBox, cfg.googleClientId, (credential) => {
      msg.textContent = "";
      void signinWithGoogle(credential)
        .then((s) => finish(s.nickname))
        .catch((e) => (msg.textContent = errText(e)));
    });
    googleNote.textContent = okBtn ? ZH.auth.googleHint : ZH.auth.googleUnavailable;
  })();

  const submit = async (): Promise<void> => {
    msg.textContent = "";
    try {
      const s =
        mode === "signin"
          ? await signin(emailIn.value.trim(), passIn.value)
          : await signup(emailIn.value.trim(), nickIn.value.trim(), passIn.value);
      finish(s.nickname);
    } catch (e) {
      msg.textContent = errText(e);
    }
  };

  const pwBlock = el("div", { style: "display:flex; flex-direction:column; gap:8px" });
  const renderPw = (): void => {
    pwBlock.replaceChildren();
    if (mode === "signup") pwBlock.append(nickIn);
    pwBlock.append(
      emailIn,
      passIn,
      button(mode === "signin" ? ZH.auth.signIn : ZH.auth.signUp, () => void submit(), "btn"),
      button(mode === "signin" ? ZH.auth.needAccount : ZH.auth.haveAccount, () => {
        mode = mode === "signin" ? "signup" : "signin";
        msg.textContent = "";
        renderPw();
      }, "btn small"),
    );
  };
  renderPw();

  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.appTitle),
    msg,
    googleBox,
    googleNote,
    el("div", { class: "label", style: "text-align:center; opacity:.55" }, `── ${ZH.auth.orPassword} ──`),
    pwBlock,
    el("div", { class: "label", style: "text-align:center; opacity:.55" }, "──────"),
    guestNick,
    button(ZH.auth.guestPlay, () => {
      const s = signInAsGuest(guestNick.value);
      finish(s.nickname);
    }, "btn small"),
    el("div", { class: "label", style: "line-height:1.6" }, ZH.auth.guestHint),
  );
  o.append(panel);
  app.setScreen(o);
}

export function showProfile(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  const auth = getAuth();
  const msg = el("div", { class: "subtitle" }, "");

  if (auth?.guest) {
    panel.append(
      el("div", { class: "title", style: "font-size:22px" }, ZH.auth.profile),
      el("div", { class: "subtitle" }, `${auth.nickname}（${ZH.auth.guestBadge}）`),
      el("div", { class: "label", style: "line-height:1.7" }, ZH.auth.guestProfile),
      button(ZH.auth.signOut, () => {
        googleDisableAutoSelect();
        void signout().then(() => app.showMenu());
      }, "btn primary"),
      button(ZH.back, () => app.showMenu()),
    );
    o.append(panel);
    app.setScreen(o);
    return;
  }

  const nickIn = field(ZH.auth.nickname);
  nickIn.value = auth?.nickname ?? "";
  const curPass = field(ZH.auth.currentPassword, "password");
  const newPass = field(ZH.auth.newPassword, "password");
  const newMail = field(ZH.auth.newEmail, "email");
  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.auth.profile),
    el("div", { class: "subtitle" }, `${auth?.nickname ?? "?"}｜${auth?.email ?? "?"}`),
    msg,
    el("div", { class: "label" }, ZH.auth.changeNickname),
    row(nickIn, button(ZH.auth.submit, () => {
      void setNickname(nickIn.value.trim())
        .then(() => {
          savePrefs({ name: nickIn.value.trim() });
          msg.textContent = "✓";
        })
        .catch((e) => (msg.textContent = errText(e)));
    }, "btn small fixed")),
    el("div", { class: "label" }, ZH.auth.changeEmail),
    row(newMail, button(ZH.auth.submit, () => {
      void changeEmail(newMail.value.trim())
        .then(() => showProfile(app))
        .catch((e) => (msg.textContent = errText(e)));
    }, "btn small fixed")),
    el("div", { class: "label" }, ZH.auth.changePassword),
    row(curPass, newPass),
    button(ZH.auth.changePassword, () => {
      void changePassword(curPass.value, newPass.value)
        .then(() => (msg.textContent = "✓"))
        .catch((e) => (msg.textContent = errText(e)));
    }, "btn small"),
    button(ZH.auth.signOut, () => {
      googleDisableAutoSelect();
      void signout().then(() => app.showMenu());
    }),
    button(ZH.back, () => app.showMenu()),
  );
  o.append(panel);
  app.setScreen(o);
}
