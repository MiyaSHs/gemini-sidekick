import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDefaults, modelCanEditImages, modelIsImagen, type GeminiModel } from "../src/gemini.ts";

const m = (name: string, methods: string[]): GeminiModel => ({
  name: `models/${name}`,
  supportedGenerationMethods: methods,
});

// A realistic mixed key: pro/flash text, Imagen (predict), Nano Banana (image
// via generateContent), Veo (long-running), plus noise.
const MODELS: GeminiModel[] = [
  m("gemini-3.1-pro-preview", ["generateContent", "countTokens"]),
  m("gemini-3.5-flash", ["generateContent", "countTokens"]),
  m("gemini-3.5-flash-lite", ["generateContent"]),
  m("gemini-2.5-pro", ["generateContent"]),
  m("deep-research-pro-preview-12-2025", ["generateContent"]), // specialist; must NOT become a text default
  m("imagen-4.0-ultra-generate-001", ["predict"]),
  m("imagen-4.0-fast-generate-001", ["predict"]),
  m("gemini-3-pro-image", ["generateContent"]),
  m("gemini-3.1-flash-image", ["generateContent"]),
  m("veo-3.1-generate-preview", ["predictLongRunning"]),
  m("text-embedding-004", ["embedContent"]),
];

test("computeDefaults picks sensible, task-matched models from the live list", () => {
  const d = computeDefaults(MODELS);
  assert.equal(d.image_generate, "imagen-4.0-ultra-generate-001"); // best quality (Imagen Ultra)
  assert.equal(d.image_generate_fast, "imagen-4.0-fast-generate-001"); // cheap draft
  assert.equal(d.image_edit, "gemini-3-pro-image"); // Nano Banana pro for editing
  assert.equal(d.image_edit_fast, "gemini-3.1-flash-image"); // fast edit loop
  assert.equal(d.video, "veo-3.1-generate-preview"); // long-running
  // fast tier must prefer plain flash over flash-lite
  assert.equal(d.fast, "gemini-3.5-flash");
  // reasoning prefers the newest pro text model, even when it's a -preview...
  assert.equal(d.reasoning, "gemini-3.1-pro-preview");
  // ...but never a Deep Research specialist (slow/expensive), despite its high version number.
  assert.notEqual(d.reasoning, "deep-research-pro-preview-12-2025");
});

test("computeDefaults degrades cleanly when a family is absent", () => {
  const textOnly = [m("gemini-3.5-flash", ["generateContent"])];
  const d = computeDefaults(textOnly);
  assert.equal(d.image_generate, undefined); // no image model -> clean undefined (caller errors nicely)
  assert.equal(d.image_edit, undefined);
  assert.equal(d.video, undefined);
  assert.equal(d.fast, "gemini-3.5-flash");
});

test("image_generate prefers Nano Banana Pro when no Imagen Ultra is present", () => {
  const lineup = [
    m("imagen-4.0-generate-001", ["predict"]), // standard Imagen, no "ultra"
    m("gemini-3-pro-image", ["generateContent"]),
    m("gemini-3.1-flash-image", ["generateContent"]),
  ];
  const d = computeDefaults(lineup);
  assert.equal(d.image_generate, "gemini-3-pro-image"); // 4K Nano Banana Pro beats standard Imagen
  assert.equal(d.image_edit, "gemini-3-pro-image");
  assert.equal(d.image_edit_fast, "gemini-3.1-flash-image");
});

test("image capability predicates match the live methods, not guesses", () => {
  assert.equal(modelIsImagen(m("imagen-4.0-ultra-generate-001", ["predict"])), true);
  assert.equal(modelCanEditImages(m("imagen-4.0-ultra-generate-001", ["predict"])), false); // Imagen can't edit
  assert.equal(modelCanEditImages(m("gemini-3-pro-image", ["generateContent"])), true); // Nano Banana can
  assert.equal(modelCanEditImages(m("gemini-3.5-flash", ["generateContent"])), false); // not an image model
});
