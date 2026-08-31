import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noGlobalHostRuntime } from "../rules/no-global-host-runtime.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

ruleTester.run("no-global-host-runtime", noGlobalHostRuntime, {
  valid: [
    {
      name: "allowed process properties in production code",
      filename: "packages/providers/src/runtime/child-process.ts",
      code: 'const env = process.env; const argv = process.argv; const cwd = process.cwd(); process.kill(process.pid); process.stdout.write("ready");',
    },
    {
      name: "writes do not read host-runtime facts",
      filename: "packages/providers/src/runtime/platform.ts",
      code: 'process.platform = "win32";',
    },
    {
      name: "the host-runtime boundary",
      filename: "packages/shared/src/node/host-runtime.ts",
      code: "export const platform = process.platform;",
    },
    {
      name: "POSIX scripts directory",
      filename: "scripts/release/publish.ts",
      code: "const platform = process.platform;",
    },
    {
      name: "Windows scripts directory",
      filename: "scripts\\release\\publish.ts",
      code: "const platform = process.platform;",
    },
    {
      name: "root config file",
      filename: "vite.config.ts",
      code: "const platform = process.platform;",
    },
    {
      name: "package config file",
      filename: "packages/providers/vite.config.ts",
      code: "const platform = process.platform;",
    },
    {
      name: "test fixture",
      filename: "apps/server/src/__tests__/fixtures/host-runtime.ts",
      code: "const platform = process.platform;",
    },
    {
      name: "generated output",
      filename: "apps/web/src/generated/client.ts",
      code: "const platform = process.platform;",
    },
    {
      name: "locally shadowed process",
      filename: "packages/providers/src/runtime/platform.ts",
      code: "function select(process: { platform: string; arch: string }) { return process.platform + process.arch; }",
    },
  ],
  invalid: [
    {
      name: "production reads process.platform",
      filename: "packages/providers/src/runtime/platform.ts",
      code: "const platform = process.platform;",
      errors: [
        {
          message: "Read host-runtime facts through @mcode/shared/node/host-runtime at composition boundaries or pass explicit injected facts.",
        },
      ],
    },
    {
      name: "production reads process.arch",
      filename: "packages/providers/src/runtime/architecture.ts",
      code: "const architecture = process.arch;",
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production reads computed platform",
      filename: "packages/providers/src/runtime/platform.ts",
      code: 'const platform = process["platform"];',
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production reads computed architecture",
      filename: "packages/providers/src/runtime/architecture.ts",
      code: 'const architecture = process["arch"];',
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production destructures platform and architecture",
      filename: "packages/providers/src/runtime/host.ts",
      code: "const { platform, arch: architecture } = process;",
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production reads globalThis process platform",
      filename: "packages/providers/src/runtime/platform.ts",
      code: "const platform = globalThis.process.platform;",
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production reads computed globalThis process architecture",
      filename: "packages/providers/src/runtime/architecture.ts",
      code: 'const architecture = globalThis["process"]["arch"];',
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production reads process ABI",
      filename: "packages/providers/src/runtime/abi.ts",
      code: "const abi = process.versions.modules;",
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production reads computed process ABI",
      filename: "packages/providers/src/runtime/abi.ts",
      code: 'const abi = process["versions"]["modules"];',
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production destructures process ABI",
      filename: "packages/providers/src/runtime/abi.ts",
      code: "const { modules } = process.versions;",
      errors: [{ messageId: "hostRuntime" }],
    },
    {
      name: "production destructures nested globalThis process ABI",
      filename: "packages/providers/src/runtime/abi.ts",
      code: "const { versions: { modules } } = globalThis.process;",
      errors: [{ messageId: "hostRuntime" }],
    },
  ],
});
