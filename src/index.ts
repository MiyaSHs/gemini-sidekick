import type { Env } from "./env.ts";
import { GeminiClient } from "./gemini.ts";
import { serveMedia } from "./images.ts";
import { handleMcpPost } from "./mcp.ts";
import type { ToolCtx } from "./tools.ts";
import { timingSafeEqual } from "./util.ts";

const CORS_BASE: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
  // The connector secret lives in the URL path; keep it out of Referer headers.
  "Referrer-Policy": "no-referrer",
};

// Default browser origins allowed to call the secret /mcp route cross-origin.
const DEFAULT_ALLOWED_ORIGINS = ["https://claude.ai", "https://www.claude.ai"];

export function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS?.trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

/**
 * CORS headers for a response. The public /img route (and generic text pages) are
 * shareable, so they get Access-Control-Allow-Origin: *. The secret-gated /mcp
 * route only echoes an allow-listed Origin, so a random website that learns the
 * URL can't read your tool output from a victim's browser. Requests with no Origin
 * (Claude Code, mobile, any non-browser client) are not CORS-enforced and are
 * unaffected — they never receive (or need) an allow-origin header.
 */
export function corsHeaders(request: Request, env: Env, isPublic: boolean): Record<string, string> {
  const headers: Record<string, string> = { ...CORS_BASE };
  const allow = allowedOrigins(env);
  const origin = request.headers.get("origin");
  if (isPublic || allow.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && allow.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function text(body: string, status: number, cors: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...cors },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const publicCors = corsHeaders(request, env, true);

    // CORS preflight — /img and generic pages are public; /mcp is origin-gated.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env, path.startsWith("/img/")) });
    }

    // Health / landing — never reveals the secret.
    if (path === "/" || path === "/health") {
      return text("Gemini Sidekick connector is running. POST JSON-RPC to /<connector-secret>/mcp", 200, publicCors);
    }

    // Image hosting. The id itself is the unguessable capability, so this route
    // is intentionally NOT behind the connector secret — sharing an image link
    // never leaks the connector secret.
    if (path.startsWith("/img/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405, publicCors);
      const id = decodeURIComponent(path.slice("/img/".length));
      return withCors(await serveMedia(env, id), publicCors);
    }

    // Configuration guard with a clean message (never a stack trace).
    if (!env.CONNECTOR_SECRET || !env.GEMINI_API_KEY) {
      return text("Server not configured: set CONNECTOR_SECRET and GEMINI_API_KEY as Worker secrets, then redeploy.", 500, publicCors);
    }

    // Secret-gated routes: /<secret>/mcp — restrict cross-origin reads to the allow-list.
    const mcpCors = corsHeaders(request, env, false);
    const segs = path.split("/").filter(Boolean);
    if (segs.length >= 1) {
      const provided = decodeURIComponent(segs[0]);
      if (await timingSafeEqual(provided, env.CONNECTOR_SECRET)) {
        const sub = segs[1] ?? "mcp";
        if (sub === "mcp") {
          if (request.method === "POST") {
            const ctx: ToolCtx = { env, gemini: new GeminiClient(env), origin: url.origin };
            return withCors(await handleMcpPost(request, ctx), mcpCors);
          }
          if (request.method === "DELETE") return new Response(null, { status: 204, headers: mcpCors });
          // Stateless server offers no server-initiated SSE stream on GET.
          return text("This MCP endpoint speaks Streamable HTTP — POST JSON-RPC here.", 405, mcpCors);
        }
      }
    }

    // Generic 404 for everything else (does not confirm whether the secret matched).
    return text("Not found", 404, publicCors);
  },
};
