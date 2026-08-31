import { RuleTester } from "oxlint/plugins-dev";
import { describe, it, vi } from "vitest";

vi.mock("node:module", async (importOriginal) => {
  const module = await importOriginal<typeof import("node:module")>();
  return {
    ...module,
    builtinModules: [...module.builtinModules, "ws", "undici", "bun", "bun:sqlite"],
  };
});

import { namespaceNodeImports } from "../rules/namespace-node-imports.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

ruleTester.run("namespace-node-imports", namespaceNodeImports, {
  valid: [
    'import * as NodeFS from "node:fs";',
    'import type * as NodePath from "node:path";',
    'import * as NodeFSPromises from "node:fs/promises";',
    'import * as NodeChildProcess from "node:child_process";',
    'import * as NodeURL from "node:url";',
    'import * as NodeFS from "fs";',
    'import * as NodeFSPromises from "fs/promises";',
    'import * as NodeAssertStrict from "assert/strict";',
    'import { readFile } from "@mcode/shared";',
    'import { readFile } from "fs-extra";',
    'import { suite } from "test";',
    'import type { WebSocket } from "ws";',
    'import { fetch } from "undici";',
    'import { file } from "bun";',
    'import { Database } from "bun:sqlite";',
    'import "node:fs";',
    'import "fs";',
  ],
  invalid: [
    {
      name: "named imports from a Node built-in",
      code: 'import { readFile } from "node:fs";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "default imports from a Node built-in",
      code: 'import Fs from "node:fs";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "mixed imports from a Node built-in",
      code: 'import Fs, * as NodeFS from "node:fs";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "non-canonical aliases from nested Node built-ins",
      code: 'import * as NodeFsPromises from "node:fs/promises";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "type-only named imports from a Node built-in",
      code: 'import type { PathLike } from "node:path";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "bare named imports from a Node built-in",
      code: 'import { readFile } from "fs";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "bare default imports from a Node built-in",
      code: 'import Fs from "fs";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "bare non-canonical namespace imports from a Node built-in",
      code: 'import * as Fs from "fs";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "bare named imports from nested Node built-ins",
      code: 'import { readFile } from "fs/promises";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "bare non-canonical namespace imports from strict assertions",
      code: 'import * as NodeAssert from "assert/strict";',
      errors: [{ messageId: "namespaceImport" }],
    },
    {
      name: "any explicit node source remains in scope",
      code: 'import { runtime } from "node:external-runtime";',
      errors: [{ messageId: "namespaceImport" }],
    },
  ],
});
