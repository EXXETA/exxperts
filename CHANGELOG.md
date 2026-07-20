# Changelog

User-visible changes per release. Historical private/internal development notes are not part of this public-facing changelog.

## 0.6.8 (2026-07-20)

- Artifacts: the in-room rail lists everything the room's specialists produced, across sessions; clicking a row opens it in the right pane (clicking again closes it) with one-click actions: Add to conversation, Save to workspace, Revise, Open in new tab.
- Artifacts: delegated tasks keep running when you leave the room, refresh, or close the tab. Coming back mid-run picks up the live progress seamlessly, and anything that finished while you were away is announced and waiting in the panel.
- Artifacts: the panel is the room's full history: it survives Memento (the fresh-conversation button) and checkpoints, rows are named after the file they produced, and status reads at a glance: a blue pulse while working, a green dot on results you haven't opened yet, "didn't finish" on errors. A quiet notification appears when a task finishes while you're chatting.
- Artifacts: the task card above the message box is gone. A running task lives in the panel instead; click it to watch live progress (with a Stop button), and finished results open in the right-pane viewer, which now also shows the specialist's notes under Details.
- Artifacts: saving a result under a name that already exists in the workspace asks what to do (Replace, Keep both with an auto-rename, or Cancel), and the room is told about saved files so it can refer to them.
- Artifacts: every settled row in the panel can be removed from the list (hover it, click the ✕). Removing never deletes files, and the confirmation toast offers Undo. The ✕ no longer closes the viewer; clicking the row again, the viewer's own close, or Escape do that.
- Artifacts: rail rows read cleaner. The file-type badge shows the full extension (HTML, no longer truncated to HTM), and the subline stops repeating the type beside it, carrying just the time.
- Storage: once delegated-task storage passes 500 MB, the app proposes deleting the oldest unused task folders, always with your approval and never anything a conversation still references.
- Memory: every remembered session shows a provenance receipt stating when it passed the review gate, and can open the stored conversation it came from. The memory page gains a history timeline whose Learn and Review entries show exactly what changed, and the growth chart is clickable time travel: pick a day and read the whole memory as it was then.
- Memory: the Recent sessions list dates each memory honestly. Entries whose exact save moment the review gate recorded show real relative times; entries known only by date say today, yesterday, or days, instead of an hour figure invented from midnight.
- Chat: a copy control on each message. It sits quietly under every AI reply and appears when you hover your own messages; clicking it copies the message and shows a checkmark.
- Chat: the message box now grows with your draft, up to 40% of the window, then scrolls inside itself. It was stuck at two lines: the auto-grow shipped in June but a CSS flex rule silently cancelled the height it computed.
- Security: the web server now requires a client auth token on API and WebSocket requests. The token is minted on first run into `~/.exxperts/app/auth-token`; `exxperts web` opens the browser through a sign-in link that stores it as an HttpOnly cookie, so nothing changes in daily use. Programmatic callers send it in the `X-Exxperts-Auth` header; delete the file and restart to rotate it.
- Security: requests arriving through a reverse proxy (any `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, or `Via` header) are refused with an explicit error instead of being treated as local; a new `SECURITY.md` states the threat model (single user, own machine, loopback only), the supported deployments, release integrity for the prebuilt archives, and how to report vulnerabilities.
- Skills: the library now also lists skills from the cross-tool `~/.agents/skills` directory (the shared location used by other agent tools), read-only and including symlinked skills. Enabling one in a room still walks through the same review screen, and an edit made by another tool trips re-review.
- Rooms: room settings become a left-rail dialog (Workspace, Memory, Skills, Scheduled tasks, Session), with one-step room delete.
- Rooms: quick checkpoints can be set to stop at the review gate per room (Settings, Memory pane) instead of applying automatically, and rooms that never chose now default to review-first. Contributed by [@blue-az](https://github.com/blue-az) in [#2](https://github.com/EXXETA/exxperts/pull/2).
- Dependencies: every security advisory flagged across the app and runtime lockfiles is resolved (29 alerts to zero).
- Install: official one-line installers for macOS (Apple Silicon), Windows x64, and Linux x64 now download a prebuilt, checksum-verified archive with a bundled runtime (no Git, Node, or npm needed), updating in place and falling back to building from source anywhere else.
- Install: the macOS/Linux one-liner finishes the job on machines where `~/.local/bin` was not on the PATH: the installer appends the export line to your shell startup file itself (exactly once, respecting an existing entry; opt out with `EXXPERTS_NO_MODIFY_PATH=1`), and the closing message says precisely what remains, open a new terminal, instead of claiming "all set" beside a command that would not resolve yet.
- Install: `exxperts --version` reports the product version, and the installers print it when they finish, so "did the update land?" is answerable.
- Install: when Git is installed on Windows but missing from PATH (installed without the "Git from the command line" option), the installer finds and uses it instead of asking for a reinstall, and installer messages cover no-admin installs of Git and Node and corporate TLS-inspection networks (`NODE_EXTRA_CA_CERTS`, `git http.sslCAInfo`).
- Doctor: `exxperts doctor` now works on every install type (prebuilt archive, npm-global, or repo clone), detecting which one it is and printing the fix for anything missing; the optional layers get one-command setup with `exxperts setup chromium` (headless Chromium) and `exxperts setup search` (local web search). `npm run doctor` finds Git Bash for per-user Git installs.

## 0.6.7 (2026-07-13)

- Skills: a Skills page in the web app to write a skill, upload .md/.zip/.skill files, or import from a repo, with review before accepting. Skills are enabled per room; rooms read them via a `read_skill` tool.
- Consult: a room can ask another room a question via @-mention in chat; the consulted room answers read-only from its own memory and context.
- Rooms can run delegated tasks shown as task cards in chat, and produce artifacts viewable in a sandboxed artifacts viewer.
- MCP: connectors whose providers do not support dynamic client registration (HubSpot, Gmail, Google Drive) can be added with your own OAuth app credentials via the "Custom OAuth client" section of the add-connector form; directory cards for those providers open the form prefilled.
- npm 12 installs work out of the box (`allowScripts` approvals in `package.json` plus a committed `.npmrc`); on npm 11.11+ a harmless "Unknown project config" line may print.
- Linux: the workspace folder path is typeable and a zenity-based native folder picker is available.
- CONTRIBUTING.md added; Windows clone guidance in the README.
- Hardened security headers on the web server.
