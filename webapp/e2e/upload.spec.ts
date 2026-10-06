import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { downloadText, expectPClose, open, statValue } from "./helpers";

const FIXTURES = fileURLToPath(new URL("../../tests/fixtures/csv/", import.meta.url));
const EXPECTED_FILES = ["aggregated_continuous.csv", "aggregated_daily.csv", "continuous_per_user_cuped.csv", "conversion_per_user.csv", "semicolon_crlf_bom.csv", "three_variants_error.csv"];
const csvFiles = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => f.endsWith(".csv")).sort() : [];

/** Subset of the Python `analyze()` output stored per fixture in expected.json (the parity reference). */
interface Expected {
  format?: string;
  metric_type?: string;
  n_a: number;
  n_b: number;
  test: { p_value: number };
  cuped?: { adjusted_test?: { p_value: number } } | null;
  srm: { mismatch: boolean };
}
const expectedByFile: Record<string, Expected> = existsSync(`${FIXTURES}expected.json`) ? (JSON.parse(readFileSync(`${FIXTURES}expected.json`, "utf8")) as Record<string, Expected>) : {};

// ---------- minimal CSV reading for deriving expectations from the fixture text ----------
const stripBom = (text: string): string => text.replace(/^﻿/, "");
function delimiterOf(header: string): string {
  const count = (c: string) => header.split(c).length - 1;
  return count(";") > count(",") ? ";" : count("\t") > count(",") ? "\t" : ",";
}
function columns(csv: string): { header: string[]; rows: string[][] } {
  const lines = stripBom(csv).split(/\r?\n/).filter((l) => l.trim() !== "");
  const d = delimiterOf(lines[0] ?? "");
  const split = (l: string) => l.split(d).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
  return { header: split(lines[0] ?? "").map((h) => h.toLowerCase()), rows: lines.slice(1).map(split) };
}
/** Aggregated rows carry a `users` column, per-user rows do not. */
const formatOf = (csv: string): "per-user" | "aggregated" => (columns(csv).header.includes("users") ? "aggregated" : "per-user");
function variantLabels(csv: string): string[] {
  const { header, rows } = columns(csv);
  const i = header.indexOf("variant");
  return [...new Set(rows.map((r) => r[i] ?? "").filter((v) => v !== ""))];
}

// ---------- page helpers ----------
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const preview = (page: Page): Locator => page.getByRole("region", { name: /preview/i });
async function previewRow(page: Page, label: string): Promise<string> {
  const row = preview(page).locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) });
  await expect(row, `preview row "${label}"`).toBeVisible();
  return ((await row.locator("dd").textContent()) ?? "").trim();
}
async function uploadCsv(page: Page, name: string, file: string | { name: string; csv: string }): Promise<void> {
  await open(page, "/upload", "Upload experiment data");
  await page.getByRole("textbox", { name: /experiment name/i }).fill(name);
  await page.locator('input[type="file"]').setInputFiles(typeof file === "string" ? file : { name: file.name, mimeType: "text/csv", buffer: Buffer.from(file.csv, "utf8") });
}
async function downloadSample(page: Page, label: string): Promise<{ name: string; csv: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: label, exact: true }).click()]);
  return { name: download.suggestedFilename(), csv: await downloadText(download) };
}
/** Names of the experiments in the versioned store (empty until the store is first used). */
const storedNames = (page: Page): Promise<string[]> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem("abkit-experiments-v2") ?? '{"experiments":[]}') as { experiments: { name: string }[] }).experiments.map((e) => e.name));
const armRow = (page: Page, arm: "A · control" | "B · treatment"): Locator => page.getByRole("row", { name: new RegExp(`^${escapeRegExp(arm)}`) });

