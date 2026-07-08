import { expect, test, type Page } from "@playwright/test";
import { badgeVariants } from "../src/components/ui/badge";
import { buttonVariants } from "../src/components/ui/button";
import { inputVariants } from "../src/components/ui/input";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

async function setup(page: Page): Promise<void> {
  await mockWebSocketServer(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

async function measuredStyles(
  page: Page,
  className: string,
  tagName = "div",
): Promise<{
  fontSize: string;
  height: string;
  lineHeight: string;
  paddingLeft: string;
  borderRadius: string;
  gap: string;
  width: string;
}> {
  return page.evaluate(
    ({ className: klass, tagName: tag }) => {
      const el = document.createElement(tag);
      el.className = klass;
      el.textContent = "Scale";
      document.body.append(el);
      const styles = getComputedStyle(el);
      const result = {
        fontSize: styles.fontSize,
        height: styles.height,
        lineHeight: styles.lineHeight,
        paddingLeft: styles.paddingLeft,
        borderRadius: styles.borderRadius,
        gap: styles.gap,
        width: styles.width,
      };
      el.remove();
      return result;
    },
    { className, tagName },
  );
}

test.describe("Design system scale", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("sets the decimal rem root and preserves Tailwind spacing math", async ({ page }) => {
    const rootFontSize = await page.evaluate(() =>
      getComputedStyle(document.documentElement).fontSize,
    );
    expect(rootFontSize).toBe("10px");

    await expect
      .poll(() => measuredStyles(page, "h-8 w-8 p-4 gap-4 flex"))
      .toEqual(expect.objectContaining({
        gap: "16px",
        height: "32px",
        paddingLeft: "16px",
        width: "32px",
      }));
  });

  test("maps Tailwind text utilities to the documented type scale", async ({ page }) => {
    const expected = [
      ["text-xs", "12px", "16px"],
      ["text-sm", "14px", "16px"],
      ["text-base", "16px", "20px"],
      ["text-lg", "20px", "24px"],
      ["text-xl", "24px", "28px"],
      ["text-2xl", "28px", "32px"],
      ["text-3xl", "32px", "40px"],
      ["text-4xl", "40px", "48px"],
      ["text-5xl", "48px", "56px"],
    ];

    for (const [className, fontSize, lineHeight] of expected) {
      await expect
        .poll(() => measuredStyles(page, className))
        .toEqual(expect.objectContaining({ fontSize, lineHeight }));
    }
  });

  test("maps radius utilities to the documented radius tokens", async ({ page }) => {
    const expected = [
      ["rounded-sm", "6px"],
      ["rounded-md", "8px"],
      ["rounded-lg", "10px"],
      ["rounded-xl", "14px"],
      ["rounded-2xl", "18px"],
      ["rounded-3xl", "22px"],
      ["rounded-4xl", "26px"],
    ];

    for (const [className, borderRadius] of expected) {
      await expect
        .poll(() => measuredStyles(page, className))
        .toEqual(expect.objectContaining({ borderRadius }));
    }
  });

  test("maps Button, Input, and Badge classes to documented computed sizes", async ({ page }) => {
    await expect
      .poll(() => measuredStyles(page, buttonVariants({ size: "sm" }), "button"))
      .toEqual(expect.objectContaining({
        gap: "8px",
        height: "32px",
        fontSize: "14px",
        lineHeight: "16px",
        paddingLeft: "12px",
      }));
    await expect
      .poll(() => measuredStyles(page, buttonVariants({ size: "md" }), "button"))
      .toEqual(expect.objectContaining({
        gap: "8px",
        height: "48px",
        fontSize: "16px",
        lineHeight: "20px",
        paddingLeft: "12px",
      }));
    await expect
      .poll(() => measuredStyles(page, buttonVariants({ size: "lg" }), "button"))
      .toEqual(expect.objectContaining({
        gap: "8px",
        height: "56px",
        fontSize: "20px",
        lineHeight: "24px",
        paddingLeft: "16px",
      }));
    await expect
      .poll(() => measuredStyles(page, buttonVariants({ size: "icon-sm" }), "button"))
      .toEqual(expect.objectContaining({ height: "32px", width: "32px" }));
    await expect
      .poll(() => measuredStyles(page, buttonVariants({ size: "icon-md" }), "button"))
      .toEqual(expect.objectContaining({ height: "48px", width: "48px" }));
    await expect
      .poll(() => measuredStyles(page, buttonVariants({ size: "icon-lg" }), "button"))
      .toEqual(expect.objectContaining({ height: "56px", width: "56px" }));
    await expect
      .poll(() =>
        page.evaluate((className) => {
          const button = document.createElement("button");
          button.className = className;
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          button.append(svg);
          document.body.append(button);
          const styles = getComputedStyle(svg);
          const result = { height: styles.height, width: styles.width };
          button.remove();
          return result;
        }, buttonVariants({ size: "icon-md" })),
      )
      .toEqual({ height: "24px", width: "24px" });
    await expect
      .poll(() => measuredStyles(page, inputVariants({ size: "sm" }), "input"))
      .toEqual(expect.objectContaining({ height: "32px", fontSize: "14px", lineHeight: "16px" }));
    await expect
      .poll(() => measuredStyles(page, badgeVariants({ size: "default" }), "span"))
      .toEqual(expect.objectContaining({ height: "20px", fontSize: "12px", lineHeight: "16px", paddingLeft: "8px" }));
    await expect
      .poll(() => measuredStyles(page, badgeVariants({ size: "sm" }), "span"))
      .toEqual(expect.objectContaining({ height: "16px", fontSize: "12px", lineHeight: "16px", paddingLeft: "4px" }));
  });

  test("captures scale evidence screenshots", async ({ page }, testInfo) => {
    for (const size of [
      { width: 1440, height: 900, name: "design-scale-1440x900.png" },
      { width: 900, height: 700, name: "design-scale-900x700.png" },
      { width: 390, height: 844, name: "design-scale-390x844.png" },
    ]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.screenshot({
        path: testInfo.outputPath(size.name),
        fullPage: false,
      });
    }
  });
});
