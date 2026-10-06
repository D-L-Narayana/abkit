import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { DEMO, DEMO_LIST, createExperiment, downloadText, open } from "./helpers";

const KEY_V1 = "abkit-experiments-v1";
const KEY_V2 = "abkit-experiments-v2";
const KEY_QUARANTINE = "abkit-experiments-quarantine";

interface StoreFile { version: number; savedAt: string; experiments: { id: string; status: string; days: unknown[] }[] }

const readStore = (page: Page) =>
  page.evaluate(([v1, v2, q]) => ({ v1: localStorage.getItem(v1), v2: localStorage.getItem(v2), quarantine: localStorage.getItem(q) }), [KEY_V1, KEY_V2, KEY_QUARANTINE] as const);

test.describe("storage", () => {
  test("legacy v1 records migrate into the versioned store and invalid records are quarantined, not dropped", async ({ page }) => {
    await open(page, "/", "Experiments");
    const seeded = await readStore(page);
    expect(seeded.v2, "first visit writes the v2 store file").toBeTruthy();
    const file = JSON.parse(seeded.v2 ?? "{}") as StoreFile;
    expect(file.version).toBe(2);
    expect(file.experiments.map((e) => e.id).sort()).toEqual(DEMO_LIST.map((d) => d.id).sort());

    // Replace the store with a pre-1.1 array: five valid experiments plus one corrupt record.
    const legacy = [...file.experiments.filter((e) => e.id !== DEMO.checkout.id), { id: "broken", name: 42, days: "nope" }];
    await page.evaluate(([v1, v2, q, data]) => { localStorage.removeItem(v2); localStorage.removeItem(q); localStorage.setItem(v1, data); }, [KEY_V1, KEY_V2, KEY_QUARANTINE, JSON.stringify(legacy)] as const);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();

    for (const demo of DEMO_LIST) {
      const link = page.getByRole("link", { name: demo.name, exact: true });
      if (demo.id === DEMO.checkout.id) await expect(link).toHaveCount(0);
      else await expect(link).toBeVisible();
    }
    const banner = page.getByRole("status").filter({ hasText: /could not be read/i });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/1 stored record/);
    await expect(banner.getByRole("button", { name: "Discard" })).toBeVisible();

    const migrated = await readStore(page);
    expect(migrated.v1, "v1 key removed after migration").toBeNull();
    const v2 = JSON.parse(migrated.v2 ?? "{}") as StoreFile;
    expect(v2.version).toBe(2);
    expect(v2.experiments).toHaveLength(5);
    const quarantine = JSON.parse(migrated.quarantine ?? "[]") as { raw: unknown; reason: string }[];
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]!.reason).toMatch(/\w/);
    expect(quarantine[0]!.raw).toMatchObject({ id: "broken" });

    // The quarantined record can be downloaded before it is discarded.
    const [download] = await Promise.all([page.waitForEvent("download"), banner.getByRole("button", { name: "Download JSON" }).click()]);
    expect(download.suggestedFilename()).toMatch(/quarantine.*\.json$/);
    const saved = JSON.parse(await downloadText(download)) as { raw: unknown; reason: string }[];
    expect(saved[0]?.raw).toMatchObject({ id: "broken" });
    await banner.getByRole("button", { name: "Discard" }).click();
    await expect(banner).toHaveCount(0);
    expect((await readStore(page)).quarantine).toBeNull();
  });

  test("export-all then import-all restores an experiment byte-for-byte", async ({ page }) => {
    const id = await createExperiment(page, "Round trip experiment");
    await open(page, "/", "Experiments");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export all" }).click()]);
    const exported = await downloadText(download);
    const file = JSON.parse(exported) as StoreFile;
    expect(file.version).toBe(2);
    expect(file.experiments).toHaveLength(7);
    const original = file.experiments.find((e) => e.id === id);
    expect(original, "the new experiment is part of the export").toBeTruthy();

    await page.getByRole("button", { name: "Delete: Round trip experiment" }).click();
    await expect(page.getByRole("link", { name: "Round trip experiment", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Round trip experiment", exact: true })).toHaveCount(0);

    // "Import JSON" drives a hidden file input.
    await expect(page.getByRole("button", { name: "Import JSON" })).toBeVisible();
    const filename = download.suggestedFilename() || "abkit-experiments.json";
    await page.locator('input[type="file"][accept*="json"]').setInputFiles({ name: filename, mimeType: "application/json", buffer: Buffer.from(exported, "utf8") });
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`Imported .*${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*1 added`) })).toBeVisible();
    await expect(page.getByRole("link", { name: "Round trip experiment", exact: true })).toBeVisible();
    const after = JSON.parse((await readStore(page)).v2 ?? "{}") as StoreFile;
    expect(after.experiments).toHaveLength(7);
    expect(after.experiments.find((e) => e.id === id)).toEqual(original);

    // Importing the same file again changes nothing.
    await page.locator('input[type="file"][accept*="json"]').setInputFiles({ name: filename, mimeType: "application/json", buffer: Buffer.from(exported, "utf8") });
    await expect(page.getByRole("status").filter({ hasText: /Nothing new/ })).toBeVisible();
    expect((JSON.parse((await readStore(page)).v2 ?? "{}") as StoreFile).experiments).toHaveLength(7);
  });
});