test.describe("CSV upload", () => {
  test("the parity fixtures exist", () => {
    expect(csvFiles, "tests/fixtures/csv/*.csv").toEqual(EXPECTED_FILES);
    expect(Object.keys(expectedByFile).length, "tests/fixtures/csv/expected.json entries").toBeGreaterThanOrEqual(5);
  });

  test("previews the per-user sample before anything is stored, then imports it", async ({ page }) => {
    await open(page, "/upload", "Upload experiment data");
    const sample = await downloadSample(page, "Download sample (per-user)");
    expect(sample.name).toMatch(/\.csv$/);
    expect(columns(sample.csv).header).toEqual(["variant", "converted", "day"]);

    await uploadCsv(page, "Sample import", sample);
    await expect(preview(page)).toBeVisible();
    await expect(preview(page).getByText(/^per-user$/)).toBeVisible();
    expect(await previewRow(page, "Control label")).toBe("A");
    expect(await previewRow(page, "Treatment label")).toBe("B");
    expect(await previewRow(page, "Users per arm")).toBe("6 control · 6 treatment");
    expect(await previewRow(page, "Rows used")).toBe("12");
    expect(page.url()).toContain("/upload");
    expect(await storedNames(page), "previewing stores nothing").not.toContain("Sample import");

    await preview(page).getByRole("button", { name: "Create experiment" }).click();
    await expect(page).toHaveURL(/\/exp\//);
    await expect(page.getByRole("heading", { level: 1, name: "Sample import" })).toBeVisible();
    expect(await storedNames(page)).toContain("Sample import");
    const control = armRow(page, "A · control").getByRole("cell");
    await expect(control.nth(1)).toHaveText("6");
    await expect(control.nth(2)).toHaveText("2");
    const treatment = armRow(page, "B · treatment").getByRole("cell");
    await expect(treatment.nth(1)).toHaveText("6");
    await expect(treatment.nth(2)).toHaveText("4");
  });

  test("imports the aggregated (per arm and day) sample", async ({ page }) => {
    await open(page, "/upload", "Upload experiment data");
    const sample = await downloadSample(page, "Download sample (aggregated)");
    expect(formatOf(sample.csv)).toBe("aggregated");
    await uploadCsv(page, "Aggregated sample", sample);
    await expect(preview(page).getByText(/^aggregated$/)).toBeVisible();
    expect(await previewRow(page, "Users per arm")).toBe("2,990 control · 3,010 treatment");
    expect(await previewRow(page, "Days")).toMatch(/^3 /);
    await preview(page).getByRole("button", { name: "Create experiment" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Aggregated sample" })).toBeVisible();
    const control = armRow(page, "A · control").getByRole("cell");
    await expect(control.nth(1)).toHaveText("2,990");
    await expect(control.nth(2)).toHaveText("300");
    const treatment = armRow(page, "B · treatment").getByRole("cell");
    await expect(treatment.nth(1)).toHaveText("3,010");
    await expect(treatment.nth(2)).toHaveText("354");
  });

  for (const file of csvFiles) {
    const csv = readFileSync(`${FIXTURES}${file}`, "utf8");
    if (file === "three_variants_error.csv") {
      test(`${file} is rejected with a message that lists the labels`, async ({ page }) => {
        const labels = variantLabels(csv);
        expect(labels.length).toBeGreaterThanOrEqual(3);
        await uploadCsv(page, "Three variants", `${FIXTURES}${file}`);
        const alert = page.getByRole("alert");
        await expect(alert).toBeVisible();
        for (const label of labels) await expect(alert).toContainText(label);
        await expect(preview(page)).toHaveCount(0);
        expect(page.url()).toContain("/upload");
      });
      continue;
    }
    test(`${file} imports and matches the Python reference analysis`, async ({ page }) => {
      const expected = expectedByFile[file];
      expect(expected, `expected.json has an entry for ${file}`).toBeTruthy();
      if (!expected) return;
      const format = expected.format ?? formatOf(csv);
      await uploadCsv(page, `Fixture ${file}`, `${FIXTURES}${file}`);
      await expect(preview(page).getByText(new RegExp(`^${escapeRegExp(format)}$`))).toBeVisible();
      expect(await previewRow(page, "Users per arm")).toBe(`${expected.n_a.toLocaleString("en-US")} control · ${expected.n_b.toLocaleString("en-US")} treatment`);
      await preview(page).getByRole("button", { name: "Create experiment" }).click();
      await expect(page).toHaveURL(/\/exp\//);
      await expect(page.getByRole("heading", { level: 1, name: `Fixture ${file}` })).toBeVisible();

      await expect(armRow(page, "A · control").getByRole("cell").nth(1)).toHaveText(expected.n_a.toLocaleString("en-US"));
      await expect(armRow(page, "B · treatment").getByRole("cell").nth(1)).toHaveText(expected.n_b.toLocaleString("en-US"));
      const p = expected.cuped?.adjusted_test?.p_value ?? expected.test.p_value;
      expectPClose(await statValue(page, "p-value"), p);
      const srmAlert = page.getByRole("alert").filter({ hasText: /sample-ratio mismatch/i });
      if (expected.srm.mismatch) await expect(srmAlert).toBeVisible();
      else await expect(srmAlert).toHaveCount(0);
    });
  }
});
