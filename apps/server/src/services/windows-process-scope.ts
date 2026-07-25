import { createRequire } from "node:module";

const nativeRequire = createRequire(import.meta.url);
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const ERROR_MORE_DATA = 234;
const MAX_PROCESS_IDS = 128;
const POINTER_BYTES = process.arch === "ia32" ? 4 : 8;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const EXTENDED_LIMIT_SIZE = process.arch === "ia32" ? 112 : 144;

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
}

/** Owns one terminal process tree with a nested Windows Job Object. */
export class WindowsProcessScope {
  private native: WindowsProcessScopeNative | null;
  private assigned = false;

  constructor(native: WindowsProcessScopeNative | null) {
    this.native = native;
  }

  /** Whether the native child Job Object was initialized successfully. */
  get ready(): boolean {
    return this.native !== null;
  }

  /** Whether the terminal root was successfully assigned to this scope. */
  get ownsProcessTree(): boolean {
    return this.assigned && this.native !== null;
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
    try { native.closeHandle(native.jobHandle); } catch { /* best effort */ }
  }

  private nativeFailure(native: WindowsProcessScopeNative, operation: string): WindowsProcessScopeResult {
    return { ok: false, error: `${operation} failed (${native.getLastError()})` };
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
      });
    } catch {
      return new WindowsProcessScope(null);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
