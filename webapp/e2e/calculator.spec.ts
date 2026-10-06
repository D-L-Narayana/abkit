import { expect, test } from "./fixtures";
import { Z, fmtPct, open, sampleSizeProportion } from "./helpers";

/** Delta-method confidence interval for the relative lift of two proportions (oracle, independent of the app). */
function relativeLiftCI(convA: number, nA: number, convB: number, nB: number): { lift: number; lo: number; hi: number } {
  const pa = convA / nA;
  const pb = convB / nB;
  const seA2 = (pa * (1 - pa)) / nA;
  const seB2 = (pb * (1 - pb)) / nB;
  const lift = pb / pa - 1;
  const se = Math.sqrt(seB2 / pa ** 2 + (pb ** 2 * seA2) / pa ** 4);
  return { lift, lo: lift - Z.q975 * se, hi: lift + Z.q975 * se };
}

test.describe("calculators", () => {
  test("inputs are mirrored into the URL and a shared URL restores them", async ({ page, context }) => {
    await open(page, "/calculator", "Calculators");
    const sampleSize = page.getByRole("region", { name: /sample size/i });
    await expect(sampleSize).toContainText(sampleSizeProportion(0.1, 0.05).toLocaleString("en-US"));

    await sampleSize.getByRole("textbox", { name: /baseline rate/i }).fill("0.12");
    await sampleSize.getByRole("textbox", { name: /mde/i }).fill("0.08");
    await expect(sampleSize).toContainText(sampleSizeProportion(0.12, 0.08).toLocaleString("en-US"));
    // The address bar follows the inputs (debounced); defaults stay out of the query string.
    await expect.poll(() => page.url()).toMatch(/\?(?=.*\bbase=0\.12\b)(?=.*\bmde=0\.08\b)/);
    expect(page.url()).not.toMatch(/alpha=|power=/);

    // Open the same URL in another tab: the state comes back from the query string alone.
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(other.getByRole("heading", { level: 1, name: "Calculators" })).toBeVisible();
    const restored = other.getByRole("region", { name: /sample size/i });
    await expect(restored.getByRole("textbox", { name: /baseline rate/i })).toHaveValue("0.12");
    await expect(restored.getByRole("textbox", { name: /mde/i })).toHaveValue("0.08");
    await expect(restored).toContainText(sampleSizeProportion(0.12, 0.08).toLocaleString("en-US"));
    await other.close();
  });

  test("the z-test card reports the delta-method relative confidence interval", async ({ page }) => {
    await open(page, "/calculator", "Calculators");
    const card = page.getByRole("region", { name: /z-test/i });
    await card.getByRole("textbox", { name: /^A conversions/i }).fill("1000");
    await card.getByRole("textbox", { name: /^A visitors/i }).fill("10000");
    await card.getByRole("textbox", { name: /^B conversions/i }).fill("1100");
    await card.getByRole("textbox", { name: /^B visitors/i }).fill("10000");
    const ci = relativeLiftCI(1000, 10000, 1100, 10000);
    await expect(card).toContainText(`+${fmtPct(ci.lift)}`); // +10.00%
    await expect(card).toContainText(fmtPct(ci.lo)); // 1.09%
    await expect(card).toContainText(fmtPct(ci.hi)); // 18.91%
    await expect(card).toContainText(/p\s*[=:]?\s*0\.021/);
  });

  test("invalid numbers are flagged inline and never produce a result", async ({ page }) => {
    await open(page, "/calculator", "Calculators");
    const card = page.getByRole("region", { name: /sample-ratio mismatch/i });
    const usersA = card.getByRole("textbox", { name: /users in A/i });
    await usersA.fill("abc");
    await expect(usersA).toHaveAttribute("aria-invalid", "true");
    await expect(card.getByRole("alert").first()).toContainText(/enter a whole number/i);
    await usersA.fill("100000");
    await expect(usersA).toHaveAttribute("aria-invalid", "false");
    await expect(card).toContainText(/χ²/);
  });
});
