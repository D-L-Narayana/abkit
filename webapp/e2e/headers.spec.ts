import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Production response headers, served by e2e/serve-dist.mjs from the repository's vercel.json. Expected values are read
 * from that file (never duplicated here); the test only fixes WHICH headers must exist and what the policy must forbid.
 */
const VERCEL_JSON = fileURLToPath(new URL("../../vercel.json", import.meta.url));
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

interface VercelConfig {
  headers?: { source: string; headers: { key: string; value: string }[] }[];
  rewrites?: { source: string; destination: string }[];
}
const config = JSON.parse(readFileSync(VERCEL_JSON, "utf8")) as VercelConfig;
const anchored = (source: string): RegExp => new RegExp(`^${source}$`);

/** Header name → value that vercel.json declares for a request path (file order, first value per name wins). */
function declaredHeaders(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of config.headers ?? []) {
    if (!anchored(rule.source).test(path)) continue;
    for (const { key, value } of rule.headers) if (!out.has(key.toLowerCase())) out.set(key.toLowerCase(), value);
  }
  return out;
}
const rewriteFor = (path: string) => (config.rewrites ?? []).find((r) => anchored(r.source).test(path));

/** Security headers every HTML and asset response must carry (values come from vercel.json). */
const SECURITY_HEADERS = ["content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy", "strict-transport-security", "cross-origin-opener-policy"] as const;

const indexHtml = readFileSync(`${DIST}index.html`, "utf8");
const firstAsset = (ext: string): string => {
  const match = indexHtml.match(new RegExp(`/assets/[\\w.-]+\\.${ext}`));
  if (!match) throw new Error(`dist/index.html references no /assets/*.${ext}`);
  return match[0];
};
const assetFiles = (ext: string): string[] => (existsSync(`${DIST}assets`) ? readdirSync(`${DIST}assets`).filter((f) => f.endsWith(`.${ext}`)).sort() : []);

