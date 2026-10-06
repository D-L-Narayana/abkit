import { defineConfig, devices } from "@playwright/test";

/**
 * Browser checks run against the production bundle (`dist/`) served by `e2e/serve-dist.mjs`, which applies the response
 * headers and SPA rewrites declared in the repository's `vercel.json`. The application-flow projects therefore run with
 * the real Content-Security-Policy ENFORCED — `bypassCSP` must never be set on them.
 */
// Default port 4173 (the `serve:dist` script). `ABKIT_E2E_PORT` moves the server when that port is taken on a shared machine;
// the extra `--port` passed through `npm run serve:dist --` overrides the script's default (the last one wins).
const PORT = Number(process.env.ABKIT_E2E_PORT ?? "4173");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`ABKIT_E2E_PORT must be a TCP port, got "${process.env.ABKIT_E2E_PORT}"`);
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const SERVE_COMMAND = PORT === 4173 ? "npm run serve:dist" : `npm run serve:dist -- --port ${PORT}`;

// The screenshots project rewrites docs/screenshots/*.jpg and public/og.png, so it only exists when asked for explicitly
// (`npm run e2e:screens` → `playwright test --project=screenshots`). The flag is propagated through the environment
// because worker processes re-evaluate this file and must build the same project list as the runner.
const argv = process.argv.slice(2);
const screenshotsRequested =
  process.env.ABKIT_E2E_SCREENSHOTS === "1" || argv.some((a, i) => a === "--project=screenshots" || (a === "--project" && argv[i + 1] === "screenshots"));
if (screenshotsRequested) process.env.ABKIT_E2E_SCREENSHOTS = "1";

const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };
const mobile = { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 };

/** Specs that need their own project: the axe audit (CSP bypass) and the screenshot generator. */
const NOT_APPLICATION_FLOWS = ["**/a11y.axe.spec.ts", "**/screenshots.spec.ts"];

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    // Keep artifacts small: no traces or videos, a screenshot only when a test fails.
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: SERVE_COMMAND,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    // Application flows, CSP enforced (desktop).
    { name: "chromium-desktop", testIgnore: NOT_APPLICATION_FLOWS, use: desktop },
    // Application flows, CSP enforced (phone). The HTTP header spec is viewport-independent and runs once, on desktop.
    { name: "chromium-mobile", testIgnore: [...NOT_APPLICATION_FLOWS, "**/headers.spec.ts"], use: mobile },
    {
      // Accessibility audit. axe-core is injected into the page as script content, which the production policy
      // (`script-src 'self'`) would refuse, so this project bypasses CSP. The bypass applies to this axe
      // instrumentation context ONLY — the application-flow projects above keep the policy enforced.
      name: "a11y-axe-instrumentation",
      testMatch: ["**/a11y.axe.spec.ts"],
      use: { ...desktop, bypassCSP: true },
    },
    ...(screenshotsRequested ? [{ name: "screenshots", testMatch: ["**/screenshots.spec.ts"], use: desktop }] : []),
  ],
});
