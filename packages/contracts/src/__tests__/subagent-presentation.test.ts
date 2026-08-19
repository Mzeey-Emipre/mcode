import { describe, expect, it } from "vitest";
import {
  createSubagentPresentation,
  mergeSubagentPresentation,
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
      providerAgentKey: "/root/review_probe",
    });
  });

  it("enriches a terminal row without losing its established child identity", () => {
    const initial = createSubagentPresentation({ receiverThreadIds: ["child-1"] }, "call-1");
    const late = createSubagentPresentation({ agentName: "Hubble", model: "gpt-5.6-luna" }, "call-1");

    expect(mergeSubagentPresentation(initial, late, "call-1")).toEqual({
      displayName: "Hubble",
      hasExplicitIdentity: true,
      identityKey: "child-1",
      providerAgentKey: undefined,
      model: "gpt-5.6-luna",
      reasoningEffort: undefined,
    });
  });
});
