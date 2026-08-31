import * as NodeAsyncHooks from "node:async_hooks";
import { inject, injectable } from "tsyringe";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { normalizePathForComparison } from "../../../shared/filesystem/path-identity.js";

/** Serializes nested Git worktree mutations for each repository. */
@injectable()
export class RepositoryGitMutationLock {
  private readonly repositoryLocks = new Map<string, Promise<void>>();
  private readonly lockContext = new NodeAsyncHooks.AsyncLocalStorage<ReadonlySet<string>>();

  /** Run one worktree mutation after earlier mutations for the same repository finish. */
  constructor(@inject("HostRuntime") private readonly hostRuntime: HostRuntime) {}

  async run<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
    const key = normalizePathForComparison(repoPath, this.hostRuntime.platform);
    if (this.lockContext.getStore()?.has(key)) return work();

    const previous = this.repositoryLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const tail = previous.then(() => current);
    this.repositoryLocks.set(key, tail);
    await previous;
    try {
      const context = new Set(this.lockContext.getStore() ?? []);
      context.add(key);
      return await this.lockContext.run(context, work);
    } finally {
      release();
      if (this.repositoryLocks.get(key) === tail) {
        this.repositoryLocks.delete(key);
      }
    }
  }
}
