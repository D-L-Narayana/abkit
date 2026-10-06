// Dependency-free static server for the production bundle. It applies the response headers and SPA rewrites declared in
// the repository's vercel.json, so the browser checks run against the same Content-Security-Policy and security headers
// as the deployed site. Node ≥ 18, no packages.
//
//   node e2e/serve-dist.mjs --port 4173 [--dist ../dist] [--config ../../vercel.json]
//
// Paths are resolved relative to this file. Request handling mirrors Vercel's static hosting:
//   1. an existing file under dist is served with its Content-Type;
//   2. otherwise the first matching `rewrites[]` rule serves its destination file;
//   3. otherwise 404 text/plain.
// Every response carries all `headers[]` entries whose `source` matches the request path, in file order; the first value
// per header name wins. The server binds to 127.0.0.1 and refuses paths that escape the dist directory.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function fail(message) {
  console.error(`serve-dist: ${message}`);
  process.exit(1);
}

/** `--name value` or `--name=value`; the last occurrence wins, so `npm run serve:dist -- --port 4199` overrides the script's default. */
function option(name, fallback) {
  const argv = process.argv.slice(2);
  let value = fallback;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name && argv[i + 1] !== undefined) value = argv[++i];
    else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
  }
  return value;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: node e2e/serve-dist.mjs --port 4173 [--dist ../dist] [--config ../../vercel.json]");
  process.exit(0);
}

const port = Number(option("--port", "4173"));
const dist = resolve(HERE, option("--dist", "../dist"));
const configPath = resolve(HERE, option("--config", "../../vercel.json"));

if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid --port value "${option("--port", "")}"`);
if (!existsSync(resolve(dist, "index.html"))) fail(`${resolve(dist, "index.html")} is missing — run npm run build first`);
if (!existsSync(configPath)) fail(`${configPath} is missing`);

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  fail(`${configPath} is not valid JSON: ${err.message}`);
}

/** Vercel `source` strings are plain regular expressions matched against the whole path. */
function compile(source, where) {
  try {
    return new RegExp(`^${source}$`);
  } catch (err) {
    return fail(`${where}: cannot compile source "${source}": ${err.message}`);
  }
}
const headerRules = (config.headers ?? []).map((rule, i) => ({ test: compile(rule.source, `headers[${i}]`), headers: rule.headers ?? [] }));
const rewriteRules = (config.rewrites ?? []).map((rule, i) => ({ test: compile(rule.source, `rewrites[${i}]`), destination: String(rule.destination ?? "") }));

function applyHeaders(res, pathname) {
  const seen = new Set();
  for (const rule of headerRules) {
    if (!rule.test.test(pathname)) continue;
    for (const { key, value } of rule.headers) {
      const name = String(key).toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      res.setHeader(key, value);
    }
  }
}

/** Absolute path of an existing regular file under dist for a request path, or null (also for any traversal attempt). */
function fileUnderDist(pathname) {
  if (pathname.includes("\0") || pathname.split("/").some((segment) => segment === "..")) return null;
  const file = resolve(dist, `.${pathname}`);
  if (file !== dist && !file.startsWith(dist + sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function send(req, res, status, pathname, file, text) {
  applyHeaders(res, pathname);
  const body = file ? readFileSync(file) : Buffer.from(text ?? "", "utf8");
  const type = file ? CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" : "text/plain; charset=utf-8";
  res.writeHead(status, { "Content-Type": type, "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "/", null, "method not allowed");
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", `http://${HOST}`).pathname);
  } catch {
    return send(req, res, 400, "/", null, "bad request");
  }
  const file = fileUnderDist(pathname);
  if (file) return send(req, res, 200, pathname, file);
  for (const rule of rewriteRules) {
    if (!rule.test.test(pathname)) continue;
    const target = fileUnderDist(pathname.replace(rule.test, rule.destination));
    return target ? send(req, res, 200, pathname, target) : send(req, res, 404, pathname, null, "not found");
  }
  return send(req, res, 404, pathname, null, "not found");
});

server.on("error", (err) => fail(`cannot listen on http://${HOST}:${port}: ${err.message}`));
server.listen(port, HOST, () => {
  console.log(`serving ${dist} at http://${HOST}:${port}/ with ${headerRules.length} header rule(s) and ${rewriteRules.length} rewrite(s) from ${configPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections?.();
    process.exit(0);
  });
}
