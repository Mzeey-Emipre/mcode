import { describe, it, expect } from "vitest";
import {
  flattenProcessEnv,
  parseNewlineDelimitedEnv,
  parseNullDelimitedEnv,
} from "../shell-env-utils.js";

describe("shell-env-utils", () => {
  describe("parseNullDelimitedEnv", () => {
    it("splits on NUL and supports = in values", () => {
      const buf = Buffer.from("A=1\0B=x=y\0", "utf8");
      expect(parseNullDelimitedEnv(buf)).toEqual({ A: "1", B: "x=y" });
    });

    it("returns empty object for empty buffer", () => {
      expect(parseNullDelimitedEnv(Buffer.alloc(0))).toEqual({});
    });

    it("skips entries without = separator", () => {
      const buf = Buffer.from("A=1\0NOEQ\0B=2\0", "utf8");
      expect(parseNullDelimitedEnv(buf)).toEqual({ A: "1", B: "2" });
    });
  });

  describe("parseNewlineDelimitedEnv", () => {
    it("splits on newlines and supports = in values", () => {
      expect(parseNewlineDelimitedEnv("A=1\nB=x=y\n")).toEqual({
        A: "1",
        B: "x=y",
      });
    });

    it("returns empty object for empty string", () => {
      expect(parseNewlineDelimitedEnv("")).toEqual({});
    });

    it("skips lines without = separator", () => {
      expect(parseNewlineDelimitedEnv("A=1\nNOEQ\nB=2\n")).toEqual({
        A: "1",
        B: "2",
      });
    });

    it("handles values containing = characters", () => {
      expect(parseNewlineDelimitedEnv("FORMULA=a=b=c\n")).toEqual({
        FORMULA: "a=b=c",
      });
    });
  });

  describe("flattenProcessEnv", () => {
    it("drops undefined entries", () => {
      const env = { X: "a", Y: undefined } as NodeJS.ProcessEnv;
      expect(flattenProcessEnv(env)).toEqual({ X: "a" });
    });

    it("preserves empty string values", () => {
      const env = { EMPTY: "" } as NodeJS.ProcessEnv;
      expect(flattenProcessEnv(env)).toEqual({ EMPTY: "" });
    });
  });
});
