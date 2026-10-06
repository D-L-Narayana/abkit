import { readFileSync } from "node:fs";
import { expect, type BrowserContext, type Download, type Locator, type Page, type TestInfo } from "@playwright/test";

/** The six demo experiments seeded on first visit (ids and names are stable across releases). */
export const DEMO = {
  rankerV2: { id: "exp-ranker-v2", name: "Search ranker v2 (LTR) vs price sort" },
  freeCancel: { id: "exp-free-cancel-badge", name: "Free-cancellation badge on hotel cards" },
  urgency: { id: "exp-urgency-copy", name: "Scarcity copy: 'Only 2 left' on results" },
  checkout: { id: "exp-checkout-2step", name: "Two-step checkout vs single page" },
  upsell: { id: "exp-genius-upsell", name: "Loyalty upsell module: revenue per visitor" },
  mapDefault: { id: "exp-map-default", name: "Map view as default on mobile" },
} as const;
export const DEMO_LIST = Object.values(DEMO);

/** Every route of the SPA with the heading it must render (used for the policy sweep and the axe audit). */
export const ROUTES: { path: string; h1: string | RegExp }[] = [
  { path: "/", h1: "Experiments" },
  { path: "/new", h1: "New experiment" },
  { path: "/calculator", h1: "Calculators" },
  { path: "/ranking", h1: "Ranking metrics playground" },
  { path: "/upload", h1: "Upload experiment data" },
  { path: "/docs", h1: "Docs" },
  { path: `/exp/${DEMO.rankerV2.id}`, h1: DEMO.rankerV2.name },
  { path: `/exp/${DEMO.mapDefault.id}`, h1: DEMO.mapDefault.name },
  { path: `/exp/${DEMO.upsell.id}`, h1: DEMO.upsell.name },
  { path: "/share/not-a-valid-share-token", h1: /not found/i },
  { path: "/definitely-missing-page", h1: /not found/i },
];

/** Phone layout breakpoint of the app (Tailwind `md`). */
export const isMobile = (testInfo: TestInfo): boolean => (testInfo.project.use.viewport?.width ?? 1440) < 768;

/**
 * Store a theme choice before any document of the context loads, exactly as a returning visitor would have it.
 * Init scripts also run on `about:blank`, where storage access is denied, so only http(s) documents are touched.
 */
export async function presetTheme(context: BrowserContext, theme: "light" | "dark"): Promise<void> {
  await context.addInitScript((t) => {
    if (location.protocol.startsWith("http")) localStorage.setItem("abkit-theme", t);
  }, theme);
}

/**
 * Navigate to a route and wait until the page heading is rendered and the web fonts have settled, so that a following
 * navigation never aborts an in-flight request (which would otherwise surface as a `requestfailed` policy finding).
 */
export async function open(page: Page, path: string, h1?: string | RegExp): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.status;
  });
}

/** Click a primary navigation entry (top bar on desktop, bottom tab bar on phones). */
export async function navigateTo(page: Page, label: string, testInfo: TestInfo): Promise<void> {
  const nav = page.getByRole("navigation", { name: isMobile(testInfo) ? "Mobile" : "Primary" });
  await nav.getByRole("link", { name: label }).click();
}

/** The visible dashboard row (table row on desktop, card on phones) that links to an experiment by its exact name. */
export function experimentRow(page: Page, name: string): Locator {
  return page.locator("tr, li").filter({ has: page.getByRole("link", { name, exact: true }) }).filter({ visible: true });
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Value shown in a `Stat` tile (small-caps label above a monospace value), e.g. statValue(page, "p-value"). */
export async function statValue(page: Page, label: string): Promise<string> {
  const labelEl = page.locator("div.card > div").filter({ hasText: new RegExp(`^${escapeRegExp(label)}$`, "i") }).first();
  const tile = labelEl.locator("..");
  await expect(tile, `Stat tile "${label}"`).toBeVisible();
  return ((await tile.locator(".mono").first().textContent()) ?? "").trim();
}

/** Drive the wizard from the name field to the results page; tolerant to the number of steps in between. Returns the id. */
export async function createExperiment(page: Page, name: string): Promise<string> {
  await open(page, "/new", "New experiment");
  await page.getByRole("textbox", { name: /experiment name/i }).fill(name);
  for (let i = 0; i < 6; i++) {
    if (await page.getByRole("button", { name: /launch experiment/i }).isVisible()) break;
    await page.getByRole("button", { name: /continue/i }).click();
  }
  await page.getByRole("button", { name: /launch experiment/i }).click();
  await expect(page).toHaveURL(/\/exp\//);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

/** Text of a finished download. */
export async function downloadText(download: Download): Promise<string> {
  const path = await download.path();
  return readFileSync(path, "utf8");
}

/** Parse "1,234" / "–" style numbers rendered by the app. */
export const parseNumber = (text: string | null): number => Number(String(text ?? "").replace(/[,\s]/g, ""));

/** Horizontal overflow check — the layout must fit the viewport on every route. */
export async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

// ---------- formatting twins of the app (for comparing displayed numbers) ----------
export const fmtPct = (x: number, d = 2): string => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : "–");
export const fmtP = (p: number): string => (!Number.isFinite(p) ? "–" : p < 1e-4 ? p.toExponential(1) : p.toFixed(4));

/** Tolerance implied by the app's p-value formatting (4 decimals, or 1 decimal in exponent form below 1e-4). */
export function expectPClose(displayed: string, p: number): void {
  const shown = Number(displayed);
  expect(Number.isFinite(shown), `displayed p-value "${displayed}" is numeric`).toBe(true);
  const tolerance = p < 1e-4 ? 0.06 * p : 5.1e-5;
  expect(Math.abs(shown - p), `displayed p ${displayed} vs expected ${p}`).toBeLessThanOrEqual(tolerance);
}

// ---------- independent statistical oracles (not imported from the app) ----------
function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Exact two-sided binomial test p-value, summing every outcome at most as likely as the observed one (SciPy's method). */
export function binomialTwoSidedP(k: number, n: number, p0 = 0.5): number {
  const logPmf = (i: number) => lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * Math.log(p0) + (n - i) * Math.log(1 - p0);
  const reference = logPmf(k) + Math.log1p(1e-7);
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const lp = logPmf(i);
    if (lp <= reference) sum += Math.exp(lp);
  }
  return Math.min(1, sum);
}

/** Standard normal quantiles used by the planning formulas (reference values, 15 significant digits). */
export const Z = { q975: 1.959963984540054, q80: 0.8416212335729143 } as const;

/** Users per arm for a two-sided two-proportion test at α = 0.05 and power 0.8 (same formula as the Docs page). */
export function sampleSizeProportion(baseline: number, mdeRel: number): number {
  const p1 = baseline;
  const p2 = baseline * (1 + mdeRel);
  const pbar = (p1 + p2) / 2;
  const num = Z.q975 * Math.sqrt(2 * pbar * (1 - pbar)) + Z.q80 * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num / (p2 - p1)) ** 2);
}

/** Legacy (v1) share token: base64url of the UTF-8 JSON of the experiment. */
export const v1ShareToken = (experimentJson: string): string => Buffer.from(experimentJson, "utf8").toString("base64url");
