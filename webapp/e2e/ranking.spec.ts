import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { binomialTwoSidedP, expectPClose, open, parseNumber } from "./helpers";

async function wins(page: Page): Promise<{ a: number; b: number; ties: number }> {
  // Each tile is a small box with the label above the monospace count; climb from the label to its tile.
  const tile = (label: RegExp) => page.getByText(label).first().locator("..").locator(".mono").first();
  return {
    a: parseNumber(await tile(/^A wins$/i).textContent()),
    b: parseNumber(await tile(/^B wins$/i).textContent()),
    ties: parseNumber(await tile(/^ties$/i).textContent()),
  };
}

const displayedP = async (page: Page): Promise<string> => {
  const text = (await page.getByText(/binomial p\s*=/i).first().textContent()) ?? "";
  return text.match(/binomial p\s*=\s*([0-9.e+-]+|–)/i)?.[1] ?? "";
};

test.describe("ranking lab", () => {
  test("the interleaving p-value is the exact two-sided binomial test of the win counts", async ({ page }) => {
    await open(page, "/ranking", "Ranking metrics playground");
    const w = await wins(page);
    expect(w.a + w.b + w.ties).toBe(400); // default number of simulated sessions
    expectPClose(await displayedP(page), binomialTwoSidedP(w.b, w.a + w.b));
    // Preference for B with its Wilson interval, mapped to [-1, 1].
    await expect(page.getByText(/Preference for B/)).toBeVisible();
    await expect(page.getByText(/\(Wilson\)/)).toBeVisible();
    const bar = page.getByRole("img", { name: /^Estimate .*, interval/ });
    const label = (await bar.getAttribute("aria-label")) ?? "";
    const m = label.match(/Estimate (-?[\d.]+), interval (-?[\d.]+) to (-?[\d.]+)/);
    expect(m, "preference interval bar").toBeTruthy();
    const [est, lo, hi] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
    expect(Math.abs(est - (w.b - w.a) / (w.a + w.b))).toBeLessThanOrEqual(0.0051);
    expect(lo).toBeLessThan(est);
    expect(hi).toBeGreaterThan(est);
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
  });

  test("the lab is shareable through the URL and the p-value follows the configured sessions", async ({ page }) => {
    await open(page, "/ranking?a=3,2,1,0,1&b=2,3,1,1,0&k=4&seed=11&n=200", "Ranking metrics playground");
    await expect(page.getByRole("textbox", { name: /ranker a/i })).toHaveValue("3,2,1,0,1");
    await expect(page.getByRole("textbox", { name: /ranker b/i })).toHaveValue("2,3,1,1,0");
    await expect(page.getByText(/NDCG@4/)).toBeVisible();
    await expect(page.getByText(/^Sessions: 200$/)).toBeVisible();
    const w = await wins(page);
    expect(w.a + w.b + w.ties).toBe(200);
    expectPClose(await displayedP(page), binomialTwoSidedP(w.b, w.a + w.b));

    await page.getByRole("button", { name: /re-roll sessions/i }).click();
    await expect(page).toHaveURL(/seed=12/);
    const rerolled = await wins(page);
    expect(rerolled.a + rerolled.b + rerolled.ties).toBe(200);
    expectPClose(await displayedP(page), binomialTwoSidedP(rerolled.b, rerolled.a + rerolled.b));

    // The same URL reproduces the same simulation (seeded PRNG).
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Ranking metrics playground" })).toBeVisible();
    expect(await wins(page)).toEqual(rerolled);
  });
});
