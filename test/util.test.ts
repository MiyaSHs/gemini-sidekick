import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPublicHttpUrl,
  base64ToBytes,
  bytesToBase64,
  coerceBool,
  coerceNumber,
  coerceStringArray,
  randomToken,
  sanitizeMethod,
  sanitizeModel,
  sanitizeOperationName,
  timingSafeEqual,
} from "../src/util.ts";

test("coerceStringArray accepts arrays, JSON-array strings, and bare strings", () => {
  assert.deepEqual(coerceStringArray(["a", "b"]), ["a", "b"]);
  assert.deepEqual(coerceStringArray('["a","b"]'), ["a", "b"]);
  assert.deepEqual(coerceStringArray("a"), ["a"]);
  assert.deepEqual(coerceStringArray(""), []);
  assert.deepEqual(coerceStringArray(null), []);
  assert.deepEqual(coerceStringArray(undefined), []);
  // a single non-JSON string that merely starts with '[' should survive
  assert.deepEqual(coerceStringArray("https://x/y?z=[1]"), ["https://x/y?z=[1]"]);
  // nested / mixed
  assert.deepEqual(coerceStringArray(['["a","b"]', "c"]), ["a", "b", "c"]);
});

test("coerceNumber and coerceBool tolerate string inputs", () => {
  assert.equal(coerceNumber(5), 5);
  assert.equal(coerceNumber("5"), 5);
  assert.equal(coerceNumber("  5.5 "), 5.5);
  assert.equal(coerceNumber("nope"), undefined);
  assert.equal(coerceNumber(""), undefined);
  assert.equal(coerceBool(true), true);
  assert.equal(coerceBool("true"), true);
  assert.equal(coerceBool("0"), false);
  assert.equal(coerceBool("no"), false);
  assert.equal(coerceBool(""), undefined);
});

test("base64 round-trips exact bytes (no pooled-buffer leakage)", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 13, 10, 0]);
  const b64 = bytesToBase64(bytes);
  const back = base64ToBytes(b64);
  assert.equal(back.length, bytes.length);
  assert.deepEqual([...back], [...bytes]);
  // the decoded buffer must be exactly the right size, not a larger pooled one
  assert.equal(back.buffer.byteLength, bytes.length);
});

test("base64ToBytes handles url-safe alphabet and missing padding", () => {
  // 0xFB 0xFF -> standard "+/8=", url-safe "-_8"
  assert.deepEqual([...base64ToBytes("-_8")], [0xfb, 0xff]);
});

test("sanitizeModel strips models/ prefix and rejects injection", () => {
  assert.equal(sanitizeModel("models/gemini-3.1-pro"), "gemini-3.1-pro");
  assert.equal(sanitizeModel("imagen-4.0-ultra-generate-001"), "imagen-4.0-ultra-generate-001");
  assert.throws(() => sanitizeModel("../../secret"), /Invalid model/);
  assert.throws(() => sanitizeModel("a:generateContent?key=x"), /Invalid model/);
  assert.throws(() => sanitizeModel(""), /required/);
});

test("sanitizeMethod allow-lists methods", () => {
  assert.equal(sanitizeMethod(undefined), "generateContent");
  assert.equal(sanitizeMethod("predict"), "predict");
  assert.equal(sanitizeMethod("predictLongRunning"), "predictLongRunning");
  assert.throws(() => sanitizeMethod("deleteEverything"), /Unsupported/);
});

test("sanitizeOperationName validates shape", () => {
  assert.equal(sanitizeOperationName("operations/abc-123"), "operations/abc-123");
  assert.equal(sanitizeOperationName("models/veo-3/operations/x.y_z"), "models/veo-3/operations/x.y_z");
  assert.throws(() => sanitizeOperationName("../escape"), /Invalid operation/);
  assert.throws(() => sanitizeOperationName("operations/a/../b"), /Invalid operation/);
});

test("timingSafeEqual matches only equal strings", async () => {
  assert.equal(await timingSafeEqual("secret-abc", "secret-abc"), true);
  assert.equal(await timingSafeEqual("secret-abc", "secret-abd"), false);
  assert.equal(await timingSafeEqual("short", "a-much-longer-secret"), false);
});

test("randomToken is url-safe and unguessable-length", () => {
  const t = randomToken(18);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.ok(t.length >= 20);
  assert.notEqual(randomToken(), randomToken());
});

test("assertPublicHttpUrl allows public http(s) and blocks SSRF targets", () => {
  assert.equal(assertPublicHttpUrl("https://example.com/a.png").hostname, "example.com");
  assert.equal(assertPublicHttpUrl("http://1.2.3.4/x").hostname, "1.2.3.4");
  // non-http(s)
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), /http/);
  assert.throws(() => assertPublicHttpUrl("ftp://example.com"), /http/);
  // loopback / private / link-local / metadata
  assert.throws(() => assertPublicHttpUrl("http://localhost/x"), /internal/);
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/x"), /private|loopback/);
  assert.throws(() => assertPublicHttpUrl("http://10.0.0.5/x"), /private|loopback/);
  assert.throws(() => assertPublicHttpUrl("http://192.168.1.1/x"), /private|loopback/);
  assert.throws(() => assertPublicHttpUrl("http://172.16.0.1/x"), /private|loopback/);
  assert.throws(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data"), /private|loopback/);
  assert.throws(() => assertPublicHttpUrl("http://[::1]/x"), /IPv6|private|loopback/);
  assert.throws(() => assertPublicHttpUrl("not a url"), /valid URL/);
});
