# Gemini Sidekick — a Gemini MCP connector for Claude

A remote [MCP](https://modelcontextprotocol.io) connector that gives Claude **capabilities it
doesn't have on its own** — image generation/editing and other Gemini generative modalities —
deployed as a single stateless **Cloudflare Worker** on the free tier. It works everywhere your
Claude account goes: claude.ai web, the mobile app, Claude Desktop, and every Claude Code project.

> **The rule this whole thing is built around:**
> Gemini is a capability extender, never a co-author or reviewer. Claude writes every answer
> itself — its reasoning, writing, code, analysis, and judgment are Claude's own, and are never
> outsourced to, supplemented by, or second-guessed against Gemini. This connector exists only to
> do things Claude cannot do at all: generate and edit images, and reach other generative
> modalities (video, speech, music, embeddings, and exotic or future models). **Use it for those
> capabilities and nothing else.**

This rule is sent to Claude on every connection, and it's also in the two paste-blocks below
([`claude-profile-instructions.md`](./claude-profile-instructions.md) and
[`claude-code-config.md`](./claude-code-config.md)). Keep it in all three.

## What it gives Claude

| Tool | What it's for |
|------|---------------|
| `list_gemini_models` | Live model discovery + recommended defaults. Nothing is hardcoded; the live list is the source of truth, so new models on your key appear automatically. |
| `generate_image` | Generate (Imagen-class quality, or a fast/cheap draft) **and** iteratively edit — feed a result's URL back in to refine "add a red bandana / warmer light / bigger logo" indefinitely, branching whenever you want. |
| `gemini_raw` | Escape hatch to any other generative modality on your key (video/Veo, speech/TTS, music/Lyria, embeddings, future models), including polling long-running video jobs to completion. |

It is deliberately scoped to **capabilities only** — not second opinions, code review,
fact-checking, web grounding, or summarisation. Claude's own reasoning, writing, and code stay
authoritative.

Every generated/edited image is hosted at a stable, unguessable URL and returned both as a
markdown image and as a plain clickable link — because many clients (claude.ai web/mobile)
won't render an inline image from a connector.

---

## Deploy

Prerequisites: a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free) and a
[Google AI Studio API key](https://aistudio.google.com/apikey) with billing enabled. The only
value you generate yourself is one random string — your connector secret:

```bash
openssl rand -hex 24
```

> **Forking this for your own use?** Your `src/` code needs **no** changes. The one fork-specific
> value is the **KV namespace id**: a KV namespace belongs to a single Cloudflare account, so the
> id committed here (the original author's) won't work in yours. Set yours — no CLI required:
>
> 1. Fork the repo on GitHub.
> 2. Cloudflare dashboard → **Storage & Databases → KV → Create a namespace** (any name) → copy
>    its **Namespace ID**.
> 3. In your fork on GitHub, open `wrangler.jsonc`, replace the `id` on the `MEDIA` binding with
>    that value, and commit.

### Option A — Connect the repo to Cloudflare (recommended; no local tooling)

After this one-time setup, every push to `main` auto-builds and deploys (**edit → `update.sh` → live**).

1. **Create the application.** Dashboard → **Workers & Pages → Create application** →
   **Import a repository** → **GitHub** → install/authorize the Cloudflare GitHub app → pick your repo.
2. **On the "Set up your application" screen** (open **Advanced settings** to see everything):
   - **Build command:** `npm install`
   - **Deploy command:** `npx wrangler deploy`
   - **Non-production branch deploy command:** `npx wrangler versions upload` *(the default — leave it)*
   - **Path:** `/` · **API token:** leave the auto-created one
   - **Variable name / Variable value → leave BLANK.** ⚠️ This box adds *build* variables; secrets
     entered here never reach the running worker. The real secrets go in step 3.
   - Click **Deploy** and let the first build finish.
3. **Add the two secrets to the WORKER (runtime — not the build).** Open the worker →
   **Settings → Variables and secrets → + Add**, each as type **Secret** (encrypted):
   - `GEMINI_API_KEY` — your AI Studio key
   - `CONNECTOR_SECRET` — the random string from above (the secret in your URL)

   Save. (`DAILY_CALL_CAP` and `IMAGE_TTL_SECONDS` are already listed as plaintext — they come from
   `wrangler.jsonc`.) Until the secrets are set, the URL returns a clean *"Server not configured."*
4. **Get your connector URL.** On the worker's page the address is shown at the top and behind the
   **Visit** button:
   ```
   https://gemini-mcp.<your-subdomain>.workers.dev
   ```
   `gemini-mcp` is the worker `name` from `wrangler.jsonc`; `<your-subdomain>` is your account's
   workers.dev subdomain (the same across all your workers). That bare URL should say *"Gemini Sidekick
   connector is running."* **Your connector URL is it plus `/<CONNECTOR_SECRET>/mcp`:**
   ```
   https://gemini-mcp.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp
   ```

Verify with `npm run smoke` (see ["Verify it works"](#verify-it-works-after-deploy)), then add it in
claude.ai. Push future changes — which auto-deploy — with:

```bash
bash scripts/update.sh "what you changed"     # macOS / Linux / Git Bash
scripts\update.bat "what you changed"         # Windows
```

### Option B — Deploy from your machine with the CLI (alternative)

Needs Node 18+.

```bash
npm install
npx wrangler login

# Forkers: create your KV namespace, then put the printed id in wrangler.jsonc (kv_namespaces[0].id),
# replacing the committed value. Say NO if wrangler offers to "add it on your behalf".
npx wrangler kv namespace create MEDIA

npx wrangler deploy                          # creates the worker and prints its URL
npx wrangler secret put GEMINI_API_KEY       # your AI Studio key
npx wrangler secret put CONNECTOR_SECRET     # the random string from above
```

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

**Automated smoke test** — speaks MCP straight to your deployed Worker and exercises the tools
against real Gemini, with no Claude in the loop (so it's deterministic and scriptable). It makes
a few cents of real calls (mostly the image generate + edit).

```bash
GEMINI_MCP_URL="https://gemini-mcp.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp" npm run smoke
```

- `npm run smoke -- --cheap` — protocol + model list + a free `countTokens` call only (no images).
- `npm run smoke -- --no-image` — skip the (priciest) image generate/edit calls.

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
  worker URL (no path) should say "Gemini Sidekick connector is running."

## Configuration (optional)

Set in `wrangler.jsonc` under `vars`, then redeploy:

- **`DAILY_CALL_CAP`** — a circuit breaker. `"0"` (default) disables it; `"200"` refuses
  billable Gemini calls after 200 in a UTC day. Approximate (counted in KV), meant to stop a
  runaway loop, not to do accounting. Listing models and polling operations don't count.
- **`IMAGE_TTL_SECONDS`** — how long hosted images live in KV (default `2592000` = 30 days).
  Images must outlive an editing session so you can keep refining a result across turns.
- **`ALLOWED_ORIGINS`** — comma-separated browser origins allowed to call the secret `/mcp`
  route cross-origin (default `https://claude.ai,https://www.claude.ai`). The public `/img`
  route stays open. `"*"` allows any origin. Non-browser clients (Claude Code, mobile) send no
  Origin and are unaffected — CORS is browser-enforced — so this can't lock those out.

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
- **The secret `/mcp` route is CORS-locked** to an origin allow-list (see `ALLOWED_ORIGINS`),
  so a site that learns your URL can't drive the connector from a victim's browser.
- Model names and API methods are validated against allow-lists before they're ever placed in
  an API URL path (injection protection), and outbound fetches of user-supplied URLs are
  re-validated on every redirect hop (SSRF protection).
- Stored image bytes are copied into an exact-length buffer, so no pooled/shared memory can
  leak into a stored image or a subsequent edit.

## Secrets — what's committed, what isn't

No secrets are committed, so a fork is safe to keep public:

- **`GEMINI_API_KEY` and `CONNECTOR_SECRET` are never in the repo.** They live as encrypted
  Cloudflare Worker secrets; `.dev.vars` (local only) is gitignored.
- **The KV namespace id in `wrangler.jsonc` is not a secret** — it's an account-scoped resource
  handle that does nothing without your Cloudflare credentials, so it's safe to commit.

To stand up your own copy, create a KV namespace, swap that id, and set your two secrets — see
[Deploy](#deploy).

## Local development & tests

```bash
cp .dev.vars.example .dev.vars   # fill in a fake key + a test secret
npm run dev                       # wrangler dev (local workerd + local KV)
npm test                          # unit + integration tests (transport, security, defaults)
npm run typecheck                 # tsc --noEmit over src/
npm run build                     # dry-run bundle, no deploy
```

## Text-to-speech: why there's no dedicated tool

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
- A leaner tool list keeps the connector reliable: fewer tools means Claude routes to the
  right one more readily, so a low-frequency capability is better left in the escape hatch
  than promoted to its own tool.
- If you find yourself reaching for it constantly, promoting it to a first-class tool later is
  a small change (it would mostly be the hosting wiring, which already exists).

So it's available today via `gemini_raw` (model + `generateContent` + a `speechConfig` body),
just not as its own tool.
