import assert from "node:assert/strict";
import { test } from "node:test";
import { collectUris, processMedia } from "../src/tools.ts";

test("processMedia extracts Nano Banana inlineData and redacts the blob", () => {
  const resp = {
    candidates: [
      { content: { parts: [{ text: "here you go" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] } },
    ],
  };
  const out: any[] = [];
  const redacted = processMedia(resp, out);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { mimeType: "image/png", b64: "QUJD" });
  // text is preserved, the base64 is replaced by a short placeholder
  assert.equal(redacted.candidates[0].content.parts[0].text, "here you go");
  assert.match(redacted.candidates[0].content.parts[1].inlineData.data, /hosted separately/);
});

test("processMedia extracts Imagen predictions[].bytesBase64Encoded", () => {
  const resp = { predictions: [{ bytesBase64Encoded: "WFla", mimeType: "image/jpeg" }] };
  const out: any[] = [];
  const redacted = processMedia(resp, out);
  assert.deepEqual(out, [{ mimeType: "image/jpeg", b64: "WFla" }]);
  assert.match(redacted.predictions[0].bytesBase64Encoded, /hosted separately/);
});

test("processMedia handles snake_case inline_data and multiple/nested media", () => {
  const resp = {
    a: { inline_data: { mime_type: "image/webp", data: "AAAA" } },
    b: [{ inlineData: { mimeType: "image/gif", data: "BBBB" } }],
  };
  const out: any[] = [];
  processMedia(resp, out);
  assert.equal(out.length, 2);
  assert.ok(out.some((m) => m.mimeType === "image/webp" && m.b64 === "AAAA"));
  assert.ok(out.some((m) => m.mimeType === "image/gif" && m.b64 === "BBBB"));
});

test("processMedia leaves media-free payloads untouched", () => {
  const resp = { candidates: [{ content: { parts: [{ text: "just words" }] } }], usageMetadata: { totalTokenCount: 5 } };
  const out: any[] = [];
  const redacted = processMedia(resp, out);
  assert.equal(out.length, 0);
  assert.deepEqual(redacted, resp);
});

test("processMedia recurses into sibling keys — no media dropped or leaked", () => {
  // A node carries inlineData AND a sibling key that itself contains nested media.
  const resp = {
    part: {
      inlineData: { mimeType: "image/png", data: "AAAA" },
      sibling: { inlineData: { mimeType: "image/jpeg", data: "BBBB" } },
    },
  };
  const out: any[] = [];
  const redacted = processMedia(resp, out);
  assert.equal(out.length, 2); // both blobs collected, not just the first
  assert.ok(out.some((media) => media.b64 === "AAAA"));
  assert.ok(out.some((media) => media.b64 === "BBBB"));
  // both are redacted in the returned copy (no raw base64 leaks back to the model)
  assert.match(redacted.part.inlineData.data, /hosted separately/);
  assert.match(redacted.part.sibling.inlineData.data, /hosted separately/);
});

test("processMedia is depth-bounded and does not overflow on deep input", () => {
  let deep: any = { leaf: true };
  for (let i = 0; i < 5000; i++) deep = { nested: deep };
  const out: any[] = [];
  assert.doesNotThrow(() => processMedia(deep, out)); // returns instead of RangeError
});

test("collectUris finds Veo-style output file URIs", () => {
  const resp = {
    response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://example.com/v.mp4?key=x" } }] } },
    extra: { fileUri: "https://example.com/f.bin" },
  };
  const out = new Set<string>();
  collectUris(resp, out);
  assert.ok(out.has("https://example.com/v.mp4?key=x"));
  assert.ok(out.has("https://example.com/f.bin"));
});
