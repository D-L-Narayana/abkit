import { expect, test as base, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";

export { expect };

/** One `securitypolicyviolation` event as recorded by the page-side listener installed on every document. */
export interface CspViolation {
  documentURI: string;
  blockedURI: string;
  violatedDirective: string;
  effectiveDirective: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
  disposition: string;
}

declare global {
  interface Window {
    /** Violations seen by the current document (mirror of what the Node side receives through the binding). */
    __abkitCspViolations?: CspViolation[];
    __abkitReportCspViolation?: (violation: CspViolation) => void;
  }
}

/** Console messages that indicate a policy refusal or a network-level failure. */
const REFUSAL = /Content Security Policy|Refused to|net::ERR_|Failed to load resource/i;

/**
 * Records everything the production policy forbids while a test drives the app with CSP enforced:
 * `securitypolicyviolation` events, console refusals, console errors, uncaught page errors, failed requests and
 * requests to any origin other than the server under test. `assertClean()` runs after every test.
 */
export class PolicyMonitor {
  readonly violations: CspViolation[] = [];
  readonly consoleRefusals: { page: string; type: string; text: string }[] = [];
  readonly consoleErrors: { page: string; text: string }[] = [];
  readonly pageErrors: { page: string; message: string }[] = [];
  readonly requestFailed: { page: string; url: string; error: string }[] = [];
  readonly foreignRequests: { page: string; url: string }[] = [];
  private readonly contexts = new Set<BrowserContext>();

  constructor(readonly origin: string) {}

  /** Instrument a browser context: violation capture in every document plus page-level listeners. */
  async watch(context: BrowserContext): Promise<void> {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    await context.exposeBinding("__abkitReportCspViolation", (_source, violation: CspViolation) => {
      this.violations.push(violation);
    });
    await context.addInitScript(() => {
      const list: CspViolation[] = [];
      window.__abkitCspViolations = list;
      document.addEventListener("securitypolicyviolation", (e) => {
        const violation: CspViolation = {
          documentURI: e.documentURI,
          blockedURI: e.blockedURI,
          violatedDirective: e.violatedDirective,
          effectiveDirective: e.effectiveDirective,
          sourceFile: e.sourceFile,
          lineNumber: e.lineNumber,
          sample: e.sample,
          disposition: e.disposition,
        };
        list.push(violation);
        window.__abkitReportCspViolation?.(violation);
      });
    });
    context.on("page", (page) => this.attach(page));
    for (const page of context.pages()) this.attach(page);
  }

  /** A fresh, instrumented context that mirrors the current project's device settings (used for share-link checks). */
  async newContext(browser: Browser, testInfo: TestInfo, overrides: BrowserContextOptions = {}): Promise<BrowserContext> {
    const use = testInfo.project.use;
    const context = await browser.newContext({
      baseURL: this.origin,
      viewport: use.viewport ?? null,
      isMobile: use.isMobile,
      hasTouch: use.hasTouch,
      deviceScaleFactor: use.deviceScaleFactor,
      userAgent: use.userAgent,
      locale: use.locale,
      timezoneId: use.timezoneId,
      colorScheme: use.colorScheme,
      ...overrides,
    });
    await this.watch(context);
    return context;
  }

  private attach(page: Page): void {
    page.on("console", (msg) => {
      const text = msg.text();
      if (REFUSAL.test(text)) this.consoleRefusals.push({ page: page.url(), type: msg.type(), text });
      else if (msg.type() === "error") this.consoleErrors.push({ page: page.url(), text });
    });
    page.on("pageerror", (err) => this.pageErrors.push({ page: page.url(), message: err.message }));
    page.on("requestfailed", (req) => this.requestFailed.push({ page: page.url(), url: req.url(), error: req.failure()?.errorText ?? "unknown" }));
    page.on("request", (req) => {
      const url = req.url();
      if (!this.isSameOrigin(url)) this.foreignRequests.push({ page: page.url(), url });
    });
  }

  private isSameOrigin(url: string): boolean {
    if (url.startsWith("data:") || url.startsWith("about:")) return true;
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  /** Collect the per-document mirrors of still-open pages, attach details to the report, and assert every list is empty. */
  async assertClean(testInfo: TestInfo): Promise<void> {
    for (const context of this.contexts) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        const seen = await page.evaluate(() => window.__abkitCspViolations ?? []).catch(() => [] as CspViolation[]);
        for (const violation of seen) {
          const key = JSON.stringify(violation);
          if (!this.violations.some((v) => JSON.stringify(v) === key)) this.violations.push(violation);
        }
      }
    }
    const report = {
      origin: this.origin,
      violations: this.violations,
      consoleRefusals: this.consoleRefusals,
      consoleErrors: this.consoleErrors,
      pageErrors: this.pageErrors,
      requestFailed: this.requestFailed,
      foreignRequests: this.foreignRequests,
    };
    if (Object.values(report).some((v) => Array.isArray(v) && v.length > 0)) {
      await testInfo.attach("policy-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    }
    expect(this.violations, "securitypolicyviolation events under the enforced production CSP").toEqual([]);
    expect(this.consoleRefusals, "console messages reporting CSP refusals or network errors").toEqual([]);
    expect(this.consoleErrors, "console.error output").toEqual([]);
    expect(this.pageErrors, "uncaught page errors").toEqual([]);
    expect(this.requestFailed, "failed requests").toEqual([]);
    expect(this.foreignRequests, "requests to origins other than the server under test").toEqual([]);
  }
}

/**
 * Every application-flow spec imports `test` from here. The `policy` fixture is automatic: it instruments the default
 * context before the page is created and fails the test afterwards if anything violated the production policy.
 */
export const test = base.extend<{ policy: PolicyMonitor }>({
  policy: [
    async ({ context, baseURL }, use, testInfo) => {
      if (!baseURL) throw new Error("baseURL must be configured");
      const monitor = new PolicyMonitor(new URL(baseURL).origin);
      await monitor.watch(context);
      await use(monitor);
      await monitor.assertClean(testInfo);
    },
    { auto: true },
  ],
  // The default page must be created after the context is instrumented (fixture order follows the parameter order).
  page: async ({ policy, page }, use) => {
    void policy;
    await use(page);
  },
});
