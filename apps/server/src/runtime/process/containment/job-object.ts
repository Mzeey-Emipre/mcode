/**
 * Windows Job Object wrapper for grouping child processes under the server.
 *
 * On Windows: creates a kernel Job Object with KILL_ON_JOB_CLOSE so every
 * descendant process dies atomically when the server exits (graceful or
 * crash). Job membership inherits through normal CreateProcess semantics;
 * `assign()` exists for spawns that opt out of inheritance (notably
 * node-pty/ConPTY).
 *
 * On non-Windows: every method is a no-op. Unix already has process groups
 * and the existing process-kill.ts handles that path.
 */
import * as NodeModule from "node:module";
import { logger } from "@mcode/shared";

const _require = NodeModule.createRequire(import.meta.url);

const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
// SetProcessDescription requires only limited-information access, not full terminate rights.
const PROCESS_SET_LIMITED_INFORMATION = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION sizes:
// x64/arm64 = 144 bytes, x86 = 112 bytes.
// LimitFlags is at offset 16 in BasicLimitInformation (which is at offset 0).
/** Immutable host facts required to initialize a Windows Job Object. */
export interface JobObjectHostFacts {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
}

interface WindowsState {
  jobHandle: unknown; // opaque koffi handle
  CloseHandle: (h: unknown) => number;
  AssignProcessToJobObject: (job: unknown, proc: unknown) => number;
  OpenProcess: (access: number, inherit: number, pid: number) => unknown;
  // Null when unavailable (not exported on all Windows SKUs/builds).
  SetProcessDescription: ((proc: unknown, desc: string) => number) | null;
}

/**
 * Groups child processes under a Windows Job Object so they die atomically
 * when the server exits. No-op on non-Windows platforms (Unix process groups
 * already provide equivalent semantics via process-kill.ts).
 */
export class JobObject {
  /**
   * True when running on Windows. Reflects platform detection only;
   * actual job-handle readiness is tracked by the private `initialized`
   * field (false when koffi/native init fails).
   */
  public readonly isWindowsJob: boolean;
  private readonly extendedLimitSize: number;
  private initialized = false;
  private windowsState: WindowsState | null = null;

  constructor({ platform, architecture }: JobObjectHostFacts) {
    this.isWindowsJob = platform === "win32";
    this.extendedLimitSize = architecture === "ia32" ? 112 : 144;
    if (this.isWindowsJob) {
      this.initWindows();
    }
  }

  /** Attach a process to the job and report whether required Windows assignment succeeded. */
  assign(pid: number): boolean {
    if (!this.initialized) return !this.isWindowsJob;
    return this.assignWindows(pid);
  }

  /** Close the job handle, terminating all assigned processes (Windows). */
  close(): void {
    if (!this.initialized) return;
    this.closeWindows();
  }

  /** Set a human-readable description on a process (visible in Task Manager). No-op on non-Windows. */
  setDescription(pid: number, description: string): void {
    if (!this.initialized) return;
    this.setDescriptionWindows(pid, description);
  }

  private initWindows(): void {
    try {
      // Dynamic require so non-Windows builds never load the native binary.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const koffi = _require("koffi") as any;
      const kernel32 = koffi.load("kernel32.dll");

      const CreateJobObjectW = kernel32.func("void* __stdcall CreateJobObjectW(void*, str16)");
      const AssignProcessToJobObject = kernel32.func("int __stdcall AssignProcessToJobObject(void*, void*)");
      const OpenProcess = kernel32.func("void* __stdcall OpenProcess(uint32, int, uint32)");
      const CloseHandle = kernel32.func("int __stdcall CloseHandle(void*)");
      const SetInformationJobObject = kernel32.func("int __stdcall SetInformationJobObject(void*, int, void*, uint32)");

      const jobHandle = CreateJobObjectW(null, null);
      if (!jobHandle) {
        throw new Error("CreateJobObjectW returned NULL");
      }

      // Zero a buffer of the right size and set LimitFlags = KILL_ON_JOB_CLOSE at offset 16.
      const buffer = Buffer.alloc(this.extendedLimitSize);
      buffer.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);

      const setOk = SetInformationJobObject(
        jobHandle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        buffer,
        this.extendedLimitSize,
      );
      if (!setOk) {
        CloseHandle(jobHandle);
        throw new Error("SetInformationJobObject failed");
      }

      // Load SetProcessDescription separately: not exported on all Windows SKUs/builds,
      // so a failure here must not prevent the job object from initializing.
      // Returns HRESULT (0=S_OK, negative=failure), unlike the BOOL-returning functions above.
      let SetProcessDescription: WindowsState["SetProcessDescription"] = null;
      try {
        SetProcessDescription = kernel32.func("int32 __stdcall SetProcessDescription(void*, str16)");
      } catch {
        // Degrade gracefully; setDescription() will be a no-op on this machine.
      }

      this.windowsState = { jobHandle, CloseHandle, AssignProcessToJobObject, OpenProcess, SetProcessDescription };
      this.initialized = true;
      logger.info("JobObject initialized");
    } catch (err) {
      logger.warn("JobObject: Windows init failed, falling back to no-op", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private assignWindows(pid: number): boolean {
    const s = this.windowsState!;
    let procHandle: unknown = null;
    try {
      procHandle = s.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (!procHandle) {
        // Process may already be dead, or we lack access. Best-effort.
        return false;
      }
      const ok = s.AssignProcessToJobObject(s.jobHandle, procHandle);
      if (!ok) {
        logger.debug("JobObject: AssignProcessToJobObject failed", { pid });
        return false;
      }
      return true;
    } catch (err) {
      logger.debug("JobObject: assign threw", {
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      if (procHandle) {
        try { s.CloseHandle(procHandle); } catch { /* ignore */ }
      }
    }
  }

  private setDescriptionWindows(pid: number, description: string): void {
    const s = this.windowsState!;
    if (!s.SetProcessDescription) return;
    let procHandle: unknown = null;
    try {
      procHandle = s.OpenProcess(PROCESS_SET_LIMITED_INFORMATION, 0, pid);
      if (!procHandle) return;
      const hr = s.SetProcessDescription(procHandle, description);
      // HRESULT: 0 (S_OK) = success, negative = failure
      if (hr < 0) {
        logger.debug("JobObject: SetProcessDescription failed", {
          pid,
          hr: `0x${(hr >>> 0).toString(16)}`,
        });
      }
    } catch (err) {
      logger.debug("JobObject: setDescription threw", {
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (procHandle) {
        try { s.CloseHandle(procHandle); } catch { /* ignore */ }
      }
    }
  }

  private closeWindows(): void {
    const s = this.windowsState!;
    this.initialized = false;
    this.windowsState = null;
    try {
      s.CloseHandle(s.jobHandle);
    } catch (err) {
      logger.debug("JobObject: close threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
