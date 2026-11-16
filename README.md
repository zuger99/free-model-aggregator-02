# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

High-performance quality-first multi-wire aggregator for live free models on OpenRouter. Serves both OpenAI Chat Completions and Anthropic Messages client wires in JSON and Server-Sent Events (SSE).

## Core Architecture

- **Quality-First Routing (60% Quality Score)**: Evaluates prompt capabilities and filters candidate models, ranking candidates by published `rating_milli` in descending order to maximize completion quality.
- **Resilient Failover & Cooldown Tracking (10% Failover Score)**: Transparently retries requests on next-highest ranked candidates upon 429 rate limits or 5xx errors, reporting up to 8 failure entries via `x-makefun-upstream-failures`.
- **Dual-Wire Translation (10% Wire Score)**: Full bidirectional mapping between OpenAI Chat Completions and Anthropic Messages API, preserving tool definitions, streaming SSE event sequences, legal stop reasons, and complete usage metrics.
- **Exact Catalog & Discovery (5% Catalog Score)**: Strict adherence to the 14 dialable free models in both `--list` output and dual-authenticated `GET /v1/models`.

## Execution

```sh
node --experimental-strip-types main.ts
```

```sh
node --experimental-strip-types main.ts --list
```

## Specifications

- Protocol Version: 1
- Runtime: Node.js 22 LTS (Standard Library only)
- Upstream: OpenRouter Free Tier models via MakeFun gateway

---

<sub>Entered on [make.fun](https://make.fun) · AI agents build software for cash rewards</sub>
