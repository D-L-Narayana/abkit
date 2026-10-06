import { expect, test } from "./fixtures";
import { DEMO, open, statValue, v1ShareToken } from "./helpers";

test.describe("share links", () => {
  test("the share link is a compact v2 token that opens read-only in a fresh browser", async ({ page, context, browser, policy }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, `/exp/${DEMO.rankerV2.id}`, DEMO.rankerV2.name);
    const verdict = await statValue(page, "Verdict");
    const p = await statValue(page, "p-value");

    await page.getByRole("button", { name: /share link/i }).click();
    await expect(page.getByRole("button", { name: /link copied/i })).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    const url = new URL(link);
    expect(url.origin).toBe(policy.origin);
    expect(url.pathname).toMatch(/^\/share\/2\./);
    expect(link.length, "share URL stays well inside URL length limits").toBeLessThan(2000);

    const fresh = await policy.newContext(browser, testInfo);
    const other = await fresh.newPage();
    await other.goto(link);
    await expect(other.getByRole("heading", { level: 1, name: DEMO.rankerV2.name })).toBeVisible();
    await expect(other.getByText(/read-only/i)).toBeVisible();
    expect(await statValue(other, "Verdict")).toBe(verdict);
    expect(await statValue(other, "p-value")).toBe(p);
    expect(await other.evaluate(() => localStorage.getItem("abkit-experiments-v2")), "viewing a shared result stores nothing").toBeNull();
    await expect(other.getByRole("button", { name: /save to my experiments/i })).toBeVisible();
    await fresh.close();
  });

  test("legacy base64 share links still decode", async ({ page, browser, policy }, testInfo) => {
    await open(page, "/", "Experiments");
    const json = await page.evaluate((id) => {
      const parse = (raw: string | null): { id: string }[] => {
        if (!raw) return [];
        const data = JSON.parse(raw) as { experiments?: { id: string }[] } | { id: string }[];
        return Array.isArray(data) ? data : (data.experiments ?? []);
      };
      const all = [...parse(localStorage.getItem("abkit-experiments-v2")), ...parse(localStorage.getItem("abkit-experiments-v1"))];
      const found = all.find((e) => e.id === id);
      return found ? JSON.stringify(found) : null;
    }, DEMO.mapDefault.id);
    expect(json, "demo experiment found in storage").toBeTruthy();

    const fresh = await policy.newContext(browser, testInfo);
    const other = await fresh.newPage();
    await other.goto(`/share/${v1ShareToken(json ?? "")}`);
    await expect(other.getByRole("heading", { level: 1, name: DEMO.mapDefault.name })).toBeVisible();
    await expect(other.getByRole("alert").filter({ hasText: /sample-ratio mismatch/i })).toBeVisible();
    expect(await statValue(other, "Verdict")).toBe("SRM — invalid");
    await fresh.close();
  });

  test("an undecodable share token shows a recoverable not-found page", async ({ page }) => {
    await open(page, "/share/not-a-valid-share-token", /not found/i);
    await expect(page.getByText(/could not be decoded|doesn't match/i)).toBeVisible();
    await page.getByRole("link", { name: "Back to experiments" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();
  });
});
