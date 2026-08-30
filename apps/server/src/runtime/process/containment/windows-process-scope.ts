import { createRequire } from "node:module";

const nativeRequire = createRequire(import.meta.url);
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_FILES = 18;
const MAX_PROCESS_IDS = 128;
const POINTER_BYTES = process.arch === "ia32" ? 4 : 8;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const EXTENDED_LIMIT_SIZE = process.arch === "ia32" ? 112 : 144;
const TH32CS_SNAPPROCESS = 0x00000002;
const PROCESS_ENTRY_SIZE = process.arch === "ia32" ? 556 : 568;
const PROCESS_ENTRY_PARENT_OFFSET = process.arch === "ia32" ? 24 : 32;
const PROCESS_ENUMERATION_LIMIT = 16_384;
const RECONCILIATION_PASS_LIMIT = 5;

/** Result returned by a Windows process-scope operation. */
export interface WindowsProcessScopeResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Bounded snapshot of processes currently owned by a Windows process scope. */
export interface WindowsProcessScopeProcessIds extends WindowsProcessScopeResult {
  readonly processIds: readonly number[];
  readonly overflow: boolean;
}

/** Native calls used by a per-terminal Windows Job Object. */
export interface WindowsProcessScopeNative {
  readonly jobHandle: unknown;
  readonly closeHandle: (handle: unknown) => number;
  readonly assignProcessToJobObject: (job: unknown, process: unknown) => number;
  readonly openProcess: (access: number, inherit: number, pid: number) => unknown;
  readonly terminateJobObject: (job: unknown, exitCode: number) => number;
  readonly queryInformationJobObject: (
    job: unknown,
    infoClass: number,
    buffer: Buffer,
    bufferLength: number,
    returnLength: Buffer,
  ) => number;
  readonly getLastError: () => number;
  readonly createToolhelp32Snapshot?: (flags: number, processId: number) => unknown;
  readonly process32First?: (snapshot: unknown, entry: Buffer) => number;
  readonly process32Next?: (snapshot: unknown, entry: Buffer) => number;
  readonly getProcessTimes?: (
    process: unknown,
    creation: Buffer,
    exit: Buffer,
    kernel: Buffer,
    user: Buffer,
  ) => number;
}

/** Creation-identity record used while reconciling a terminal process tree. */
export interface WindowsProcessScopeIdentity {
  readonly pid: number;
  readonly parentPid: number | null;
  readonly startMarker: string;
  readonly depth: number;
}

type ReconcileCapture =
  | { readonly kind: "captured"; readonly identities: readonly WindowsProcessScopeIdentity[] }
  | { readonly kind: "retry" }
  | { readonly kind: "failed"; readonly error: string };

type ReconcilePassOutcome = Exclude<ReconcileCapture, { readonly kind: "captured" }> | { readonly kind: "converged" };

type ReconciliationInspection =
  | { readonly ok: true; readonly missing: readonly WindowsProcessScopeIdentity[] }
  | { readonly ok: false; readonly error: string };

type ProcessSnapshotNative = WindowsProcessScopeNative & Required<Pick<WindowsProcessScopeNative,
  "createToolhelp32Snapshot" | "process32First" | "process32Next" | "getProcessTimes"
>>;

/** Owns one terminal process tree with a nested Windows Job Object. */
export class WindowsProcessScope {
  private native: WindowsProcessScopeNative | null;
  private assigned = false;
  private authoritative = false;

  constructor(native: WindowsProcessScopeNative | null) {
    this.native = native;
  }

  /** Whether the native child Job Object was initialized successfully. */
  get ready(): boolean {
    return this.native !== null;
  }

  /** Whether the terminal root was successfully assigned to this scope. */
  get ownsProcessTree(): boolean {
    return this.authoritative && this.native !== null;
  }

