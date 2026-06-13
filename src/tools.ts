import type { Env } from "./env.ts";
import {
  computeDefaults,
  GeminiClient,
  modelCanEditImages,
  modelIsImagen,
  type GeminiModel,
} from "./gemini.ts";
import { getMedia, mediaUrl, storeMedia } from "./images.ts";
import { AUDIT_SYSTEM } from "./instructions.ts";
import {
  assertPublicHttpUrl,
  base64ToBytes,
  bytesToBase64,
  CleanError,
  coerceBool,
  coerceNumber,
  coerceStringArray,
  SAFE_INLINE_IMAGE_TYPES,
  sanitizeModel,
  truncate,
} from "./util.ts";

export interface ToolCtx {
  env: Env;
  gemini: GeminiClient;
  origin: string;
}

type Content = Record<string, unknown>;
export interface ToolResult {
  content: Content[];
  isError?: boolean;
  // MCP 2025-06-18 structured tool output. Returned alongside a text mirror so
  // older clients still work; lets Claude consume the result as a real object.
  structuredContent?: Record<string, unknown>;
}

const textBlock = (text: string): Content => ({ type: "text", text });
const imageBlock = (data: string, mimeType: string): Content => ({
  type: "image",
  data,
  mimeType,
});

// ---------------------------------------------------------------------------
// Output schemas. Each is used twice: as the Gemini `responseSchema` (to force
// structured generation) and as the MCP tool `outputSchema` (so the result's
// structuredContent is described to the client). `propertyOrdering` is a Gemini
// extension that plain JSON-Schema consumers harmlessly ignore.
// ---------------------------------------------------------------------------

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["sound", "minor_issues", "significant_issues", "incorrect"] },
    confidence: { type: "number", description: "0..1 confidence in this audit." },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "nit"] },
          location: { type: "string", description: "Where in the content, e.g. a line, function, or quote." },
          description: { type: "string" },
          suggested_correction: { type: "string" },
        },
        required: ["severity", "description"],
        propertyOrdering: ["severity", "location", "description", "suggested_correction"],
      },
    },
  },
  required: ["verdict", "confidence", "summary", "issues"],
  propertyOrdering: ["verdict", "confidence", "summary", "issues"],
};

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    key_points: { type: "array", items: { type: "string" } },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, gist: { type: "string" } },
        required: ["gist"],
        propertyOrdering: ["title", "gist"],
      },
    },
    entities: { type: "array", items: { type: "string" } },
    facts_and_figures: { type: "array", items: { type: "string" } },
    answer_to_task: { type: "string", description: "Only if a task/query was given." },
    caveats: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "key_points"],
  propertyOrdering: ["summary", "key_points", "sections", "entities", "facts_and_figures", "answer_to_task", "caveats"],
};

const DISAGREE_SCHEMA = {
  type: "object",
  properties: {
    overall: { type: "string", enum: ["agree", "mostly_agree", "partial", "conflict"] },
    agreements: { type: "string", description: "One line on what they agree about." },
    divergences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          fast_position: { type: "string" },
          strong_position: { type: "string" },
          why_it_matters: { type: "string" },
        },
        required: ["topic", "fast_position", "strong_position"],
        propertyOrdering: ["topic", "fast_position", "strong_position", "why_it_matters"],
      },
    },
  },
  required: ["overall", "divergences"],
  propertyOrdering: ["overall", "agreements", "divergences"],
};

