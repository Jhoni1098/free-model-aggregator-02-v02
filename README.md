# free-model-aggregator-02 v02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/Jhoni1098/free-model-aggregator-02-v02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/Jhoni1098/free-model-aggregator-02-v02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

The best live free-model aggregator: one server that speaks the OpenAI Chat Completions API and the Anthropic Messages API (JSON and SSE) and answers every request with a REAL completion from a live free OpenRouter model, dialled through the grader's gateway on the entrant's pushed key. It ranks the fourteen free models by the brief's quality rating less a budget-spreading discount — 60 milli per attempt already spent on that model (capped at 180 after 3 attempts), plus 25 after two refusals in a row — so traffic rotates to fresh models instead of hammering the top-rated one until it rate-limits, fails over to the next-best free model when a provider refuses (429 / 402 / 5xx), reports recovered refusals in the `x-makefun-upstream-failures` header, and returns the answer in the wire the client used with the dialled model's id on every answer and every streamed chunk. `node main.ts --list` prints the catalog as one JSON document.

## Run it

```sh
node main.ts
```

`node main.ts --list` prints the catalog as one JSON document and exits 0 without starting the server.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nd0791d4&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
