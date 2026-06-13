#!/usr/bin/env node
// Automated smoke test for a DEPLOYED Gemini connector.
// It speaks MCP (Streamable HTTP / JSON-RPC) straight to your Worker and exercises
// each tool against the real Gemini API — no Claude in the loop, so it's
// deterministic and scriptable (exit 0 = all passed, 1 = something failed).
//
// It makes REAL, billable Gemini calls (a few cents: a couple of flash text calls
// plus one image generate + one edit by default). Cheaper/fuller modes below.
//
// Usage:
//   GEMINI_MCP_URL="https://gemini-connector.<sub>.workers.dev/<SECRET>/mcp" node scripts/smoke.mjs
//   ... npm run smoke
//
// Flags:
//   --cheap   protocol + model list + one flash text call only (near-free; no images)
//   --full    everything above PLUS gemini_disagree (3 calls) and gemini_digest
//   --no-image    skip image generate/edit (avoids the priciest calls)
//
// Optional env overrides (else the server's recommended defaults are used):
//   SMOKE_TEXT_MODEL, SMOKE_IMAGE_MODEL, SMOKE_EDIT_MODEL

const URL_ = process.env.GEMINI_MCP_URL;
if (!URL_ || !/\/mcp$/.test(URL_)) {
  console.error("Set GEMINI_MCP_URL to your full connector URL ending in /mcp, e.g.\n  GEMINI_MCP_URL=\"https://gemini-connector.<sub>.workers.dev/<SECRET>/mcp\" node scripts/smoke.mjs");
  process.exit(2);
}
const args = new Set(process.argv.slice(2));
const CHEAP = args.has("--cheap");
const FULL = args.has("--full");
const NO_IMAGE = args.has("--no-image");

let id = 0;
async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (res.status === 202) return null; // notification ack
  const j = await res.json().catch(() => {
    throw new Error(`${method}: non-JSON response (HTTP ${res.status})`);
  });
  if (j.error) throw new Error(`${method}: JSON-RPC ${j.error.code} ${j.error.message}`);
  return j.result;
}

async function tool(name, toolArgs) {
  const r = await rpc("tools/call", { name, arguments: toolArgs });
  const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name} isError: ${text.slice(0, 400)}`);
  return { text, structured: r.structuredContent, content: r.content };
}

function findImageUrl(text) {
  const m = text.match(/https?:\/\/[^\s)\]]+\/img\/[A-Za-z0-9_-]+/);
  return m && m[0];
}

async function verifyImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const ct = (res.headers.get("content-type") || "").split(";")[0];
  if (!ct.startsWith("image/")) throw new Error(`served as ${ct}, not an image`);
  const n = (await res.arrayBuffer()).byteLength;
  if (n < 100) throw new Error(`suspiciously small image (${n} bytes)`);
  return `${ct}, ${n} bytes`;
}

let pass = 0;
let fail = 0;
async function step(label, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}  (${Date.now() - t0}ms)`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${label} — ${e.message}  (${Date.now() - t0}ms)`);
  }
}

const defaults = {};
const run = async () => {
  console.log(`Smoke testing ${URL_.replace(/\/[^/]+\/mcp$/, "/<secret>/mcp")}`);
  console.log(CHEAP ? "Mode: --cheap (near-free)" : FULL ? "Mode: --full" : "Mode: standard (a few cents of real calls)");

  await step("initialize", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    if (r.serverInfo?.name !== "gemini-connector") throw new Error("unexpected serverInfo");
    return `proto ${r.protocolVersion}`;
  });
  await rpc("notifications/initialized").catch(() => {});

  await step("tools/list = 8 tools", async () => {
    const r = await rpc("tools/list");
    if (r.tools.length !== 8) throw new Error(`got ${r.tools.length}`);
    return r.tools.map((t) => t.name).join(", ");
  });

  await step("list_gemini_models", async () => {
    const r = await tool("list_gemini_models", {});
    const parsed = JSON.parse(r.text);
    Object.assign(defaults, parsed.recommended_defaults || {});
    return `${parsed.count} models; reasoning=${defaults.reasoning}, fast=${defaults.fast}, img=${defaults.image_generate}`;
  });

  const textModel = process.env.SMOKE_TEXT_MODEL || defaults.fast;
  await step("ask_gemini (fast)", async () => {
    const r = await tool("ask_gemini", { prompt: "Reply with exactly one word: pong", model: textModel });
    if (!r.text.trim()) throw new Error("empty answer");
    return `“${r.text.split("\n")[0].slice(0, 40)}”`;
  });

  if (CHEAP) return;

  await step("gemini_audit (structured)", async () => {
    const r = await tool("gemini_audit", { content: "function add(a, b) { return a - b; }", focus: "logical errors", model: textModel });
    if (!r.structured || !r.structured.verdict) throw new Error("no structuredContent.verdict");
    return `verdict=${r.structured.verdict}, issues=${(r.structured.issues || []).length}`;
  });

  await step("gemini_grounded", async () => {
    const r = await tool("gemini_grounded", { query: "Name one fact about the Eiffel Tower's height. Be brief.", model: textModel });
    if (!r.text.trim()) throw new Error("empty answer");
    return r.text.includes("Sources") ? "answer + sources" : "answer (no sources attached)";
  });

  if (!NO_IMAGE) {
    let genUrl;
    await step("generate_image (generate)", async () => {
      const r = await tool("generate_image", {
        prompt: "a simple solid red circle centered on a white background, minimal",
        model: process.env.SMOKE_IMAGE_MODEL || defaults.image_generate_fast || defaults.image_generate,
      });
      genUrl = findImageUrl(r.text);
      if (!genUrl) throw new Error("no hosted /img/ URL in result");
      return await verifyImage(genUrl);
    });

    if (genUrl) {
      await step("generate_image (edit the result)", async () => {
        const r = await tool("generate_image", {
          prompt: "make the circle blue instead of red",
          input_image_urls: [genUrl],
          model: process.env.SMOKE_EDIT_MODEL || defaults.image_edit_fast || defaults.image_edit,
        });
        const editUrl = findImageUrl(r.text);
        if (!editUrl) throw new Error("no hosted /img/ URL in edit result");
        if (editUrl === genUrl) throw new Error("edit returned the same URL (not a new result)");
        return await verifyImage(editUrl);
      });
    }
  }

  if (FULL) {
    await step("gemini_digest", async () => {
      const r = await tool("gemini_digest", { content: "The quick brown fox jumps over the lazy dog. ".repeat(50), query: "What animal jumps?", model: textModel });
      if (!r.structured?.summary) throw new Error("no structuredContent.summary");
      return "structured digest ok";
    });
    await step("gemini_disagree (3 calls)", async () => {
      const r = await tool("gemini_disagree", { prompt: "Is tabs or spaces better for indentation?", fast_model: textModel, strong_model: defaults.reasoning });
      return r.structured ? `overall=${r.structured.overall}` : "ran (no structured analysis)";
    });
  }
};

run().then(() => {
  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  process.exit(1);
});
