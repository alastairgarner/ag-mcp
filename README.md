# Markdown Brain

A shared Markdown second brain for AI agents, exposed through one MCP server.

## Intent

Plain Markdown files are authoritative. Reuse [QMD](https://github.com/tobi/qmd) for keyword and semantic search rather than building a search engine. Combine retrieval and safe file editing behind one endpoint accessible to agents on a Tailscale network.

Target deployment: Docker on a Raspberry Pi; assess ARM64 support and model resource requirements before promising local semantic-search performance. A stronger tailnet host is an option, not a settled decision.

## Proposed first slice

- Discover allowed directories and list notes.
- Search via QMD; return compact excerpts and references.
- Read authoritative files or sections directly from disk.
- Create Markdown notes without overwriting existing files.
- Edit using unique exact old-text/new-text replacements and expected content hashes.
- Enforce allowed-root boundaries, including symlink/traversal protection.
- Serialize writes per file, verify hashes inside that critical section, and use safe atomic replacement.
- Refresh the derived search index after writes and expose pending/stale indexing explicitly.
- Offer stdio for local development and Streamable HTTP for shared access.

Do not expose an unauthenticated write endpoint beyond a deliberately restricted local development environment. Tailscale is private connectivity, not per-agent attribution or permissions.

## Not settled

Language/framework, exact QMD SDK integration, authentication design, refresh strategy, and deployment topology. Verify current QMD SDK/CLI capabilities and licensing before implementation. The existing discussion is direction, not an approved detailed specification.

## Out of scope initially

Kanban UI, task orchestration, repository synchronisation, notifications, and a bespoke vector database/search engine. Tasks and specs can initially be ordinary Markdown conventions.

## Implementation handoff

Inspect upstream QMD documentation and package APIs first. Prefer a thin adapter over QMD internals or a second search implementation. Build a small tested vertical slice, document assumptions and setup, and report material decisions needing user input. Use fixtures, not the user's actual vault; do not deploy, publish, create remote repositories, or change Tailscale configuration without permission.
