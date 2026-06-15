import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedOrigins, corsHeaders } from "../src/index.ts";

const req = (origin?: string) =>
  new Request("https://gemini-mcp.example.workers.dev/s/mcp", origin ? { headers: { origin } } : {});
const env = (allowed?: string) => ({ ALLOWED_ORIGINS: allowed }) as any;

test("allowedOrigins falls back to the claude.ai default, else parses the var", () => {
  assert.deepEqual(allowedOrigins(env()), ["https://claude.ai", "https://www.claude.ai"]);
  assert.deepEqual(allowedOrigins(env("")), ["https://claude.ai", "https://www.claude.ai"]);
  assert.deepEqual(allowedOrigins(env(" https://a.com , https://b.com ")), ["https://a.com", "https://b.com"]);
});

test("/mcp CORS echoes only allow-listed origins", () => {
  // Default allow-list: claude.ai is echoed (with Vary); other origins get no allow-origin.
  const okH = corsHeaders(req("https://claude.ai"), env(), false);
  assert.equal(okH["Access-Control-Allow-Origin"], "https://claude.ai");
  assert.equal(okH["Vary"], "Origin");
  const badH = corsHeaders(req("https://evil.example"), env(), false);
  assert.equal(badH["Access-Control-Allow-Origin"], undefined);
  // A non-browser client (no Origin) is unaffected — no allow-origin needed.
  assert.equal(corsHeaders(req(), env(), false)["Access-Control-Allow-Origin"], undefined);
});

test("public /img and ALLOWED_ORIGINS=* always allow any origin", () => {
  assert.equal(corsHeaders(req("https://evil.example"), env(), true)["Access-Control-Allow-Origin"], "*");
  assert.equal(corsHeaders(req("https://evil.example"), env("*"), false)["Access-Control-Allow-Origin"], "*");
});

test("a custom ALLOWED_ORIGINS entry is honored on /mcp", () => {
  const h = corsHeaders(req("https://my.app"), env("https://my.app"), false);
  assert.equal(h["Access-Control-Allow-Origin"], "https://my.app");
  // ...and the default claude.ai origin is no longer allowed once you override.
  assert.equal(corsHeaders(req("https://claude.ai"), env("https://my.app"), false)["Access-Control-Allow-Origin"], undefined);
});

test("base CORS headers are always present", () => {
  const h = corsHeaders(req("https://claude.ai"), env(), false);
  assert.equal(h["Referrer-Policy"], "no-referrer");
  assert.match(h["Access-Control-Allow-Methods"], /POST/);
});
