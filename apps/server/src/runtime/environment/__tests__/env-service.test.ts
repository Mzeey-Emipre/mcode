import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EnvService } from "../env-service.js";
import type { ProtectedEnvStore } from "../protected-env-store.js";
import type { ShellEnvResolver } from "../shell-env-resolver.js";

function makeResolver(
  envMap: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/user" },
): ShellEnvResolver {
  return {
    peekResolvedOverlay: vi.fn(() => ({ ...envMap })),
    resolveFreshAsync: vi.fn(async () => ({ ...envMap })),
  } as unknown as ShellEnvResolver;
}

function makeStore(
  snapshot: Record<string, string> = { MCODE_PORT: "19400" },
): ProtectedEnvStore {
  return {
    applyTo: vi.fn((resolved: Record<string, string>) => {
      const out: Record<string, string> = { ...resolved };
      for (const k of Object.keys(resolved)) {
        if (
          k.startsWith("MCODE_") ||
          k.startsWith("ELECTRON_") ||
          k.startsWith("BETTER_SQLITE3_")
        ) {
          delete out[k];
        }
      }
      return { ...out, ...snapshot };
    }),
  } as unknown as ProtectedEnvStore;
}

async function flushRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvService", () => {
  let resolver: ShellEnvResolver;
  let store: ProtectedEnvStore;
  let service: EnvService;

  beforeEach(() => {
    resolver = makeResolver();
    store = makeStore();
    service = new EnvService(resolver, store);
  });

  it("returns merged env with protected keys winning", () => {
    const env = service.getEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.MCODE_PORT).toBe("19400");
  });

  it("schedules resolveFreshAsync on first access", async () => {
    service.getEnv();
    expect(resolver.resolveFreshAsync).toHaveBeenCalledOnce();
    await flushRefresh();
  });

  it("does not call resolveFreshAsync again until TTL expires after refresh", async () => {
    service.getEnv();
    await flushRefresh();
    vi.mocked(resolver.resolveFreshAsync).mockClear();

    service.getEnv();
    service.getEnv();
    expect(resolver.resolveFreshAsync).not.toHaveBeenCalled();
  });

  it("re-resolves after TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      service.getEnv();
      await flushRefresh();
      expect(resolver.resolveFreshAsync).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date(61_000));
      service.getEnv();
      await flushRefresh();
      expect(resolver.resolveFreshAsync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a defensive copy (mutations do not leak back)", async () => {
    const first = service.getEnv();
    first.PATH = "/hacked";
    await flushRefresh();
    const second = service.getEnv();
    expect(second.PATH).toBe("/usr/bin");
  });

  it("includes current process.env as base layer", () => {
    const prev = process.env.SOME_RANDOM_VAR;
    process.env.SOME_RANDOM_VAR = "from-process";
    try {
      const env = service.getEnv();
      expect(env.SOME_RANDOM_VAR).toBe("from-process");
    } finally {
      if (prev === undefined) delete process.env.SOME_RANDOM_VAR;
      else process.env.SOME_RANDOM_VAR = prev;
    }
  });

  it("protected keys override shell-resolved values", () => {
    const resolverWithConflict = makeResolver({ MCODE_PORT: "from-shell" });
    const storeWithMcode = makeStore({ MCODE_PORT: "19400" });
    const svc = new EnvService(resolverWithConflict, storeWithMcode);

    const env = svc.getEnv();
    expect(env.MCODE_PORT).toBe("19400");
  });
});
