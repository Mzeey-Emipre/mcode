import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noFunctionScopeZodSchema } from "../rules/no-function-scope-zod-schema.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

ruleTester.run("no-function-scope-zod-schema", noFunctionScopeZodSchema, {
  valid: [
    {
      name: "module-scope object schema",
      code: 'import { z } from "zod"; const UserSchema = z.object({ id: z.string() });',
    },
    {
      name: "cheap primitive schema chain in a function",
      code: 'import { z } from "zod"; function parse(input: unknown) { return z.string().min(1).optional().parse(input); }',
    },
    {
      name: "cheap literal and enum schema chains in a function",
      code: 'import { z } from "zod"; function schemas() { return [z.literal("open").optional(), z.enum(["open", "closed"]).nullable()]; }',
    },
    {
      name: "array of primitive schemas in a function",
      code: 'import { z } from "zod"; function parse(input: unknown) { return z.array(z.string().min(1)).parse(input); }',
    },
    {
      name: "a shadowed z import is unrelated to Zod",
      code: 'import { z } from "zod"; function parse(z: any, input: unknown) { return z.object({ id: z.string() }).parse(input); }',
    },
    {
      name: "an imported lazySchema factory defers schema construction",
      code: 'import { z } from "zod"; import { lazySchema } from "../utils/lazySchema.js"; const UserSchema = lazySchema(() => z.object({ id: z.string() }));',
    },
    {
      name: "an aliased contracts lazySchema factory defers schema construction",
      code: 'import { z } from "zod"; import { lazySchema as defer } from "./utils/lazySchema.js"; const UserSchema = defer(() => z.object({ id: z.string() }));',
    },
    {
      name: "the contracts lazySchema re-export defers schema construction",
      code: 'import { z } from "zod"; import { lazySchema } from "@mcode/contracts"; const UserSchema = lazySchema(() => z.object({ id: z.string() }));',
    },
  ],
  invalid: [
    {
      name: "immediately parses an object schema created in a function",
      code: 'import { z } from "zod"; function parse(input: unknown) { return z.object({ id: z.string() }).parse(input); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "safe parses a composite schema created in an arrow function",
      code: 'import { z } from "zod"; const parse = (input: unknown) => z.array(z.object({ id: z.string() })).safeParse(input);',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates a union in a nested function",
      code: 'import { z } from "zod"; function outer() { return function inner() { return z.union([z.literal("open"), z.literal("closed")]); }; }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates a discriminated union in a function",
      code: 'import { z } from "zod"; function schema() { return z.discriminatedUnion("kind", [z.object({ kind: z.literal("one") }), z.object({ kind: z.literal("two") })]); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates an intersection in a function",
      code: 'import { z } from "zod"; function schema() { return z.intersection(z.object({ id: z.string() }), z.object({ name: z.string() })); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates a record in a function",
      code: 'import { z } from "zod"; function schema() { return z.record(z.string(), z.object({ id: z.string() })); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates a tuple in a function",
      code: 'import { z } from "zod"; function schema() { return z.tuple([z.string(), z.object({ id: z.string() })]); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "preprocesses a schema in a function",
      code: 'import { z } from "zod"; function schema() { return z.preprocess((value) => value, z.object({ id: z.string() })); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "adds a transform effect in a function",
      code: 'import { z } from "zod"; function schema() { return z.string().transform((value) => value.trim()); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates an object schema from a dynamic shape",
      code: 'import { z } from "zod"; function schema(shape: z.ZodRawShape) { return z.object(shape); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates an array schema from a dynamic item schema",
      code: 'import { z } from "zod"; function schema(item: z.ZodTypeAny) { return z.array(item); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "a local lazySchema function does not create an exemption",
      code: 'import { z } from "zod"; function lazySchema<T>(factory: () => T): T { return factory(); } const UserSchema = lazySchema(() => z.object({ id: z.string() }));',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "an unrelated imported lazySchema does not create an exemption",
      code: 'import { z } from "zod"; import { lazySchema } from "schema-library"; const UserSchema = lazySchema(() => z.object({ id: z.string() }));',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "a local binding shadows an imported contracts lazySchema",
      code: 'import { z } from "zod"; import { lazySchema as defer } from "../utils/lazySchema.js"; function build(defer: any) { return defer(() => z.object({ id: z.string() })); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates a lazy schema in a function",
      code: 'import { z } from "zod"; function schema() { return z.lazy(() => z.string()); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates a map schema in a function",
      code: 'import { z } from "zod"; function schema() { return z.map(z.string(), z.string()); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates a promise schema in a function",
      code: 'import { z } from "zod"; function schema() { return z.promise(z.string()); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "creates a set schema in a function",
      code: 'import { z } from "zod"; function schema() { return z.set(z.string()); }',
      errors: [{ messageId: "hoistSchema" }],
    },
    {
      name: "nested ordinary callbacks in a lazySchema factory still report",
      code: 'import { z } from "zod"; import { lazySchema } from "../utils/lazySchema.js"; const UserSchema = lazySchema(() => { const nestedSchema = () => z.object({ nested: z.string() }); return z.object({ id: z.string() }); });',
      errors: [{ messageId: "hoistSchema" }],
    },
  ],
});