// ---------------------------------------------------------------------------
// Tool definitions (name, description with trigger conditions, input schema).
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: "list_gemini_models",
    description:
      "List the Gemini models currently on the user's API key, with recommended defaults and per-model capabilities (tier, image generate/edit, grounding, video). ALWAYS call this once before other Gemini tools — the live list is the source of truth. Pick per task and override the defaults with a smaller/cheaper model for smaller jobs.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional case-insensitive substring filter, e.g. 'image', 'pro', 'flash', 'veo'.",
        },
      },
    },
  },
  {
    name: "generate_image",
    description:
      "Generate an image, or iteratively EDIT a previous one. To refine a result ('add a red bandana', 'warmer lighting', 'bigger logo'), pass its hosted URL in input_image_urls with the change as the prompt; repeat to keep refining, and pass an earlier URL to branch. Imagen models give best single-shot quality; Nano Banana (Gemini image) models are required for editing. Editing re-renders the WHOLE image each pass, so quality compounds over many hops (the connector itself stores exact bytes and adds no loss) — prefer fewer combined edits and branch from the cleanest earlier result rather than chaining many tiny ones. If the user did NOT name a model, offer them a quick choice first (best quality / best for editing / fast & cheap). Every result is also hosted at a link you MUST show the user, because many clients won't render the inline image.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to generate, OR the edit instruction when input_image_urls is provided.",
        },
        model: {
          type: "string",
          description:
            "Image model id from list_gemini_models. Omit to use the recommended default (best generator, or best editor when editing).",
        },
        input_image_urls: {
          type: "array",
          items: { type: "string" },
          description:
            "Hosted URL(s) of prior image(s) to edit/refine/combine (up to 4). Nano Banana models only — Imagen cannot edit. Accepts an array, a JSON-array string, or a single URL string.",
        },
        aspect_ratio: {
          type: "string",
          description: "Best-effort aspect ratio for generation, e.g. '1:1', '16:9', '9:16', '4:3', '3:4'.",
        },
        number_of_images: {
          type: "integer",
          description: "How many images to generate (Imagen supports >1). 1–4, default 1. Ignored when editing.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "gemini_audit",
    description:
      "Get an independent, structured cross-model audit of high-stakes content YOU already produced (code, analysis, a plan, factual claims). Returns issues with severity + location + a concrete suggested correction, plus an overall confidence — so you can surgically fix only what's actually wrong and keep your own voice. Worth running when the work is complex, risky, security-sensitive, or hard to reverse; skip it for routine answers. Prefer a pro/thinking model.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The content to audit." },
        focus: {
          type: "string",
          description: "Optional focus, e.g. 'security', 'logical errors', 'factual accuracy', 'edge cases'.",
        },
        model: { type: "string", description: "Model to use (omit for the recommended pro default)." },
      },
      required: ["content"],
    },
    outputSchema: AUDIT_SCHEMA,
  },
  {
    name: "ask_gemini",
    description:
      "Get a genuine second opinion or contrasting perspective from a Gemini model to compare against YOUR OWN answer — which you always write yourself, first and in full. This enriches your answer; it never replaces your reasoning, writing, or creativity. Supports multi-turn via history. Defaults to a fast model; name a pro model for hard questions.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to send to Gemini." },
        model: { type: "string", description: "Model id (omit for the fast default)." },
        system_instruction: { type: "string", description: "Optional system instruction." },
        temperature: { type: "number", description: "0–2, default 1." },
        top_p: { type: "number" },
        max_output_tokens: { type: "number", description: "Cap on response length." },
        thinking_budget: {
          type: "number",
          description: "Thinking-token budget for thinking-capable models (0 disables).",
        },
        json_output: { type: "boolean", description: "Force a valid-JSON response." },
        history: {
          type: "array",
          description: "Optional prior turns for a multi-turn conversation with Gemini.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant", "model"] },
              text: { type: "string" },
            },
            required: ["role", "text"],
          },
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "gemini_disagree",
    description:
      "Ask a fast and a strong Gemini model the same question and surface ONLY where they diverge (conflicting facts, different recommendations or assumptions). Agreement is cheap; divergence is the signal worth showing the user. Costs three calls — use it for genuinely contested or high-stakes questions, not routine ones.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question to put to both models." },
        fast_model: { type: "string", description: "Fast model (omit for default)." },
        strong_model: { type: "string", description: "Strong model (omit for default)." },
        system_instruction: { type: "string", description: "Optional shared system instruction." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "gemini_digest",
    description:
      "Offload a very large input — a big PDF, an entire codebase dump, a long transcript, or a YouTube URL — to Gemini's huge context window and get back a compact, STRUCTURED summary you then reason over yourself. Use when the input is too large or too costly to read in full. Pass a task/query to focus the digest.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Large text to digest (optional if file_urls given)." },
        file_urls: {
          type: "array",
          items: { type: "string" },
          description:
            "URLs to digest: PDFs/text/audio/video (fetched and inlined, <15MB each) or YouTube links. Accepts an array, JSON-array string, or single string.",
        },
        query: { type: "string", description: "Optional task/question to focus the digest." },
        model: { type: "string", description: "Model id (omit for a long-context default)." },
      },
    },
    outputSchema: DIGEST_SCHEMA,
  },
  {
    name: "gemini_grounded",
    description:
      "Run a query through Gemini with Google Search grounding as a second, independent search engine, returning an answer plus its web sources. Use to cross-check YOUR OWN search or factual claims: agreement raises confidence; flag any conflict to the user. Good for recent or verifiable facts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question to research with Google Search grounding." },
        model: { type: "string", description: "Grounding-capable model id (omit for default)." },
        system_instruction: { type: "string", description: "Optional system instruction." },
      },
      required: ["query"],
    },
  },
  {
    name: "gemini_raw",
    description:
      "ESCAPE HATCH: raw, validated passthrough to any model/method on the key for things the other tools don't cover (music/Lyria, video/Veo, robotics, computer-use, TTS, embeddings, future models). Supply model, method (generateContent/predict/predictLongRunning/countTokens/embedContent…), and the exact request body per Google's docs. For long-running jobs (video) pass operation_name to poll. Inline media is auto-hosted and linked; other output file URIs (e.g. Veo video) are surfaced as links on completion. Confirm with the user before expensive jobs like video.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Any model id from list_gemini_models." },
        method: {
          type: "string",
          description: "API method (default generateContent): generateContent, predict, predictLongRunning, countTokens, embedContent…",
        },
        body: { type: "object", description: "Exact JSON request body for that method." },
        operation_name: {
          type: "string",
          description:
            "Poll a long-running operation instead: pass the 'name' returned by predictLongRunning. Call repeatedly until done.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function extractText(resp: any): string {
  const parts = resp?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("");
}

