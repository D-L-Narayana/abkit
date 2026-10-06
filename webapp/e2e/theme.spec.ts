import { expect, test } from "./fixtures";
import { open } from "./helpers";

declare global {
  interface Window {
    __abkitThemeTrace?: { theme: string | undefined; bodyParsed: boolean }[];
  }
}

/** Records every change of <html data-theme> together with whether <body> existed yet (i.e. before first paint or not). */
const TRACE = () => {
  const trace: { theme: string | undefined; bodyParsed: boolean }[] = [];
  window.__abkitThemeTrace = trace;
  new MutationObserver(() => trace.push({ theme: document.documentElement.dataset.theme, bodyParsed: document.body !== null })).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-theme"] });
};

test.describe("theme", () => {
  test("the toggle persists across reloads and the stored theme is applied before the body is parsed", async ({ page, context }) => {
    await context.addInitScript(TRACE);
    await open(page, "/", "Experiments");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f7f7f9");

    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#17171c");
    await expect(page.getByRole("button", { name: "Switch to light theme" })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => localStorage.getItem("abkit-theme"))).toBe("dark");

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();
    await expect(html).toHaveAttribute("data-theme", "dark");
    const trace = await page.evaluate(() => window.__abkitThemeTrace ?? []);
    expect(trace.length).toBeGreaterThan(0);
    expect(trace[0], "theme-init.js applied the stored theme before <body> existed").toEqual({ theme: "dark", bodyParsed: false });

    // Switching back is persisted too.
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "light");
  });

  test("without a stored choice the system preference wins", async ({ browser, policy }, testInfo) => {
    const dark = await policy.newContext(browser, testInfo, { colorScheme: "dark" });
    const page = await dark.newPage();
    await page.goto("/calculator");
    await expect(page.getByRole("heading", { level: 1, name: "Calculators" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("abkit-theme"))).toBeNull();
    await dark.close();
  });
});
