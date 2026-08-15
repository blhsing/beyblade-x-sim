import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "tw.dev.beybladex.sim",
  appName: "BEYBLADE X 模擬對戰",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
};

export default config;
