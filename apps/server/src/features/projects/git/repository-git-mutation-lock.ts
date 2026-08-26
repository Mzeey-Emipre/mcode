import { AsyncLocalStorage } from "node:async_hooks";
import { injectable } from "tsyringe";
import { normalizePathForComparison } from "../../../shared/filesystem/path-identity.js";

/** Serializes nested Git worktree mutations for each repository. */
@injectable()
export class RepositoryGitMutationLock {
  private readonly repositoryLocks = new Map<string, Promise<void>>();
  private readonly lockContext = new AsyncLocalStorage<ReadonlySet<string>>();

  /** Run one worktree mutation after earlier mutations for the same repository finish. */
  async run<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
    const key = normalizePathForComparison(repoPath);
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
