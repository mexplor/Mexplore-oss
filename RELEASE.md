# Mexplore 0.3

Mexplore provides filesystem-backed long-term memory for DeepSeek Harness and OpenCode.

## Included packages

| Package | Version |
|---|---|
| `dsh-mexplore` | 0.3.3 |
| `mexplore` (OpenCode) | 0.3.1 |
| `mexplore-ui` | 0.3.3 |

- DSH: direct memory tools or a dedicated memory agent, conversation-history import, and a read-only graph panel.
- OpenCode: temporary graph-only memory sessions, host-model inheritance by default, independent memory-model selection, and a local usage dashboard.
- Shared graph/import sources, shell helpers, tests and committed UI assets.
- DSH memory-agent activation supports both flat and nested host task specifications.

## Installation

See [README.md](README.md) for installation and first-use instructions. Packages install from Git subdirectories; no npm publication is required.

## Limits and permissions

Search is lexical. Large graphs require whole-graph scans, and large attachments are only partly searched. Model choice affects answer quality, latency and cost.

Memory writes can occur outside the workspace. DSH's chat access mode alone does not block them; use `approveWrites` in memory-agent mode when approval is required. OpenCode can ask before manage calls through its permission rules.

Back up existing graphs before importing or applying maintenance. History imports require explicit scope, privacy, mode and start confirmations. Automatic redaction is not a guarantee that all personal information is removed.

## License

MIT, Copyright (c) 2026 Mexplore contributors. Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