function parseCsp(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

async function expectSecurityHeaders(headers: Record<string, string>, path: string): Promise<void> {
  const declared = declaredHeaders(path);
  for (const name of SECURITY_HEADERS) {
    const expected = declared.get(name);
    expect(expected, `vercel.json declares ${name} for ${path}`).toBeTruthy();
    expect(headers[name], `${name} served for ${path}`).toBe(expected);
  }
}

test.describe("production headers and routing", () => {
  test("the SPA shell is served with every security header at its exact vercel.json value", async ({ request }) => {
    const res = await request.get("/");
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    await expectSecurityHeaders(headers, "/");
    expect(await res.text()).toContain('<div id="root">');

    // The policy that the browser checks run under must be strict: same-origin scripts only, no eval, no third parties.
    const csp = parseCsp(headers["content-security-policy"] ?? "");
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("font-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(headers["content-security-policy"]).not.toMatch(/unsafe-eval|https?:\/\//);
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  test("compiled script and stylesheet assets are typed correctly, cached immutably and carry the security headers", async ({ request }) => {
    const script = firstAsset("js");
    const stylesheet = firstAsset("css");
    const cacheControl = declaredHeaders(script).get("cache-control");
    expect(cacheControl, "vercel.json declares cache-control for /assets/*").toBeTruthy();
    expect(cacheControl).toMatch(/\bimmutable\b/);
    expect(cacheControl).toMatch(/max-age=\d{6,}/);

    const js = await request.get(script);
    expect(js.status()).toBe(200);
    expect(js.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers()["cache-control"]).toBe(cacheControl);
    await expectSecurityHeaders(js.headers(), script);

    const css = await request.get(stylesheet);
    expect(css.status()).toBe(200);
    expect(css.headers()["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.headers()["cache-control"]).toBe(cacheControl);
    await expectSecurityHeaders(css.headers(), stylesheet);
  });

  test("self-hosted fonts are emitted as /assets/*.woff2 files (never inlined as data: URLs) and served as font/woff2", async ({ request }) => {
    const fonts = assetFiles("woff2");
    expect(fonts.some((f) => /geist/i.test(f)), "a Geist subset is bundled").toBe(true);
    expect(fonts.some((f) => /jetbrains-mono/i.test(f)), "a JetBrains Mono subset is bundled").toBe(true);
    for (const file of fonts) {
      const path = `/assets/${file}`;
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()["content-type"], path).toBe("font/woff2");
      expect(res.headers()["cache-control"], path).toBe(declaredHeaders(path).get("cache-control"));
      expect((await res.body()).subarray(0, 4).toString("latin1"), `${path} starts with the woff2 signature`).toBe("wOF2");
    }
    // font-src 'self' refuses data: fonts, so every @font-face must point at a bundled file. The only data: URLs the
    // policy tolerates inside CSS are images (img-src 'self' data: blob:), such as an inline SVG icon.
    const stylesheets = assetFiles("css");
    expect(stylesheets.length).toBeGreaterThan(0);
    for (const file of stylesheets) {
      const served = await (await request.get(`/assets/${file}`)).text();
      expect(served === readFileSync(`${DIST}assets/${file}`, "utf8"), `${file} is served byte-for-byte`).toBe(true);
      const embedded = [...served.matchAll(/url\(\s*["']?(data:[^;,)"']*)/g)].map((m) => m[1] ?? "");
      expect(embedded.filter((u) => !u.startsWith("data:image/")), `${file}: embedded data: URLs that are not images`).toEqual([]);
      const faces = served.match(/@font-face\s*\{[^}]*\}/g) ?? [];
      expect(faces.length, `${file}: @font-face rules`).toBeGreaterThanOrEqual(2);
      for (const face of faces) {
        expect(face, `${file}: @font-face embeds its file`).not.toMatch(/data:/);
        expect(face, `${file}: @font-face points at a bundled woff2`).toMatch(/url\(\/assets\/[\w.-]+\.woff2\)/);
      }
    }
  });

  test("application routes are rewritten to the SPA shell while static files are excluded from the rewrite", async ({ request }) => {
    for (const path of ["/exp/exp-ranker-v2", "/share/2.abc", "/calculator", "/definitely-missing-page"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()["content-type"], path).toBe("text/html; charset=utf-8");
      expect(await res.text(), path).toContain('<div id="root">');
      await expectSecurityHeaders(res.headers(), path);
      expect(rewriteFor(path)?.destination, `vercel.json rewrites ${path}`).toBe("/index.html");
    }
    for (const path of ["/theme-init.js", "/favicon.svg", "/og.png", "/assets/index-abc123.js", "/assets/geist-latin-wght-normal-abc123.woff2"]) {
      expect(rewriteFor(path), `vercel.json must not rewrite ${path}`).toBeUndefined();
    }
  });

  test("static files are served as themselves, never as HTML", async ({ request }) => {
    const theme = await request.get("/theme-init.js");
    expect(theme.status()).toBe(200);
    expect(theme.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
    const body = await theme.text();
    expect(body).toContain("abkit-theme");
    expect(body).not.toMatch(/<!doctype html>/i);
    await expectSecurityHeaders(theme.headers(), "/theme-init.js");

    const icon = await request.get("/favicon.svg");
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toBe("image/svg+xml");

    const og = await request.get("/og.png");
    expect(og.status(), "og.png referenced by the og:image meta tag exists").toBe(200);
    expect(og.headers()["content-type"]).toBe("image/png");
    const png = await og.body();
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16), "og.png width").toBe(1200);
    expect(png.readUInt32BE(20), "og.png height").toBe(630);
  });

  test("missing assets are 404 text/plain (not the shell) and path traversal is refused", async ({ request }) => {
    const missing = await request.get("/assets/missing.js");
    expect(missing.status()).toBe(404);
    expect(missing.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(await missing.text()).not.toContain("<html");
    expect(missing.headers()["x-content-type-options"]).toBe(declaredHeaders("/assets/missing.js").get("x-content-type-options"));

    // Encoded slashes survive URL normalisation; the server must still refuse to leave the dist directory.
    const traversal = await request.get("/assets/..%2f..%2fpackage.json");
    expect(traversal.status()).toBe(404);
    expect(await traversal.text()).not.toContain("abkit-web");
    // Dot segments are collapsed by URL parsing; whatever remains must never expose files outside dist.
    const encodedDots = await request.get("/%2e%2e/%2e%2e/package.json");
    expect(encodedDots.status()).toBeLessThan(500);
    expect(await encodedDots.text()).not.toContain("abkit-web");
  });
});
