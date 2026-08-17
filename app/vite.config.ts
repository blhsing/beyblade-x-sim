import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  test: {
    fileParallelism: false,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: true,
    // online play in dev goes same-origin through vite to the local relay
    proxy: {
      "/game": {
        target: "http://127.0.0.1:8080",
        ws: true,
      },
    },
  },
});
