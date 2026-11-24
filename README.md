# `@unblocklabs/decisions`

Provider-agnostic TypeScript client for **Decision Models** (`noul`, `choice`, `score`) and **Extraction Models** (`text`, `number`, `date`, `estimate`, `list`), compatible with OpenRouter / Codex LB `/v1/decisions` & `/v1/extractions` as well as legacy `/v1/systemone`.

## Install

```sh
npm install @unblocklabs/decisions
```

## Quick Start

### Decisions (`noul`, `choice`, `score`)

```ts
import { createDecisionClient, noul, choice, score } from "@unblocklabs/decisions";

const client = createDecisionClient({
  endpoint: "https://codex.unblocklabs.ai/v1/decisions",
  model: "liquid/d1.2-ultra",
  apiKeyFile: "/home/you/.openclaw/secrets/unblock-memory-decisions.env",
  timeoutMs: 1500,
});

const result = await client.decide(
  { request: "Where is our staging cluster?", excerpt: "Atlas staging runs in eu-west-1." },
  {
    relevant: noul("Does `excerpt` directly answer `request`?"),
    category: choice("What kind of fact is this?", {
      infrastructure: "Hosting, region, or deployment details.",
      other: "Anything else.",
    }),
    quality: score("How complete is the evidence?", [
      "None",
      "Marginal",
      "Partial",
      "Direct",
    ]),
  },
);

console.log(result.answers.relevant.noul);        // number in [0, 1]
console.log(result.answers.category.choice);      // "infrastructure" | "other"
console.log(result.answers.quality.score);        // number in [0, 3]
```

### Extractions (`text`, `number`, `date`, `estimate`, `list`)

When `endpoint` ends with `/decisions`, `extractionsEndpoint` is automatically derived as `/extractions` (or set `extractionsEndpoint` explicitly):

```ts
import { createDecisionClient, textField, numberField, dateField } from "@unblocklabs/decisions";

const client = createDecisionClient({
  endpoint: "https://codex.unblocklabs.ai/v1/decisions",
  model: "liquid/d1.2-ultra",
  apiKey: process.env.CODEX_LB_API_KEY,
});

const extracted = await client.extract(
  "Invoice total is $3,850 due by 2026-11-28 from Acme Corp.",
  {
    vendor: textField({ null_threshold: 0.5 }),
    total: numberField({ decimals: 2, null_threshold: 0.5 }),
    due_date: dateField({ null_threshold: 0.5 }),
  },
);

console.log(extracted.answers.total.value); // 3850 | null
```

## Security & Reliability Guarantees

- **HTTPS-only transport** (loopback HTTP `localhost` / `127.0.0.1` / `[::1]` allowed for local tests), no credentials/query/fragment/whitespace in endpoints, and `redirect: "error"`.
- **Origin-isolated credentials:** Ambient `process.env` lookup is scoped strictly by exact HTTPS origin (`https://codex.unblocklabs.ai` → `CODEX_LB_API_KEY`, `https://api.typesafe.ai` → `TYPESAFE_API_KEY`, custom origins → no ambient fallback unless explicitly configured via `ambientEnvKeys`).
- **Strict response validation:** Declared keys only (no unknown probability keys inflating rounding tolerance), dated-snapshot model matching, option-count-scaled 2-decimal rounding tolerance, and sanitized `DecisionError` messages that never leak tokens or raw provider bodies.
