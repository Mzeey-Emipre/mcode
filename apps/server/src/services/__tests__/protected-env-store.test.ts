import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ProtectedEnvStore } from "../protected-env-store.js";

describe("ProtectedEnvStore", () => {
  it("overlays startup MCODE_ values onto a resolved map", () => {
    const prev = process.env.MCODE_PORT;
    process.env.MCODE_PORT = "19400";
    try {
      const store = new ProtectedEnvStore();
      const merged = store.applyTo({ MCODE_PORT: "1", USER: "shell" });
      expect(merged.MCODE_PORT).toBe("19400");
      expect(merged.USER).toBe("shell");
    } finally {
      if (prev === undefined) {
        delete process.env.MCODE_PORT;
      } else {
        process.env.MCODE_PORT = prev;
      }
    }
  });

  it("auto-protects ELECTRON_ prefixed keys", () => {
    const prev = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const store = new ProtectedEnvStore();
      expect(store.isProtected("ELECTRON_RUN_AS_NODE")).toBe(true);
      const merged = store.applyTo({ ELECTRON_RUN_AS_NODE: "from-shell" });
      expect(merged.ELECTRON_RUN_AS_NODE).toBe("1");
    } finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prev;
    }
  });

  it("auto-protects BETTER_SQLITE3_ prefixed keys", () => {
    const prev = process.env.BETTER_SQLITE3_BINDING;
    process.env.BETTER_SQLITE3_BINDING = "/native/path";
    try {
      const store = new ProtectedEnvStore();
      expect(store.isProtected("BETTER_SQLITE3_BINDING")).toBe(true);
      const merged = store.applyTo({ BETTER_SQLITE3_BINDING: "from-shell" });
      expect(merged.BETTER_SQLITE3_BINDING).toBe("/native/path");
    } finally {
      if (prev === undefined) delete process.env.BETTER_SQLITE3_BINDING;
      else process.env.BETTER_SQLITE3_BINDING = prev;
    }
  });

  it("isProtected returns false for non-protected keys", () => {
    const store = new ProtectedEnvStore();
    expect(store.isProtected("PATH")).toBe(false);
    expect(store.isProtected("HOME")).toBe(false);
    expect(store.isProtected("USER")).toBe(false);
  });

  it("honours protect() for non-prefixed keys", () => {
    const prev = process.env.CUSTOM_SERVER_FLAG;
    process.env.CUSTOM_SERVER_FLAG = "keep-me";
    try {
      const store = new ProtectedEnvStore();
      store.protect("CUSTOM_SERVER_FLAG");
      expect(store.isProtected("CUSTOM_SERVER_FLAG")).toBe(true);
      const merged = store.applyTo({ CUSTOM_SERVER_FLAG: "from-shell" });
      expect(merged.CUSTOM_SERVER_FLAG).toBe("keep-me");
    } finally {
      if (prev === undefined) {
        delete process.env.CUSTOM_SERVER_FLAG;
      } else {
        process.env.CUSTOM_SERVER_FLAG = prev;
      }
    }
  });

  it("drops explicit protected keys from resolved when no snapshot value exists", () => {
    delete process.env.ORPHAN_PROTECTED_KEY;
    const store = new ProtectedEnvStore();
    store.protect("ORPHAN_PROTECTED_KEY");

    const merged = store.applyTo({
      ORPHAN_PROTECTED_KEY: "from-shell",
      PATH: "/bin",
    });
    expect(merged.ORPHAN_PROTECTED_KEY).toBeUndefined();
    expect(merged.PATH).toBe("/bin");
  });

  it("passes through non-protected keys unchanged", () => {
    const store = new ProtectedEnvStore();
    const merged = store.applyTo({ PATH: "/usr/bin", HOME: "/home/dev" });
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.HOME).toBe("/home/dev");
  });
});
