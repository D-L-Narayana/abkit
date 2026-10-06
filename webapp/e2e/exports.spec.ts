import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { DEMO, downloadText, open, statValue } from "./helpers";

/** Open the export menu on the results page and pick an item. */
async function pickExport(page: Page, item: RegExp): Promise<void> {
  const trigger = page.getByRole("button", { name: "Export", exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("menu").getByRole("menuitem", { name: item }).click();
}

/** The Markdown summary is copied to the clipboard; when the clipboard is unavailable the app downloads it instead. */
async function copyMarkdown(page: Page): Promise<string> {
  await page.evaluate(() => navigator.clipboard.writeText(""));
  const fallback = page.waitForEvent("download", { timeout: 8_000 }).then(downloadText, () => null);
  await pickExport(page, /markdown/i);
  const read = () => page.evaluate(() => navigator.clipboard.readText());
  try {
    await expect.poll(read, { timeout: 4_000 }).not.toBe("");
    return await read();
  } catch {
    return (await fallback) ?? "";
  }
}

test.describe("exports from the results page", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });

  test("CSV export is the lossless aggregated format and re-imports to the same analysis", async ({ page }) => {
    await open(page, `/exp/${DEMO.rankerV2.id}`, DEMO.rankerV2.name);
    const pOriginal = await statValue(page, "p-value");
    const liftOriginal = await statValue(page, "Relative lift");
    const [download] = await Promise.all([page.waitForEvent("download"), pickExport(page, /csv/i)]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const csv = await downloadText(download);
    const lines = csv.trim().split(/\r?\n/);
    const header = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
    expect(header).toEqual(expect.arrayContaining(["day", "variant", "users", "conversions"]));
    expect(lines.length, "header + 21 days × 2 arms").toBe(1 + 21 * 2);
    const users = lines.slice(1).reduce((s, l) => s + Number(l.split(",")[header.indexOf("users")]), 0);
    expect(users).toBeGreaterThan(1_000_000);

    // Round trip through the importer reproduces the numbers.
    await open(page, "/upload", "Upload experiment data");
    await page.getByRole("textbox", { name: /experiment name/i }).fill("Re-imported ranker test");
    await page.locator('input[type="file"]').setInputFiles({ name: "ranker.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    const preview = page.getByRole("region", { name: /preview/i });
    await expect(preview.getByText(/^aggregated$/)).toBeVisible();
    await expect(preview).toContainText(/21 \(/); // 21 days
    await preview.getByRole("button", { name: "Create experiment" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Re-imported ranker test" })).toBeVisible();
    expect(await statValue(page, "p-value")).toBe(pOriginal);
    expect(await statValue(page, "Relative lift")).toBe(liftOriginal);
    await expect(page.getByRole("row", { name: /control/i })).toContainText(/\d{3},\d{3}/);
  });

  test("JSON export carries the experiment with its schema tag", async ({ page }) => {
    await open(page, `/exp/${DEMO.upsell.id}`, DEMO.upsell.name);
    const [download] = await Promise.all([page.waitForEvent("download"), pickExport(page, /json/i)]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    const doc = JSON.parse(await downloadText(download)) as { schema: string; experiment: { id: string; metricType: string; days: { nA: number; sumsA: { sxy: number } }[] } };
    expect(doc.schema).toBe("abkit-experiment/1");
    expect(doc.experiment.id).toBe(DEMO.upsell.id);
    expect(doc.experiment.metricType).toBe("continuous");
    expect(doc.experiment.days).toHaveLength(18);
    expect(Number.isFinite(doc.experiment.days[0]!.sumsA.sxy)).toBe(true);
  });

  test("Markdown summary states the verdict, lift, p-values and guardrails", async ({ page }) => {
    await open(page, `/exp/${DEMO.rankerV2.id}`, DEMO.rankerV2.name);
    const lift = await statValue(page, "Relative lift");
    const p = await statValue(page, "p-value");
    const md = await copyMarkdown(page);
    expect(md).toMatch(/^#+\s.*Search ranker v2/m);
    expect(md).toMatch(/winner/i);
    expect(md).toContain(lift);
    expect(md).toContain(p);
    expect(md).toMatch(/always-valid/i);
    expect(md).toMatch(/sample-ratio/i);
    expect(md).toMatch(/\| A · control \|/);
    expect(md).toMatch(/\| B · treatment \|/);
    expect(md).toMatch(/per arm|users/i);
  });

  test("the export menu is keyboard operable and closes on Escape", async ({ page }) => {
    await open(page, `/exp/${DEMO.rankerV2.id}`, DEMO.rankerV2.name);
    const trigger = page.getByRole("button", { name: "Export", exact: true });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
