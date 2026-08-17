import { fileURLToPath } from "node:url";
import {
  createClaudeProvider,
  createCodexProvider,
  createCopilotProvider,
  createCursorProvider,
} from "../factories.js";
import type { ProviderConformanceRegistration } from "./types.js";

function fixtureFile(providerId: ProviderConformanceRegistration["providerId"]): string {
  return fileURLToPath(new URL(`./fixtures/${providerId}-core.synthetic.json`, import.meta.url));
}

function namedFixtureFile(fileName: string): string {
  return fileURLToPath(new URL(`./fixtures/${fileName}`, import.meta.url));
}

/** Enabled Provider factories and the offline evidence required for each one. */
export const ENABLED_PROVIDER_CONFORMANCE: readonly ProviderConformanceRegistration[] = [
  {
    providerId: "claude",
    factory: createClaudeProvider,
    requiredProfiles: ["core"],
    fixtureFiles: [fixtureFile("claude")],
    supportedVersions: [{
      component: "@anthropic-ai/claude-agent-sdk",
      oldestSupported: "0.3.212",
      currentTested: "0.3.212",
      source: "apps/server/package.json and bun.lock",
    }],
  },
  {
    providerId: "codex",
    factory: createCodexProvider,
    requiredProfiles: [
      "core",
      "build",
      "plan",
      "goals",
      "permissions",
      "usage",
      "session-eviction",
      "clean-fork",
      "orchestration",
      "browser-access",
      "thread-control",
      "child-cancellation",
    ],
    fixtureFiles: [
      fixtureFile("codex"),
      namedFixtureFile("codex-core.captured.json"),
      namedFixtureFile("codex-adversarial.synthetic.json"),
    ],
    supportedVersions: [{
      component: "codex-cli",
      oldestSupported: "0.37.0",
      currentTested: "0.130.0",
      source: "packages/providers/src/private/codex/codex-provider.ts and codex-protocol-golden.ndjson",
    }],
  },
  {
    providerId: "copilot",
    factory: createCopilotProvider,
    requiredProfiles: ["core"],
    fixtureFiles: [fixtureFile("copilot")],
    supportedVersions: [{
      component: "@github/copilot",
      oldestSupported: "0.0.403",
      currentTested: "1.0.25",
      source: "apps/server/src/features/providers/adapters/copilot/copilot-cli-resolver.ts and bun.lock",
    }],
  },
  {
    providerId: "cursor",
    factory: createCursorProvider,
    requiredProfiles: ["core"],
    fixtureFiles: [fixtureFile("cursor")],
    supportedVersions: [{
      component: "@agentclientprotocol/sdk",
      oldestSupported: "0.21.0",
      currentTested: "0.21.0",
      source: "apps/server/package.json and bun.lock",
    }],
  },
];
