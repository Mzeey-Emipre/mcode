import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: process.env.ELECTRON_BUILD ? "./" : "/",
  plugins: [react(), tailwindcss()],
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
      "@shikijs/langs/yaml",
      "@shikijs/themes/github-dark",
      "@shikijs/themes/github-light",
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
  },
});
