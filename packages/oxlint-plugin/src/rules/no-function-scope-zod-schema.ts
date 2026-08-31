import { defineRule, type Context, type Definition, type ESTree } from "@oxlint/plugins";

const NON_TRIVIAL_BUILDERS = new Set([
  "discriminatedUnion",
  "effect",
  "intersection",
  "lazy",
  "map",
  "object",
  "promise",
  "preprocess",
  "record",
  "set",
  "tuple",
  "union",
]);

const SCHEMA_BUILDERS = new Set([
  "any",
  "array",
  "bigint",
  "boolean",
  "date",
  "discriminatedUnion",
  "effect",
  "enum",
  "instanceof",
  "intersection",
  "lazy",
  "literal",
  "map",
  "nativeEnum",
  "never",
  "null",
  "number",
  "object",
  "promise",
  "preprocess",
  "record",
  "set",
  "string",
  "symbol",
  "tuple",
  "undefined",
  "union",
  "unknown",
  "void",
]);

const EFFECT_METHODS = new Set(["refine", "superRefine", "transform"]);
const COMPOSITE_METHODS = new Set(["and", "merge", "or", "pipe"]);
const PARSE_METHODS = new Set(["parse", "safeParse"]);
const CONTRACTS_LAZY_SCHEMA_MODULES = new Set([
  "@mcode/contracts",
  "./utils/lazySchema.js",
  "../utils/lazySchema.js",
]);

type ZodImport = { type: "namespace" } | { type: "named"; name: string };

function isCallExpression(node: unknown): node is ESTree.CallExpression {
  return typeof node === "object" && node !== null && "type" in node && node.type === "CallExpression";
}

function getImportBinding(context: Context, identifier: ESTree.IdentifierReference): Definition | undefined {
  const reference = context.sourceCode
    .getScope(identifier)
    .references.find((candidate) => candidate.identifier === identifier);
  return reference?.resolved?.defs.find((candidate) => candidate.type === "ImportBinding");
}

function isZodImportBinding(definition: Definition | undefined): definition is Definition {
  return definition?.parent?.type === "ImportDeclaration" && definition.parent.source.value === "zod";
}

function getZodImport(context: Context, identifier: ESTree.IdentifierReference): ZodImport | null {
  const definition = getImportBinding(context, identifier);
  if (!isZodImportBinding(definition)) {
    return null;
  }

  if (definition.node.type === "ImportNamespaceSpecifier") {
    return { type: "namespace" };
  }

  if (definition.node.type !== "ImportSpecifier") {
    return null;
  }

  const imported = definition.node.imported;
  const name = imported.type === "Identifier" ? imported.name : imported.value;
  return name === "z" ? { type: "namespace" } : { type: "named", name };
}

function isImportedLazySchema(context: Context, identifier: ESTree.IdentifierReference): boolean {
  const definition = getImportBinding(context, identifier);
  if (
    definition?.parent?.type !== "ImportDeclaration"
    || !CONTRACTS_LAZY_SCHEMA_MODULES.has(definition.parent.source.value)
    || definition.node.type !== "ImportSpecifier"
  ) {
    return false;
  }

  const imported = definition.node.imported;
  const name = imported.type === "Identifier" ? imported.name : imported.value;
  return name === "lazySchema";
}

function isLazySchemaFactoryCallback(
  context: Context,
  node: ESTree.Function | ESTree.ArrowFunctionExpression,
): boolean {
  const parent = node.parent;
  return (
    parent.type === "CallExpression"
    && parent.arguments.length === 1
    && parent.arguments[0] === node
    && parent.callee.type === "Identifier"
    && isImportedLazySchema(context, parent.callee)
  );
}

function isZodNamespace(context: Context, expression: ESTree.Expression): boolean {
  let root = expression;
  while (root.type === "MemberExpression") {
    root = root.object;
  }

  return root.type === "Identifier" && getZodImport(context, root)?.type === "namespace";
}

function getZodBuilderName(context: Context, node: ESTree.CallExpression): string | null {
  if (node.callee.type === "Identifier") {
    const imported = getZodImport(context, node.callee);
    return imported?.type === "named" && SCHEMA_BUILDERS.has(imported.name) ? imported.name : null;
  }

  if (node.callee.type !== "MemberExpression" || node.callee.computed || !isZodNamespace(context, node.callee)) {
    return null;
  }

  return SCHEMA_BUILDERS.has(node.callee.property.name) ? node.callee.property.name : null;
}

