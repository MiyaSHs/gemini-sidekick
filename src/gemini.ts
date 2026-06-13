import type { Env } from "./env.ts";
import {
  CapError,
  CleanError,
  sanitizeMethod,
  sanitizeModel,
  sanitizeOperationName,
  truncate,
} from "./util.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiModel {
  name: string; // e.g. "models/gemini-3.1-pro-preview"
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
}

// Module-level cache shared across requests in the same isolate. Purely an
// optimisation; list_gemini_models can force a refresh so new models on the key
// are never more than a few minutes from being visible.
let MODEL_CACHE: { at: number; models: GeminiModel[] } | null = null;
const MODEL_TTL_MS = 5 * 60 * 1000;

export class GeminiClient {
  private env: Env;
  constructor(env: Env) {
    this.env = env;
  }

  private headers(): HeadersInit {
    return {
      "x-goog-api-key": this.env.GEMINI_API_KEY,
      "content-type": "application/json",
    };
  }

  /** List models available on the key (paginated, cached). */
  async listModels(force = false): Promise<GeminiModel[]> {
    if (!force && MODEL_CACHE && Date.now() - MODEL_CACHE.at < MODEL_TTL_MS) {
      return MODEL_CACHE.models;
    }
    const models: GeminiModel[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${BASE}/models`);
      url.searchParams.set("pageSize", "200");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, { headers: this.headers() });
      const json = await this.parse(res, "list models");
      for (const m of json.models ?? []) models.push(m as GeminiModel);
      pageToken = json.nextPageToken;
      if (!pageToken) break;
    }
    MODEL_CACHE = { at: Date.now(), models };
    return models;
  }

  /** generateContent (text, multimodal, Nano Banana image models, grounding, TTS…). */
  async generateContent(model: string, body: unknown): Promise<any> {
    await this.countBillableCall();
    return this.callMethod("generateContent", model, body);
  }

  /** predict (Imagen image generation, some other model families). */
  async predict(model: string, body: unknown): Promise<any> {
    await this.countBillableCall();
    return this.callMethod("predict", model, body);
  }

  /** predictLongRunning (Veo video and other async jobs). Returns an operation. */
  async predictLongRunning(model: string, body: unknown): Promise<any> {
    await this.countBillableCall();
    return this.callMethod("predictLongRunning", model, body);
  }

  /** Generic, validated method dispatch used by gemini_raw and the above. */
  async callMethod(method: string, model: string, body: unknown): Promise<any> {
    const safeModel = sanitizeModel(model);
    const safeMethod = sanitizeMethod(method);
    const res = await fetch(`${BASE}/models/${safeModel}:${safeMethod}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body ?? {}),
    });
    return this.parse(res, `${safeMethod} on ${safeModel}`);
  }

  /** Poll a long-running operation once. */
  async getOperation(name: string): Promise<any> {
    const safe = sanitizeOperationName(name);
    const res = await fetch(`${BASE}/${safe}`, { headers: this.headers() });
    return this.parse(res, "poll operation");
  }

  // ---- internals ----------------------------------------------------------

  private async parse(res: Response, what: string): Promise<any> {
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const j: any = await res.json();
        if (j?.error?.message) detail = `${res.status} ${j.error.status ?? ""}: ${j.error.message}`;
      } catch {
        try {
          const t = await res.text();
          if (t) detail = `${res.status}: ${t}`;
        } catch {
          /* ignore */
        }
      }
      throw new CleanError(`Gemini API error while trying to ${what} — ${truncate(detail, 800)}`);
    }
    try {
      return await res.json();
    } catch {
      throw new CleanError(`Gemini returned a non-JSON response while trying to ${what}.`);
    }
  }

  /**
   * Optional circuit breaker. When DAILY_CALL_CAP is a positive integer, count
   * billable generation calls per UTC day in KV and refuse once the cap is hit.
   * Approximate by design (KV is eventually consistent) — it is a guard rail,
   * not an accounting system. Listing models and polling operations do not count.
   */
  private async countBillableCall(): Promise<void> {
    const cap = parseInt(this.env.DAILY_CALL_CAP ?? "0", 10);
    if (!Number.isFinite(cap) || cap <= 0) return;
    const day = new Date().toISOString().slice(0, 10);
    const key = `calls:${day}`;
    const current = parseInt((await this.env.MEDIA.get(key)) ?? "0", 10) || 0;
    if (current >= cap) {
      throw new CapError(
        `Daily Gemini call cap reached (${cap} billable calls for ${day} UTC). This is your circuit breaker — it resets at 00:00 UTC. Raise DAILY_CALL_CAP or wait.`,
      );
    }
    // Counter keys self-expire after two days.
    await this.env.MEDIA.put(key, String(current + 1), { expirationTtl: 172800 });
  }
}

