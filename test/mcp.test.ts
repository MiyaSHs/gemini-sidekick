import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcpPost } from "../src/mcp.ts";

// Stub context. The protocol-level methods never touch Gemini; the one tool test
// uses a client whose listModels throws, to prove errors come back clean.
const ctx: any = {
  env: {},
  origin: "https://example.workers.dev",
  gemini: {
    listModels: async () => {
      throw new Error("no key in test");
    },
  },
};

function postWith(body: unknown, c: any) {
  const req = new Request("https://example.workers.dev/secret/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleMcpPost(req, c);
}

function post(body: unknown) {
  return postWith(body, ctx);
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

test("initialize returns serverInfo, capabilities, and the philosophy instructions", async () => {
  const res = await post(rpc("initialize", { protocolVersion: "2025-06-18" }));
  assert.equal(res.status, 200);
  const j: any = await res.json();
  assert.equal(j.result.serverInfo.name, "gemini-mcp");
  assert.ok(j.result.capabilities.tools);
  assert.match(j.result.instructions, /capability extender/);
  assert.match(j.result.instructions, /generate and edit images/);
});

test("initialize negotiates protocol version (echo known, else latest)", async () => {
  const older: any = await (await post(rpc("initialize", { protocolVersion: "2024-11-05" }))).json();
  assert.equal(older.result.protocolVersion, "2024-11-05");
  const unknown: any = await (await post(rpc("initialize", { protocolVersion: "1999-01-01" }))).json();
  assert.equal(unknown.result.protocolVersion, "2025-11-25"); // newest supported
  const current: any = await (await post(rpc("initialize", { protocolVersion: "2025-11-25" }))).json();
  assert.equal(current.result.protocolVersion, "2025-11-25");
});

test("tools/list returns the three capability tools with schemas + annotations", async () => {
  const j: any = await (await post(rpc("tools/list"))).json();
  const names = j.result.tools.map((t: any) => t.name);
  assert.equal(names.length, 3);
  for (const n of ["list_gemini_models", "generate_image", "gemini_raw"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  // the removed verification/second-opinion tools must be gone
  for (const n of ["gemini_audit", "ask_gemini", "gemini_disagree", "gemini_digest", "gemini_grounded"]) {
    assert.ok(!names.includes(n), `${n} should have been removed`);
  }
  for (const t of j.result.tools) assert.ok(t.inputSchema, `${t.name} missing inputSchema`);
  for (const t of j.result.tools) assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} missing annotations`);
  assert.equal(j.result.tools.find((t: any) => t.name === "list_gemini_models").annotations.readOnlyHint, true);
  assert.equal(j.result.tools.find((t: any) => t.name === "generate_image").annotations.readOnlyHint, false);
});

test("ping returns an empty result", async () => {
  const j: any = await (await post(rpc("ping"))).json();
  assert.deepEqual(j.result, {});
});

test("notifications get a 202 with no body", async () => {
  const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
});

test("unknown method returns JSON-RPC -32601", async () => {
  const j: any = await (await post(rpc("bogus/method"))).json();
  assert.equal(j.error.code, -32601);
});

test("unknown tool returns an isError tool result, not a crash", async () => {
  const j: any = await (await post(rpc("tools/call", { name: "nope", arguments: {} }))).json();
  assert.equal(j.result.isError, true);
  assert.match(j.result.content[0].text, /Unknown tool/);
});

test("a tool failure surfaces a clean message, never a stack trace", async () => {
  const j: any = await (await post(rpc("tools/call", { name: "generate_image", arguments: { prompt: "x" } }))).json();
  assert.equal(j.result.isError, true);
  const text = j.result.content[0].text;
  assert.match(text, /no key in test/); // the underlying message is surfaced
  assert.doesNotMatch(text, /\n\s+at /); // but no stack frames
});

test("malformed JSON body returns a parse error", async () => {
  const req = new Request("https://example.workers.dev/secret/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  const j: any = await (await handleMcpPost(req, ctx)).json();
  assert.equal(j.error.code, -32700);
});
