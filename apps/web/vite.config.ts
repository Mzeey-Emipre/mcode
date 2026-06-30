import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const analyze = process.env.ANALYZE === "true" || process.env.ANALYZE === "1";

export default defineConfig({
  plugins: [
    // React Compiler auto-memoizes components and hooks at build time, so manual
    // React.memo / useMemo / useCallback become redundant. Runs as a Babel pass
    // inside @vitejs/plugin-react; React 19 ships the runtime it emits against.
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", {}]],
      },
    }),
    tailwindcss(),
    ...(analyze
      ? [(await import("rollup-plugin-visualizer")).visualizer({ open: true, gzipSize: true, filename: "dist/bundle-stats.html" })]
      : []),
  ],
  base: process.env.ELECTRON_BUILD ? "./" : "/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: [
      "shiki",
      "shiki/bundle/full",
      "shiki/core",
      "shiki/engine/javascript",
      "@shikijs/langs/bash",
      "@shikijs/langs/cpp",
      "@shikijs/langs/csharp",
      "@shikijs/langs/css",
      "@shikijs/langs/diff",
      "@shikijs/langs/dockerfile",
      "@shikijs/langs/go",
      "@shikijs/langs/html",
      "@shikijs/langs/java",
      "@shikijs/langs/javascript",
      "@shikijs/langs/json",
      "@shikijs/langs/kotlin",
      "@shikijs/langs/markdown",
      "@shikijs/langs/php",
      "@shikijs/langs/python",
      "@shikijs/langs/rust",
      "@shikijs/langs/shell",
      "@shikijs/langs/sql",
      "@shikijs/langs/swift",
      "@shikijs/langs/toml",
      "@shikijs/langs/typescript",
      "@shikijs/langs/vue",
      "@shikijs/langs/yaml",
      "@shikijs/themes/github-dark",
      "@shikijs/themes/github-light",
      "@xterm/addon-webgl",
    ],
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
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    pool: "threads",
    minWorkers: 1,
    maxWorkers: 4,
    exclude: ["e2e/**", "node_modules/**"],
    env: {
      NODE_ENV: "test",
    },
  },
});
