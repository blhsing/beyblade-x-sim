// Account screens: sign-in / sign-up / email verification gate, and the
// profile-management screen (change password / change email, sign out).

import {
  AuthError,
  changeEmail,
  changePassword,
  confirmEmail,
  getAuth,
  signin,
  signout,
  signup,
  verify,
} from "../game/auth";
import { savePrefs } from "../game/persist";
import { ZH } from "../i18n/zh";
import { button, el, overlay, row } from "./dom";
import type { GameApp } from "./app";

const errText = (e: unknown): string =>
  e instanceof AuthError ? (ZH.auth.errors[e.message] ?? e.message) : String(e);

function field(placeholder: string, type = "text"): HTMLInputElement {
  return el("input", { type, placeholder, autocapitalize: "none" });
}

/** Blocking gate: resolves once the player is signed in. */
export function showAuthGate(app: GameApp, onDone: () => void): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  const msg = el("div", { class: "subtitle", style: "color:#ff9a90" }, "");
  const emailIn = field(ZH.auth.email, "email");
  const passIn = field(ZH.auth.password, "password");
  const nickIn = field(ZH.auth.nickname);
  const codeIn = field(ZH.auth.verifyCode);
  let mode: "signin" | "signup" | "verify" = "signin";
  let pendingEmail = "";

  const render = (): void => {
    panel.replaceChildren(
      el("div", { class: "title", style: "font-size:22px" },
        mode === "signin" ? ZH.auth.signIn : mode === "signup" ? ZH.auth.signUp : ZH.auth.verifyCode),
      msg,
    );
    if (mode === "verify") {
      panel.append(
        el("div", { class: "subtitle" }, `${ZH.auth.verifyHint}（${pendingEmail}）`),
        codeIn,
        button(ZH.auth.submit, () => void doVerify(), "btn primary"),
      );
      return;
    }
    if (mode === "signup") panel.append(nickIn);
    panel.append(
      emailIn,
      passIn,
      button(mode === "signin" ? ZH.auth.signIn : ZH.auth.signUp, () => void submit(), "btn primary"),
      button(mode === "signin" ? ZH.auth.needAccount : ZH.auth.haveAccount, () => {
        mode = mode === "signin" ? "signup" : "signin";
        msg.textContent = "";
        render();
      }, "btn small"),
    );
  };

  const finishSignin = async (): Promise<void> => {
    const s = await signin(emailIn.value.trim(), passIn.value);
    savePrefs({ name: s.nickname }); // account nickname becomes the player name
    o.remove();
    onDone();
  };

  const submit = async (): Promise<void> => {
    msg.textContent = "";
    try {
      if (mode === "signin") {
        await finishSignin();
        return;
      }
      const r = await signup(emailIn.value.trim(), nickIn.value.trim(), passIn.value);
      pendingEmail = emailIn.value.trim();
      mode = "verify";
      msg.textContent = r.devCode ? `${ZH.auth.devCodeHint}${r.devCode}` : "";
      render();
    } catch (e) {
      msg.textContent = errText(e);
    }
  };

  const doVerify = async (): Promise<void> => {
    try {
      await verify(pendingEmail, codeIn.value.trim());
      await finishSignin();
    } catch (e) {
      msg.textContent = errText(e);
    }
  };

  render();
  o.append(panel);
  app.setScreen(o);
}

export function showProfile(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  const auth = getAuth();
  const msg = el("div", { class: "subtitle" }, "");
  const curPass = field(ZH.auth.currentPassword, "password");
  const newPass = field(ZH.auth.newPassword, "password");
  const newMail = field(ZH.auth.newEmail, "email");
  const mailCode = field(ZH.auth.verifyCode);
  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.auth.profile),
    el("div", { class: "subtitle" }, `${auth?.nickname ?? "?"}｜${auth?.email ?? "?"}`),
    msg,
    el("div", { class: "label" }, ZH.auth.changePassword),
    row(curPass, newPass),
    button(ZH.auth.changePassword, () => {
      void changePassword(curPass.value, newPass.value)
        .then(() => (msg.textContent = "✓"))
        .catch((e) => (msg.textContent = errText(e)));
    }, "btn small"),
    el("div", { class: "label" }, ZH.auth.changeEmail),
    row(newMail, button(ZH.auth.submit, () => {
      void changeEmail(newMail.value.trim())
        .then((r) => (msg.textContent = r.devCode ? `${ZH.auth.devCodeHint}${r.devCode}` : ZH.auth.verifyHint))
        .catch((e) => (msg.textContent = errText(e)));
    }, "btn small fixed")),
    row(mailCode, button(ZH.auth.verifyCode, () => {
      void confirmEmail(mailCode.value.trim())
        .then(() => showProfile(app))
        .catch((e) => (msg.textContent = errText(e)));
    }, "btn small fixed")),
    button(ZH.auth.signOut, () => {
      void signout().then(() => app.showMenu());
    }),
    button(ZH.back, () => app.showMenu()),
  );
  o.append(panel);
  app.setScreen(o);
}
