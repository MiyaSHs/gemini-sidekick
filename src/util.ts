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

/**
 * Best-effort SSRF guard for server-side fetches of user-supplied URLs.
 * Allows only http(s) and rejects loopback / private / link-local literals.
 * Note: this does not resolve DNS, so it can't stop a public hostname that
 * points at a private IP — Cloudflare's runtime blocks most internal targets,
 * and this is a personal, secret-gated tool, so this is defence-in-depth.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new CleanError(`Not a valid URL: "${truncate(raw, 80)}".`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new CleanError(`Only http(s) URLs are allowed; got "${u.protocol}".`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new CleanError("Refusing to fetch an internal host.");
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (
      a === 0 || a === 127 || a === 10 ||
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      a >= 224 // multicast / reserved
    ) {
      throw new CleanError("Refusing to fetch a private, loopback, or link-local address.");
    }
  }
  if (host === "::" || host === "::1" || host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) {
    throw new CleanError("Refusing to fetch a private or loopback IPv6 address.");
  }
  return u;
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

/**
 * Best-effort pixel dimensions read from the image bytes themselves (PNG, JPEG,
 * GIF, WebP — the raster types this server serves). Returns null when the format
 * is unrecognised or the header is too short; callers must treat the result as
 * optional. Pure header inspection — never throws, never decodes pixels.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    const n = bytes.length;
    const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : null);

    // PNG: 8-byte signature, then IHDR width/height as big-endian uint32.
    if (
      n >= 24 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    ) {
      const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
      const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
      return ok(w, h);
    }

    // GIF: "GIF87a"/"GIF89a", then logical-screen width/height as little-endian uint16.
    if (n >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return ok(bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8));
    }

    // WebP: "RIFF"<size>"WEBP"<fourcc>… — three sub-formats carry size differently.
    if (
      n >= 30 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (fourcc === "VP8 ") {
        // Lossy: 14-bit width/height at offset 26/28 (little-endian).
        return ok((bytes[26] | (bytes[27] << 8)) & 0x3fff, (bytes[28] | (bytes[29] << 8)) & 0x3fff);
      }
      if (fourcc === "VP8L" && bytes[20] === 0x2f) {
        // Lossless: 14-bit (width-1),(height-1) packed little-endian after the 0x2f sig.
        const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
        const w = 1 + (((b1 & 0x3f) << 8) | b0);
        const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return ok(w, h);
      }
      if (fourcc === "VP8X") {
        // Extended: 24-bit (canvas-1) width/height at offset 24/27 (little-endian).
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return ok(w, h);
      }
      return null;
    }

    // JPEG: walk the segments to the Start-Of-Frame marker (SOFn) and read its size.
    if (n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let off = 2;
      while (off + 1 < n) {
        if (bytes[off] !== 0xff) { off++; continue; } // resync over stray bytes
        const marker = bytes[off + 1];
        if (marker === 0xff) { off++; continue; } // fill byte
        off += 2;
        // Markers with no length payload (SOI/EOI/RSTn/TEM): nothing to skip.
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          continue;
        }
        if (off + 1 >= n) break;
        const segLen = (bytes[off] << 8) | bytes[off + 1];
        if (segLen < 2) break;
        // SOF0..SOF15 carry the frame size, excluding DHT(C4), JPG(C8), DAC(CC).
        const isSOF =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) {
          if (off + 6 >= n) break;
          return ok((bytes[off + 5] << 8) | bytes[off + 6], (bytes[off + 3] << 8) | bytes[off + 4]);
        }
        off += segLen;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
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