  /** Assign a terminal root process to this child Job Object. */
  assign(pid: number): WindowsProcessScopeResult {
    const native = this.native;
    if (!native) return { ok: false, error: "scope unavailable" };
    let processHandle: unknown = null;
    try {
      processHandle = native.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (!processHandle) return this.nativeFailure(native, "OpenProcess");
      if (!native.assignProcessToJobObject(native.jobHandle, processHandle)) {
        return this.nativeFailure(native, "AssignProcessToJobObject");
      }
      this.assigned = true;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    } finally {
      if (processHandle) {
        try { native.closeHandle(processHandle); } catch { /* best effort */ }
      }
    }
  }

  /**
   * Reconcile descendants that existed before the root entered this Job Object.
   * Authority is granted only after a complete pass observes no missing members.
   */
  async reconcile(
    rootPid: number,
    capture: () => Promise<readonly WindowsProcessScopeIdentity[]> =
      async () => this.captureProcessTree(rootPid),
  ): Promise<WindowsProcessScopeResult> {
    if (!this.assigned || !this.native) {
      return { ok: false, error: "scope root is not assigned" };
    }
    this.authoritative = false;
    for (let pass = 0; pass < RECONCILIATION_PASS_LIMIT; pass += 1) {
      const outcome = await this.reconcilePass(rootPid, capture, pass);
      if (outcome.kind === "retry") continue;
      if (outcome.kind === "converged") {
        this.authoritative = true;
        return { ok: true };
      }
      return { ok: false, error: outcome.error };
    }
    return { ok: false, error: `process scope did not converge after ${RECONCILIATION_PASS_LIMIT} passes` };
  }

  private async reconcilePass(
    rootPid: number,
    capture: () => Promise<readonly WindowsProcessScopeIdentity[]>,
    pass: number,
  ): Promise<ReconcilePassOutcome> {
    const initialCapture = await this.captureForReconciliation(capture, pass);
    if (initialCapture.kind !== "captured") return initialCapture;

    const inspection = this.inspectReconciliation(rootPid, initialCapture.identities);
    if (!inspection.ok) return { kind: "failed", error: inspection.error };
    if (inspection.missing.length === 0) return { kind: "converged" };

    const validationCapture = await this.captureForReconciliation(capture, pass);
    if (validationCapture.kind !== "captured") return validationCapture;
    const failure = await this.assignMissingProcesses(inspection.missing, validationCapture.identities, capture);
    return failure ? { kind: "failed", error: failure.error ?? "process assignment failed" } : { kind: "retry" };
  }

  private async captureForReconciliation(
    capture: () => Promise<readonly WindowsProcessScopeIdentity[]>,
    pass: number,
  ): Promise<ReconcileCapture> {
    try {
      return { kind: "captured", identities: await capture() };
    } catch (error) {
      return pass + 1 < RECONCILIATION_PASS_LIMIT
        ? { kind: "retry" }
        : { kind: "failed", error: describeError(error) };
    }
  }

  private inspectReconciliation(
    rootPid: number,
    descendants: readonly WindowsProcessScopeIdentity[],
  ): ReconciliationInspection {
    if (descendants.length === 0 || descendants[0]?.pid !== rootPid) {
      return { ok: false, error: "root creation identity unavailable" };
    }
    if (descendants.length > MAX_PROCESS_IDS) {
      return { ok: false, error: `process tree exceeds ${MAX_PROCESS_IDS}-process limit` };
    }
    const membership = this.queryProcessIds();
    if (!membership.ok || membership.overflow) {
      return { ok: false, error: membership.error ?? "job membership overflow" };
    }
    const memberIds = new Set(membership.processIds);
    return {
      ok: true,
      missing: descendants
        .filter((identity) => !memberIds.has(identity.pid))
        .sort((left, right) => left.depth - right.depth),
    };
  }

  private async assignMissingProcesses(
    missing: readonly WindowsProcessScopeIdentity[],
    validation: readonly WindowsProcessScopeIdentity[],
    capture: () => Promise<readonly WindowsProcessScopeIdentity[]>,
  ): Promise<WindowsProcessScopeResult | null> {
    const validationByPid = new Map(validation.map((identity) => [identity.pid, identity]));
    for (const identity of missing) {
      const failure = await this.assignReconciledProcess(identity, validationByPid, capture);
      if (failure) return failure;
    }
    return null;
  }

