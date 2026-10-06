import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { DEMO, open, presetTheme } from "./helpers";

/**
 * Regenerates the documentation screenshots and the Open Graph image from real renders of the production bundle, served
 * with the production headers (CSP enforced). Runs only in the `screenshots` project: `npm run e2e:screens`.
 */
const SHOTS = fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));
const OG = fileURLToPath(new URL("../public/og.png", import.meta.url));

const DESKTOP = { width: 1360, height: 850 };
const MOBILE = { width: 390, height: 844 };

type Theme = "light" | "dark";
interface Shot { file: string; theme: Theme; viewport: typeof DESKTOP; render: (page: Page) => Promise<void> }

const SHOTS_LIST: Shot[] = [
  { file: "home-desktop.jpg", theme: "light", viewport: DESKTOP, render: (p) => open(p, "/", "Experiments") },
  { file: "exp-desktop.jpg", theme: "dark", viewport: DESKTOP, render: (p) => open(p, `/exp/${DEMO.rankerV2.id}`, DEMO.rankerV2.name) },
  {
    file: "cuped-desktop.jpg",
    theme: "light",
    viewport: DESKTOP,
    render: async (p) => {
      await open(p, `/exp/${DEMO.upsell.id}`, DEMO.upsell.name);
      await p.getByRole("heading", { name: /CUPED — before and after/ }).evaluate((el) => el.closest("section")?.scrollIntoView({ block: "end" }));
    },
  },
  { file: "srm-desktop.jpg", theme: "light", viewport: DESKTOP, render: (p) => open(p, `/exp/${DEMO.mapDefault.id}`, DEMO.mapDefault.name) },
  {
    file: "new-desktop.jpg",
    theme: "light",
    viewport: DESKTOP,
    render: async (p) => {
      await open(p, "/new", "New experiment");
      await p.getByRole("textbox", { name: /experiment name/i }).fill("Map view as default on mobile");
      await p.getByRole("button", { name: /continue/i }).click();
      await expect(p.getByRole("textbox", { name: /baseline/i })).toBeVisible();
      await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },
  { file: "calc-desktop.jpg", theme: "light", viewport: DESKTOP, render: (p) => open(p, "/calculator", "Calculators") },
  { file: "ranking-desktop.jpg", theme: "dark", viewport: DESKTOP, render: (p) => open(p, "/ranking", "Ranking metrics playground") },
  { file: "docs-desktop.jpg", theme: "dark", viewport: DESKTOP, render: (p) => open(p, "/docs", "Docs") },
  { file: "home-mobile.jpg", theme: "dark", viewport: MOBILE, render: (p) => open(p, "/", "Experiments") },
  { file: "exp-mobile.jpg", theme: "dark", viewport: MOBILE, render: (p) => open(p, `/exp/${DEMO.rankerV2.id}`, DEMO.rankerV2.name) },
  { file: "calc-mobile.jpg", theme: "light", viewport: MOBILE, render: (p) => open(p, "/calculator", "Calculators") },
  { file: "ranking-mobile.jpg", theme: "light", viewport: MOBILE, render: (p) => open(p, "/ranking", "Ranking metrics playground") },
];

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(250);
}

test.describe("documentation screenshots", () => {
  test("regenerates docs/screenshots/*.jpg and public/og.png from real renders", async ({ browser, policy }, testInfo) => {
    test.setTimeout(240_000);
    mkdirSync(SHOTS, { recursive: true });
    const contexts = new Map<string, BrowserContext>();
    const contextFor = async (theme: Theme, viewport: typeof DESKTOP) => {
      const key = `${theme}-${viewport.width}`;
      let ctx = contexts.get(key);
      if (!ctx) {
        ctx = await policy.newContext(browser, testInfo, { viewport, deviceScaleFactor: 1, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, colorScheme: theme, reducedMotion: "reduce" });
        await presetTheme(ctx, theme);
        contexts.set(key, ctx);
      }
      return ctx;
    };

    for (const shot of SHOTS_LIST) {
      const page = await (await contextFor(shot.theme, shot.viewport)).newPage();
      await shot.render(page);
      await settle(page);
      await page.screenshot({ path: `${SHOTS}${shot.file}`, type: "jpeg", quality: 80 });
      await page.close();
    }

    // Open Graph image: the dashboard in the dark theme at the canonical 1200×630.
    const ogContext = await policy.newContext(browser, testInfo, { viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
    await presetTheme(ogContext, "dark");
    const og = await ogContext.newPage();
    await open(og, "/", "Experiments");
    await settle(og);
    await og.screenshot({ path: OG, type: "png" });
    await ogContext.close();
    for (const ctx of contexts.values()) await ctx.close();
  });
});
