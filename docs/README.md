# Article Lens documentation

Start with the repository [README](../README.md), then use the document that
matches the task:

| Document | Use it for |
|---|---|
| [Architecture](./architecture.md) | Worker structure, APIs, durable workflow, recovery, Manyfold A2A, caching |
| [Agent orchestration](./agent-orchestration.md) | DAG semantics, `GraphConfig`, effort, replicas, presets, token reporting |
| [Operations](./operations.md) | local setup, `/settings`, access control, validation, secrets, deployment |

## Source-of-truth order

When documentation and implementation disagree:

1. Cloudflare bindings and deploy target: `wrangler.toml`.
2. Runtime behavior and API routes: `src/`.
3. Front-end behavior: `public/`.
4. These documents.

Keep historical notes and one-off handovers out of this directory. Update the
relevant reference document when behavior changes.
