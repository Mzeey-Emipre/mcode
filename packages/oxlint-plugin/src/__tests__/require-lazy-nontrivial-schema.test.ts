import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { requireLazyNontrivialSchema } from "../rules/require-lazy-nontrivial-schema.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

ruleTester.run("require-lazy-nontrivial-schema", requireLazyNontrivialSchema, {
  valid: [
    {
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; export const NameSchema = z.string().min(1);',
    },
    {
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; export const StateSchema = z.enum(["open", "closed"]);',
    },
    {
      name: "a non-Zod named object helper is unrelated",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { object } from "domain-schema"; export const UserSchema = object({ id: "string" });',
    },
    {
      name: "a local object binding shadows a named Zod builder",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { object } from "zod"; function defer<T>(factory: () => T): T { return factory(); } export const UserSchema = defer(() => { const object = (shape: unknown) => shape; return object({ id: "string" }); });',
    },
    {
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; import { lazySchema } from "../utils/lazySchema.js"; export const UserSchema = lazySchema(() => z.object({ id: z.string() }));',
    },
    {
      filename: "packages/contracts/src/models/schema.ts",
      code: 'import { z } from "zod"; import { lazySchema as defer } from "../utils/lazySchema.js"; export const UserSchema = defer(() => z.object({ id: z.string() }));',
    },
    {
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; const UserSchema = z.object({ id: z.string() });',
    },
    {
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; export const userValidator = z.object({ id: z.string() });',
    },
    {
      filename: "packages/shared/src/schema.ts",
      code: 'import { z } from "zod"; export const UserSchema = z.object({ id: z.string() });',
    },
  ],
  invalid: [
    {
      name: "exported object schema in contracts",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; export const UserSchema = z.object({ id: z.string() });',
      errors: [{ messageId: "lazySchema" }],
    },
    {
      name: "exported array schema in contracts",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; export const UsersSchema = z.string().array();',
      errors: [{ messageId: "lazySchema" }],
    },
    {
      name: "lazySchema receives an already-created schema",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; import { lazySchema } from "../utils/lazySchema.js"; export const UserSchema = lazySchema(z.object({ id: z.string() }));',
      errors: [{ messageId: "lazySchema" }],
    },
    {
      name: "an unrelated imported lazySchema is not the contracts helper",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; import { lazySchema } from "schema-library"; export const UserSchema = lazySchema(() => z.object({ id: z.string() }));',
      errors: [{ messageId: "lazySchema" }],
    },
    {
      name: "a local lazySchema function is not the contracts helper",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { z } from "zod"; function lazySchema<T>(factory: () => T): T { return factory(); } export const UserSchema = lazySchema(() => z.object({ id: z.string() }));',
      errors: [{ messageId: "lazySchema" }],
    },
    {
      name: "a named Zod object builder requires lazySchema",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { object } from "zod"; export const UserSchema = object({});',
      errors: [{ messageId: "lazySchema" }],
    },
    {
      name: "an aliased named Zod object builder requires lazySchema",
      filename: "packages/contracts/src/schema.ts",
      code: 'import { object as zObject } from "zod"; export const UserSchema = zObject({});',
      errors: [{ messageId: "lazySchema" }],
    },
  ],
});
