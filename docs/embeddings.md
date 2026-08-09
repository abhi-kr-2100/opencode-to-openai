# Executive Decision: Local Embeddings Support (`/v1/embeddings`)

**Status:** Proposed
**Author:** (to fill)
**Date:** 2026-08-09
**Decision requested:** Approve adding a `/v1/embeddings` endpoint backed by a locally running embedding model.

---

## 1. Summary

`opencode-to-openai` is an OpenAI v1-compatible API proxy that currently exposes
`/v1/chat/completions` and `/v1/models`, routing chat traffic to an OpenCode server.
OpenCode itself has no embeddings API (the `@opencode-ai/sdk` exposes session, model,
and agent endpoints only), so embeddings cannot be proxied to it.

We propose to add `/v1/embeddings` backed by a **small embedding model running
in-process** via Hugging Face Transformers.js (ONNX Runtime). This makes the proxy a
drop-in local replacement for OpenAI embedding APIs (RAG pipelines, vector stores,
semantic search tools) with **no external API calls and no GPU required**.

**Recommendation:** Adopt **`bge-small-en-v1.5`** (BAAI, English-only, 33M parameters,
384 dims, ~130 MB full precision / ~40 MB quantized) as the default model.

---

## 2. Solution Description

A new `POST /v1/embeddings` route that:

1. Accepts the standard OpenAI request shape:
   - `input`: a string or an array of strings (batched in one forward pass),
   - `model`: the configured embedding model id (validated; per-request model
     override is out of scope initially),
   - optional `encoding_format: "float" | "base64"` (accept both, implement both —
     base64 is trivially derived from the float vector).
2. Embeds locally with Transformers.js `feature-extraction` pipeline, `mean` pooling
   and L2 normalization (matching `text-embedding-3` semantics).
3. Responds with the OpenAI contract:
   ```json
   {
     "object": "list",
     "data": [
       { "object": "embedding", "index": 0, "embedding": [0.012, -0.034, ...] }
     ],
     "model": "<model id>",
     "usage": { "prompt_tokens": 8, "total_tokens": 8 }
   }
   ```
4. Streams nothing (embeddings are always one-shot responses), but stays under the
   same router/error architecture so validation errors, 404s, and 405s behave
   identically to the existing endpoints.

The embedding model is **lazy-loaded on first request** and cached as a process-wide
singleton (optionally preloaded at startup — see `EMBEDDINGS_PRELOAD`).

What is *not* in scope:

- Proxying embeddings to OpenCode (impossible — OpenCode exposes no embedding API).
- GPU/WebGPU acceleration (CPU ONNX is sufficient for batch ≤ 100 short texts).
- Multilingual models (explicitly a small **English-only** model).

---

## 3. Implementation Requirements

To implement the solution we need to:

| Capability | How it is fulfilled |
|---|---|
| In-process ONNX inference in Bun | `@huggingface/transformers` (v3+ supports Node/Bun via `onnxruntime-node`; official Bun example exists) |
| Model artifacts | Pre-converted ONNX weights on Hugging Face Hub (`Xenova/bge-small-en-v1.5`, ...) |
| First-run model download | HF Hub download on demand; cached under `~/.cache/huggingface` (~133 MB disk) |
| Request schema + response | Zod schema + JSON types, mirroring existing `src/openai/chat-completions.ts` patterns |
| Route registration | One `router.register(...)` call in `src/app.ts` |
| Token accounting | Token counts approximated from the pipeline's tokenizer (no billing here; informational only) |
| Preload/warm-up | Env config (`EMBEDDINGS_MODEL`, `EMBEDDINGS_PRELOAD`) following `src/config.ts` conventions |

No GPU, no Python, no external embedding service.

---

## 4. Embedding Model Comparison

All candidates are ≈5-10 MB-130 MB, single-digit-parameter models, and all ship
official-onnx weights usable by Transformers.js. Numbers are MTEB English task
averages / BEIR retrieval (NDCG@10) where published.

| Model | Params | Dims | Max tokens | Size (fp32 / q8) | English | MTEB avg (EN) | Retrieval (NDCG@10 h) | ONNX ready (Hub) | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `sentence-transformers/all-MiniLM-L6-v2` | 22.7M | 384 | 256 | ~90 MB / ~24 MB | Mostly | ~56.3 | ~42 | `Xenova/all-MiniLM-L6-v2` ✓ | The classic smallest; baseline quality; MIT |
| `BAAI/bge-small-en-v1.5` | 33.4M | 384 | 512 | ~130 MB / ~33 MB | Yes | ~60 | ~51.7 | `Xenova/bge-small-en-v1.5` ✓ | Superior English retrieval relative to cost; standard for local RAG; MIT |
| `thenlper/gte-small` | 33.4M | 384 | 512 | ~130 MB / ~33 MB | Yes (plug multilingual) | ~61.4 | ~49.5 | `Xenova/gte-small` ✓ | Slightly better overall MTEB; not English-only (multilingual corpus) |
| `Snowflake/snowflake-arctic-embed-s` | 33M | 384 | 512 | ~130 MB / ~33 MB | Yes | ~52.0* | ~51.98 | `Snowflake/...onnx` ✓ | Best-in-class retrieval at this size; based on e5-small |
| `mixedbread-ai/mxbai-embed-xsmall-v1` | 25M | 384 | 512 | ~100 MB / ~33 MB | Yes | ~61–62 | ~50.3 | ✓ (used in official Transformers.js docs) | Official TF.js example embedder; Matryoshka (can truncate dims) |
| `BAAI/bge-base-en-v1.5` | 109M | 768 | 512 | ~440 MB / ~110 MB | — | — | ~54.3 | `Xenova/bge-base-en-v1.5` ✓ | 3× heavier; only if quality demands it later |

