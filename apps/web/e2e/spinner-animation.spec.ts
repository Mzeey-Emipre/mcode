import { test, expect } from "@playwright/test";

/** Sample computed transform on an element to detect CSS animation motion. */
async function sampleTransform(page: import("@playwright/test").Page, selector: string) {
  return page.$eval(selector, (el) => {
    const style = getComputedStyle(el);
    return {
      animationName: style.animationName,
      transform: style.transform,
    };
  });
}

test.describe("status indicator animations", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      const spin = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      spin.id = "spin";
      spin.setAttribute("class", "status-spin");
      spin.setAttribute("width", "16");
      spin.setAttribute("height", "16");
      spin.setAttribute("viewBox", "0 0 24 24");
      spin.innerHTML = '<circle cx="12" cy="12" r="10" stroke="currentColor" fill="none" />';
      document.body.appendChild(spin);

      const pulse = document.createElement("span");
      pulse.id = "pulse";
      pulse.className = "status-pulse";
      pulse.textContent = "blob";
      document.body.appendChild(pulse);
    });
  });

  test("status-spin rotates loader icons", async ({ page }) => {
    const first = await sampleTransform(page, "#spin");
    await page.waitForTimeout(400);
    const second = await sampleTransform(page, "#spin");

    expect(first.animationName).not.toBe("none");
    expect(first.animationName).toContain("spin");
    expect(second.transform).not.toBe(first.transform);
  });

  test("status-pulse animates agent dots", async ({ page }) => {
    const name = await page.$eval("#pulse", (el) => getComputedStyle(el).animationName);
    expect(name).not.toBe("none");
    expect(name).toContain("pulse");
  });

  test("prefers-reduced-motion disables status indicator motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const spin = await sampleTransform(page, "#spin");
    const pulse = await page.$eval("#pulse", (el) => getComputedStyle(el).animationName);
    expect(spin.animationName).toBe("none");
    expect(pulse).toBe("none");
  });

  test("status classes ship in app css on first load", async ({ page }) => {
    const cssText = await page.evaluate(() => {
      const chunks: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules ?? [])) {
            chunks.push(rule.cssText);
          }
        } catch {
          // Cross-origin stylesheets are not readable.
        }
      }
      return chunks.join("\n");
    });

    expect(cssText).toMatch(/\.status-spin\s*\{[^}]*animation:[^}]*spin/);
    expect(cssText).toMatch(/\.status-pulse\s*\{[^}]*animation:[^}]*pulse/);
    expect(cssText).toMatch(/\.spinner-tail-fade\s*\{[^}]*conic-gradient/);
  });
});
