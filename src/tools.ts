import type { Env } from "./env.ts";
import {
  computeDefaults,
  GeminiClient,
  modelCanEditImages,
  modelIsImagen,
  type GeminiModel,
} from "./gemini.ts";
import { getMedia, mediaUrl, storeMedia } from "./images.ts";
import {
  assertPublicHttpUrl,
  base64ToBytes,
  bytesToBase64,
  CleanError,
  coerceNumber,
  coerceStringArray,
  imageDimensions,
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
  // MCP 2025-06-18 structured tool output, when a tool returns one.
  structuredContent?: Record<string, unknown>;
}

const textBlock = (text: string): Content => ({ type: "text", text });
const imageBlock = (data: string, mimeType: string): Content => ({
  type: "image",
  data,
  mimeType,
});

// ---------------------------------------------------------------------------
// Tool definitions. This connector is a pure capability extender: it only does
// things Claude cannot do itself — generate/edit images, and reach other
// generative modalities via the raw escape hatch. It is NOT used for second
// opinions, verification, fact-checking, or analysis.
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: "list_gemini_models",
    annotations: { title: "List Gemini models", readOnlyHint: true, openWorldHint: true },
    description:
      "List the Gemini models currently on the user's API key, with recommended defaults and per-model capabilities (tier, image generate/edit, video). ALWAYS call this once before the other tools — the live list is the source of truth, so new models on the key appear automatically. Pick per task and override the defaults with a smaller/cheaper model for smaller jobs.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional case-insensitive substring filter, e.g. 'image', 'imagen', 'veo'.",
        },
      },
    },
  },
  {
    name: "generate_image",
    annotations: { title: "Generate / edit image", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Generate an image, or iteratively EDIT a previous one. To refine a result ('add a red bandana', 'warmer lighting', 'bigger logo'), pass its hosted URL in input_image_urls with the change as the prompt; repeat to keep refining, and pass an earlier URL to branch. Imagen models give best single-shot quality; Nano Banana (Gemini image) models are required for editing. Editing re-renders the WHOLE image each pass, so quality compounds over many hops (the connector itself stores exact bytes and adds no loss) — prefer fewer combined edits and branch from the cleanest earlier result rather than chaining many tiny ones. If the user didn't name a model, pick a sensible cost-appropriate one yourself rather than making them choose. Every result is also hosted at a link you MUST show the user, because many clients won't render the inline image.",
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
          description: "Best-effort aspect ratio, e.g. '1:1', '16:9', '9:16', '4:3', '3:4', '21:9'.",
        },
        image_size: {
          type: "string",
          description: "Resolution for Nano Banana (Gemini image) models: '1K', '2K', or '4K'. Best-effort; ignored by Imagen.",
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
    name: "gemini_raw",
    annotations: { title: "Raw Gemini API", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      "ESCAPE HATCH for other generative modalities Claude can't produce itself — video/Veo, speech/TTS, music/Lyria, embeddings, robotics, computer-use, future models. A raw, validated passthrough to any model/method on the key: supply model, method (generateContent/predict/predictLongRunning/countTokens/embedContent…), and the exact request body per Google's docs. Long-running jobs are stateless-friendly: predictLongRunning returns immediately with an operation name; then call this tool with operation_name to poll — each call checks for up to ~18s and returns, so re-invoke with the same operation_name until done. Inline media is auto-hosted and linked; other output file URIs (e.g. Veo video) are surfaced as links on completion. Confirm with the user before expensive jobs like video. Not for text second opinions or fact-checking — Claude's own reasoning is authoritative.",
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

interface Media {
  mimeType: string;
  b64: string;
}

// Cap recursion into arbitrary API JSON (especially via gemini_raw) so a deep or
// cyclic shape can't blow the stack; real responses are only a few levels deep.
const MAX_WALK_DEPTH = 64;

/** Walk a Gemini response, collecting inline media and returning a redacted copy
 *  (base64 blobs replaced by short placeholders) so we never dump megabytes of
 *  base64 back to the model. Recurses into EVERY key — so media sitting beside
 *  other keys is still hosted and redacted — with a depth bound. Exported for tests. */
export function processMedia(node: any, out: Media[], depth = 0): any {
  if (depth > MAX_WALK_DEPTH) return node;
  if (Array.isArray(node)) return node.map((n) => processMedia(n, out, depth + 1));
  if (node && typeof node === "object") {
    const copy: any = {};
    for (const [k, v] of Object.entries(node)) {
      if ((k === "inlineData" || k === "inline_data") && v && typeof v === "object" && typeof (v as any).data === "string") {
        const inline = v as any;
        out.push({ mimeType: inline.mimeType ?? inline.mime_type ?? "image/png", b64: inline.data });
        copy[k] = { ...inline, data: `<${inline.data.length}B media, hosted separately>` };
      } else if (k === "bytesBase64Encoded" && typeof v === "string") {
        out.push({ mimeType: node.mimeType ?? "image/png", b64: v });
        copy[k] = `<${v.length}B media, hosted separately>`;
      } else {
        copy[k] = processMedia(v, out, depth + 1);
      }
    }
    return copy;
  }
  return node;
}

/** Collect output file/download URIs (e.g. Veo video, which returns a URI rather
 *  than inline bytes) so they can be surfaced as clickable links. Exported for tests. */
export function collectUris(node: any, out: Set<string>, depth = 0): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(node)) {
    for (const n of node) collectUris(n, out, depth + 1);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && /^https?:\/\//i.test(v) && /^(uri|fileUri|file_uri|downloadUri|videoUri)$/i.test(k)) {
        out.add(v);
      } else {
        collectUris(v, out, depth + 1);
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
    const dim = imageDimensions(bytes);
    const desc = dim ? `${m.mimeType}, ${dim.width}×${dim.height}` : m.mimeType;
    lines.push(`Image ${i} (${desc}): ${url}`);
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

const MAX_REDIRECTS = 4;
// Aggregate inline-byte budget — a 128MB isolate can't hold many large input
// images at once (raw bytes plus ~1.33x base64), so cap the SUM, not just each.
const MAX_EDIT_INLINE_BYTES = 28 * 1024 * 1024;

/** Charge bytes against a shared budget; throw a clean error once it's exhausted. */
function chargeBudget(budget: { left: number }, bytes: number, what: string): void {
  budget.left -= bytes;
  if (budget.left < 0) {
    throw new CleanError(
      `Combined ${what} exceed the inline memory limit (Worker free tier). Use fewer or smaller inputs.`,
    );
  }
}

/** Fetch a user-supplied URL, re-validating against SSRF at EVERY hop. fetch()
 *  follows redirects by default, which would let an allowed URL bounce to an
 *  internal target — so follow manually and re-check each Location. */
async function safeFetch(rawUrl: string): Promise<Response> {
  let target = assertPublicHttpUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      if (hop >= MAX_REDIRECTS) throw new CleanError(`Too many redirects fetching ${truncate(rawUrl, 80)}.`);
      target = assertPublicHttpUrl(new URL(loc, target).toString());
      continue;
    }
    return res;
  }
}

/** Load an image to edit: from our own KV (fast path) or any public http(s) URL. */
async function loadImageForEdit(
  ctx: ToolCtx,
  rawUrl: string,
  budget?: { left: number },
): Promise<{ mimeType: string; data: string }> {
  const url = rawUrl.trim();
  const prefix = `${ctx.origin}/img/`;
  if (url.startsWith(prefix)) {
    const id = url.slice(prefix.length).split(/[?#]/)[0];
    const item = await getMedia(ctx.env, id);
    if (item) {
      if (budget) chargeBudget(budget, item.bytes.byteLength, "input images");
      return { mimeType: item.mimeType, data: bytesToBase64(item.bytes) };
    }
    // fall through to a normal fetch if the id wasn't found locally
  }
  const res = await safeFetch(url);
  if (!res.ok) throw new CleanError(`Couldn't fetch the image to edit (HTTP ${res.status}): ${truncate(url, 120)}`);
  const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().slice(0, 128) || "image/png";
  if (!ct.startsWith("image/")) throw new CleanError(`That URL is ${ct}, not an image: ${truncate(url, 80)}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > 20 * 1024 * 1024) throw new CleanError("Input image exceeds the 20MB limit.");
  if (budget) chargeBudget(budget, buf.byteLength, "input images");
  return { mimeType: ct, data: bytesToBase64(buf) };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new CleanError(`'${field}' is required.`);
  return v;
}

/** A sanitized explicit model, or undefined if none was provided. */
function explicitModel(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? sanitizeModel(v) : undefined;
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
async function generateImageContent(ctx: ToolCtx, modelId: string, parts: any[], aspect?: string, imageSize?: string): Promise<any> {
  const base = { contents: [{ role: "user", parts }] };
  const imageConfig = (): Record<string, unknown> | undefined => {
    const ic: Record<string, unknown> = {};
    if (aspect) ic.aspectRatio = aspect;
    if (imageSize) ic.imageSize = imageSize;
    return Object.keys(ic).length ? ic : undefined;
  };
  const cfg = (mods: string[], useImageConfig: boolean) => {
    const ic = useImageConfig ? imageConfig() : undefined;
    return {
      ...base,
      generationConfig: { responseModalities: mods, ...(ic ? { imageConfig: ic } : {}) },
    };
  };

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

  // Only the capabilities this connector adds get a recommended default.
  const payload = {
    recommended_defaults: {
      image_generate: defaults.image_generate,
      image_generate_fast: defaults.image_generate_fast,
      image_edit: defaults.image_edit,
      image_edit_fast: defaults.image_edit_fast,
      video: defaults.video,
    },
    legend: "tiers: image=generate/edit, video=async (Veo). The defaults cover the capabilities this connector adds; the model list is the source of truth and you may override per task.",
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
  if (explicit && !meta) {
    return {
      content: [
        textBlock(
          `"${modelId}" isn't in your current model list, so I can't tell how to call it. Run list_gemini_models for valid ids, or use gemini_raw for a brand-new model.`,
        ),
      ],
      isError: true,
    };
  }
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
  const imageSize = typeof args.image_size === "string" && args.image_size.trim() ? args.image_size.trim() : undefined;

  let resp: any;
  if (isImagen && !editing) {
    const n = Math.min(Math.max(Math.round(coerceNumber(args.number_of_images) ?? 1), 1), 4);
    const parameters: Record<string, unknown> = { sampleCount: n };
    if (aspect) parameters.aspectRatio = aspect;
    resp = await ctx.gemini.predict(modelId, { instances: [{ prompt }], parameters });
  } else {
    // Nano Banana (Gemini image) via generateContent — supports editing, with a
    // transparent TEXT+IMAGE -> IMAGE-only fallback for model-shape differences.
    const editBudget = { left: MAX_EDIT_INLINE_BYTES };
    const parts: any[] = [];
    for (const url of inputs) {
      const img = await loadImageForEdit(ctx, url, editBudget);
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    parts.push({ text: prompt });
    resp = await generateImageContent(ctx, modelId, parts, aspect, imageSize);
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
