import { describe, expect, it } from "vitest";
import {
  createSubagentPresentation,
  createCanonicalSubagentPresentation,
  decodeCanonicalSubagentDetailTarget,
  decodeSubagentAliasDetailTarget,
  encodeCanonicalSubagentDetailTarget,
  encodeSubagentAliasDetailTarget,
  mergeSubagentPresentation,
  resolveSubagentExactIdentity,
} from "../models/tool-call-record.js";

describe("sub-agent presentation", () => {
  it("normalizes provider identity and carries the bounded parent task separately", () => {
    expect(createSubagentPresentation({
      agentName: "direct_detail_worker",
      prompt: "Do not expose this task",
      receiverThreadIds: ["child-1"],
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    }, "call-1")).toEqual({
      displayName: "Direct detail worker",
      task: "Do not expose this task",
      hasExplicitIdentity: true,
      identityKey: "child-1",
      detail: { kind: "canonical-alias", identityKey: "child-1" },
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
  });

  it("uses a server-provided child thread ID as the canonical detail target", () => {
    expect(createCanonicalSubagentPresentation({
      receiverThreadIds: ["native-child"],
      agentPath: "/root/worker",
    }, "call-1", "thread:codex-child:generated")).toMatchObject({
      identityKey: "native-child",
      detail: { kind: "canonical-child", threadId: "thread:codex-child:generated" },
    });
  });

  it("distinguishes new canonical storage from legacy native aliases", () => {
    const childThreadId = "thread:codex-child:generated";
    const nativeIdentity = "mcode:subagent:v1:provider-native";

    expect(decodeCanonicalSubagentDetailTarget(encodeCanonicalSubagentDetailTarget(childThreadId)))
      .toBe(childThreadId);
    expect(decodeCanonicalSubagentDetailTarget(encodeSubagentAliasDetailTarget(nativeIdentity)))
      .toBeUndefined();
    expect(decodeSubagentAliasDetailTarget(encodeSubagentAliasDetailTarget(nativeIdentity)))
      .toBe(nativeIdentity);
    expect(decodeCanonicalSubagentDetailTarget(nativeIdentity)).toBeUndefined();
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
    const initial = createCanonicalSubagentPresentation({ receiverThreadIds: ["child-1"] }, "call-1", "canonical-child-1");
    const late = createSubagentPresentation({ agentName: "Hubble", model: "gpt-5.6-luna" }, "call-1");

    expect(mergeSubagentPresentation(initial, late, "call-1")).toEqual({
      displayName: "Hubble",
      task: undefined,
      hasExplicitIdentity: true,
      identityKey: "child-1",
      detail: { kind: "canonical-child", threadId: "canonical-child-1" },
      providerAgentKey: undefined,
      model: "gpt-5.6-luna",
      reasoningEffort: undefined,
    });
  });
});
