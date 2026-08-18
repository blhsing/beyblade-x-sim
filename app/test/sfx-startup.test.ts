import { describe, expect, it } from "vitest";
import { installAudioStartup, isAudioUnlocked } from "../src/audio/sfx";

describe("audio startup", () => {
  it("autostarts safely when a cached module evaluates after DOMContentLoaded", () => {
    const documentTarget = new EventTarget();
    Object.defineProperty(documentTarget, "readyState", { value: "complete" });
    const windowTarget = new EventTarget();
    let unlockCalls = 0;
    let announcements = 0;
    windowTarget.addEventListener("beyblade:audio", () => announcements++);

    const cleanup = installAudioStartup(
      documentTarget as unknown as Document,
      windowTarget as unknown as Window,
      {
        unlock: () => unlockCalls++,
        contextRunning: true,
      },
    );

    expect(unlockCalls).toBe(1);
    expect(isAudioUnlocked()).toBe(true);
    expect(announcements).toBe(1);
    cleanup();
  });
});
