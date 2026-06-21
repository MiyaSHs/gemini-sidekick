# Claude Code — make Gemini available in every project

## 1. Register the connector at user scope

This makes the connector available in **every** Claude Code project on this machine:

```bash
claude mcp add --scope user --transport http gemini \
  "https://gemini-mcp.<your-subdomain>.workers.dev/<CONNECTOR_SECRET>/mcp"
```

Verify with `claude mcp list`. (Under the hood this adds an `mcpServers` entry to your user
config at `~/.claude.json`.)

## 2. Add the usage guidance to your global memory

Append the block below to `~/.claude/CLAUDE.md` (create it if it doesn't exist) so the rules
apply in every project:

---

## Gemini connector

I have a personal **Gemini** connector available. It is a capability extender, not a co-author or
reviewer: you write every answer yourself — your reasoning, writing, code, analysis, and judgment
are your own and are never outsourced to, supplemented by, or checked against Gemini. Use it only
for things you genuinely cannot do yourself: generate and edit images, and reach other generative
modalities (video, speech, music, embeddings, exotic models). Not for second opinions, code review,
fact-checking, web grounding, or summarising on your behalf.

Use it autonomously, like any other tool — on your own initiative, without asking my permission,
and without ending messages by offering to "run this by Gemini." Just use it when the job needs a
capability you lack. (The only thing to confirm first is expensive video.)

- Call `list_gemini_models` once first; the live list is the source of truth. Billing is on, so
  match model size to task size.
- `generate_image` to create or iteratively edit images; always surface the returned hosted link
  as a plain URL. Editing re-renders the whole image each pass, so quality compounds over many
  hops — prefer fewer combined edits and branch from the cleanest earlier version.
- `gemini_raw` is the escape hatch for any other generative modality (video/Veo, speech/TTS,
  music, embeddings, future models). Confirm before anything expensive (video).