  private async assignReconciledProcess(
    identity: WindowsProcessScopeIdentity,
    validationByPid: ReadonlyMap<number, WindowsProcessScopeIdentity>,
    capture: () => Promise<readonly WindowsProcessScopeIdentity[]>,
  ): Promise<WindowsProcessScopeResult | null> {
    const current = validationByPid.get(identity.pid);
    if (!current || current.startMarker !== identity.startMarker) {
      return { ok: false, error: `process identity changed for PID ${identity.pid}` };
    }
    const membership = this.queryProcessIds();
    if (!membership.ok || membership.overflow) {
      return { ok: false, error: membership.error ?? "job membership overflow" };
    }
    if (membership.processIds.includes(identity.pid)) return null;

    const assignment = this.assignProcess(identity.pid);
    if (assignment.ok || await this.assignmentRaced(identity, capture)) return null;
    return { ok: false, error: `${assignment.error ?? "process assignment failed"} for PID ${identity.pid}` };
  }

  private async assignmentRaced(
    identity: WindowsProcessScopeIdentity,
    capture: () => Promise<readonly WindowsProcessScopeIdentity[]>,
  ): Promise<boolean> {
    const membership = this.queryProcessIds();
    try {
      const current = (await capture()).find((candidate) => candidate.pid === identity.pid);
      return membership.ok
        && !membership.overflow
        && membership.processIds.includes(identity.pid)
        && current?.startMarker === identity.startMarker;
    } catch {
      return false;
    }
  }

