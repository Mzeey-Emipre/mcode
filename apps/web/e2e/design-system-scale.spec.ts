import { expect, test, type Page } from "@playwright/test";
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
    const buttonBase =
      "inline-flex items-center justify-center rounded-lg border border-transparent font-medium [&_svg:not([class*='size-'])]:size-4";
    const buttonSmall =
      "h-8 gap-1.5 px-2.5 text-sm";
    const buttonMedium =
      "h-12 gap-2 px-3 text-base [&_svg:not([class*='size-'])]:size-6";
    const buttonLarge =
      "h-14 gap-2.5 px-4 text-lg [&_svg:not([class*='size-'])]:size-8";
    const inputSmall =
      "flex h-8 w-full rounded-lg border border-input bg-input px-3 py-1 text-sm";
    const badgeDefault =
      "inline-flex h-5 items-center justify-center rounded-4xl px-2 py-0 text-xs leading-4";
    const badgeSmall =
      "inline-flex h-4 items-center justify-center rounded-4xl px-1 py-0 text-xs leading-4";

    await expect
      .poll(() => measuredStyles(page, `${buttonBase} ${buttonSmall}`, "button"))
      .toEqual(expect.objectContaining({ height: "32px", fontSize: "14px", lineHeight: "16px" }));
    await expect
      .poll(() => measuredStyles(page, `${buttonBase} ${buttonMedium}`, "button"))
      .toEqual(expect.objectContaining({ height: "48px", fontSize: "16px", lineHeight: "20px" }));
    await expect
      .poll(() => measuredStyles(page, `${buttonBase} ${buttonLarge}`, "button"))
      .toEqual(expect.objectContaining({ height: "56px", fontSize: "20px", lineHeight: "24px" }));
    await expect
      .poll(() => measuredStyles(page, "inline-flex size-8 [&_svg:not([class*='size-'])]:size-4", "button"))
      .toEqual(expect.objectContaining({ height: "32px", width: "32px" }));
    await expect
      .poll(() => measuredStyles(page, "inline-flex size-12 [&_svg:not([class*='size-'])]:size-6", "button"))
      .toEqual(expect.objectContaining({ height: "48px", width: "48px" }));
    await expect
      .poll(() => measuredStyles(page, "inline-flex size-14 [&_svg:not([class*='size-'])]:size-8", "button"))
      .toEqual(expect.objectContaining({ height: "56px", width: "56px" }));
    await expect
      .poll(() =>
        page.evaluate(() => {
          const button = document.createElement("button");
          button.className = "inline-flex h-12 [&_svg:not([class*='size-'])]:size-6";
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          button.append(svg);
          document.body.append(button);
          const styles = getComputedStyle(svg);
          const result = { height: styles.height, width: styles.width };
          button.remove();
          return result;
        }),
      )
      .toEqual({ height: "24px", width: "24px" });
    await expect
      .poll(() => measuredStyles(page, inputSmall, "input"))
      .toEqual(expect.objectContaining({ height: "32px", fontSize: "14px", lineHeight: "16px" }));
    await expect
      .poll(() => measuredStyles(page, badgeDefault, "span"))
      .toEqual(expect.objectContaining({ height: "20px", fontSize: "12px", lineHeight: "16px", paddingLeft: "8px" }));
    await expect
      .poll(() => measuredStyles(page, badgeSmall, "span"))
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
