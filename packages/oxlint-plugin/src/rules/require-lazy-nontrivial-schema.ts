import { defineRule, type Context, type Definition, type ESTree } from "@oxlint/plugins";

const NON_TRIVIAL_ZOD_METHODS = new Set([
  "array",
  "discriminatedUnion",
  "intersection",
  "lazy",
  "map",
  "object",
  "promise",
  "record",
  "set",
  "tuple",
  "union",
]);

const EXPRESSION_WRAPPER_TYPES = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
]);

const CONTRACTS_LAZY_SCHEMA_MODULES = new Set([
  "./utils/lazySchema.js",
  "../utils/lazySchema.js",
]);

type ExpressionWrapper =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSAsExpression
  | ESTree.TSSatisfiesExpression
  | ESTree.TSTypeAssertion
  | ESTree.TSNonNullExpression;

type ImportSpecifier = ESTree.ImportDeclaration["specifiers"][number];
type ZodImport = { type: "namespace" } | { type: "named"; name: string };

function isContractsFile(filename: string): boolean {
  return filename.replaceAll("\\", "/").includes("/packages/contracts/");
}

function getImportBinding(context: Context, identifier: ESTree.IdentifierReference): Definition | undefined {
  const reference = context.sourceCode
    .getScope(identifier)
    .references.find((candidate) => candidate.identifier === identifier);
  return reference?.resolved?.defs.find((candidate) => candidate.type === "ImportBinding");
}

function getZodImport(context: Context, identifier: ESTree.IdentifierReference): ZodImport | null {
  const definition = getImportBinding(context, identifier);
  if (definition?.parent?.type !== "ImportDeclaration" || definition.parent.source.value !== "zod") {
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

function isContractsLazySchemaImport(source: string, specifier: ImportSpecifier): boolean {
  return (
    CONTRACTS_LAZY_SCHEMA_MODULES.has(source)
    && specifier.type === "ImportSpecifier"
    && specifier.imported.type === "Identifier"
    && specifier.imported.name === "lazySchema"
  );
}

function isExpressionWrapper(expression: ESTree.Expression): expression is ExpressionWrapper {
  return EXPRESSION_WRAPPER_TYPES.has(expression.type);
}

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  return isExpressionWrapper(expression) ? expression.expression : expression;
}

function initialZodMethodChain(context: Context, identifier: ESTree.IdentifierReference): string[] | null {
  const imported = getZodImport(context, identifier);
  if (imported?.type === "namespace") {
    return [];
  }

  return imported?.type === "named" ? [imported.name] : null;
}

function zodMethodChain(
  expression: ESTree.Expression,
  context: Context,
): string[] | null {
  if (expression.type === "CallExpression") {
    return zodMethodChain(expression.callee, context);
  }

  const unwrapped = unwrapExpression(expression);
  if (unwrapped !== expression) {
    return zodMethodChain(unwrapped, context);
  }

  if (unwrapped.type === "Identifier") {
    return initialZodMethodChain(context, unwrapped);
  }

  if (unwrapped.type !== "MemberExpression" || unwrapped.computed) {
    return null;
  }

  const methods = zodMethodChain(unwrapped.object, context);
  return methods === null ? null : [unwrapped.property.name, ...methods];
}

function isNontrivialZodBuilder(
  expression: ESTree.Expression,
  context: Context,
): boolean {
  return zodMethodChain(expression, context)?.some((method) =>
    NON_TRIVIAL_ZOD_METHODS.has(method),
  ) ?? false;
}

function isLazySchemaFactory(
  expression: ESTree.Expression,
  lazySchemaAliases: ReadonlySet<string>,
): boolean {
  if (
    expression.type !== "CallExpression"
    || expression.callee.type !== "Identifier"
    || !lazySchemaAliases.has(expression.callee.name)
    || expression.arguments.length !== 1
  ) {
    return false;
  }

  const [factory] = expression.arguments;
  return factory?.type === "ArrowFunctionExpression" || factory?.type === "FunctionExpression";
}

function containsNontrivialZodFunctionBody(
  expression: ESTree.ArrowFunctionExpression | ESTree.Function,
  context: Context,
): boolean {
  const body = expression.body;
  if (body === null) {
    return false;
  }

  if (body.type !== "BlockStatement") {
    return containsNontrivialZodBuilder(body, context);
  }

  return body.body.some(
    (statement) =>
      statement.type === "ReturnStatement"
      && statement.argument !== null
      && containsNontrivialZodBuilder(statement.argument, context),
  );
}

function containsNontrivialZodArgument(
  argument: ESTree.Argument,
  context: Context,
): boolean {
  return argument.type !== "SpreadElement" && containsNontrivialZodBuilder(argument, context);
}

function containsNontrivialZodMember(
  expression: ESTree.MemberExpression,
  context: Context,
): boolean {
  return (
    containsNontrivialZodBuilder(expression.object, context)
    || (expression.computed
      && containsNontrivialZodBuilder(expression.property, context))
  );
}

function containsNontrivialZodBuilder(
  expression: ESTree.Expression,
  context: Context,
): boolean {
  if (isNontrivialZodBuilder(expression, context)) {
    return true;
  }

  const unwrapped = unwrapExpression(expression);
  if (unwrapped !== expression) {
    return containsNontrivialZodBuilder(unwrapped, context);
  }

  if (unwrapped.type === "ArrowFunctionExpression" || unwrapped.type === "FunctionExpression") {
    return containsNontrivialZodFunctionBody(unwrapped, context);
  }

  if (unwrapped.type === "CallExpression") {
    return unwrapped.arguments.some((argument) =>
      containsNontrivialZodArgument(argument, context),
    );
  }

  return unwrapped.type === "MemberExpression"
    && containsNontrivialZodMember(unwrapped, context);
}

/** Require lazySchema for exported non-trivial contract schemas. */
export const requireLazyNontrivialSchema = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      lazySchema: "Wrap exported non-trivial contract schemas in lazySchema(() => ...).",
    },
  },
  create(context) {
    const lazySchemaAliases = new Set<string>();

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (isContractsLazySchemaImport(node.source.value, specifier)) {
            lazySchemaAliases.add(specifier.local.name);
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (!isContractsFile(context.filename) || node.declaration?.type !== "VariableDeclaration") {
          return;
        }

        for (const declaration of node.declaration.declarations) {
          if (
            declaration.id.type === "Identifier"
            && declaration.id.name.endsWith("Schema")
            && declaration.init !== null
            && !isLazySchemaFactory(declaration.init, lazySchemaAliases)
            && containsNontrivialZodBuilder(declaration.init, context)
          ) {
            context.report({ node: declaration.init, messageId: "lazySchema" });
          }
        }
      },
    };
  },
});
