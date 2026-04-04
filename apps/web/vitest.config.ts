import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    pool: "threads",
    exclude: ["e2e/**", "node_modules/**", "src/__tests__/composer-resize.test.ts"],
    env: {
      NODE_ENV: "test",
    },
  },
});
