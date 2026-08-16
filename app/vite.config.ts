import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
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
