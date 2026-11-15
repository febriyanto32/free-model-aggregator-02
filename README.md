[![make.fun](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/febriyanto32/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/febriyanto32/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02)

# Free Model Aggregator

One server that puts OpenRouter's free models behind a single endpoint. Point
any OpenAI or Anthropic client at it and every answer is a live completion
from a real free model, dialled through the make.fun gateway on the key
pushed for this entry.

Built for the make.fun bounty [The best live free-model aggregator](https://make.fun/bounty/free-model-aggregator-02) ($500 USDC).

## What it does

- Serves `POST /v1/chat/completions` (OpenAI wire) and `POST /v1/messages`
  (Anthropic wire), in JSON and in server-sent events.
- Serves `GET /v1/models` in the wire its auth header names: an
  `Authorization: Bearer` request gets the OpenAI model list, an `x-api-key`
  request gets the Anthropic one.
- Answers each prompt with a real completion from one of the fourteen free
  OpenRouter models in the brief, chosen by the house quality rating: the
  best model that can serve the prompt. JSON-mode prompts ride a model that
  supports JSON mode; the tools prompt rides a model that supports tools.
- Every model call goes through the gateway's Chat Completions route
  (`POST $OPENAI_BASE_URL/chat/completions`); an Anthropic-shaped request is
  translated into a Chat Completions body first and the answer translated
  back. The gateway's Messages route is never used for these ids.
- A refusal is real: a provider 429 or 5xx is retried once on the same
  model, then the server fails over to the next-best eligible model. A
  model that refuses twice in a row is treated as spent for the trial.
  Recovered refusals are reported in the `x-makefun-upstream-failures`
  header. The reply is always the live model's own completion, with its
  text whole and its usage and stop reason carried back in the client's
  own wire. Nothing is ever invented.
- Deterministic: no wall clock, no unseeded randomness. Every choice is a
  function of the brief, the request and the gateway's answers, so a replay
  leaves the same state export.

## The free models

Fourteen models, all priced $0, ranked by the house rating in the brief:

| Model | Rating | JSON | Tools |
| --- | --- | --- | --- |
| thinkingmachines/inkling-2-small | 1475 | no | yes |
| nvidia/nemotron-3.5-super-vl | 1303 | yes | yes |
| nvidia/nemotron-3-ultra-550b-a55b | 1285 | no | yes |
| nvidia/nemotron-3.5-lightning | 1221 | no | yes |
| google/gemma-4-31b-it | 1210 | yes | yes |
| cohere/north-mini-code | 1200 | no | yes |
| baidu/ernie-5.5-flash-preview | 1150 | yes | yes |
| dots-studio/dots-3-note-preview | 1150 | yes | yes |
| google/gemma-4-26b-a4b-it | 1150 | yes | yes |
| inclusionai/ling-3.2-flash | 1150 | yes | yes |
| liquid/lfm-3-1.7b | 1150 | yes | yes |
| particle-ai/particle-1 | 1150 | yes | yes |
| recursive/flint-v1.0 | 1150 | yes | yes |
| nvidia/nemotron-3-nano-omni-30b-a3b-reasoning | 1150 | no | yes |

Each is dialled as `openrouter/<id>:free`. The best overall model
(Inkling 2 Small, 1475) does not support JSON mode, so JSON-mode prompts
are served by the best JSON-capable model (Nemotron 3.5 Super VL, 1303).

## Run it

Requires Node 22. Standard library only — nothing to install.

```sh
node main.ts --list    # print the catalog document and exit
node main.ts           # serve; registers with $MAKEFUN_ENV_URL and exits
                       # 0 when the env's /work says done
```

In a trial the sandbox sets `MAKEFUN_ENV_URL`, `MAKEFUN_PROMPT_FILE`,
`MAKEFUN_TRIAL_SEED`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. The server picks a free port,
registers it with the env together with its catalog, serves the six
prompts, polls `GET $MAKEFUN_ENV_URL/work` and exits 0 when it says done.
Each gateway call is bounded at 25 seconds so a hung provider cannot eat
the trial.

## The key

Completions come from OpenRouter's free models on an OpenRouter key pushed
to the competition (`makefun secrets push free-model-aggregator-02
--env-file .env` with `OPENROUTER_API_KEY=<key>`, or Profile > API keys).
The key never enters this repository or the server's code: the gateway
swaps the trial's dummy key for it. Without a pushed key every model call
is refused HTTP 401 and no prompt is served.

## License

MIT — see [LICENSE](LICENSE).
