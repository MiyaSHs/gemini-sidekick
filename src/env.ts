// Bindings configured in wrangler.jsonc + `wrangler secret put`.
export interface Env {
  // Secrets (set with `wrangler secret put`):
  GEMINI_API_KEY: string; // Google AI Studio API key, billing enabled.
  CONNECTOR_SECRET: string; // Unguessable first path segment of the connector URL.

  // KV namespace: hosted media bytes (media:<id>) + daily-call counter (calls:<date>).
  MEDIA: KVNamespace;

  // Vars (wrangler.jsonc):
  DAILY_CALL_CAP?: string; // "0"/"" disables; otherwise max billable calls per UTC day.
  IMAGE_TTL_SECONDS?: string; // KV TTL for hosted media. Default 30 days.
  ALLOWED_ORIGINS?: string; // Comma-separated browser origins allowed to call /mcp cross-origin. "*" = any. Empty = built-in claude.ai default.
}