  /** Atomically terminate every process owned by this scope. */
  terminate(exitCode = 1): WindowsProcessScopeResult {
    const native = this.native;
    if (!native || !this.assigned) return { ok: false, error: "scope does not own a process tree" };
    try {
      return native.terminateJobObject(native.jobHandle, exitCode)
        ? { ok: true }
        : this.nativeFailure(native, "TerminateJobObject");
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /** Query at most 128 process IDs currently owned by this scope. */
  queryProcessIds(): WindowsProcessScopeProcessIds {
    const native = this.native;
    if (!native) return { ok: false, processIds: [], overflow: false, error: "scope unavailable" };
    const buffer = Buffer.alloc(8 + MAX_PROCESS_IDS * POINTER_BYTES);
    const returnLength = Buffer.alloc(4);
    try {
      const ok = native.queryInformationJobObject(
        native.jobHandle,
        JOB_OBJECT_BASIC_PROCESS_ID_LIST,
        buffer,
        buffer.length,
        returnLength,
      );
      const errorCode = ok ? 0 : native.getLastError();
      if (!ok && errorCode !== ERROR_MORE_DATA) {
        return { ok: false, processIds: [], overflow: false, error: `QueryInformationJobObject failed (${errorCode})` };
      }
      const assignedCount = buffer.readUInt32LE(0);
      const listedCount = Math.min(buffer.readUInt32LE(4), MAX_PROCESS_IDS);
      const processIds: number[] = [];
      for (let index = 0; index < listedCount; index += 1) {
        const offset = 8 + index * POINTER_BYTES;
        const pid = POINTER_BYTES === 4
          ? buffer.readUInt32LE(offset)
          : Number(buffer.readBigUInt64LE(offset));
        if (pid > 0) processIds.push(pid);
      }
      return { ok: true, processIds, overflow: assignedCount > MAX_PROCESS_IDS || errorCode === ERROR_MORE_DATA };
    } catch (error) {
      return { ok: false, processIds: [], overflow: false, error: describeError(error) };
    }
  }

  /** Wait asynchronously until the scope is empty or the timeout expires. */
  async waitForEmpty(timeoutMs: number): Promise<WindowsProcessScopeResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      const snapshot = this.queryProcessIds();
      if (!snapshot.ok) return snapshot;
      if (!snapshot.overflow && snapshot.processIds.length === 0) return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    return { ok: false, error: `process scope remained non-empty after ${timeoutMs}ms` };
  }

  /** Close the child Job Object handle exactly once. */
  close(): void {
    const native = this.native;
    if (!native) return;
    this.native = null;
    this.assigned = false;
    this.authoritative = false;
    try { native.closeHandle(native.jobHandle); } catch { /* best effort */ }
  }

  private nativeFailure(native: WindowsProcessScopeNative, operation: string): WindowsProcessScopeResult {
    return { ok: false, error: `${operation} failed (${native.getLastError()})` };
  }

  private assignProcess(pid: number): WindowsProcessScopeResult {
    const native = this.native;
    if (!native) return { ok: false, error: "scope unavailable" };
    let processHandle: unknown = null;
    try {
      processHandle = native.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (!processHandle) return this.nativeFailure(native, "OpenProcess");
      return native.assignProcessToJobObject(native.jobHandle, processHandle)
        ? { ok: true }
        : this.nativeFailure(native, "AssignProcessToJobObject");
    } catch (error) {
      return { ok: false, error: describeError(error) };
    } finally {
      if (processHandle) {
        try { native.closeHandle(processHandle); } catch { /* best effort */ }
      }
    }
  }

  private captureProcessTree(rootPid: number): WindowsProcessScopeIdentity[] {
    const native = this.getProcessSnapshotNative();
    const parentByPid = this.readProcessParents(native);
    return this.captureTreeIdentities(rootPid, parentByPid, this.createChildrenByParent(parentByPid));
  }

  private getProcessSnapshotNative(): ProcessSnapshotNative {
    const native = this.native;
    if (!native || !native.createToolhelp32Snapshot || !native.process32First || !native.process32Next || !native.getProcessTimes) {
      throw new Error("native process snapshot unavailable");
    }
    return native as ProcessSnapshotNative;
  }

  private readProcessParents(native: ProcessSnapshotNative): Map<number, number> {
    const snapshot = native.createToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (!snapshot) throw new Error(`CreateToolhelp32Snapshot failed (${native.getLastError()})`);
    try {
      return this.scanProcessSnapshot(native, snapshot);
    } finally {
      native.closeHandle(snapshot);
    }
  }

  private scanProcessSnapshot(native: ProcessSnapshotNative, snapshot: unknown): Map<number, number> {
    const entry = Buffer.alloc(PROCESS_ENTRY_SIZE);
    entry.writeUInt32LE(PROCESS_ENTRY_SIZE, 0);
    if (!native.process32First(snapshot, entry)) return this.emptyProcessSnapshot(native);

    const parentByPid = new Map<number, number>();
    let hasEntry = true;
    let count = 0;
    while (hasEntry && count < PROCESS_ENUMERATION_LIMIT) {
      parentByPid.set(entry.readUInt32LE(8), entry.readUInt32LE(PROCESS_ENTRY_PARENT_OFFSET));
      entry.fill(0);
      entry.writeUInt32LE(PROCESS_ENTRY_SIZE, 0);
      hasEntry = Boolean(native.process32Next(snapshot, entry));
      count += 1;
    }
    if (hasEntry) throw new Error(`process enumeration exceeds ${PROCESS_ENUMERATION_LIMIT}-entry limit`);
    this.assertProcessEnumerationComplete(native);
    return parentByPid;
  }

  private emptyProcessSnapshot(native: ProcessSnapshotNative): Map<number, number> {
    const errorCode = readLastError(native);
    if (errorCode !== ERROR_NO_MORE_FILES) throw new Error(`Process32FirstW failed (${errorCode})`);
    return new Map();
  }

  private assertProcessEnumerationComplete(native: ProcessSnapshotNative): void {
    const errorCode = readLastError(native);
    if (errorCode !== ERROR_NO_MORE_FILES) throw new Error(`Process32NextW failed (${errorCode})`);
  }

  private createChildrenByParent(parentByPid: ReadonlyMap<number, number>): Map<number, number[]> {
    const childrenByParent = new Map<number, number[]>();
    for (const [pid, parentPid] of parentByPid) {
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(pid);
      childrenByParent.set(parentPid, children);
    }
    return childrenByParent;
  }

  private captureTreeIdentities(
    rootPid: number,
    parentByPid: ReadonlyMap<number, number>,
    childrenByParent: ReadonlyMap<number, readonly number[]>,
  ): WindowsProcessScopeIdentity[] {
    const pending = [{ pid: rootPid, parentPid: null as number | null, depth: 0 }];
    const identities: WindowsProcessScopeIdentity[] = [];
    const visited = new Set<number>();
    while (pending.length > 0 && identities.length < MAX_PROCESS_IDS) {
      const identity = pending.shift()!;
      if (visited.has(identity.pid) || !parentByPid.has(identity.pid)) continue;
      visited.add(identity.pid);
      const startMarker = this.readStartMarker(identity.pid);
      if (!startMarker) throw new Error(`creation identity unavailable for PID ${identity.pid}`);
      identities.push({ ...identity, startMarker });
      pending.push(...(childrenByParent.get(identity.pid) ?? []).map((pid) => ({
        pid,
        parentPid: identity.pid,
        depth: identity.depth + 1,
      })));
    }
    if (pending.length > 0) throw new Error(`process tree exceeds ${MAX_PROCESS_IDS}-process limit`);
    return identities;
  }

  private readStartMarker(pid: number): string | null {
    const native = this.native;
    if (!native?.getProcessTimes) return null;
    const processHandle = native.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!processHandle) return null;
    try {
      const times = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)] as const;
      if (!native.getProcessTimes(processHandle, ...times)) return null;
      return times[0].toString("hex");
    } finally {
      native.closeHandle(processHandle);
    }
  }
}

