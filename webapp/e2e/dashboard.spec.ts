import { expect, test } from "./fixtures";
import { DEMO, DEMO_LIST, experimentRow, hasHorizontalOverflow, isMobile, open, statValue } from "./helpers";

test.describe("dashboard", () => {
  test("lists the six demo experiments with honest verdicts", async ({ page }) => {
    await open(page, "/", "Experiments");
    for (const demo of DEMO_LIST) await expect(page.getByRole("link", { name: demo.name, exact: true })).toBeVisible();

    // The deliberately skewed experiment is invalid, the finished ranker test is a winner.
    await expect(experimentRow(page, DEMO.mapDefault.name)).toContainText("SRM — invalid");
    await expect(experimentRow(page, DEMO.rankerV2.name)).toContainText("Winner");
    await expect(experimentRow(page, DEMO.rankerV2.name)).not.toContainText("SRM");

    // Summary tiles agree with the rows.
    expect(await statValue(page, "SRM alerts")).toBe("1");
    expect(Number(await statValue(page, "Winners shipped"))).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(/Showing 6 of 6/)).toBeVisible();
  });

  test("self-hosted variable fonts load under font-src 'self'", async ({ page, baseURL }) => {
    await open(page, "/", "Experiments");
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      const faces = [...document.fonts].map((f) => ({ family: f.family.replace(/^["']|["']$/g, ""), status: f.status }));
      const mono = document.querySelector(".mono");
      return {
        geistCheck: document.fonts.check('16px "Geist Variable"'),
        monoCheck: document.fonts.check('16px "JetBrains Mono Variable"'),
        geistLoaded: faces.some((f) => f.family === "Geist Variable" && f.status === "loaded"),
        monoLoaded: faces.some((f) => f.family === "JetBrains Mono Variable" && f.status === "loaded"),
        failed: faces.filter((f) => f.status === "error").map((f) => f.family),
        bodyFamily: getComputedStyle(document.body).fontFamily,
        monoFamily: mono ? getComputedStyle(mono).fontFamily : "",
        fontRequests: performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\.woff2?(\?|$)/.test(n)),
      };
    });
    expect(fonts.failed, "font faces that failed to load").toEqual([]);
    expect(fonts.geistCheck, 'document.fonts.check(\'16px "Geist Variable"\')').toBe(true);
    expect(fonts.monoCheck, 'document.fonts.check(\'16px "JetBrains Mono Variable"\')').toBe(true);
    expect(fonts.geistLoaded, "a loaded Geist Variable face").toBe(true);
    expect(fonts.monoLoaded, "a loaded JetBrains Mono Variable face").toBe(true);
    expect(fonts.bodyFamily).toContain("Geist Variable");
    expect(fonts.monoFamily).toContain("JetBrains Mono Variable");
    expect(fonts.fontRequests.length, "woff2 files fetched").toBeGreaterThanOrEqual(2);
    for (const url of fonts.fontRequests) expect(url.startsWith(`${new URL(baseURL ?? "").origin}/assets/`), `${url} is served from /assets/`).toBe(true);
  });

  test("uses a table on desktop and cards on phones without horizontal overflow", async ({ page }, testInfo) => {
    await open(page, "/", "Experiments");
    const table = page.getByRole("table");
    const cards = page.getByRole("list", { name: "Experiments" });
    if (isMobile(testInfo)) {
      await expect(cards).toBeVisible();
      await expect(cards.getByRole("listitem")).toHaveCount(6);
      await expect(table).toBeHidden();
      await expect(cards.getByRole("link", { name: "Open results" }).first()).toBeVisible();
    } else {
      await expect(table).toBeVisible();
      await expect(table.locator("tbody tr")).toHaveCount(6);
      await expect(cards).toBeHidden();
    }
    expect(await hasHorizontalOverflow(page), "page wider than the viewport").toBe(false);
  });

  test("search and status filters narrow the list and live in the URL", async ({ page }) => {
    await open(page, "/", "Experiments");
    const search = page.getByRole("searchbox", { name: "Search experiments" });
    await search.fill("map view");
    await expect(page.getByRole("link", { name: DEMO.mapDefault.name, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: DEMO.rankerV2.name, exact: true })).toHaveCount(0);
    await expect(page.getByText(/Showing 1 of 6/)).toBeVisible();
    await expect(page).toHaveURL(/[?&]q=map\+view/);

    await page.getByRole("button", { name: "Clear search experiments" }).click();
    await expect(page.getByRole("link", { name: DEMO.rankerV2.name, exact: true })).toBeVisible();

    await page.getByRole("radiogroup", { name: "Status" }).getByRole("radio", { name: /^Completed/ }).click();
    await expect(page.getByRole("link", { name: DEMO.rankerV2.name, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: DEMO.upsell.name, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: DEMO.mapDefault.name, exact: true })).toHaveCount(0);
    await expect(page.getByText(/Showing 2 of 6/)).toBeVisible();
    await expect(page).toHaveURL(/[?&]status=completed/);

    // The filtered view is shareable: a fresh load of the URL shows the same subset.
    await page.reload();
    await expect(page.getByText(/Showing 2 of 6/)).toBeVisible();
  });

  test("delete can be undone and lifecycle actions persist", async ({ page }) => {
    await open(page, "/", "Experiments");
    await page.getByRole("button", { name: `Delete: ${DEMO.checkout.name}` }).click();
    await expect(page.getByRole("link", { name: DEMO.checkout.name, exact: true })).toHaveCount(0);
    const toast = page.getByRole("status").filter({ hasText: /Deleted/ });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("link", { name: DEMO.checkout.name, exact: true })).toBeVisible();

    await page.getByRole("button", { name: `Stop: ${DEMO.urgency.name}` }).click();
    await expect(experimentRow(page, DEMO.urgency.name)).toContainText(/stopped/i);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();
    await expect(page.getByRole("link", { name: DEMO.checkout.name, exact: true })).toBeVisible();
    await expect(experimentRow(page, DEMO.urgency.name)).toContainText(/stopped/i);
    await expect(page.getByRole("button", { name: `Resume: ${DEMO.urgency.name}` })).toBeVisible();
  });
});
