import { defineConfig } from "vite";
export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { host: "127.0.0.1" },
});
