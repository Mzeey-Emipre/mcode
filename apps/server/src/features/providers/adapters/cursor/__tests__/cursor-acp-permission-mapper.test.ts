import { describe, expect, it } from "vitest";
import {
  mapDecisionToAcpOutcome,
  pickFullAccessAllowOption,
} from "../cursor-acp-permission-mapper.js";

describe("cursor-acp-permission-mapper", () => {
  const options = [
    { kind: "reject_once" as const, name: "No", optionId: "r1" },
    { kind: "allow_once" as const, name: "Yes", optionId: "a1" },
  ];

  it("pickFullAccessAllowOption prefers allow_always then allow_once", () => {
    expect(
      pickFullAccessAllowOption([
        { kind: "reject_once", name: "n", optionId: "r" },
        { kind: "allow_once", name: "y", optionId: "a" },
      ]),
    ).toBe("a");
    expect(
      pickFullAccessAllowOption([
        { kind: "allow_always", name: "all", optionId: "aa" },
        { kind: "allow_once", name: "y", optionId: "a" },
      ]),
    ).toBe("aa");
  });

  it("mapDecisionToAcpOutcome selects allow_once for allow", () => {
    expect(mapDecisionToAcpOutcome("allow", options)).toEqual({
      outcome: "selected",
      optionId: "a1",
    });
  });

  it("mapDecisionToAcpOutcome yields cancelled", () => {
    expect(mapDecisionToAcpOutcome("cancelled", options)).toEqual({ outcome: "cancelled" });
  });
});