function parseJsonMaybe(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Build a structured tool result: a text mirror (for older clients) plus
 *  structuredContent (for clients that consume MCP structured output). */
function structuredResult(resp: any, note: string): ToolResult {
  const text = extractText(resp).trim();
  const parsed = text ? parseJsonMaybe(text) : undefined;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return {
      content: [textBlock(JSON.stringify(parsed, null, 2)), textBlock(note)],
      structuredContent: parsed,
    };
  }
  // responseSchema makes this near-impossible; surface it honestly if it happens.
  return {
    content: [
      textBlock(text ? `Gemini did not return parseable structured output:\n\n${truncate(text, 3000)}` : "(empty response)"),
    ],
    isError: true,
  };
}

interface Media {
  mimeType: string;
  b64: string;
}

/** Walk a Gemini response, collecting inline media and returning a redacted copy
 *  (base64 blobs replaced by short placeholders) so we never dump megabytes of
 *  base64 back to the model. Exported for tests. */
export function processMedia(node: any, out: Media[]): any {
  if (Array.isArray(node)) return node.map((n) => processMedia(n, out));
  if (node && typeof node === "object") {
    const inline = node.inlineData ?? node.inline_data;
    if (inline && typeof inline.data === "string") {
      out.push({ mimeType: inline.mimeType ?? inline.mime_type ?? "image/png", b64: inline.data });
      return { ...node, inlineData: { ...inline, data: `<${inline.data.length}B media, hosted separately>` } };
    }
    if (typeof node.bytesBase64Encoded === "string") {
      out.push({ mimeType: node.mimeType ?? "image/png", b64: node.bytesBase64Encoded });
      return { ...node, bytesBase64Encoded: `<${node.bytesBase64Encoded.length}B media, hosted separately>` };
    }
    const copy: any = {};
    for (const [k, v] of Object.entries(node)) copy[k] = processMedia(v, out);
    return copy;
  }
  return node;
}

/** Collect output file/download URIs (e.g. Veo video, which returns a URI rather
 *  than inline bytes) so they can be surfaced as clickable links. Exported for tests. */
export function collectUris(node: any, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectUris(n, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && /^https?:\/\//i.test(v) && /^(uri|fileUri|file_uri|downloadUri|videoUri)$/i.test(k)) {
        out.add(v);
      } else {
        collectUris(v, out);
      }
    }
  }
}

/** Host collected media in KV and build content blocks (inline image when the
 *  type is a safe raster) plus a text block with the links the user must see. */
