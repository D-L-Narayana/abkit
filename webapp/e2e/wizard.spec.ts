import { expect, test } from "./fixtures";
import { DEMO, open, sampleSizeProportion } from "./helpers";

test.describe("experiment wizard", () => {
  test("plans the sample size, creates a simulated experiment and opens its results", async ({ page }) => {
    await open(page, "/new", "New experiment");
    const nameField = page.getByRole("textbox", { name: /experiment name/i });
    await expect(page.getByRole("button", { name: /continue/i })).toBeDisabled();
    await nameField.fill("E2E conversion test");
    await page.getByRole("textbox", { name: /hypothesis/i }).fill("If we simplify the flow, conversion rises because fewer users drop out.");
    await page.getByRole("button", { name: /continue/i }).click();

    // Live power analysis for the defaults (10% baseline, +5% relative MDE, α 0.05, power 0.8).
    const aside = page.getByRole("complementary", { name: /power analysis/i });
    await expect(aside).toContainText(sampleSizeProportion(0.1, 0.05).toLocaleString("en-US"));
    await page.getByRole("textbox", { name: /minimum detectable effect/i }).fill("0.10");
    await expect(aside).toContainText(sampleSizeProportion(0.1, 0.1).toLocaleString("en-US"));
    await expect(aside).not.toContainText(sampleSizeProportion(0.1, 0.05).toLocaleString("en-US"));

    for (let i = 0; i < 5; i++) {
      if (await page.getByRole("button", { name: /launch experiment/i }).isVisible()) break;
      await page.getByRole("button", { name: /continue/i }).click();
    }
    await page.getByRole("button", { name: /launch experiment/i }).click();
    await expect(page).toHaveURL(/\/exp\/exp-e2e-conversion-test/);
    await expect(page.getByRole("heading", { level: 1, name: "E2E conversion test" })).toBeVisible();
    await expect(page.getByText("If we simplify the flow, conversion rises because fewer users drop out.")).toBeVisible();
    await expect(page.locator(".card").filter({ hasText: /^Verdict/ })).toBeVisible();
    await expect(page.locator("svg.recharts-surface").first()).toBeVisible();

    // It is persisted and listed first on the dashboard.
    await page.getByRole("link", { name: "abkit home" }).click();
    await expect(page.getByRole("link", { name: "E2E conversion test", exact: true })).toBeVisible();
    const firstLink = page.getByRole("table").or(page.getByRole("list", { name: "Experiments" })).getByRole("link").first();
    await expect(firstLink).toHaveText("E2E conversion test");
  });

  test("keeps the draft across a reload", async ({ page }) => {
    await open(page, "/new", "New experiment");
    await page.getByRole("textbox", { name: /experiment name/i }).fill("Draft that survives");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("abkit-wizard-draft") ?? "")).toContain("Draft that survives");
    await page.reload();
    await expect(page.getByRole("textbox", { name: /experiment name/i })).toHaveValue("Draft that survives");
  });

  test("prefills from an existing experiment via /new?from=<id>", async ({ page }) => {
    await open(page, "/", "Experiments"); // seeds the demo experiments
    await open(page, `/new?from=${DEMO.rankerV2.id}`, "New experiment");
    await expect(page.getByRole("textbox", { name: /experiment name/i })).toHaveValue(/Search ranker v2/);
    await page.getByRole("button", { name: /continue/i }).click();
    await expect(page.getByRole("textbox", { name: /baseline rate/i })).toHaveValue("0.082");
  });
});
