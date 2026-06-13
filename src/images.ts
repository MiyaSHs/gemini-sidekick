import type { Env } from "./env.ts";
import { randomToken, SAFE_INLINE_IMAGE_TYPES } from "./util.ts";

const DEFAULT_TTL = 2592000; // 30 days

interface StoredMeta {
  mimeType: string;
  createdAt: number;
}

/**
 * Store media bytes in KV under an unguessable id and return that id.
 * `bytes` must already be an exact-length copy (see util.base64ToBytes) so no
 * pooled/shared backing buffer can leak into the stored value.
 */
export async function storeMedia(
  env: Env,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const id = randomToken(18);
  const ttl = parseInt(env.IMAGE_TTL_SECONDS ?? "", 10);
  const meta: StoredMeta = { mimeType, createdAt: Date.now() };
  await env.MEDIA.put(`media:${id}`, bytes, {
    expirationTtl: Number.isFinite(ttl) && ttl >= 60 ? ttl : DEFAULT_TTL,
    metadata: meta,
  });
  return id;
}

/** Read media bytes back (e.g. to feed a previously generated image into an edit). */
export async function getMedia(
  env: Env,
  id: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const res = await env.MEDIA.getWithMetadata<StoredMeta>(`media:${id}`, {
    type: "arrayBuffer",
  });
  if (!res.value) return null;
  return {
    bytes: new Uint8Array(res.value),
    mimeType: res.metadata?.mimeType ?? "application/octet-stream",
  };
}

/** Public URL for a stored media id, derived from the incoming request origin. */
export function mediaUrl(origin: string, id: string): string {
  return `${origin}/img/${id}`;
}

// Only the bare token after /img/ is a valid id; reject anything else early.
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Serve a stored media item. Security posture:
 *  - Only known raster types render inline; everything else is forced to download.
 *  - The served Content-Type comes from an allow-list, never echoed arbitrarily,
 *    so e.g. an "image/svg+xml" can never be served inline as a script vector.
 *  - Strict CSP + nosniff neutralise any attempt to have the bytes interpreted
 *    as an active document.
 */
export async function serveMedia(env: Env, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return new Response("Not found", { status: 404 });
  const item = await getMedia(env, id);
  if (!item) return new Response("Not found or expired", { status: 404 });

  const inlineType = SAFE_INLINE_IMAGE_TYPES[item.mimeType.toLowerCase()];
  const headers = new Headers({
    "Content-Security-Policy":
      "default-src 'none'; style-src 'none'; script-src 'none'; sandbox; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (inlineType) {
    headers.set("Content-Type", inlineType);
    headers.set("Content-Disposition", "inline");
  } else {
    // Unknown / potentially active type: never serve inline.
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="download-${id}"`);
  }
  // Copy into a fresh ArrayBuffer of exactly the right length for the body.
  const body = item.bytes.slice().buffer;
  return new Response(body, { status: 200, headers });
}
