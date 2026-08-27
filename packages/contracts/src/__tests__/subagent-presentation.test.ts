import { describe, expect, it } from "vitest";
import {
  createSubagentPresentation,
  mergeSubagentPresentation,
  resolveSubagentExactIdentity,
} from "../models/tool-call-record.js";

describe("sub-agent presentation", () => {
  it("normalizes provider identity and keeps task text out of the model", () => {
    expect(createSubagentPresentation({
      agentName: "direct_detail_worker",
      prompt: "Do not expose this task",
      receiverThreadIds: ["child-1"],
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    }, "call-1")).toEqual({
      displayName: "Direct detail worker",
      hasExplicitIdentity: true,
      identityKey: "child-1",
      detail: { kind: "canonical-child" },
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
  });

  it("uses an explicit Codex task path when no receiver thread is available", () => {
    expect(createSubagentPresentation({
      codexCollabKind: "spawnAgent",
      agentPath: "/root/review_probe",
    }, "call-1")).toEqual({
      displayName: "Review probe",
      hasExplicitIdentity: true,
      identityKey: "/root/review_probe",
      detail: { kind: "transcript-unavailable" },
      providerAgentKey: "/root/review_probe",
    });
  });

  it("resolves only bounded structural receiver/native identities", () => {
    expect(resolveSubagentExactIdentity({
      codexCollabKind: "spawnAgent",
      agentPath: "/root/review_probe",
    })).toBeUndefined();
    expect(resolveSubagentExactIdentity({ receiverThreadIds: ["receiver-1"] })).toBe("receiver-1");
    expect(resolveSubagentExactIdentity({ nativeThreadId: "native-1" })).toBe("native-1");
    expect(resolveSubagentExactIdentity({ nativeThreadId: "x".repeat(513) })).toBeUndefined();
  });

  it("keeps a provider identity as metadata when no canonical child exists", () => {
    expect(createSubagentPresentation({
      subagentProviderName: "Cursor",
      agentId: "cursor-agent-1",
    }, "call-1")).toMatchObject({
      identityKey: "call-1",
      detail: {
        kind: "transcript-unavailable",
        providerName: "Cursor",
      },
    });
  });

  it("enriches a terminal row without losing its established child identity", () => {
    const initial = createSubagentPresentation({ receiverThreadIds: ["child-1"] }, "call-1");
    const late = createSubagentPresentation({ agentName: "Hubble", model: "gpt-5.6-luna" }, "call-1");

    expect(mergeSubagentPresentation(initial, late, "call-1")).toEqual({
      displayName: "Hubble",
      hasExplicitIdentity: true,
      identityKey: "child-1",
      detail: { kind: "canonical-child" },
      providerAgentKey: undefined,
      model: "gpt-5.6-luna",
      reasoningEffort: undefined,
    });
  });
});