function getSchemaMethodName(context: Context, node: ESTree.CallExpression): string | null {
  if (node.callee.type !== "MemberExpression" || node.callee.computed) {
    return null;
  }

  return isZodSchemaExpression(context, node.callee.object) ? node.callee.property.name : null;
}

function isZodSchemaExpression(context: Context, expression: ESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  return getZodBuilderName(context, expression) !== null || getSchemaMethodName(context, expression) !== null;
}

function isCompositeArrayItem(context: Context, argument: ESTree.Argument | undefined): boolean {
  if (argument === undefined || argument.type === "SpreadElement" || !isZodSchemaExpression(context, argument)) {
    return true;
  }

  return isCompositeSchemaExpression(context, argument);
}

function isCompositeSchemaExpression(context: Context, expression: ESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const builder = getZodBuilderName(context, expression);
  if (builder !== null) {
    return builder === "array" || NON_TRIVIAL_BUILDERS.has(builder);
  }

  const method = getSchemaMethodName(context, expression);
  if (method === null || expression.callee.type !== "MemberExpression") {
    return false;
  }

  return method === "array" || EFFECT_METHODS.has(method) || COMPOSITE_METHODS.has(method)
    || isCompositeSchemaExpression(context, expression.callee.object);
}

function isNonTrivialBuilder(context: Context, node: ESTree.CallExpression): boolean | null {
  const builder = getZodBuilderName(context, node);
  if (builder === null) {
    return null;
  }

  return builder === "array"
    ? isCompositeArrayItem(context, node.arguments[0])
    : NON_TRIVIAL_BUILDERS.has(builder);
}

function isDirectParseOfNonTrivialSchema(context: Context, node: ESTree.CallExpression): boolean {
  return node.callee.type === "MemberExpression"
    && node.callee.object.type === "CallExpression"
    && isNonTrivialSchemaConstruction(context, node.callee.object);
}

function isNonTrivialSchemaMethod(context: Context, node: ESTree.CallExpression): boolean {
  const method = getSchemaMethodName(context, node);
  if (method === null) {
    return false;
  }

  if (EFFECT_METHODS.has(method) || COMPOSITE_METHODS.has(method)) {
    return true;
  }

  if (method === "array") {
    return node.callee.type === "MemberExpression"
      && isCompositeSchemaExpression(context, node.callee.object);
  }

  return PARSE_METHODS.has(method) && isDirectParseOfNonTrivialSchema(context, node);
}

function isNonTrivialSchemaConstruction(context: Context, node: ESTree.CallExpression): boolean {
  return isNonTrivialBuilder(context, node) ?? isNonTrivialSchemaMethod(context, node);
}

function hasNonTrivialSchemaAncestor(context: Context, node: ESTree.CallExpression): boolean {
  return context.sourceCode
    .getAncestors(node)
    .some((ancestor) => isCallExpression(ancestor) && isNonTrivialSchemaConstruction(context, ancestor));
}

/** Disallow repeated non-trivial Zod schema construction in function scope. */
export const noFunctionScopeZodSchema = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      hoistSchema: "Hoist this non-trivial Zod schema to module scope. Use lazySchema for non-trivial contract schemas.",
    },
  },
  create(context) {
    const functionFactories: boolean[] = [];

    function enterFunction(node: ESTree.Function | ESTree.ArrowFunctionExpression): void {
      functionFactories.push(isLazySchemaFactoryCallback(context, node));
    }

    return {
      FunctionDeclaration(node) {
        enterFunction(node);
      },
      "FunctionDeclaration:exit"() {
        functionFactories.pop();
      },
      FunctionExpression(node) {
        enterFunction(node);
      },
      "FunctionExpression:exit"() {
        functionFactories.pop();
      },
      ArrowFunctionExpression(node) {
        enterFunction(node);
      },
      "ArrowFunctionExpression:exit"() {
        functionFactories.pop();
      },
      CallExpression(node) {
        if (
          functionFactories.length > 0
          && !functionFactories.at(-1)
          && isNonTrivialSchemaConstruction(context, node)
          && !hasNonTrivialSchemaAncestor(context, node)
        ) {
          context.report({ node, messageId: "hoistSchema" });
        }
      },
    };
  },
});
