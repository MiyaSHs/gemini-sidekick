# Gemini Connector — a personal Gemini MCP for Claude

A remote [MCP](https://modelcontextprotocol.io) connector that gives Claude access to your
Google Gemini models, deployed as a single stateless **Cloudflare Worker** on the free tier.
It works everywhere your Claude account goes: claude.ai web, the mobile app, Claude Desktop,
and every Claude Code project.

> **The rule this whole thing is built around:**
> Gemini is a gap-filler and a verifier, never an author. Claude writes every answer itself —
> its own reasoning, creativity, brainstorming, and judgment, from start to finish. This
> connector exists only to (a) do things Claude cannot do at all (generate and edit images,
> reach exotic models) and (b) make Claude's own answers better through independent
> verification and contrasting perspectives. Never use it to outsource Claude's thinking,
> writing, ideation, or analysis. **Critique-then-refine, not merge-two-drafts.**

This rule is sent to Claude on every connection, and it's also in the two paste-blocks below
([`claude-profile-instructions.md`](./claude-profile-instructions.md) and
[`claude-code-config.md`](./claude-code-config.md)). Keep it in all three.

## What it gives Claude

| Tool | What it's for |
|------|---------------|
| `list_gemini_models` | Live model discovery + recommended defaults. Nothing is hardcoded; the live list is the source of truth, so new models on your key appear automatically. |
| `generate_image` | Generate (Imagen-class quality, or a fast/cheap draft) **and** iteratively edit — feed a result's URL back in to refine "add a red bandana / warmer light / bigger logo" indefinitely, branching whenever you want. |
| `gemini_audit` | Independent, **structured** cross-model audit of important output Claude produced (issues with severity + location + suggested fix + a confidence) so Claude can surgically fix only what's wrong. |
| `ask_gemini` | A genuine second opinion to contrast with Claude's own answer. Multi-turn. |
| `gemini_disagree` | Asks a fast and a strong model the same thing and surfaces only where they **diverge** — divergence is the signal. |
| `gemini_digest` | Offloads a very large input (big PDF, whole codebase, long transcript, YouTube URL) to Gemini's huge context window and returns a compact structured summary. |
| `gemini_grounded` | Gemini with Google Search grounding as a second, independent search engine to cross-check facts. |
| `gemini_raw` | Escape hatch to any model/method on your key (music, robotics, video, TTS, embeddings, future models), including polling long-running video jobs to completion. |

Every generated/edited image is hosted at a stable, unguessable URL and returned both as a
markdown image and as a plain clickable link — because many clients (claude.ai web/mobile)
won't render an inline image from a connector.

---

## One-time setup

You need a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free), Node 18+, and a
[Google AI Studio API key](https://aistudio.google.com/apikey) with billing enabled.

```bash
# 1. Install dependencies
npm install

# 2. Log in to Cloudflare (opens a browser)
npx wrangler login

# 3. Pick an unguessable connector secret and keep it handy
#    (this becomes the first path segment of your connector URL)
openssl rand -hex 24            # e.g. 7f3c...  -> copy it

# 4. Create the KV namespace that hosts generated images, and paste the printed
#    id into wrangler.jsonc under kv_namespaces[0].id
npx wrangler kv namespace create MEDIA

# 5. Store the two secrets (you'll be prompted to paste each value)
npx wrangler secret put GEMINI_API_KEY      # your AI Studio key
npx wrangler secret put CONNECTOR_SECRET    # the random string from step 3

# 6. Deploy (do this AFTER pasting the KV id from step 4)
npx wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://gemini-connector.<your-subdomain>.workers.dev`.

**Your connector URL is that, plus `/<CONNECTOR_SECRET>/mcp`:**

```
https://gemini-connector.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp
```

Visit the bare Worker URL in a browser — it should say *"Gemini MCP connector is running"* (it
never reveals the secret). If you change the KV id later, re-run `npx wrangler deploy`.

### Connect it to claude.ai (web + mobile + Desktop share this)

Settings → **Connectors** → **Add custom connector** → paste the full connector URL above →
save. Because connectors live on your account, it's immediately available in the web app, the
mobile app, and Claude Desktop. Then paste [`claude-profile-instructions.md`](./claude-profile-instructions.md)
into Settings → Profile → **"Instructions for Claude."**

> Custom connectors require a Claude plan that supports them (Pro/Max/Team/Enterprise).

### Connect it to Claude Code (every project, automatically)

```bash
claude mcp add --scope user --transport http gemini \
  "https://gemini-connector.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp"
```

`--scope user` makes it available in **every** project. Then add the philosophy + usage block
from [`claude-code-config.md`](./claude-code-config.md) to your global `~/.claude/CLAUDE.md`.

---

## Configuration (optional)

Set in `wrangler.jsonc` under `vars`, then redeploy:

- **`DAILY_CALL_CAP`** — a circuit breaker. `"0"` (default) disables it; `"200"` refuses
  billable Gemini calls after 200 in a UTC day. Approximate (counted in KV), meant to stop a
  runaway loop, not to do accounting. Listing models and polling operations don't count.
- **`IMAGE_TTL_SECONDS`** — how long hosted images live in KV (default `2592000` = 30 days).
  Images must outlive an editing session so you can keep refining a result across turns.

## Billing safety — read this

Billing is on, so a runaway loop costs **money**, not just quota. The `DAILY_CALL_CAP` above is
a guard rail. **Your real safety net is a budget alert:** in the
[Google Cloud Console](https://console.cloud.google.com/billing) → Billing → **Budgets &
alerts**, create a budget on the project behind your AI Studio key with email alerts at, say,
50% / 90% / 100%. Do this — the connector secret lives in the URL, so if it ever leaks, a
budget alert is what tells you.

## Security notes

- **Auth** is an unguessable secret as the first URL path segment (claude.ai's connector UI
  can't send static auth headers, so this is what actually works). It's compared in
  **constant time**, and the Gemini key is stored as a Cloudflare secret, never in the URL.
- **Image links are decoupled from the connector secret.** Images are served from
  `/img/<id>` where `<id>` is its own 144-bit unguessable token — so sharing an image link
  never leaks your connector secret.
- **The image route can't become an XSS vector.** Only safe raster types (PNG/JPEG/WebP/GIF)
  are served inline; anything else (e.g. SVG) is forced to download, under a strict
  `Content-Security-Policy` and `X-Content-Type-Options: nosniff`.
- Model names and API methods are validated against allow-lists before they're ever placed in
  an API URL path (injection protection).
- Stored image bytes are copied into an exact-length buffer, so no pooled/shared memory can
  leak into a stored image or a subsequent edit.

## Local development & tests

```bash
cp .dev.vars.example .dev.vars   # fill in a fake key + a test secret
npm run dev                       # wrangler dev (local workerd + local KV)
npm test                          # unit + integration tests (transport, security, defaults)
npm run typecheck                 # tsc --noEmit over src/
npm run build                     # dry-run bundle, no deploy
```

## Should there be a text-to-speech tool? (the open question)

**Decision: no dedicated TTS tool — it's covered by the `gemini_raw` escape hatch, whose audio
output is auto-hosted at a link.** Reasoning:

- TTS is a real capability gap (Claude can't synthesize speech), so it belongs *somewhere*.
  But unlike image editing, it has **no iterative loop and no model-shape juggling** that a
  bespoke tool would simplify — it's a single `generateContent` call with a `speechConfig`,
  which `gemini_raw` already expresses directly.
- Audio can't render inline in Claude's clients anyway, so it needs the same "host it and
  return a link" treatment images get. `gemini_raw` already does that automatically for any
  inline media in a response, so TTS audio comes back as a clickable URL with **zero** extra
  surface.
- You removed TTS once already, which signals it's low-frequency for you. A leaner tool list
  also serves the "proactive but never naggy" goal: fewer tools means Claude routes to the
  right one more reliably.
- If you find yourself reaching for it constantly, promoting it to a first-class tool later is
  a small change (it would mostly be the hosting wiring, which already exists).

So it's available today via `gemini_raw` (model + `generateContent` + a `speechConfig` body),
just not as its own tool.
