import { defineRule, type Context, type ESTree } from "@oxlint/plugins";

const HOST_RUNTIME_PROPERTIES = new Set(["platform", "arch"]);

function normaliseFilename(filename: string): string {
  return filename.replaceAll("\\", "/");
}

function isAllowedFilename(filename: string): boolean {
  const normalised = normaliseFilename(filename);

  return (
    /(?:^|\/)packages\/shared\/src\/node\/host-runtime\.ts$/.test(normalised)
    || /(?:^|\/)scripts(?:\/|$)/.test(normalised)
    || /(?:^|\/)[^/]+\.config\.[cm]?[jt]sx?$/.test(normalised)
    || /(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__)(?:\/|$)/.test(normalised)
    || /(?:^|\/)(?:dist|out|build|generated|__generated__)(?:\/|$)/.test(normalised)
    || /\.(?:generated|gen)\.[cm]?[jt]sx?$/.test(normalised)
  );
}

function isLocalReference(context: Context, identifier: ESTree.IdentifierReference): boolean {
  return context.sourceCode.scopeManager.scopes.some((scope) =>
    scope.references.some(
      (reference) =>
        reference.identifier.start === identifier.start
        && reference.identifier.end === identifier.end
        && reference.resolved !== null
        && reference.resolved.scope.type !== "global",
    ),
  );
}

function staticPropertyName(computed: boolean, property: ESTree.PropertyKey): string | null {
  if (!computed && property.type === "Identifier") {
    return property.name;
  }

  return computed && property.type === "Literal" && typeof property.value === "string"
    ? property.value
    : null;
}

function isHostProcess(context: Context, expression: ESTree.Expression): boolean {
  if (expression.type === "Identifier") {
    return expression.name === "process" && !isLocalReference(context, expression);
  }

  return (
    expression.type === "MemberExpression"
    && staticPropertyName(expression.computed, expression.property) === "process"
    && expression.object.type === "Identifier"
    && expression.object.name === "globalThis"
    && !isLocalReference(context, expression.object)
  );
}

function isProcessVersions(context: Context, expression: ESTree.Expression): boolean {
  return (
    expression.type === "MemberExpression"
    && staticPropertyName(expression.computed, expression.property) === "versions"
    && isHostProcess(context, expression.object)
  );
}

function isHostRuntimeMember(context: Context, member: ESTree.MemberExpression): boolean {
  const property = staticPropertyName(member.computed, member.property);

  return (
    (property !== null && HOST_RUNTIME_PROPERTIES.has(property) && isHostProcess(context, member.object))
    || (property === "modules" && isProcessVersions(context, member.object))
  );
}

function destructuresProperty(pattern: ESTree.ObjectPattern, propertyName: string): boolean {
  return pattern.properties.some(
    (property) =>
      property.type === "Property"
      && staticPropertyName(property.computed, property.key) === propertyName,
  );
}

function destructuresHostRuntime(
  context: Context,
  pattern: ESTree.ObjectPattern,
  source: ESTree.Expression,
): boolean {
  if (isProcessVersions(context, source)) {
    return destructuresProperty(pattern, "modules");
  }

  if (!isHostProcess(context, source)) {
    return false;
  }

  return pattern.properties.some((property) => {
    if (property.type !== "Property") {
      return false;
    }

    const propertyName = staticPropertyName(property.computed, property.key);
    return (
      (propertyName !== null && HOST_RUNTIME_PROPERTIES.has(propertyName))
      || (propertyName === "versions"
        && property.value.type === "ObjectPattern"
        && destructuresProperty(property.value, "modules"))
    );
  });
}

function isWriteOnlyMember(member: ESTree.MemberExpression): boolean {
  return (
    (member.parent.type === "AssignmentExpression"
      && member.parent.left === member
      && member.parent.operator === "=")
    || (member.parent.type === "UpdateExpression" && member.parent.argument === member)
    || (member.parent.type === "UnaryExpression"
      && member.parent.operator === "delete"
      && member.parent.argument === member)
  );
}

/** Prevent production code from reading host-runtime facts outside their boundary. */
export const noGlobalHostRuntime = defineRule({
  meta: {
    type: "problem",
    messages: {
      hostRuntime: "Read host-runtime facts through @mcode/shared/node/host-runtime at composition boundaries or pass explicit injected facts.",
    },
  },
  create(context) {
    const isAllowedFile = isAllowedFilename(context.filename);

    return {
      MemberExpression(node) {
        if (
          isAllowedFile
          || isWriteOnlyMember(node)
          || !isHostRuntimeMember(context, node)
        ) {
          return;
        }

        context.report({ node, messageId: "hostRuntime" });
      },
      VariableDeclarator(node) {
        if (
          isAllowedFile
          || node.id.type !== "ObjectPattern"
          || node.init === null
          || !destructuresHostRuntime(context, node.id, node.init)
        ) {
          return;
        }

        context.report({ node: node.id, messageId: "hostRuntime" });
      },
    };
  },
});
