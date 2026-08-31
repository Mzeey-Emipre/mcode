import { definePlugin } from "@oxlint/plugins";
import { namespaceNodeImports } from "./rules/namespace-node-imports.ts";
import { noFunctionScopeZodSchema } from "./rules/no-function-scope-zod-schema.ts";
import { noGlobalHostRuntime } from "./rules/no-global-host-runtime.ts";
import { noNativeTitleTooltip } from "./rules/no-native-title-tooltip.ts";
import { requireLazyNontrivialSchema } from "./rules/require-lazy-nontrivial-schema.ts";

/** Mcode-specific code-quality rules for Oxlint. */
export const mcodePlugin = definePlugin({
  meta: { name: "mcode" },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-function-scope-zod-schema": noFunctionScopeZodSchema,
    "no-global-host-runtime": noGlobalHostRuntime,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "require-lazy-nontrivial-schema": requireLazyNontrivialSchema,
  },
});

export default mcodePlugin;
