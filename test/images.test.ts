import assert from "node:assert/strict";
import { test } from "node:test";
import { getMedia, serveMedia, storeMedia } from "../src/images.ts";

// Minimal in-memory stand-in for a Cloudflare KV namespace (only the methods
// images.ts uses). Stores an exact copy of the bytes so we can assert integrity.
function mockKV() {
  const store = new Map<string, { value: Uint8Array; metadata: any }>();
  return {
    store,
    async put(key: string, value: any, opts: any) {
      const bytes =
        value instanceof Uint8Array
          ? value.slice()
          : value instanceof ArrayBuffer
            ? new Uint8Array(value.slice(0))
            : new TextEncoder().encode(String(value));
      store.set(key, { value: bytes, metadata: opts?.metadata });
    },
    async getWithMetadata(key: string, _opts: any) {
      const hit = store.get(key);
      if (!hit) return { value: null, metadata: null };
      // KV returns a fresh ArrayBuffer for type:"arrayBuffer".
      return { value: hit.value.slice().buffer, metadata: hit.metadata };
    },
  };
}

function fakeEnv(kv: any) {
  return { MEDIA: kv, IMAGE_TTL_SECONDS: "2592000" } as any;
}

test("storeMedia + getMedia round-trip exact bytes", async () => {
  const kv = mockKV();
  const env = fakeEnv(kv);
  // Tricky byte pattern incl. nulls and high bytes — would expose any pooled buffer.
  const bytes = new Uint8Array([0, 255, 1, 254, 137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const id = await storeMedia(env, bytes, "image/png");
  assert.match(id, /^[A-Za-z0-9_-]{16,64}$/);
  const got = await getMedia(env, id);
  assert.ok(got);
  assert.equal(got!.mimeType, "image/png");
  assert.deepEqual([...got!.bytes], [...bytes]);
});

test("serveMedia serves PNG inline with hardened headers and exact bytes", async () => {
  const kv = mockKV();
  const env = fakeEnv(kv);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
  const id = await storeMedia(env, png, "image/png");
  const res = await serveMedia(env, id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("content-disposition"), "inline");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...body], [...png]);
});

test("serveMedia forces hostile SVG to DOWNLOAD (never inline) — XSS guard", async () => {
  const kv = mockKV();
  const env = fakeEnv(kv);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const id = await storeMedia(env, svg, "image/svg+xml");
  const res = await serveMedia(env, id);
  assert.equal(res.status, 200);
  // Must NOT be served as an inline, script-capable type.
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("serveMedia rejects malformed ids and missing items with 404", async () => {
  const env = fakeEnv(mockKV());
  assert.equal((await serveMedia(env, "../etc/passwd")).status, 404);
  assert.equal((await serveMedia(env, "short")).status, 404);
  assert.equal((await serveMedia(env, "ValidLookingButMissingId123")).status, 404);
});
