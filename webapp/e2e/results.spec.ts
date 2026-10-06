import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { DEMO, Z, open, parseNumber, statValue } from "./helpers";

/** Delta-method relative-lift CI from the arm counts shown in the "Arms & guardrails" table (oracle). */
async function relativeCIFromTable(page: Page): Promise<{ lift: number; lo: number; hi: number }> {
  const cells = async (row: RegExp) => (await page.getByRole("row", { name: row }).getByRole("cell").allTextContents()).map(parseNumber);
  const a = await cells(/^A · control/);
  const b = await cells(/^B · treatment/);
  const [nA, convA] = [a[1]!, a[2]!];
  const [nB, convB] = [b[1]!, b[2]!];
  const pa = convA / nA;
  const pb = convB / nB;
  const lift = pb / pa - 1;
  const se = Math.sqrt((pb * (1 - pb)) / nB / pa ** 2 + (pb ** 2 * ((pa * (1 - pa)) / nA)) / pa ** 4);
  return { lift, lo: lift - Z.q975 * se, hi: lift + Z.q975 * se };
}

/** The page shows a percentage equal to `value` at two decimals (allowing one unit of rounding difference). */
async function expectPercentShown(page: Page, value: number): Promise<void> {
  const base = Math.round(value * 10000);
  const candidates = [base - 1, base, base + 1].map((v) => `${(v / 100).toFixed(2)}%`);
  const text = await page.locator("main").innerText();
  expect(candidates.some((c) => text.includes(c)), `one of ${candidates.join(" | ")} appears on the page`).toBe(true);
}

test.describe("results page", () => {
  test("reports the delta-method relative confidence interval and the always-valid p-value", async ({ page }) => {
    await open(page, `/exp/${DEMO.rankerV2.id}`, DEMO.rankerV2.name);
    expect(await statValue(page, "Verdict")).toBe("Winner");
    const ci = await relativeCIFromTable(page);
    expect(await statValue(page, "Relative lift")).toBe(`+${(100 * ci.lift).toFixed(2)}%`);
    await expectPercentShown(page, ci.lo);
    await expectPercentShown(page, ci.hi);

    // Sequential monitoring is shown as an always-valid p-value next to the naive one, and the misleading Holm row is gone.
    await expect(page.getByText(/always-valid/i).first()).toBeVisible();
    await expect(page.getByText(/Holm correction/)).toHaveCount(0);
    expect(await page.locator("svg.recharts-surface").count()).toBeGreaterThanOrEqual(3);
  });

  test("a continuous metric shows CUPED before and after with a narrower adjusted interval", async ({ page }) => {
    await open(page, `/exp/${DEMO.upsell.id}`, DEMO.upsell.name);
    await expect(page.getByRole("heading", { name: /CUPED — before and after/ })).toBeVisible();
    const bars = page.getByRole("img", { name: /^Estimate .*, interval/ });
    await expect(bars).toHaveCount(2);
    const parse = async (i: number) => {
      const label = (await bars.nth(i).getAttribute("aria-label")) ?? "";
      const m = label.match(/interval (-?[\d.]+) to (-?[\d.]+)/);
      return Number(m?.[2]) - Number(m?.[1]);
    };
    const rawWidth = await parse(0);
    const cupedWidth = await parse(1);
    expect(cupedWidth).toBeGreaterThan(0);
    expect(cupedWidth).toBeLessThan(rawWidth);
    await expect(page.getByText(/variance removed/i)).toBeVisible();
  });

  test("stop marks a running experiment as stopped in the versioned store", async ({ page }) => {
    await open(page, `/exp/${DEMO.freeCancel.id}`, DEMO.freeCancel.name);
    await page.getByRole("button", { name: /^stop( experiment)?$/i }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Stopped/ })).toBeVisible();
    await expect(page.locator(".chip-status")).toHaveText("Stopped");
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const raw = localStorage.getItem("abkit-experiments-v2");
          const file = raw ? (JSON.parse(raw) as { experiments: { id: string; status: string; stoppedAt?: string }[] }) : null;
          const e = file?.experiments.find((x) => x.id === id);
          return e ? { status: e.status, stoppedAt: typeof e.stoppedAt === "string" && e.stoppedAt.length > 0 } : null;
        }, DEMO.freeCancel.id),
      )
      .toEqual({ status: "stopped", stoppedAt: true });
    await expect(page.getByRole("button", { name: /^stop( experiment)?$/i })).toHaveCount(0);
  });
});
