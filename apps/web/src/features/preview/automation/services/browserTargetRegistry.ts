/** Logical Browser target retained independently from React component lifetime. */
export interface BrowserTargetRecord {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly revision: number;
  readonly lastUsedAt: number;
  readonly attached: boolean;
}

function key(workspaceId: string, threadId: string, tabId: string): string {
  return JSON.stringify([workspaceId, threadId, tabId]);
}

/**
 * Owns Browser target identity and lifetime. Detaching a renderer handle keeps
 * the logical record warm; only an explicit scope release removes it.
 */
export class BrowserTargetRegistry {
  private readonly records = new Map<string, BrowserTargetRecord>();

  register(workspaceId: string, threadId: string, tabId: string): BrowserTargetRecord {
    const targetKey = key(workspaceId, threadId, tabId);
    const current = this.records.get(targetKey);
    const next: BrowserTargetRecord = {
      workspaceId,
      threadId,
      tabId,
      revision: current?.revision ?? 1,
      lastUsedAt: Date.now(),
      attached: true,
    };
    this.records.set(targetKey, next);
    return next;
  }

  /** Attach a runtime handle to an existing logical target, or create it. */
  attach(workspaceId: string, threadId: string, tabId: string): BrowserTargetRecord {
    return this.register(workspaceId, threadId, tabId);
  }

  refresh(workspaceId: string, threadId: string, tabId: string): BrowserTargetRecord | null {
    const targetKey = key(workspaceId, threadId, tabId);
    const current = this.records.get(targetKey);
    if (!current) return null;
    const next = { ...current, revision: current.revision + 1, lastUsedAt: Date.now(), attached: true };
    this.records.set(targetKey, next);
    return next;
  }

  detach(workspaceId: string, threadId: string, tabId: string): BrowserTargetRecord | null {
    const targetKey = key(workspaceId, threadId, tabId);
    const current = this.records.get(targetKey);
    if (!current) return null;
    const next = { ...current, attached: false };
    this.records.set(targetKey, next);
    return next;
  }

  releaseTarget(workspaceId: string, threadId: string, tabId: string): void {
    this.records.delete(key(workspaceId, threadId, tabId));
  }

  releaseThread(workspaceId: string, threadId: string): void {
    for (const [targetKey, target] of this.records) {
      if (target.workspaceId === workspaceId && target.threadId === threadId) this.records.delete(targetKey);
    }
  }

  releaseWorkspace(workspaceId: string): void {
    for (const [targetKey, target] of this.records) {
      if (target.workspaceId === workspaceId) this.records.delete(targetKey);
    }
  }

  get(workspaceId: string, threadId: string, tabId: string): BrowserTargetRecord | null {
    return this.records.get(key(workspaceId, threadId, tabId)) ?? null;
  }

  attached(): BrowserTargetRecord[] {
    return [...this.records.values()].filter((target) => target.attached);
  }

  clear(): void {
    this.records.clear();
  }
}

/** Process-local logical Browser target registry. */
export const browserTargetRegistry = new BrowserTargetRegistry();
