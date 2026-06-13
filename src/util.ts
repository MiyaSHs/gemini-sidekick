// Pure, dependency-free helpers. Kept self-contained so they can be unit-tested
// under `node --experimental-strip-types` without any Worker runtime bindings.

/** JSON-RPC / HTTP response error carried cleanly to the caller (no stack traces). */
export class CleanError extends Error {
  readonly userMessage: string;
  constructor(message: string) {
    super(message);
    this.name = "CleanError";
    this.userMessage = message;
  }
}

/** Raised when the optional daily-call circuit breaker trips. */
export class CapError extends CleanError {
  constructor(message: string) {
    super(message);
    this.name = "CapError";
  }
}

/**
 * Constant-time string comparison. Hashes both sides with SHA-256 first so the
 * comparison is over fixed-length digests — this leaks neither length nor the
 * position of the first differing byte. Use for the URL path secret.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/**
 * Coerce a value that *should* be a string array into one, defensively.
 * Some MCP clients send a real array, others a JSON-encoded array string,
 * others a single bare string. All three (and nested mixes) are accepted.
 */
export function coerceStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap((x) => coerceStringArray(x));
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.flatMap((x) => coerceStringArray(x));
      } catch {
        // not JSON — fall through and treat as a single value
      }
    }
    return [s];
  }
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  return [];
}

/** Coerce a value that should be a number (clients sometimes send numbers as strings). */
export function coerceNumber(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Coerce a value that should be a boolean (accepts "true"/"false"/1/0). */
export function coerceBool(v: unknown): boolean | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(s)) return true;
    if (["false", "0", "no", "n"].includes(s)) return false;
  }
  return undefined;
}

// A model name may optionally be prefixed with "models/". The bare id must match
// this character class before it is ever interpolated into an API URL path.
const MODEL_NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Allowed Gemini REST generation methods. Anything outside this set is rejected
// before being placed in a URL (defence against path injection).
const ALLOWED_METHODS = new Set([
  "generateContent",
  "streamGenerateContent",
  "predict",
  "predictLongRunning",
  "countTokens",
  "embedContent",
  "batchEmbedContents",
]);

/** Normalise and validate a model id; throws CleanError on anything suspicious. */
export function sanitizeModel(model: unknown): string {
  if (typeof model !== "string" || !model.trim()) {
    throw new CleanError("A model name is required but none was provided.");
  }
  const bare = model.trim().replace(/^models\//, "");
  if (!MODEL_NAME_RE.test(bare) || bare.length > 200) {
    throw new CleanError(
      `Invalid model name: "${model}". Use a model id from list_gemini_models (letters, digits, ".", "_", "-").`,
    );
  }
  return bare;
}

/** Validate an API method against the allow-list; throws CleanError otherwise. */
export function sanitizeMethod(method: unknown, fallback = "generateContent"): string {
  const m = typeof method === "string" && method.trim() ? method.trim() : fallback;
  if (!ALLOWED_METHODS.has(m)) {
    throw new CleanError(
      `Unsupported API method: "${m}". Allowed: ${[...ALLOWED_METHODS].join(", ")}.`,
    );
  }
  return m;
}

// A long-running operation name looks like "models/<model>/operations/<id>" or
// "operations/<id>". Validate the whole path segment-by-segment before using it.
const OPERATION_NAME_RE = /^(models\/[a-zA-Z0-9._-]+\/)?operations\/[a-zA-Z0-9._-]+$/;

/** Validate an operation name for polling; throws CleanError otherwise. */
export function sanitizeOperationName(name: unknown): string {
  if (typeof name !== "string" || !OPERATION_NAME_RE.test(name.trim())) {
    throw new CleanError(
      `Invalid operation name: "${String(name)}". Pass the exact "name" returned by predictLongRunning.`,
    );
  }
  return name.trim();
}

/** Decode standard or URL-safe base64 into a fresh, exact-length byte array. */
export function base64ToBytes(b64: string): Uint8Array {
  // Normalise URL-safe alphabet and restore padding so atob never chokes.
  let s = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) throw new CleanError("Corrupt base64 image data from the API.");
  const bin = atob(s);
  const len = bin.length;
  // Allocate an exact-length buffer and copy byte-by-byte. This guarantees the
  // stored bytes are *only* this image's bytes — no shared/pooled backing buffer
  // can leak neighbouring memory into the stored value or a subsequent edit.
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode bytes to standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Generate an unguessable URL-safe token (default 18 bytes = 144 bits). */
export function randomToken(nbytes = 18): string {
  const b = new Uint8Array(nbytes);
  crypto.getRandomValues(b);
  return bytesToBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Truncate long strings for safe inclusion in error messages. */
export function truncate(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** The set of raster image mime types we are willing to serve *inline*. */
export const SAFE_INLINE_IMAGE_TYPES: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};
