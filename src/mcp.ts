import { SERVER_INSTRUCTIONS } from "./instructions.ts";
import { callTool, TOOLS, type ToolCtx } from "./tools.ts";
import { CleanError, truncate } from "./util.ts";

const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const LATEST_PROTOCOL = "2025-11-25";

type Id = string | number | null | undefined;

interface RpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, result });
const err = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function initializeResult(params: any) {
  const requested = params?.protocolVersion;
  const protocolVersion =
    typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "gemini-mcp", title: "Gemini Sidekick", version: "1.0.0" },
    instructions: SERVER_INSTRUCTIONS,
  };
}

async function toolsCall(id: Id, params: any, ctx: ToolCtx): Promise<RpcResponse> {
  const name = params?.name;
  if (typeof name !== "string") return err(id, -32602, 'tools/call requires a string "name".');
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
  try {
    const result = await callTool(name, args, ctx);
    return ok(id, result);
  } catch (e: any) {
    const message =
      e instanceof CleanError
        ? e.userMessage
        : e?.message
          ? `Unexpected error: ${truncate(String(e.message), 300)}`
          : "Unexpected error handling the tool call.";
    // Tool execution problems are returned as a tool result with isError, not a
    // protocol error, so the model sees a clean, actionable message.
    return ok(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
  }
}

async function dispatch(method: string, params: any, id: Id, ctx: ToolCtx): Promise<RpcResponse> {
  switch (method) {
    case "initialize":
      return ok(id, initializeResult(params));
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call":
      return toolsCall(id, params, ctx);
    case "resources/list":
      return ok(id, { resources: [] });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "prompts/list":
      return ok(id, { prompts: [] });
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one Streamable-HTTP POST containing one JSON-RPC message (or a batch). */
export async function handleMcpPost(request: Request, ctx: ToolCtx): Promise<Response> {
  // If a protocol-version header is present it MUST be one we support (spec).
  const pv = request.headers.get("mcp-protocol-version");
  if (pv && !SUPPORTED_PROTOCOLS.includes(pv)) {
    return json(err(null, -32600, `Unsupported MCP-Protocol-Version: ${truncate(pv, 40)}.`), 400);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: body is not valid JSON." } });
  }

  // Guard the shared per-request budget: batching was removed in MCP 2025-06-18,
  // and a batch shares this stateless Worker's subrequest/memory limits, so cap it.
  if (Array.isArray(body)) {
    if (body.length > 20) return json(err(null, -32600, "Batch too large; send fewer messages per request."));
    const toolCalls = body.filter((m) => m && typeof m === "object" && m.method === "tools/call").length;
    if (toolCalls > 1) return json(err(null, -32600, "This connector accepts at most one tools/call per request."));
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses: RpcResponse[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue; // ignore non-objects/garbage
    const isNotification = msg.id === undefined || msg.id === null;
    if (typeof msg.method !== "string") {
      // A request (carries an id) with no valid method is malformed → -32600.
      if (!isNotification) responses.push(err(msg.id, -32600, "Invalid Request: missing or invalid method."));
      continue; // an id-less message with no method is ignorable garbage
    }
    if (isNotification) continue; // notifications (e.g. notifications/initialized) need no reply
    responses.push(await dispatch(msg.method, msg.params, msg.id, ctx));
  }

  // Body contained only notifications — acknowledge with 202 and no content.
  if (responses.length === 0) return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });

  const payload = Array.isArray(body) ? responses : responses[0];
  // A client that accepts ONLY event-stream (not JSON) gets the response SSE-framed.
  // claude.ai/Claude Code send both, so they stay on plain JSON.
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
    return sse(responses);
  }
  return json(payload);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/** Frame JSON-RPC responses as a Server-Sent Events stream for SSE-only clients. */
function sse(responses: RpcResponse[]): Response {
  const body = responses.map((r) => `event: message\ndata: ${JSON.stringify(r)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
