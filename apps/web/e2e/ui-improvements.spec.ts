import { test, expect } from "@playwright/test";

/**
 * Verifies that the brand color and font have been migrated away from the
 * AI-default indigo palette and DM Sans to warm amber and Space Grotesk.
 */
test("brand color is amber (not indigo hue 264) in dark mode", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");

  // Add the dark class to html so we can read the dark-mode CSS variable
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
  });

  const primaryValue = await page.evaluate(() => {
    return getComputedStyle(document.documentElement)
      .getPropertyValue("--primary")
      .trim();
  });

  // The old indigo primary contained hue 264; amber should not
  expect(primaryValue).not.toContain("264");
});

test("body font-family does not include DM Sans", async ({ page }) => {
  await page.goto("http://localhost:5173");

  const fontFamily = await page.evaluate(() => {
    return getComputedStyle(document.body).fontFamily;
  });

  expect(fontFamily.toLowerCase()).not.toContain("dm sans");
});

test("glow-primary box-shadow uses amber, not hue 264", async ({ page }) => {
  await page.goto("http://localhost:5173");

  await page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "glow-primary";
    document.body.appendChild(el);
  });

  // Read the authored CSS rule text rather than the computed style, because
  // Chromium resolves oklch() to rgba() in getComputedStyle(), which loses
  // the hue value we need to assert on.
  const glowShadow = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (
            rule instanceof CSSStyleRule &&
            rule.selectorText === ".glow-primary"
          ) {
            return rule.style.getPropertyValue("box-shadow");
          }
        }
      } catch {
        /* cross-origin stylesheet */
      }
    }
    return "";
  });

  // Old indigo glow used hue 264; amber should not
  expect(glowShadow).not.toContain("264");
  // Amber hue is 75
  expect(glowShadow).toContain("75");

  await page.evaluate(() => {
    document.querySelector(".glow-primary")?.remove();
  });
});

test(".animate-shimmer-text has no gradient background", async ({ page }) => {
  await page.goto("http://localhost:5173");

  await page.evaluate(() => {
    const el = document.createElement("span");
    el.className = "animate-shimmer-text";
    document.body.appendChild(el);
  });

  // Read from the stylesheet so the value is not resolved/normalized by the
  // browser the way getComputedStyle() would be.
  const backgroundImage = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (
            rule instanceof CSSStyleRule &&
            rule.selectorText === ".animate-shimmer-text"
          ) {
            return rule.style.getPropertyValue("background-image");
          }
        }
      } catch {
        /* cross-origin stylesheet */
      }
    }
    return "";
  });

  expect(backgroundImage).not.toContain("linear-gradient");

  await page.evaluate(() => {
    document.querySelector(".animate-shimmer-text")?.remove();
  });
});

test(".animate-shimmer-text uses text-pulse animation, not shimmer-text", async ({
  page,
}) => {
  await page.goto("http://localhost:5173");

  await page.evaluate(() => {
    const el = document.createElement("span");
    el.className = "animate-shimmer-text";
    document.body.appendChild(el);
  });

  // Read from the stylesheet so the animation name is not resolved/normalized
  // by the browser the way getComputedStyle() would be.
  const animationName = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (
            rule instanceof CSSStyleRule &&
            rule.selectorText === ".animate-shimmer-text"
          ) {
            return rule.style.getPropertyValue("animation-name");
          }
        }
      } catch {
        /* cross-origin stylesheet */
      }
    }
    return "";
  });

  expect(animationName).toContain("text-pulse");
  expect(animationName).not.toContain("shimmer-text");

  await page.evaluate(() => {
    document.querySelector(".animate-shimmer-text")?.remove();
  });
});
