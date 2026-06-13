import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPublicHttpUrl,
  base64ToBytes,
  bytesToBase64,
  coerceBool,
  coerceNumber,
  coerceStringArray,
  imageDimensions,
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

test("imageDimensions reads PNG, GIF, JPEG, and WebP headers", () => {
  // PNG 10x20: 8-byte sig, IHDR length+tag, then width/height as big-endian uint32.
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 10, 0, 0, 0, 20,
  ]);
  assert.deepEqual(imageDimensions(png), { width: 10, height: 20 });

  // GIF89a 3x4: little-endian uint16 width/height at offset 6.
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 4, 0]);
  assert.deepEqual(imageDimensions(gif), { width: 3, height: 4 });

  // JPEG 8x6 with an APP0 segment before SOF0 (exercises segment skipping).
  const jpeg = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // APP0, len 16
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, // SOF0: h=6, w=8
  ]);
  assert.deepEqual(imageDimensions(jpeg), { width: 8, height: 6 });

  // WebP VP8X 100x50: 24-bit (canvas-1) width/height, little-endian.
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, // RIFF....WEBP
    0x56, 0x50, 0x38, 0x58, 0x0a, 0, 0, 0, 0x00, 0x00, 0x00, 0x00, // VP8X + chunk hdr
    0x63, 0x00, 0x00, 0x31, 0x00, 0x00, // width-1=99 -> 100, height-1=49 -> 50
  ]);
  assert.deepEqual(imageDimensions(webp), { width: 100, height: 50 });

  // Unrecognised or truncated input is a clean null, never a throw.
  assert.equal(imageDimensions(new Uint8Array([1, 2, 3, 4, 5])), null);
  assert.equal(imageDimensions(png.subarray(0, 12)), null); // PNG sig but too short
  assert.equal(imageDimensions(new Uint8Array(0)), null);
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
