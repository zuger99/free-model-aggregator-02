# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/zuger99/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/zuger99/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

High-performance quality-first multi-wire aggregator for live free models on OpenRouter. Serves both OpenAI Chat Completions and Anthropic Messages client wires in JSON and Server-Sent Events (SSE).

## Features

- **Quality-First Routing**: Dynamically ranks and routes all candidate free models meeting prompt requirements by published `rating_milli` in descending order.
- **Multi-Wire Translation**: Full bidirectional translation between Anthropic Messages API and OpenAI Chat Completions (tools, JSON mode, streaming events, usage).
- **Resilient Failover**: Automatic retry across ranked candidate models upon upstream 4xx/5xx or rate limits, tracking failures via `x-makefun-upstream-failures`.
- **Exact Catalog & Discovery**: Full compliance with the 14 free model catalog across `--list` and dual-header `GET /v1/models`.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=3jn7ja74&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