async function hostAndDescribe(ctx: ToolCtx, header: string, medias: Media[]): Promise<Content[]> {
  const blocks: Content[] = [];
  const lines: string[] = [header, ""];
  let i = 0;
  for (const m of medias) {
    i++;
    const bytes = base64ToBytes(m.b64);
    const id = await storeMedia(ctx.env, bytes, m.mimeType);
    const url = mediaUrl(ctx.origin, id);
    lines.push(`Image ${i} (${m.mimeType}): ${url}`);
    lines.push(`  Markdown: ![image ${i}](${url})`);
    lines.push(`  Refine it: generate_image(input_image_urls=["${url}"], prompt="<your change>")`);
    lines.push("");
    if (SAFE_INLINE_IMAGE_TYPES[m.mimeType.toLowerCase()]) blocks.push(imageBlock(m.b64, m.mimeType));
  }
  lines.push(
    "IMPORTANT: show the user the clickable link(s) above as plain URLs — many clients (claude.ai web/mobile) will not render the inline image.",
  );
  return [...blocks, textBlock(lines.join("\n"))];
}

/** Load an image to edit: from our own KV (fast path) or any public http(s) URL. */
async function loadImageForEdit(ctx: ToolCtx, rawUrl: string): Promise<{ mimeType: string; data: string }> {
  const url = rawUrl.trim();
  const prefix = `${ctx.origin}/img/`;
  if (url.startsWith(prefix)) {
    const id = url.slice(prefix.length).split(/[?#]/)[0];
    const item = await getMedia(ctx.env, id);
    if (item) return { mimeType: item.mimeType, data: bytesToBase64(item.bytes) };
    // fall through to a normal fetch if the id wasn't found locally
  }
  const u = assertPublicHttpUrl(url);
  const res = await fetch(u);
  if (!res.ok) throw new CleanError(`Couldn't fetch the image to edit (HTTP ${res.status}): ${truncate(url, 120)}`);
  const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim() || "image/png";
  if (!ct.startsWith("image/")) throw new CleanError(`That URL is ${ct}, not an image: ${truncate(url, 80)}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > 20 * 1024 * 1024) throw new CleanError("Input image exceeds the 20MB limit.");
  return { mimeType: ct, data: bytesToBase64(buf) };
}

const isYouTube = (u: string) => /(?:youtube\.com|youtu\.be)/i.test(u);

/** Build a Gemini content part for a digest input URL. */
async function loadFilePart(url: string): Promise<any> {
  const u = url.trim();
  if (isYouTube(u)) return { fileData: { fileUri: u } };
  const parsed = assertPublicHttpUrl(u);
  const res = await fetch(parsed);
  if (!res.ok) throw new CleanError(`Couldn't fetch ${truncate(u, 120)} (HTTP ${res.status}).`);
  const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim() || "application/octet-stream";
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > 15 * 1024 * 1024) {
    throw new CleanError(
      `${truncate(u, 80)} is ${(buf.byteLength / 1048576).toFixed(1)}MB — over the 15MB inline limit. Split it or paste extracted text into 'content'.`,
    );
  }
  return { inlineData: { mimeType: ct, data: bytesToBase64(buf) } };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new CleanError(`'${field}' is required.`);
  return v;
}

/** A sanitized explicit model, or undefined if none was provided. */
function explicitModel(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? sanitizeModel(v) : undefined;
}

/** Compute recommended defaults (lists models — only call when a default is needed). */
async function defaultsFor(ctx: ToolCtx) {
  return computeDefaults(await ctx.gemini.listModels());
}

// Image models disagree on responseModalities/imageConfig; detect that class of error.
function isImageConfigError(e: unknown): boolean {
  const msg = e instanceof CleanError ? e.userMessage : e instanceof Error ? e.message : String(e);
  return /modalit|response_?modalities|image_?config|aspect|generation_?config/i.test(msg);
}

/**
 * Generate/edit via generateContent (Nano Banana). Tries TEXT+IMAGE (broadest
 * compatibility), then transparently falls back to IMAGE-only if the model
 * rejects the modality/config combination or returns no image under TEXT+IMAGE.
 */
async function generateImageContent(ctx: ToolCtx, modelId: string, parts: any[], aspect?: string): Promise<any> {
  const base = { contents: [{ role: "user", parts }] };
  const cfg = (mods: string[], useAspect: boolean) => ({
    ...base,
    generationConfig: {
      responseModalities: mods,
      ...(useAspect && aspect ? { imageConfig: { aspectRatio: aspect } } : {}),
    },
  });

  let resp: any;
  try {
    resp = await ctx.gemini.generateContent(modelId, cfg(["TEXT", "IMAGE"], true));
  } catch (e) {
    if (!isImageConfigError(e)) throw e;
    return ctx.gemini.generateContent(modelId, cfg(["IMAGE"], false));
  }

  // Primary call succeeded but produced no image — some models only emit images
  // under an IMAGE-only modality. Try once more before giving up.
  const probe: Media[] = [];
  processMedia(resp, probe);
  if (probe.length === 0) {
    try {
      const alt = await ctx.gemini.generateContent(modelId, cfg(["IMAGE"], false));
      const probe2: Media[] = [];
      processMedia(alt, probe2);
      if (probe2.length > 0) return alt;
    } catch {
      // keep the original response so the caller can report what the model said
    }
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  switch (name) {
    case "list_gemini_models":
      return listGeminiModels(args, ctx);
    case "generate_image":
      return generateImage(args, ctx);
    case "gemini_audit":
      return geminiAudit(args, ctx);
    case "ask_gemini":
      return askGemini(args, ctx);
    case "gemini_disagree":
      return geminiDisagree(args, ctx);
    case "gemini_digest":
      return geminiDigest(args, ctx);
    case "gemini_grounded":
      return geminiGrounded(args, ctx);
    case "gemini_raw":
      return geminiRaw(args, ctx);
    default:
      return { content: [textBlock(`Unknown tool: ${name}`)], isError: true };
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function listGeminiModels(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const models = await ctx.gemini.listModels(true);
  const defaults = computeDefaults(models);
  const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : "";

  const tierOf = (m: GeminiModel): string => {
    const n = m.name.replace(/^models\//, "").toLowerCase();
    const methods = m.supportedGenerationMethods ?? [];
    if (n.includes("imagen") || n.includes("image")) return "image";
    if (n.includes("veo") || methods.includes("predictLongRunning")) return "video";
    if (n.includes("tts")) return "tts";
    if (n.includes("embedding")) return "embedding";
    if (n.includes("pro")) return "pro";
    if (n.includes("flash")) return "fast";
    return "other";
  };

  const list = models
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      const methods = m.supportedGenerationMethods ?? [];
      return {
        id,
        tier: tierOf(m),
        displayName: m.displayName,
        methods,
        input_token_limit: m.inputTokenLimit,
        output_token_limit: m.outputTokenLimit,
        can_generate_images: modelIsImagen(m) || (methods.includes("generateContent") && id.toLowerCase().includes("image")),
        can_edit_images: modelCanEditImages(m),
        can_video: methods.includes("predictLongRunning") || id.toLowerCase().includes("veo"),
        description: m.description ? truncate(m.description, 160) : undefined,
      };
    })
    .filter((m) =>
      !filter
        ? true
        : m.id.toLowerCase().includes(filter) ||
          (m.displayName ?? "").toLowerCase().includes(filter) ||
          (m.description ?? "").toLowerCase().includes(filter),
    );

  const payload = {
    recommended_defaults: defaults,
    legend: "tiers: pro=high-reasoning, fast=quick/cheap, image=gen/edit, video=async (Veo), tts/embedding/other. The defaults are recommendations; the model list is the source of truth and you may override per task.",
    count: list.length,
    models: list,
  };
  return { content: [textBlock(JSON.stringify(payload, null, 2))] };
}

async function generateImage(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const prompt = requireString(args.prompt, "prompt");
  const inputs = coerceStringArray(args.input_image_urls).slice(0, 4);
  const editing = inputs.length > 0;

  // generate_image always needs the live list to determine a model's API shape.
  const models = await ctx.gemini.listModels();
  const defaults = computeDefaults(models);

  let modelId: string;
  const explicit = explicitModel(args.model);
  if (explicit) {
    modelId = explicit;
  } else {
    const fallback = editing ? defaults.image_edit : defaults.image_generate;
    if (!fallback) {
      return {
        content: [
          textBlock(
            `No ${editing ? "image-editing" : "image-generating"} model is available on your API key, and none was specified. Run list_gemini_models to see what's available.`,
          ),
        ],
        isError: true,
      };
    }
    modelId = fallback;
  }

  const meta = models.find((m) => m.name.replace(/^models\//, "") === modelId);
  const nameLower = modelId.toLowerCase();
  const isImagen = meta ? modelIsImagen(meta) : nameLower.includes("imagen");
  const canEdit = meta ? modelCanEditImages(meta) : nameLower.includes("image") && !nameLower.includes("imagen");

  if (editing && !canEdit) {
    const suggestion = defaults.image_edit ? ` Try a Nano Banana model like "${defaults.image_edit}".` : "";
    return {
      content: [
        textBlock(
          `"${modelId}" can't edit images${isImagen ? " (Imagen only generates)" : ""}. Editing needs a Nano Banana (Gemini image) model.${suggestion}`,
        ),
      ],
      isError: true,
    };
  }

  const aspect = typeof args.aspect_ratio === "string" && args.aspect_ratio.trim() ? args.aspect_ratio.trim() : undefined;

  let resp: any;
  if (isImagen && !editing) {
    const n = Math.min(Math.max(coerceNumber(args.number_of_images) ?? 1, 1), 4);
    const parameters: Record<string, unknown> = { sampleCount: n };
    if (aspect) parameters.aspectRatio = aspect;
    resp = await ctx.gemini.predict(modelId, { instances: [{ prompt }], parameters });
  } else {
    // Nano Banana (Gemini image) via generateContent — supports editing, with a
    // transparent TEXT+IMAGE -> IMAGE-only fallback for model-shape differences.
    const parts: any[] = [];
    for (const url of inputs) {
      const img = await loadImageForEdit(ctx, url);
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    parts.push({ text: prompt });
    resp = await generateImageContent(ctx, modelId, parts, aspect);
  }

  const medias: Media[] = [];
  processMedia(resp, medias);
  if (medias.length === 0) {
    const text = extractText(resp).trim();
    return {
      content: [
        textBlock(
          `"${modelId}" returned no image${text ? `. It said: ${truncate(text, 400)}` : " (it may have declined; try rephrasing the prompt)."}`,
        ),
      ],
      isError: true,
    };
  }

  const header = editing
    ? `Edited image with ${modelId}. Pass the new link below back into input_image_urls to keep refining.`
    : `Generated ${medias.length} image${medias.length > 1 ? "s" : ""} with ${modelId}.`;
  return { content: await hostAndDescribe(ctx, header, medias) };
}

async function geminiAudit(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const content = requireString(args.content, "content");
  const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim() : "";
  const model = explicitModel(args.model) ?? (await defaultsFor(ctx)).reasoning;
  if (!model) return { content: [textBlock("No reasoning model is available on your key. Run list_gemini_models.")], isError: true };

  const resp = await ctx.gemini.generateContent(model, {
    systemInstruction: { parts: [{ text: AUDIT_SYSTEM + (focus ? ` Focus especially on: ${focus}.` : "") }] },
    contents: [{ role: "user", parts: [{ text: `Audit the following content.\n\n=== CONTENT START ===\n${content}\n=== CONTENT END ===` }] }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: AUDIT_SCHEMA },
  });

  return structuredResult(
    resp,
    `— Independent audit by ${model}. Address the real findings surgically and keep your own voice; an empty issues list means it found nothing.`,
  );
}

async function askGemini(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const prompt = requireString(args.prompt, "prompt");
  const model = explicitModel(args.model) ?? (await defaultsFor(ctx)).fast;
  if (!model) return { content: [textBlock("No text model is available on your key. Run list_gemini_models.")], isError: true };

  const contents: any[] = [];
  if (Array.isArray(args.history)) {
    for (const turn of args.history as any[]) {
      if (turn && typeof turn.text === "string") {
        // Accept both "assistant" (our schema) and Gemini's native "model" role.
        const role = turn.role === "assistant" || turn.role === "model" ? "model" : "user";
        contents.push({ role, parts: [{ text: turn.text }] });
      }
    }
  }
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const generationConfig: Record<string, unknown> = {};
  const temperature = coerceNumber(args.temperature);
  const topP = coerceNumber(args.top_p);
  const maxOut = coerceNumber(args.max_output_tokens);
  const thinking = coerceNumber(args.thinking_budget);
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (topP !== undefined) generationConfig.topP = topP;
  if (maxOut !== undefined) generationConfig.maxOutputTokens = maxOut;
  if (thinking !== undefined) generationConfig.thinkingConfig = { thinkingBudget: thinking };
  if (coerceBool(args.json_output)) generationConfig.responseMimeType = "application/json";

  const body: Record<string, unknown> = { contents };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (typeof args.system_instruction === "string" && args.system_instruction.trim()) {
    body.systemInstruction = { parts: [{ text: args.system_instruction }] };
  }

  const resp = await ctx.gemini.generateContent(model, body);
  const text = extractText(resp).trim() || "(Gemini returned no text.)";
  const blocks: Content[] = [textBlock(text)];
  if (!coerceBool(args.json_output)) {
    blocks.push(textBlock(`— Second opinion from ${model}. Compare it against your own answer; keep your own reasoning and voice.`));
  }
  return { content: blocks };
}

async function geminiDisagree(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const prompt = requireString(args.prompt, "prompt");
  let fast = explicitModel(args.fast_model);
  let strong = explicitModel(args.strong_model);
  if (!fast || !strong) {
    const d = await defaultsFor(ctx);
    fast ??= d.fast;
    strong ??= d.reasoning;
  }
  if (!fast || !strong) return { content: [textBlock("Need both a fast and a strong model on your key. Run list_gemini_models.")], isError: true };

  const sys = typeof args.system_instruction === "string" && args.system_instruction.trim() ? args.system_instruction : undefined;
  const ask = (model: string) =>
    ctx.gemini.generateContent(model, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
    });

  const [fastResp, strongResp] = await Promise.all([ask(fast), ask(strong)]);
  const fastAns = extractText(fastResp).trim() || "(no answer)";
  const strongAns = extractText(strongResp).trim() || "(no answer)";

  const analysis = await ctx.gemini.generateContent(strong, {
    systemInstruction: {
      parts: [
        {
          text: "You compare two AI answers to the same question and report ONLY substantive divergences: conflicting facts, different recommendations, different key assumptions, or contradictions. Ignore wording and trivial overlap. If they essentially agree, say so and give an empty or short divergences list.",
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `QUESTION:\n${prompt}\n\nANSWER A (fast model ${fast}):\n${fastAns}\n\nANSWER B (strong model ${strong}):\n${strongAns}`,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: DISAGREE_SCHEMA },
  });

  const analysisText = extractText(analysis).trim();
  const div = parseJsonMaybe(analysisText);

  const blocks: Content[] = [
    textBlock(`DIVERGENCE ANALYSIS (the signal):\n${div ? JSON.stringify(div, null, 2) : analysisText || "(none)"}`),
    textBlock(`Raw answer A — ${fast}:\n${truncate(fastAns, 4000)}`),
    textBlock(`Raw answer B — ${strong}:\n${truncate(strongAns, 4000)}`),
  ];
  if (fast === strong) {
    blocks.push(
      textBlock(
        `Note: only one suitable model ("${fast}") was available, so both sides used it — this reflects self-consistency, not cross-model divergence. Pass distinct fast_model/strong_model for a real contrast.`,
      ),
    );
  }
  blocks.push(textBlock("— Where they diverge is where to dig in and flag to the user. Where they agree, that's cheap confirmation. You still form your own conclusion."));

  const result: ToolResult = { content: blocks };
  if (div && typeof div === "object" && !Array.isArray(div)) {
    result.structuredContent = { ...div, fast_model: fast, strong_model: strong, answer_fast: fastAns, answer_strong: strongAns };
  }
  return result;
}

async function geminiDigest(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const content = typeof args.content === "string" ? args.content : "";
  const fileUrls = coerceStringArray(args.file_urls);
  if (!content.trim() && fileUrls.length === 0) {
    return { content: [textBlock("Provide 'content' (large text) and/or 'file_urls' (PDF/text/media/YouTube) to digest.")], isError: true };
  }
  const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : "";
  const model = explicitModel(args.model) ?? (await defaultsFor(ctx)).digest;
  if (!model) return { content: [textBlock("No long-context model is available on your key. Run list_gemini_models.")], isError: true };

  const parts: any[] = [];
  parts.push({ text: query ? `Task to keep in focus while digesting: ${query}` : "Digest the following input(s)." });
  if (content.trim()) parts.push({ text: content });
  for (const url of fileUrls) parts.push(await loadFilePart(url));

  const resp = await ctx.gemini.generateContent(model, {
    systemInstruction: {
      parts: [
        {
          text: "You digest large inputs into a compact, faithful, structured summary that another assistant will reason over. Do not editorialize or add information not present. Preserve key facts, figures, names, structure, and anything that answers the task. Note uncertainties in caveats.",
        },
      ],
    },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: "application/json", responseSchema: DIGEST_SCHEMA },
  });

  return structuredResult(
    resp,
    `— Structured digest by ${model} over ${fileUrls.length + (content.trim() ? 1 : 0)} input(s). Reason over this yourself; it's a compression of the source, not the final answer.`,
  );
}

async function geminiGrounded(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const query = requireString(args.query, "query");
  const model = explicitModel(args.model) ?? (await defaultsFor(ctx)).grounding;
  if (!model) return { content: [textBlock("No grounding-capable model is available on your key. Run list_gemini_models.")], isError: true };

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: query }] }],
    tools: [{ googleSearch: {} }],
  };
  if (typeof args.system_instruction === "string" && args.system_instruction.trim()) {
    body.systemInstruction = { parts: [{ text: args.system_instruction }] };
  }

  const resp = await ctx.gemini.generateContent(model, body);
  const answer = extractText(resp).trim() || "(no answer)";
  const gm = resp?.candidates?.[0]?.groundingMetadata ?? {};
  const chunks: any[] = gm.groundingChunks ?? [];
  const queries: string[] = gm.webSearchQueries ?? [];

  const sourceLines = chunks
    .map((c, i) => {
      const w = c?.web ?? {};
      return w.uri ? `[${i + 1}] ${w.title ?? "(untitled)"} — ${w.uri}` : null;
    })
    .filter(Boolean) as string[];

  const out: string[] = [answer, ""];
  if (queries.length) out.push(`Google searched: ${queries.join(" | ")}`);
  out.push(sourceLines.length ? `Sources:\n${sourceLines.join("\n")}` : "(No web sources were attached to this response.)");
  out.push("");
  out.push("— Independent Google Search result. Where it agrees with your own search, confidence is higher; where it conflicts, flag the conflict to the user and say which you trust and why.");

  return { content: [textBlock(out.join("\n"))] };
}

async function geminiRaw(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  // Polling branch.
  if (typeof args.operation_name === "string" && args.operation_name.trim()) {
    const name = args.operation_name;
    const deadline = Date.now() + 18000; // bounded; Claude re-calls if still running
    let resp = await ctx.gemini.getOperation(name);
    while (!resp?.done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      resp = await ctx.gemini.getOperation(name);
    }
    if (!resp?.done) {
      return {
        content: [textBlock(`Operation still running. Call gemini_raw again with operation_name="${name}" to keep polling.\n\n${truncate(JSON.stringify(resp), 1500)}`)],
      };
    }
    const medias: Media[] = [];
    const redacted = processMedia(resp, medias);
    const blocks: Content[] = [];
    if (medias.length) blocks.push(...(await hostAndDescribe(ctx, "Operation complete. Media output:", medias)));
    const uris = new Set<string>();
    collectUris(redacted, uris);
    if (uris.size) {
      blocks.push(
        textBlock(
          `Output file URL(s) (e.g. Veo video — may require your API key to download):\n${[...uris].join("\n")}`,
        ),
      );
    }
    blocks.push(textBlock(`Operation complete.\n\n${truncate(JSON.stringify(redacted, null, 2), 6000)}`));
    return { content: blocks };
  }

  // Direct call branch.
  const model = sanitizeModel(args.model);
  const method = typeof args.method === "string" && args.method.trim() ? args.method.trim() : "generateContent";
  const body = (args.body && typeof args.body === "object") ? args.body : {};

  let resp: any;
  if (method === "generateContent") resp = await ctx.gemini.generateContent(model, body);
  else if (method === "predict") resp = await ctx.gemini.predict(model, body);
  else if (method === "predictLongRunning") resp = await ctx.gemini.predictLongRunning(model, body);
  else resp = await ctx.gemini.callMethod(method, model, body);

  // A predictLongRunning kickoff returns an operation name to poll.
  if (method === "predictLongRunning" && resp?.name) {
    return {
      content: [
        textBlock(
          `Long-running job started. Poll it with gemini_raw operation_name="${resp.name}" (repeat until done). Confirm with the user before waiting on expensive jobs like video.`,
        ),
      ],
    };
  }

  const medias: Media[] = [];
  const redacted = processMedia(resp, medias);
  const blocks: Content[] = [];
  if (medias.length) blocks.push(...(await hostAndDescribe(ctx, `Media output from ${method} on ${model}:`, medias)));
  // No media: this may be a large non-media payload (e.g. embeddings); keep more of it.
  blocks.push(textBlock(truncate(JSON.stringify(redacted, null, 2), medias.length ? 8000 : 60000)));
  return { content: blocks };
}
