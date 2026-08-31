import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { RepositoryGitMutationLock } from "../repository-git-mutation-lock.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

describe("RepositoryGitMutationLock", () => {
  it("runs cleanup after provisioning releases the same repository", async () => {
    const lock = new RepositoryGitMutationLock(TEST_HOST_RUNTIME);
    const events: string[] = [];
    let releaseProvision!: () => void;
    const provisionGate = new Promise<void>((resolveProvision) => {
      releaseProvision = resolveProvision;
    });

    const provisioning = lock.run("C:/repo", async () => {
      events.push("provision-start");
      await provisionGate;
      events.push("provision-end");
    });
    await Promise.resolve();
    const cleanup = lock.run("C:/repo", async () => {
      events.push("cleanup");
    });
    await Promise.resolve();

    expect(events).toEqual(["provision-start"]);
    releaseProvision();
    await Promise.all([provisioning, cleanup]);
    expect(events).toEqual(["provision-start", "provision-end", "cleanup"]);
  });

  it("allows a nested mutation and releases the repository afterward", async () => {
    const lock = new RepositoryGitMutationLock();

    await expect(lock.run("C:/repo", () => lock.run("C:/repo", async () => "nested")))
      .resolves.toBe("nested");
    await expect(lock.run("C:/repo", async () => "released")).resolves.toBe("released");
  });
});
