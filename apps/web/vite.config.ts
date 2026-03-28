import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: process.env.ELECTRON_BUILD ? "./" : "/",
  define: {
    // Provide a default VITE_SERVER_URL so standalone dev:web connects to
    // the server without extra configuration. Override with the env var
    // VITE_SERVER_URL to point at a different server instance or port.
    "import.meta.env.VITE_SERVER_URL": JSON.stringify(
      process.env.VITE_SERVER_URL ?? "ws://localhost:19400",
    ),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    hmr: true,
    watch: {
      ignored: ["**/desktop/**"],
    },
  },
  build: {
    target: "esnext",
    minify: "oxc",
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    pool: "threads",
    exclude: ["e2e/**", "node_modules/**"],
    env: {
      NODE_ENV: "test",
    },
  },
});
