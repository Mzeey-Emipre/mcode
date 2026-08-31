import { describe, expect, it } from "vitest";
import { hostRuntime } from "@mcode/shared/node/host-runtime";

describe("hostRuntime", () => {
  it("captures immutable Node host facts", () => {
    expect(hostRuntime).toEqual({
      platform: process.platform,
      architecture: process.arch,
      nodeAbi: process.versions.modules,
    });
    expect(Object.isFrozen(hostRuntime)).toBe(true);
  });
});