/** Creates per-terminal Windows process scopes, or unavailable scopes off Windows. */
export class WindowsProcessScopeFactory {
  /** Create one isolated terminal process scope. */
  create(): WindowsProcessScope {
    if (process.platform !== "win32") return new WindowsProcessScope(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const koffi = nativeRequire("koffi") as any;
      const kernel32 = koffi.load("kernel32.dll");
      const createJobObject = kernel32.func("void* __stdcall CreateJobObjectW(void*, str16)");
      const closeHandle = kernel32.func("int __stdcall CloseHandle(void*)");
      const setInformationJobObject = kernel32.func(
        "int __stdcall SetInformationJobObject(void*, int, void*, uint32)",
      );
      const jobHandle = createJobObject(null, null);
      if (!jobHandle) return new WindowsProcessScope(null);
      const limits = Buffer.alloc(EXTENDED_LIMIT_SIZE);
      limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
      if (!setInformationJobObject(
        jobHandle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        limits,
        limits.length,
      )) {
        closeHandle(jobHandle);
        return new WindowsProcessScope(null);
      }
      return new WindowsProcessScope({
        jobHandle,
        closeHandle,
        assignProcessToJobObject: kernel32.func("int __stdcall AssignProcessToJobObject(void*, void*)"),
        openProcess: kernel32.func("void* __stdcall OpenProcess(uint32, int, uint32)"),
        terminateJobObject: kernel32.func("int __stdcall TerminateJobObject(void*, uint32)"),
        queryInformationJobObject: kernel32.func("int __stdcall QueryInformationJobObject(void*, int, void*, uint32, void*)"),
        getLastError: kernel32.func("uint32 __stdcall GetLastError()"),
        createToolhelp32Snapshot: kernel32.func(
          "void* __stdcall CreateToolhelp32Snapshot(uint32, uint32)",
        ),
        process32First: kernel32.func("int __stdcall Process32FirstW(void*, void*)"),
        process32Next: kernel32.func("int __stdcall Process32NextW(void*, void*)"),
        getProcessTimes: kernel32.func(
          "int __stdcall GetProcessTimes(void*, void*, void*, void*, void*)",
        ),
      });
    } catch {
      return new WindowsProcessScope(null);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLastError(native: WindowsProcessScopeNative): number {
  let errorCode: number;
  try {
    errorCode = native.getLastError();
  } catch (error) {
    throw new Error(`GetLastError failed: ${describeError(error)}`);
  }
  if (!Number.isInteger(errorCode) || errorCode < 0 || errorCode > 0xffff_ffff) {
    throw new Error("GetLastError returned invalid value");
  }
  return errorCode;
}
