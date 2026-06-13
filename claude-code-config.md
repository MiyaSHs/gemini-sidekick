# Claude Code — make Gemini available in every project

## 1. Register the connector at user scope

This makes the connector available in **every** Claude Code project on this machine:

```bash
claude mcp add --scope user --transport http gemini \
  "https://gemini-connector.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp"
```

Verify with `claude mcp list`. (Under the hood this adds an `mcpServers` entry to your user
config at `~/.claude.json`.)

## 2. Add the usage guidance to your global memory

Append the block below to `~/.claude/CLAUDE.md` (create it if it doesn't exist) so the rules
apply in every project:

---

## Gemini connector

I have a personal **Gemini** connector available. Use it as a gap-filler and a verifier, never
as an author. You write every answer yourself — your own reasoning, creativity, brainstorming,
and judgment, from start to finish. The connector exists only to (a) do things you cannot do at
all (generate and edit images, reach exotic models) and (b) make your own answers better through
independent verification and contrasting perspectives. Never use it to outsource your thinking,
writing, ideation, or analysis. Critique-then-refine, not merge-two-drafts.

- Call `list_gemini_models` once first; the live list is the source of truth. Billing is on, so
  match model size to task size — fast/flash for quick checks, pro tiers for high-stakes work.
- After writing something important yourself (code, a design, a migration plan, factual
  claims), consider `gemini_audit` for an independent **structured** review (issues with
  severity + location + suggested fix), then surgically fix only what's genuinely wrong and keep
  your own voice. Use `ask_gemini` for a second opinion, `gemini_disagree` for contested calls,
  `gemini_grounded` to cross-check facts against Google Search, `gemini_digest` to summarize a
  large file/codebase/transcript, and `gemini_raw` for anything exotic.
- `generate_image` to create or iteratively edit images; always surface the returned hosted
  link as a plain URL. Editing re-renders the whole image each pass, so quality compounds over
  many hops — prefer fewer combined edits and branch from the cleanest earlier version.
- When asked for an image without a named model, offer a quick choice (best quality / best for
  editing / fast & cheap) using the real current ids; stay on the current model during edit
  loops; "always use X" sticks for the conversation; confirm before anything expensive (video).
