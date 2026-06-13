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

## Deploy

Prerequisites: a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free) and a
[Google AI Studio API key](https://aistudio.google.com/apikey) with billing enabled.

> **Using this for yourself? Fork it first.** Cloudflare's Git builds deploy from a repository you
> control, so click **Fork** on GitHub and run the steps below against *your* fork. You'll create
> your own KV namespace and put its id in `wrangler.jsonc` — the id committed here belongs to the
> original author and won't exist in your Cloudflare account.

### Option A — Auto-deploy from GitHub (recommended)

Connect the repo to Cloudflare once; every push to `main` then auto-builds and deploys, so the
workflow becomes **edit → `update.sh` → live**.

1. **KV namespace.** In your fork, create one and set its id:
   ```bash
   npx wrangler kv namespace create MEDIA
   ```
   Put the printed `id` into `wrangler.jsonc` → `kv_namespaces[0].id`, replacing the committed
   value, and commit. ⚠️ If wrangler offers to *"add it on your behalf,"* say **no** — that appends
   a second `MEDIA` binding and breaks the config. *(Original author: it's already set — skip this.)*
2. **Connect:** Cloudflare dashboard → *Workers & Pages* → **Create** → **Workers** →
   **Connect to Git** → authorize GitHub → pick your repo. Build settings: production branch `main`,
   build command `npm install`, deploy command `npx wrangler deploy`, root directory `/`. Save &
   deploy. The URL comes from the worker `name` in `wrangler.jsonc` →
   `https://gemini-mcp.<your-subdomain>.workers.dev` (change `name` first for a different URL).
3. **Set the two secrets as RUNTIME variables** — the easiest thing to get wrong:
   - ✅ Open the **worker → Settings → Variables and secrets** and add them *there*.
   - ❌ Do **not** add them under the **Build** configuration's "Variables and secrets" — those are
     build-time only; the running worker can't read them, so it deploys but every call fails.

   Add each as an **encrypted Secret**:
   - `GEMINI_API_KEY` — your AI Studio key
   - `CONNECTOR_SECRET` — a long random string (`openssl rand -hex 24`); this is the secret path
     segment in your URL.

   Then redeploy once (push anything, or *Deployments → Retry*).

`DAILY_CALL_CAP` and `IMAGE_TTL_SECONDS` deploy automatically from `wrangler.jsonc` as runtime
plaintext vars — you don't add those by hand. Until the secrets are set, the URL returns a clean
"Server not configured" message; after that, verify with `npm run smoke`
(see ["Verify it works"](#verify-it-works-after-deploy)).

To push changes (and trigger an auto-deploy):

```bash
bash scripts/update.sh "what you changed"     # macOS / Linux / Git Bash
scripts\update.bat "what you changed"         # Windows cmd / double-click
```

### Option B — Manual deploy from your machine

Needs Node 18+.

```bash
npm install
npx wrangler login

# 1) Create your KV namespace; put the printed id into wrangler.jsonc (kv_namespaces[0].id),
#    replacing the committed value. Say NO if wrangler offers to "add it on your behalf"
#    (that appends a duplicate MEDIA binding and breaks the config).
npx wrangler kv namespace create MEDIA

# 2) Deploy (creates the worker):
npx wrangler deploy

# 3) Set the two secrets (the worker now exists). CONNECTOR_SECRET is the path segment in your URL:
npx wrangler secret put GEMINI_API_KEY      # your AI Studio key
npx wrangler secret put CONNECTOR_SECRET    # e.g. the output of: openssl rand -hex 24
```

### Your connector URL (both options)

Cloudflare gives the worker a URL like `https://gemini-mcp.<your-subdomain>.workers.dev`
(shown in the dashboard, and printed by `wrangler deploy`). **Your connector URL is that plus
`/<CONNECTOR_SECRET>/mcp`:**

```
https://gemini-mcp.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp
```

Open the bare worker URL in a browser — it should say *"Gemini MCP connector is running"* (it
never reveals the secret).

### Connect it to claude.ai (web + mobile + Desktop share this)

Settings → **Connectors** → **Add custom connector** → paste the full connector URL above →
save. Because connectors live on your account, it's immediately available in the web app, the
mobile app, and Claude Desktop. Then paste [`claude-profile-instructions.md`](./claude-profile-instructions.md)
into Settings → Profile → **"Instructions for Claude."**

> Custom connectors require a Claude plan that supports them (Pro/Max/Team/Enterprise).

### Connect it to Claude Code (every project, automatically)

```bash
claude mcp add --scope user --transport http gemini \
  "https://gemini-mcp.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp"
```

`--scope user` makes it available in **every** project. Then add the philosophy + usage block
from [`claude-code-config.md`](./claude-code-config.md) to your global `~/.claude/CLAUDE.md`.

---

## Verify it works (after deploy)

**Automated smoke test** — speaks MCP straight to your deployed Worker and exercises each tool
against real Gemini, with no Claude in the loop (so it's deterministic and scriptable). It makes
a few cents of real calls.

```bash
GEMINI_MCP_URL="https://gemini-mcp.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp" npm run smoke
```

- `npm run smoke -- --cheap` — protocol + model list + one flash call only (near-free).
- `npm run smoke -- --no-image` — skip the (priciest) image generate/edit calls.
- `npm run smoke -- --full` — also run `gemini_disagree` (3 calls) and `gemini_digest`.

Exit code is `0` only if every step passed. The secret stays in the env var — it's never written
to the repo.

**Then a 2-minute manual check in claude.ai web or mobile** — the one thing the script can't
verify is client-side rendering. Ask it to *"generate an image of a fox, then make it wear a hat,"*
and confirm you get a working clickable **link** at each step (the inline image won't render there —
that's expected, and exactly why the link matters).

---

## Troubleshooting

- **Deploys fine, but every call errors or returns "Server not configured":** your secrets are set
  as *Build* variables, not runtime. Move `GEMINI_API_KEY` and `CONNECTOR_SECRET` to the **worker →
  Settings → Variables and secrets** (encrypted), then redeploy.
- **First build fails on the KV namespace:** the `id` in `wrangler.jsonc` isn't in your account.
  Create your own with `npx wrangler kv namespace create MEDIA` and replace it.
- **"MEDIA assigned to multiple KV Namespace bindings":** there are two `MEDIA` entries — wrangler
  appended one when you accepted its "add it on your behalf" prompt. Keep a single binding.
- **404 on the connector URL:** the secret in the path doesn't match `CONNECTOR_SECRET`. The bare
  worker URL (no path) should say "Gemini MCP connector is running."

## Configuration (optional)

Set in `wrangler.jsonc` under `vars`, then redeploy:

- **`DAILY_CALL_CAP`** — a circuit breaker. `"0"` (default) disables it; `"200"` refuses
  billable Gemini calls after 200 in a UTC day. Approximate (counted in KV), meant to stop a
  runaway loop, not to do accounting. Listing models and polling operations don't count.
- **`IMAGE_TTL_SECONDS`** — how long hosted images live in KV (default `2592000` = 30 days).
  Images must outlive an editing session so you can keep refining a result across turns.

> Free-tier KV allows ~1,000 writes/day. Each generated/edited image is one write (and,
> if `DAILY_CALL_CAP` is on, each billable call is one more). That's plenty for personal use,
> but it's the limit you'd hit first if something loops.

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

## Publishing this repo (it's public-safe)

Nothing secret is committed, so this repo is safe to make public:

- **`GEMINI_API_KEY` and `CONNECTOR_SECRET` are never in the repo.** They live as encrypted
  Cloudflare Worker secrets; `.dev.vars` (local only) is gitignored.
- **The KV namespace id in `wrangler.jsonc` is not a secret** — it's an account-scoped resource
  handle that does nothing without your Cloudflare credentials.

If someone forks this, they create their own KV namespace, replace that one id, and set their own
two secrets — see [Deploy](#deploy). Nothing tied to you exposes anything sensitive.

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
