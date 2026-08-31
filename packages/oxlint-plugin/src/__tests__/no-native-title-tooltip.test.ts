import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noNativeTitleTooltip } from "../rules/no-native-title-tooltip.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

ruleTester.run("no-native-title-tooltip", noNativeTitleTooltip, {
  valid: [
    {
      name: "title prop on a component",
      code: "const element = <Button title />;",
    },
    {
      name: "title prop on an unrelated Button component",
      code: 'import { Button } from "@domain/ui"; const element = <Button title="Close" />;',
    },
    {
      name: "a local Button binding shadows the shared primitive",
      code: 'import { Button } from "@/components/ui/button"; function render(Button: any) { return <Button title="Close" />; }',
    },
    {
      name: "title prop on a member component",
      code: 'const element = <Mcode.Button title="Close" />;',
    },
    {
      name: "title prop on a namespaced element",
      code: 'const element = <svg:rect title="Graphic" />;',
    },
    {
      name: "accessible embedded elements",
      code: 'const element = <><embed title="Document" /><frame title="Legacy document" /><iframe title="Preview" /><math title="Equation" /><object title="Chart" /></>;',
    },
    {
      name: "non-JSX title data",
      code: 'const title = "Close"; const metadata = { title: "Close" };',
    },
    {
      name: "title inside a spread attribute",
      code: 'const props = { title: "Close" }; const element = <button {...props} />;',
    },
  ],
  invalid: [
    {
      name: "native button title",
      code: 'const element = <button title="Close" />;',
      errors: [
        {
          message:
            "Use Mcode Tooltip, TooltipTrigger, and TooltipContent instead of title. Retain aria-label for icon-only controls.",
        },
      ],
    },
    {
      name: "native div title",
      code: 'const element = <div title="Description" />;',
      errors: [{ messageId: "nativeTitleTooltip" }],
    },
    {
      name: "native input title",
      code: 'const element = <input title="Search" />;',
      errors: [{ messageId: "nativeTitleTooltip" }],
    },
    {
      name: "native span title",
      code: 'const element = <span title="Status" />;',
      errors: [{ messageId: "nativeTitleTooltip" }],
    },
    {
      name: "native title JSX expression",
      code: 'const label = "Close"; const element = <button title={label} />;',
      errors: [{ messageId: "nativeTitleTooltip" }],
    },
    {
      name: "title prop on the shared Button primitive",
      code: 'import { Button } from "@/components/ui/button"; const element = <Button title="Close" />;',
      errors: [{ messageId: "nativeTitleTooltip" }],
    },
    {
      name: "title prop on an aliased shared Button primitive",
      code: 'import { Button as ActionButton } from "@/components/ui/button"; const element = <ActionButton title="Close" />;',
      errors: [{ messageId: "nativeTitleTooltip" }],
    },
  ],
});
