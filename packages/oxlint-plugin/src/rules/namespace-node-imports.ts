import { defineRule } from "@oxlint/plugins";
import * as NodeModule from "node:module";

const INITIALISMS = new Map([
  ["dns", "DNS"],
  ["fs", "FS"],
  ["http", "HTTP"],
  ["https", "HTTPS"],
  ["os", "OS"],
  ["tls", "TLS"],
  ["tty", "TTY"],
  ["url", "URL"],
  ["v8", "V8"],
  ["vm", "VM"],
]);

const NODE_BUILTIN_MODULES = new Set(NodeModule.builtinModules);

// Bun adds these runtime APIs to builtinModules, but they are not Node built-ins.
const BUN_ONLY_BUILTIN_MODULES = new Set(["bun", "undici", "ws"]);

function isBunOnlyBuiltin(source: string): boolean {
  return source.startsWith("bun:") || BUN_ONLY_BUILTIN_MODULES.has(source);
}

function getNodeBuiltinPath(source: string): string | null {
  if (source.startsWith("node:")) {
    return source.slice("node:".length);
  }

  return !isBunOnlyBuiltin(source) && NODE_BUILTIN_MODULES.has(source) ? source : null;
}

function formatNodeModuleSegment(segment: string): string {
  return segment
    .split(/[_-]/)
    .map((word) => INITIALISMS.get(word) ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join("");
}

function canonicalNodeAlias(modulePath: string): string {
  return `Node${modulePath.split("/").map(formatNodeModuleSegment).join("")}`;
}

/** Require namespace imports for Node built-in modules. */
export const namespaceNodeImports = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      namespaceImport: "Use exactly one namespace import with the canonical Node alias for Node built-ins.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const modulePath = getNodeBuiltinPath(node.source.value);
        if (modulePath === null || node.specifiers.length === 0) {
          return;
        }

        const [specifier] = node.specifiers;
        const expectedAlias = canonicalNodeAlias(modulePath);
        if (
          node.specifiers.length !== 1
          || specifier?.type !== "ImportNamespaceSpecifier"
          || specifier.local.name !== expectedAlias
        ) {
          context.report({ node: node.source, messageId: "namespaceImport" });
        }
      },
    };
  },
});
