import { defineRule, type Context, type Definition, type ESTree } from "@oxlint/plugins";

const TITLE_ACCESSIBLE_NAME_ELEMENTS = new Set(["embed", "frame", "iframe", "math", "object"]);
const SHARED_BUTTON_MODULE = "@/components/ui/button";

function getImportBinding(context: Context, name: ESTree.JSXIdentifier): Definition | undefined {
  const reference = context.sourceCode
    .getScope(name)
    .references.find((candidate) => candidate.identifier.start === name.start && candidate.identifier.end === name.end);
  return reference?.resolved?.defs.find((candidate) => candidate.type === "ImportBinding");
}

function isSharedButtonImport(context: Context, name: ESTree.JSXIdentifier): boolean {
  const definition = getImportBinding(context, name);
  if (
    definition?.parent?.type !== "ImportDeclaration"
    || definition.parent.source.value !== SHARED_BUTTON_MODULE
    || definition.node.type !== "ImportSpecifier"
  ) {
    return false;
  }

  const imported = definition.node.imported;
  return (imported.type === "Identifier" ? imported.name : imported.value) === "Button";
}

function shouldCheckElement(context: Context, name: ESTree.JSXElementName): boolean {
  if (name.type !== "JSXIdentifier") {
    return false;
  }

  if (name.name === name.name.toLowerCase()) {
    return !TITLE_ACCESSIBLE_NAME_ELEMENTS.has(name.name);
  }

  return isSharedButtonImport(context, name);
}

function isTitleAttribute(attribute: ESTree.JSXAttributeItem): attribute is ESTree.JSXAttribute {
  return attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier" && attribute.name.name === "title";
}

/** Require Mcode tooltips instead of native title attributes on intrinsic elements. */
export const noNativeTitleTooltip = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      nativeTitleTooltip:
        "Use Mcode Tooltip, TooltipTrigger, and TooltipContent instead of title. Retain aria-label for icon-only controls.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!shouldCheckElement(context, node.name)) {
          return;
        }

        for (const attribute of node.attributes) {
          if (isTitleAttribute(attribute)) {
            context.report({ node: attribute, messageId: "nativeTitleTooltip" });
          }
        }
      },
    };
  },
});
