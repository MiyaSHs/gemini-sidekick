import type { Env } from "./env.ts";
import { GeminiClient } from "./gemini.ts";
import { serveMedia } from "./images.ts";
import { handleMcpPost } from "./mcp.ts";
import type { ToolCtx } from "./tools.ts";
import { timingSafeEqual } from "./util.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
  // The connector secret lives in the URL path; keep it out of Referer headers.
  "Referrer-Policy": "no-referrer",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...CORS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Health / landing — never reveals the secret.
    if (path === "/" || path === "/health") {
      return text("Gemini Sidekick connector is running. POST JSON-RPC to /<connector-secret>/mcp", 200);
    }

    // Image hosting. The id itself is the unguessable capability, so this route
    // is intentionally NOT behind the connector secret — sharing an image link
    // never leaks the connector secret.
    if (path.startsWith("/img/")) {
      const id = decodeURIComponent(path.slice("/img/".length));
      return withCors(await serveMedia(env, id));
    }

    // Configuration guard with a clean message (never a stack trace).
    if (!env.CONNECTOR_SECRET || !env.GEMINI_API_KEY) {
      return text("Server not configured: set CONNECTOR_SECRET and GEMINI_API_KEY as Worker secrets, then redeploy.", 500);
    }

    // Secret-gated routes: /<secret>/mcp
    const segs = path.split("/").filter(Boolean);
    if (segs.length >= 1) {
      const provided = decodeURIComponent(segs[0]);
      if (await timingSafeEqual(provided, env.CONNECTOR_SECRET)) {
        const sub = segs[1] ?? "mcp";
        if (sub === "mcp") {
          if (request.method === "POST") {
            const ctx: ToolCtx = { env, gemini: new GeminiClient(env), origin: url.origin };
            return withCors(await handleMcpPost(request, ctx));
          }
          if (request.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
          // Stateless server offers no server-initiated SSE stream on GET.
          return text("This MCP endpoint speaks Streamable HTTP — POST JSON-RPC here.", 405);
        }
      }
    }

    // Generic 404 for everything else (does not confirm whether the secret matched).
    return text("Not found", 404);
  },
};
