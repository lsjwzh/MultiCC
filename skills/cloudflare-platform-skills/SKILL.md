---
name: cloudflare-platform-skills
description: Index of official Cloudflare platform skills (Durable Objects, Workers, Agents SDK, wrangler, sandbox SDK) to fetch and read before touching Cloudflare surface. Load when working on Cloudflare Workers, Durable Objects, wrangler, KV, R2, D1, Vectorize, Containers, or the agents SDK.
---

# Cloudflare platform skills index

When a task touches Cloudflare platform surface — Workers, Durable
Objects, wrangler, the sandbox SDK, the Agents SDK — the authoritative
guidance lives in the [`cloudflare/skills`](https://github.com/cloudflare/skills)
repository. This file is an index: open the relevant skill below when
its trigger applies and read its `SKILL.md` before starting work.

If a skill isn't already available in your environment, fetch it from
the URL listed and load it manually. The fallback for everything is
the official Cloudflare documentation at
<https://developers.cloudflare.com>.

Adapted from the `cloudflare` skill in
<https://github.com/cloudflare/computer> (MIT license — see the
`LICENSE` file next to this skill).

## Primary skills

These three cover most Cloudflare platform work:

| Skill | Load when |
|---|---|
| [`durable-objects`](https://github.com/cloudflare/skills/tree/main/skills/durable-objects) | Writing or reviewing Durable Object code: RPC methods, SQLite storage, alarms, WebSockets, hibernation. |
| [`workers-best-practices`](https://github.com/cloudflare/skills/tree/main/skills/workers-best-practices) | Writing or reviewing Worker code: streaming, floating promises, global state, bindings, secrets, observability, `wrangler.jsonc` configuration. |
| [`agents-sdk`](https://github.com/cloudflare/skills/tree/main/skills/agents-sdk) | Building on the Cloudflare Agents SDK: stateful agents, Workflows integration, scheduled tasks, MCP servers. |

## Other skills

Load these when their trigger applies:

| Skill | Load when |
|---|---|
| [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) | Running `wrangler` commands: deploy, dev, secrets, bindings for KV, R2, D1, Vectorize, Hyperdrive, Queues, Workflows, Containers. |
| [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) | General Cloudflare platform questions outside the more specific skills above — KV, R2, D1, Vectorize, networking, security, infrastructure-as-code. |
| [`sandbox-sdk`](https://github.com/cloudflare/skills/tree/main/skills/sandbox-sdk) | Building or reviewing sandboxed-execution code paths, e.g. containers running `computerd` for `@cloudflare/computer`. |
| [`web-perf`](https://github.com/cloudflare/skills/tree/main/skills/web-perf) | Profiling page load, Core Web Vitals, or render-blocking issues. |
| [`cloudflare-email-service`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare-email-service) | Working with Cloudflare Email Routing or the Email Workers binding. |

## How to use this index

- **Storage, RPC, alarms in a DO** → `durable-objects` (plus
  `workers-best-practices` for the surrounding Worker glue).
- **Deploys, secrets, bindings** → `wrangler` before running `wrangler`
  commands or editing `wrangler.jsonc`.
- **Building on `@cloudflare/computer`** → load the companion
  `cloudflare-computer` skill alongside `durable-objects`.
- **Crossing two surfaces** (e.g. a Worker that wakes a Durable Object
  that talks to a container) → load both relevant skills before
  starting. The skills are small; loading two is cheaper than fixing an
  architectural mistake.
