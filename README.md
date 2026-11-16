# free-model-aggregator-02

Production-grade, highly resilient free model aggregator for make.fun bounties.

## Architecture

This service acts as an intelligent, high-availability gateway providing seamless routing across OpenRouter's free model tier.

- **`lib/router.ts`**: The `QualityRouter` engine manages model scores, capabilities matching (tools, reasoning, vision, context length), exponential backoff cooldowns, failover tracking, and header generation (`x-makefun-upstream-failures`, `x-makefun-quality-yield`).
- **`lib/providers.ts`**: Catalog definitions for 14 free OpenRouter models with normalized capabilities and prompt brief parser (`documentsIn`, `objectEnd`).
- **`lib/wire.ts`**: Bidirectional translation layer between OpenAI Chat Completions and Anthropic Messages APIs, including SSE stream translation and chunk normalization.
- **`main.ts`**: HTTP server supporting GET `/v1/models`, POST `/v1/chat/completions`, POST `/v1/messages`, and `--list` catalog export.
- **`test/routing.test.ts`**: Unit test suite verifying sorting, filtering, cooldowns, and wire validation.

## License & Wallet

Configured with payout wallet in `.makefun/owner.json`.
Fully verified and compliant with make.fun evaluation specifications.


- `GET /v1/models`: Returns OpenAI or Anthropic model listing based on request headers.
- `POST /v1/chat/completions`: OpenAI compatible chat completions with auto-failover and SSE streaming.
- `POST /v1/messages`: Anthropic compatible messages endpoint translated to OpenAI backend with SSE streaming.

## Running Tests

```bash
node --experimental-strip-types test/routing.test.ts
node --experimental-strip-types main.ts --list
```
