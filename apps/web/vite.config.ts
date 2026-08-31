import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const analyze = process.env.ANALYZE === "true" || process.env.ANALYZE === "1";
const performanceMode = process.env.VITE_MCODE_PERFORMANCE_MODE;
const runtimeContractEndpoint = "/__mcode_runtime/ports.json";

function mcodeRuntimeContractPlugin(): Plugin {
  const registerMiddleware = (middlewares: {
    use(handler: (req: { url?: string }, res: {
      statusCode: number;
      setHeader(name: string, value: string): void;
      end(body: string): void;
    }, next: () => void) => void): void;
  }) => {
    middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== runtimeContractEndpoint) {
        next();
        return;
      }
      const singleInstance = process.env.VITE_MCODE_SINGLE_INSTANCE;
      const contractPath = process.env.VITE_MCODE_RUNTIME_CONTRACT;
      if (!(singleInstance === "true" || singleInstance === "1") || !contractPath) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      try {
        const contract = NodeFS.readFileSync(contractPath, "utf8");
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(contract);
      } catch {
        res.statusCode = 503;
        res.end("Runtime contract unavailable");
      }
    });
  };

  return {
    name: "mcode-runtime-contract",
    configureServer(server) {
      registerMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      registerMiddleware(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [
    mcodeRuntimeContractPlugin(),
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
    alias: [
      ...(performanceMode === "profiling"
        ? [{ find: "react-dom/client", replacement: "react-dom/profiling" }]
        : []),
      { find: "@", replacement: NodePath.resolve(__dirname, "./src") },
    ],
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
      ignored: ["**/desktop/**", "**/.dev/**"],
    },
  },
  build: {
    target: "esnext",
    minify: "oxc",
    sourcemap: false,
    manifest: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    pool: "threads",
    minWorkers: 1,
    maxWorkers: 4,
    exclude: ["e2e/**", "node_modules/**", "../../.dev/**"],
    env: {
      NODE_ENV: "test",
    },
  },
});