*MTEB retrieval NDCG@10 per publisher-reported BEIR/MTEB numbers; exact numbers
vary slightly across benchmark versions.

### Recommendation: `Xenova/bge-small-en-v1.5`

- **English-only** (meets the stated requirement precisely).
- **Best English retrieval quality per byte** at this size (≈51.7 retrieval vs ≈42
  for MiniLM; effectively double-efficiency).
- 384 dims — the de facto standard dim count; most OpenAI-compatible tools /
  vector stores store 384-dim vectors without friction.
- Pre-converted, quantized ONNX available (`Xenova/bge-small-en-v1.5`), so the
  first-run download is ~33 MB and inference is a few ms per short text on CPU.
- MIT license (BAAI) — no licensing burden on this CC BY-NC-ND project.

**Fallback:** If benchmarks over our own corpus prefer raw speed, swap the id to
`Xenova/all-MiniLM-L6-v2` — a one-line env change.

---

## 5. Dependencies

**Runtime (new):**
| Package | Purpose | Size impact |
|---|---|---|
| `@huggingface/transformers` | ONNX feature-extraction pipelines (official HF package; v3+ supports Bun) | ~15 MB npm + ~33-130 MB model cache |

No new dev-dependencies; existing tooling (bun test, oxlint, oxfmt, tsc, bun.lock) unchanged.

**Runtime disk:** one-time ~133 MB for the bge-small-en-v1.5 model cache (unless
`EMBEDDINGS_MODEL` points elsewhere).

---

## 6. Implementation Plan

Phase 0 — **Foundation (core PR)**
- Add `@huggingface/transformers` to `package.json`.
- `src/openai/embeddings.ts`: Zod schema (`input: string | string[]`, `model`,
  optional `encoding_format`), response types; mirror existing OpenAI-typed modules.
- `src/services/embeddings.ts`: `EmbeddingsService` interface + in-process
  implementation:
  - Lazy singleton `pipeline("feature-extraction", MODEL, { dtype: "q8" })`;
  - `mean` pooling + `normalize: true`; array batch support (one forward call);
  - token counts via the pipeline tokenizer for `usage`.
- `src/routes/v1/embeddings.ts`: handler (same shape as
  `src/routes/v1/chat/completions.ts` — parse, validate, service.create, JSON 200).
- `src/app.ts`: `router.register("POST", "/v1/embeddings", ...)`.
- `src/config.ts`: `EMBEDDINGS_MODEL` (default `Xenova/bge-small-en-v1.5`),
  `EMBEDDINGS_PRELOAD` (default `false`).
- Unit tests: schema validation, service with a stubbed pipeline, route wiring.
  (No e2e inference tests in CI — downloads and CPU time are not stable in CI.)

Phase 1 — Validation
1. Manual smoke test: start server, `POST /v1/embeddings` with 1 and 10 strings,
   confirm shape and that cosine similarity ranks the expected pairs.
2. Measure latency/memory on a representative corpus; record in this doc.

Phase 2 — Hardening (follow-ups)
- Request abort handling (check `request.signal` during inference).
- `encoding_format: "base64"` + `dimensions` (Matryoshka truncation) support.
- Model warm-up at startup when `EMBEDDINGS_PRELOAD=1` so first request is fast.
- Optional: expose embeddings in `/v1/models` for tools that call `models.list()`
  first.

---

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| First request is slow (model download + warm-up) | 1-5 s cold start | `EMBEDDINGS_PRELOAD=1`; document it; model ~33 MB download |
| CPU inference throughput | Lower than GPU | Mutation batch single-call; Q8 quantization; per-request ~ms for short texts |
| HF Hub unavailable (offline env) | Service 500 on first request | Cache-friendly: model cache persists; document `HF_HOME` override |
| Quality mismatch vs. `text-embedding-3-small` | Embedding drift for consumers | No perfect stand-in; bge-small-en and arctic-embed-s are the closest per size; allow model swap via env |
| `bun --compile` single-binary | Broken (onsite lib loading issue) | Out of scope — project runs `bun src/main.ts`, not compiled binaries; documented |
| License smell (CC BY-NC-ND on this project) | Legal surface | Model MIT-licensed (bge, arctic) avoids contamination; this doc is administrative, not applied code |

---

## 8. Open Questions (defaults chosen in this doc)

1. Inputs longer than 512 tokens are truncated with a `warn` log (typical for 384-dim
   models; alternative is rejecting with a 400). Default: truncate.
2. Expose embeddings in `/v1/models`? Default: no (Phase 2).
3. `dtype: "q8"` (33 MB, tiny quality drop) vs `"fp32"` (130 MB, max quality)?
   Default: `q8`.

---

*This document accompanies an implementation decision; the architecture mirrors the
existing route/service modularity of this repo (`src/app.ts`,
`src/services/opencode/service.ts`), so add/revert risk is minimal.*