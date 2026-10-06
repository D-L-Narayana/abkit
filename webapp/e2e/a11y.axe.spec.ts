import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ROUTES, open, presetTheme } from "./helpers";

/**
 * Accessibility audit with axe-core on every route in both themes. This spec runs ONLY in the `a11y-axe-instrumentation`
 * project: axe is injected as script content, which the production policy (`script-src 'self'`) refuses, so that project
 * sets `bypassCSP`. The application-flow projects keep CSP enforced and ignore this file.
 */
interface Audit { route: string; theme: string; violations: { id: string; impact: string; nodes: number }[]; passes: number; incomplete: number }
const summary: Audit[] = [];

// Summary for the evidence folder; merged across worker restarts so a failing audit does not erase the others.
test.afterAll(async ({}, workerInfo) => {
  const dir = workerInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "axe-summary.json");
  const merged = new Map<string, Audit>();
  try {
    for (const a of (JSON.parse(readFileSync(file, "utf8")) as { results?: Audit[] }).results ?? []) merged.set(`${a.theme} ${a.route}`, a);
  } catch {
    /* first write of this run */
  }
  for (const a of summary) merged.set(`${a.theme} ${a.route}`, a);
  const results = [...merged.values()];
  const serious = results.flatMap((s) => s.violations.filter((v) => v.impact === "serious" || v.impact === "critical"));
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), audits: results.length, seriousOrCritical: serious.length, results }, null, 2));
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`axe audit · ${theme} theme`, () => {
    for (const route of ROUTES) {
      test(`${route.path} has no serious or critical violations`, async ({ page, context }, testInfo) => {
        await presetTheme(context, theme);
        await open(page, route.path, route.h1);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.evaluate(() => document.fonts.ready);
        // Contrast is measured on the settled page: the cards fade in (`.rise`, opacity 0 → 1 over ~0.6 s), and text sampled
        // mid-animation reads as low-contrast. Wait for every finite animation/transition to finish (infinite ones such as a
        // spinner are skipped); capped so a paused animation can never hang the audit.
        await page.evaluate(() => {
          const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
          const settled = Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
          return Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        });
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        summary.push({
          route: route.path,
          theme,
          violations: results.violations.map((v) => ({ id: v.id, impact: v.impact ?? "unknown", nodes: v.nodes.length })),
          passes: results.passes.length,
          incomplete: results.incomplete.length,
        });
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        if (serious.length > 0) await testInfo.attach("axe-violations.json", { body: JSON.stringify(serious, null, 2), contentType: "application/json" });
        expect(serious.map((v) => `${v.impact}: ${v.id} — ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`)).toEqual([]);
      });
    }
  });
}
