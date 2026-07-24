# Changelog

User-visible changes per release. Historical private/internal development notes are not part of this public-facing changelog.

## 0.7.0 (2026-07-24)

- Desktop app: exxperts is now a real app. A self-contained macOS app (Apple Silicon, dmg or zip) and Windows app (x64, zip or one-click installer) carry their own server and runtime: download, open, sign in. No terminal, Git, Node, or npm involved. It uses the same `~/.exxperts` data as a terminal install, so both doors open the same rooms.
- Desktop app: lives in the menu bar / system tray. Closing the window keeps your rooms and scheduled work running; the tray icon shows a badge when a task finishes while the window is hidden, and Quit from the tray shuts everything down cleanly (a crash watchdog restarts the embedded server once if it ever dies unexpectedly).
- Desktop app: native notifications when a task finishes in the background, click to jump back in. On macOS, notification banners require a signed build (signing is in progress); until then the tray badge is the reliable signal. Windows toasts work.
- Desktop app: Open at Login (with a hidden start: boots into the tray, no window), remembered window size and position, right-click context menus with spellcheck suggestions, an About panel stating both app and server versions, and a Health Check window with the full doctor report.
- Desktop app: Check for Updates lives in the app menu and tray. Nothing polls in the background: the update check and the Health Check contact the GitHub releases feed only when you use them.
- Reconnect: a room tab that loses its server (laptop sleep, server restart, crash) now reconnects by itself and rebuilds the conversation, instead of sitting offline until a manual reload. This closes the longest-standing rough edge of 0.6.8.
- Web search: built in via DuckDuckGo, no setup. When DuckDuckGo rate-limits or blocks automated queries (it does on some networks), the room says so honestly and points to the fix instead of suggesting a retry that will not help; a local SearXNG instance remains the preferred backend whenever configured, with automatic fallback while it is unreachable, timeouts so a dead SearXNG never hangs a search, and pacing so query bursts stop tripping DuckDuckGo's limits.
- Chat: consecutive web searches and page reads collapse into one quiet line ("Searched the web", "Read 12 pages") that expands to the individual calls; a run with failures stays honest (counts successes, notes failures, goes red only when everything failed).
- Chat: the sidebar collapses (the toggle sits by the settings gear; the preference is remembered), and the connected dot is now green with proper alignment.
- Memory: the checkpoint review screens (Checkpoint, Learn, Review Memory) speak the current compact design language: smaller left-aligned headers, one-line status, actions where you expect them, and the fine print moved into footnotes.
- Fixed: completing AI setup no longer requires a page refresh before entering a room; the model status follows every sign-in, sign-out, and provider change immediately (this was every new user's first-run path).
- Docs: the README leads with what the product looks like (a real demo recording and product shots), download buttons for the apps, and a "ways to use exxperts" table that states the doors model plainly: the app is self-contained and always runs its own version, a terminal install updates separately, both share the same data, one server at a time.
- Release: the release pipeline builds and publishes the desktop apps alongside the server archives, all checksummed in `SHA256SUMS.txt`, with stable versionless download links that never rot across releases.
- Dependencies: all six security advisories flagged on the lockfile since 0.6.8 are resolved (fast-uri, find-my-way, shell-quote, dompurify, and `@hono/node-server` via an override).

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
