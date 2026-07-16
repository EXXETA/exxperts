# Changelog

User-visible changes per release. Historical private/internal development notes are not part of this public-facing changelog.

## Unreleased

- Skills: the library now also lists skills from the cross-tool `~/.agents/skills` directory (the shared location used by other agent tools), read-only and including symlinked skills. Enabling one in a room still walks through the same review screen, and an edit made by another tool trips re-review.
- Rooms: quick checkpoints can be set to stop at the review gate per room (Settings, Memory pane) instead of applying automatically. Contributed by [@blue-az](https://github.com/blue-az) in [#2](https://github.com/EXXETA/exxperts/pull/2).
- Install: `exxperts --version` reports the product version, and the installers print it when they finish, so "did the update land?" is answerable.
- Windows installer: when Git is installed but missing from PATH (installed without the "Git from the command line" option), the installer finds and uses it instead of asking for a reinstall.
- Installer messages now cover no-admin installs of Git and Node and corporate TLS-inspection networks (`NODE_EXTRA_CA_CERTS`, `git http.sslCAInfo`).
- `npm run doctor` finds Git Bash for per-user Git installs (it previously reported it missing on machines where the install itself succeeded).
- `exxperts doctor` now works on every install type (prebuilt archive, npm-global, or repo clone), detecting which one it is and printing the fix for anything missing; the optional layers get one-command setup with `exxperts setup chromium` (headless Chromium) and `exxperts setup search` (local web search).

## 0.6.7 (2026-07-13)

- Skills: a Skills page in the web app to write a skill, upload .md/.zip/.skill files, or import from a repo, with review before accepting. Skills are enabled per room; rooms read them via a `read_skill` tool.
- Consult: a room can ask another room a question via @-mention in chat; the consulted room answers read-only from its own memory and context.
- Rooms can run delegated tasks shown as task cards in chat, and produce artifacts viewable in a sandboxed artifacts viewer.
- MCP: connectors whose providers do not support dynamic client registration (HubSpot, Gmail, Google Drive) can be added with your own OAuth app credentials via the "Custom OAuth client" section of the add-connector form; directory cards for those providers open the form prefilled.
- npm 12 installs work out of the box (`allowScripts` approvals in `package.json` plus a committed `.npmrc`); on npm 11.11+ a harmless "Unknown project config" line may print.
- Linux: the workspace folder path is typeable and a zenity-based native folder picker is available.
- CONTRIBUTING.md added; Windows clone guidance in the README.
- Hardened security headers on the web server.