// ---------------------------------------------------------------------------
// Dynamic default selection. Nothing is hardcoded as "the" model — these are
// recommendations derived from the *live* list, with name-pattern fallbacks so
// new models are picked up automatically and a missing family degrades sanely.
// ---------------------------------------------------------------------------

export interface ModelDefaults {
  reasoning?: string; // pro / thinking tier — audits, hard second opinions
  fast?: string; // flash tier — quick checks, cheap opinions
  image_generate?: string; // best single-shot generation (Imagen-class)
  image_generate_fast?: string; // cheap drafts
  image_edit?: string; // best iterative editor (Nano Banana)
  image_edit_fast?: string; // fast editing loops
  grounding?: string; // Google Search cross-check
  digest?: string; // long-context offload
  video?: string; // Veo / predictLongRunning
}

const bare = (m: GeminiModel) => m.name.replace(/^models\//, "");
const has = (m: GeminiModel, method: string) =>
  (m.supportedGenerationMethods ?? []).includes(method);
const nameHas = (m: GeminiModel, s: string) => bare(m).toLowerCase().includes(s);

// Rough "newness" score: sum the numeric runs in the id so gemini-3.1 ranks above
// gemini-2.5. Tie-break later by preferring non-preview, larger context.
function versionScore(m: GeminiModel): number {
  const nums = bare(m).match(/\d+/g) ?? [];
  let score = 0;
  for (let i = 0; i < nums.length; i++) {
    score += parseInt(nums[i], 10) / Math.pow(100, i);
  }
  return score;
}

function pick(models: GeminiModel[], pred: (m: GeminiModel) => boolean): string | undefined {
  const matches = models.filter(pred);
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => {
    const pa = nameHas(a, "preview") || nameHas(a, "exp") ? 0 : 1;
    const pb = nameHas(b, "preview") || nameHas(b, "exp") ? 0 : 1;
    if (pa !== pb) return pb - pa; // prefer stable over preview/experimental
    const va = versionScore(a);
    const vb = versionScore(b);
    if (va !== vb) return vb - va; // prefer newer
    return (b.inputTokenLimit ?? 0) - (a.inputTokenLimit ?? 0);
  });
  return bare(matches[0]);
}

const isImageGenModel = (m: GeminiModel) =>
  (has(m, "predict") && nameHas(m, "imagen")) ||
  (has(m, "generateContent") && nameHas(m, "image"));
const isImageEditModel = (m: GeminiModel) =>
  has(m, "generateContent") && nameHas(m, "image"); // Nano Banana family
const isTextModel = (m: GeminiModel) =>
  has(m, "generateContent") && !nameHas(m, "image") && !nameHas(m, "tts") &&
  !nameHas(m, "embedding") && !nameHas(m, "veo") && !nameHas(m, "aqa");

export function computeDefaults(models: GeminiModel[]): ModelDefaults {
  return {
    reasoning:
      pick(models, (m) => isTextModel(m) && nameHas(m, "pro")) ??
      pick(models, isTextModel),
    fast:
      pick(models, (m) => isTextModel(m) && nameHas(m, "flash") && !nameHas(m, "lite")) ??
      pick(models, (m) => isTextModel(m) && nameHas(m, "flash")) ??
      pick(models, isTextModel),
    image_generate:
      pick(models, (m) => nameHas(m, "imagen") && nameHas(m, "ultra")) ??
      pick(models, (m) => nameHas(m, "imagen") && !nameHas(m, "fast")) ??
      pick(models, (m) => isImageEditModel(m) && nameHas(m, "pro")) ??
      pick(models, isImageGenModel),
    image_generate_fast:
      pick(models, (m) => nameHas(m, "imagen") && nameHas(m, "fast")) ??
      pick(models, (m) => isImageEditModel(m) && nameHas(m, "flash")) ??
      pick(models, isImageGenModel),
    image_edit:
      pick(models, (m) => isImageEditModel(m) && nameHas(m, "pro")) ??
      pick(models, isImageEditModel),
    image_edit_fast:
      pick(models, (m) => isImageEditModel(m) && nameHas(m, "flash")) ??
      pick(models, isImageEditModel),
    grounding:
      pick(models, (m) => isTextModel(m) && nameHas(m, "flash") && !nameHas(m, "lite")) ??
      pick(models, isTextModel),
    digest:
      pick(models, (m) => isTextModel(m) && nameHas(m, "flash") && !nameHas(m, "lite")) ??
      pick(models, isTextModel),
    video:
      pick(models, (m) => has(m, "predictLongRunning") || nameHas(m, "veo")),
  };
}

/** True if this model can edit images (Nano Banana family), per the live list. */
export function modelCanEditImages(m: GeminiModel | undefined): boolean {
  return !!m && isImageEditModel(m);
}

/** True if this model generates images via the Imagen :predict shape. */
export function modelIsImagen(m: GeminiModel | undefined): boolean {
  return !!m && has(m, "predict") && nameHas(m, "imagen");
}
