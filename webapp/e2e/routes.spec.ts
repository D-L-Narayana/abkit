import { expect, test } from "./fixtures";
import { ROUTES, hasHorizontalOverflow, open, presetTheme } from "./helpers";

/**
 * Every route rendered under the enforced production policy, in both themes. The `policy` fixture fails the test on any
 * CSP violation, console refusal, page error, failed request or foreign-origin request observed along the way.
 */
for (const theme of ["light", "dark"] as const) {
  test(`every route renders cleanly in the ${theme} theme`, async ({ page, context }) => {
    await presetTheme(context, theme);
    for (const route of ROUTES) {
      await open(page, route.path, route.h1);
      await expect(page.locator("html"), route.path).toHaveAttribute("data-theme", theme);
      expect(await hasHorizontalOverflow(page), `${route.path} overflows horizontally`).toBe(false);
      if (route.path.startsWith("/exp/")) {
        // Charts are drawn (Recharts styles its SVG inline, which style-src 'unsafe-inline' permits).
        expect(await page.locator("svg.recharts-surface").count(), `${route.path} renders charts`).toBeGreaterThanOrEqual(2);
      }
    }
    // Client-side navigation keeps the theme and the policy intact as well.
    await page.getByRole("link", { name: "abkit home" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  });
}

test("unknown addresses show the not-found page with a way back", async ({ page }) => {
  await open(page, "/definitely-missing-page", /not found/i);
  await page.getByRole("link", { name: "Back to experiments" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();
});
