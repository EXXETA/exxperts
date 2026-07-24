# Exxperts documentation

This is the canonical index for documentation in this repository. Treat this page as the active docs surface.

## Start here

- [Quickstart](quickstart.md): install, connect your AI, first room, first memory; plus backup/move and uninstall. All platforms.
- [How Exxperts works](how-exxperts-works.md): what the product is and how the pieces fit; the right orientation read.
- [Memory](memory.md): how room memory (checkpoint → Learn → Review Memory) and CLI memory work, what is stored where, and who approves it.
- [Provider setup and AI profiles](provider-setup.md): connecting a provider: in-app sign-in for Claude / ChatGPT Plus/Pro, and the OpenAI-compatible gateway path.
- [Web search](web-search.md): built-in DuckDuckGo backend and its limits; SearXNG setup for heavy use or blocked networks, keeping it running, and configuration reference.
- [Security](../SECURITY.md): threat model, supported deployments, release integrity, and vulnerability reporting.
- [MCP client support](mcp.md): MCP connectors: transports, config locations, and commands.

## Current command and storage truth

Preferred commands today:

| Context | Command |
| --- | --- |
| Desktop app | none: open the app; it runs its own server and window |
| Repo/dev web app | `./scripts/exxperts-web` |
| Repo/dev CLI/TUI | `./scripts/exxperts-cli` |
| Packaged web app | `exxperts web` |
| Packaged CLI/TUI | `exxperts cli` |
| Packaged picker | bare `exxperts` (choose web app or CLI) |

Current storage roots:

| Root | Purpose |
| --- | --- |
| `~/.exxperts/app/` | Product/app state: persistent rooms, conversations, feature config, usage, artifacts, and related app data. |
| `~/.exxperts/agent/` | Embedded runtime provider/auth/model/session state. |

If another active doc conflicts with this table, treat this table as the newer source until that doc is refreshed. Archived docs may intentionally contain stale commands, storage roots, provider assumptions, or links.

## Developer and packaging docs

- [Developer guide](developer.md): primary developer guide with current command and storage-root guidance.
- [Operations](operations.md): support/troubleshooting notes with current repo/dev command and storage-root guidance.
- [Local npm packaging](packaging-local.md): package and tarball validation.
- [Release pipeline](release-pipeline.md): cutting tagged releases with prebuilt per-OS archives, the vendored Node pin, and the currency check.
- [Architecture](architecture.md): small landing placeholder pointing at the current guides.
- [L1a constitution upgrade](l1a-constitution-upgrade.md): how to upgrade existing rooms to a newer constitution template after pulling an update.

A current public extension/developer-extension guide does not exist yet. Historical extension notes were archived and should not be treated as current launcher, storage, or provider guidance.
