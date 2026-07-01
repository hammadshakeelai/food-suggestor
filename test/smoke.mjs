// Dependency-free smoke tests for the Food Suggestor server.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_PORT || 4599);
const base = `http://127.0.0.1:${PORT}`;

let child;

before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write(d));

  // Wait until the server answers /api/health (max ~5s).
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("Server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  if (child && !child.killed) child.kill();
});

test("GET /api/health returns ok", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.hasAgnesKey, "boolean");
});

test("GET / serves the app shell with security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const html = await res.text();
  assert.match(html, /Pink Plate/);
});

test("unknown /api route returns 404 JSON", async () => {
  const res = await fetch(`${base}/api/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "Not found");
});

test("missing static asset returns 404", async () => {
  const res = await fetch(`${base}/styles-missing.css`);
  assert.equal(res.status, 404);
});

test("navigation route falls back to app shell (200 HTML)", async () => {
  const res = await fetch(`${base}/some/client/route`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
});

test("POST /api/suggest with invalid JSON returns 400", async () => {
  const res = await fetch(`${base}/api/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json"
  });
  assert.equal(res.status, 400);
});

test("PUT / returns 405", async () => {
  const res = await fetch(`${base}/`, { method: "PUT" });
  assert.equal(res.status, 405);
});

test("path traversal cannot escape the public directory", async () => {
  // Encoded traversal toward the project's .env must not leak secrets.
  const res = await fetch(`${base}/..%2f.env`);
  const text = await res.text();
  assert.ok(!/AGNES_API_KEY=sk-/.test(text), "response must not contain the API key");
});
