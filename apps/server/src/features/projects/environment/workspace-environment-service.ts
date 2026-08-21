import { createHash, randomUUID } from "crypto";
import { mkdir, open, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
  WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES,
  WorkspaceEnvironmentDocumentSchema,
  workspaceEnvironmentValidationIssues,
  type WorkspaceEnvironmentReadResult,
  type WorkspaceEnvironmentSaveInput,
  type WorkspaceEnvironmentValidationIssue,
  type WorkspaceEnvironmentValidationReason,
} from "@mcode/contracts";
import { getMcodeDir } from "@mcode/shared";
import { ZodError } from "zod";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";

export { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function issue(
  path: (string | number)[],
  code: string,
  reason: WorkspaceEnvironmentValidationReason,
  message: string,
): WorkspaceEnvironmentValidationIssue {
  return { path, code, reason, message };
}

function revisionFor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validationError(error: ZodError): WorkspaceEnvironmentServiceError {
  const issues = workspaceEnvironmentValidationIssues(error);
  const unsupported = issues.some((candidate) => candidate.reason === "unsupported_version");
  return new WorkspaceEnvironmentServiceError(
    unsupported
      ? "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION"
      : "WORKSPACE_ENVIRONMENT_VALIDATION",
    unsupported ? "Workspace environment version is not supported" : "Workspace environment failed validation",
    issues,
  );
}

/** Persists one private, system-local environment document per workspace. */
export class WorkspaceEnvironmentService {
  private readonly mcodeDir: string;
  private readonly saveTails = new Map<string, Promise<void>>();

  constructor(mcodeDir = getMcodeDir()) {
    this.mcodeDir = mcodeDir;
  }

  /** Resolve the exact private environment document path for one workspace. */
  filePath(workspaceId: string): string {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace id is not a safe path segment",
        [issue(["workspaceId"], "INVALID_WORKSPACE_ID", "invalid_value", "Workspace id is not a safe path segment")],
      );
    }
    return join(this.mcodeDir, "projects", workspaceId, "environment.json");
  }

  /** Read and validate the current document, returning an absent default when no file exists. */
  async read(workspaceId: string): Promise<WorkspaceEnvironmentReadResult> {
    const filePath = this.filePath(workspaceId);
    const bounded = await this.readBounded(filePath);
    if (bounded.kind === "absent") {
      return {
        document: DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
        revision: null,
        status: "absent",
      };
    }
    if (bounded.kind === "too_large") {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace environment exceeds the maximum persisted size",
        [issue([], "DOCUMENT_TOO_LARGE", "document_too_large", `Environment documents must be at most ${WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES} bytes`)],
      );
    }
    const bytes = bounded.bytes;

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace environment is not valid JSON",
        [issue([], "INVALID_JSON", "invalid_value", "Workspace environment is not valid JSON")],
      );
    }
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse(value);
    if (!parsed.success) throw validationError(parsed.error);
    return {
      document: parsed.data,
      revision: revisionFor(bytes),
      status: "present",
    };
  }

  private async readBounded(filePath: string): Promise<
    | { kind: "absent" }
    | { kind: "too_large" }
    | { kind: "present"; bytes: Uint8Array }
  > {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    const bytes = new Uint8Array(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES + 1);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        offset += bytesRead;
        if (bytesRead === 0) break;
      }
      return offset > WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES
        ? { kind: "too_large" }
        : { kind: "present", bytes: bytes.subarray(0, offset) };
    } finally {
      await handle.close();
    }
  }

  /** Validate and atomically replace the workspace environment when its revision is current. */
  async save(input: WorkspaceEnvironmentSaveInput): Promise<WorkspaceEnvironmentReadResult> {
    const filePath = this.filePath(input.workspaceId);
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse(input.document);
    if (!parsed.success) throw validationError(parsed.error);

    return this.enqueueSave(input.workspaceId, async () => {
      const current = await this.read(input.workspaceId);
      if (current.revision !== input.sourceRevision) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_STALE",
          "Workspace environment changed since it was loaded",
        );
      }

      const directory = dirname(filePath);
      await mkdir(directory, { recursive: true });
      const temporaryPath = join(directory, `.environment.${randomUUID()}.tmp`);
      const encoded = new TextEncoder().encode(JSON.stringify(parsed.data));
      try {
        await writeFile(temporaryPath, encoded);
        await rename(temporaryPath, filePath);
      } catch (error) {
        try {
          await unlink(temporaryPath);
        } catch {
          // Cleanup is limited to this operation's own temporary file.
        }
        throw error;
      }

      return {
        document: parsed.data,
        revision: revisionFor(encoded),
        status: "present",
      };
    });
  }

  private enqueueSave<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.saveTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.saveTails.set(workspaceId, current);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.saveTails.get(workspaceId) === current) this.saveTails.delete(workspaceId);
      });
  }
}
