import assert from "node:assert/strict";
import { test } from "node:test";
import { processMedia } from "../src/tools.ts";

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
