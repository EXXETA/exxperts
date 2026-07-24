# Quickstart

Get Exxperts running, connect your AI, and save your first memory, all in about five minutes.

Exxperts is a local-first platform for persistent AI colleagues. Each "room" is an agent with durable, governed memory: everything it remembers lives in plain files on your machine, every memory write goes through an approval workflow you control, and the memory belongs to the room, not to any model vendor.

## Ways to use exxperts

Three doors into the same product, all sharing the same local data under `~/.exxperts` (rooms, memory, provider logins), one local server at a time:

- **Desktop app** (macOS Apple Silicon, Windows x64): [download it from the README](../README.md#download-the-app) and open it, no terminal and no prerequisites. The app is self-contained and always runs its own version. Already installed via the terminal? The app uses the same data: download and open it.
- **Terminal install**: the one-line command below; gives you the `exxperts` commands.
- **Repo clone**: for contributors; the by-hand steps are [below](#1-install-and-run), the full guide is [CONTRIBUTING.md](../CONTRIBUTING.md).

If you take the app door, skip to [step 2](#2-connect-your-ai) once it opens.

## What you need

- macOS, Windows, or Linux with a terminal, and about 1 GB of free disk space (updates briefly peak at about 1.4 GB while the new version is unpacked next to the old one). On macOS with Apple Silicon, Windows x64, and Linux x64, the one-line install below needs nothing else preinstalled; other platforms automatically build from source, which needs the git and Node.js from the next bullet.
- Only for shell access in rooms and for the build-from-source fallback: [git](https://git-scm.com) (on Windows, Git for Windows; rooms' optional shell tool runs through Git Bash) and Node.js 20.6+ with npm (check with `node --version`; if missing, install the LTS from [nodejs.org](https://nodejs.org)). Building from source takes about 3 GB of disk.
- An AI subscription: **Claude** (Pro/Max) or **ChatGPT Plus/Pro**, or an OpenAI-compatible gateway if you or your org run one.

## 1. Install and run

One command installs everything: it downloads a prebuilt archive for your platform (no Node.js, npm, or Git needed) and installs the `exxperts` command. Prebuilt archives exist for macOS on Apple Silicon, Windows x64, and Linux x64; on any other platform, or when the download fails, the same command automatically falls back to building from source (that path needs git and Node.js 20.6+ and clones the repo into `~/exxperts`). Re-run it anytime to update. The archives and their checksums are published on [GitHub Releases](https://github.com/EXXETA/exxperts/releases); [release-pipeline.md](release-pipeline.md) describes how they are built.

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/EXXETA/exxperts/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/EXXETA/exxperts/main/install.ps1 | iex
```

Then start the web app:

```bash
exxperts web
```

**Windows note:** if PowerShell refuses to run `exxperts` afterwards ("running scripts is disabled on this system"), that is PowerShell's default script policy, not a broken install. Either run it from cmd.exe or Git Bash, or allow npm-installed commands for your user once and open a new terminal:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Prefer to do it by hand? The same commands work on every platform (on Windows, apply the two Git settings from [Windows notes](#windows-notes) below before cloning; the one-line installer does that for you):

```bash
git clone https://github.com/EXXETA/exxperts.git
cd exxperts
npm install
npm run install:global   # builds, packs, and installs the exxperts commands
exxperts web
```

The web app starts on `http://127.0.0.1:8787` and opens in your browser (if it doesn't, open the URL the command prints). Everything runs locally: the server only listens on your machine.

If `install:global` fails with `ENOTEMPTY`, an older exxperts install is in the way: run `npm uninstall -g @exxeta/exxperts-app`, delete the leftover directory the error names if it survives, and retry. (The tarball it mentions is named after the npm package `@exxeta/exxperts-app`; Exxeta is the company behind exxperts.)

If it fails with `EACCES` on macOS/Linux, use a user-level npm prefix instead of `sudo`:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Prefer running straight from the clone without installing commands? `npm run build`, then `./scripts/exxperts-web` (macOS/Linux/Git Bash) or `node bin\exxperts-web.cjs` (Windows).

**Updating later**: re-run the one-line install command. On the platforms with prebuilt archives it performs an archive install even when you previously built from source: it migrates you to the archive install, carries `app/.env` over, and uninstalls the old npm-based global command (the clone stays in place); set `EXXPERTS_INSTALL_METHOD=source` to stay on a source install instead. Archive installs update in place and keep the install's `app/.env`; your rooms, memory, and provider logins in `~/.exxperts` are never touched by installs or updates. Updating a source install by hand: from the repo folder, `git pull`, `npm install`, `npm run install:global`. Confirm with `exxperts --version`. If anything misbehaves, `exxperts doctor` checks your install and the optional layers on any install type and prints the fix (contributors working from a clone can also use `npm run doctor`).

### Windows notes

Windows is supported for the desktop app, the web app, and the CLI/TUI; the desktop app and the one-line installer need nothing preinstalled on Windows x64. The requirements below matter for two things only, shell access in rooms and installing from source (by hand or via the installer's fallback):

1. **Git for Windows ≥ 2.40** (https://gitforwindows.org), needed for the source install path and for rooms' optional shell tool: that tool runs commands through Git Bash's `bash.exe`, which is discovered automatically from your Git installation, whether machine-wide (`C:\Program Files\Git`) or per-user (`%LOCALAPPDATA%\Programs\Git`, the no-admin install), or on `PATH`. A WSL `bash` on `PATH` also works for rooms' shell tool; in that case commands run inside the WSL Linux environment (Windows drives under `/mnt/c`, the distro's own tools).
2. **Node.js 20.6+ (LTS recommended) and npm** (https://nodejs.org), needed for the source install path only; the prebuilt archive bundles its own Node runtime.
3. **Windows Terminal** recommended for the CLI/TUI (legacy conhost is untested).

One-time Git settings before cloning (long paths matter because `node_modules` trees exceed the 260-character `MAX_PATH`); clone into a folder your user owns (for example under `%USERPROFILE%`), never into `C:\` or `C:\Program Files`:

```powershell
git config --global core.longpaths true
git config --global core.autocrlf false   # the repo's .gitattributes manages line endings
```

Developing from a clone without a global install? Use the shell-independent forms: `node bin\exxperts-web.cjs`, `node bin\exxperts-cli.cjs`, and `node scripts\exxeta-web.mjs` (dev web app with server + Vite UI). The bash launchers in `scripts/` also work from Git Bash.

## 2. Connect your AI

Open **AI setup** in the web app.

- **Claude or ChatGPT Plus/Pro:** click **Sign in →** on the provider's card. The provider's login opens in a new browser tab; complete it there and the page updates by itself. Credentials stay on your machine, in the local credential store.
- **OpenAI-compatible gateway (or any other provider):** on the same page, open **Add another provider**. For a gateway, choose **Set up gateway**, enter the base URL and model ids, then paste your token on the gateway's profile row; the terminal wizard (`exxperts setup openai-compatible`) still works too. Details: [Provider setup and AI profiles](provider-setup.md).

Signing in is enough: the matching profile activates by itself. You can switch between connected profiles anytime on the same page.

## 3. Create your first room

From Home, create a room. A room is a persistent colleague: it keeps its own memory, workspace, and conversation threads, and it picks a working style at creation.

Try this:

1. Chat normally: ask it to help with something real.
2. Tell it something worth keeping: *"Remember that I prefer concise summaries."*
3. When you finish the session, press **Checkpoint** next to the message box. The room distills the conversation into its durable memory, and anything you explicitly asked it to remember is protected through every later compression.

Nothing is memorized silently. Checkpoint proposals apply automatically only when they're clean; anything questionable comes back to you for review. Later, as checkpoints accumulate, the room offers **Learn** (consolidating recent context into stable memory) and **Review Memory** (tidying stable memory), both approval-gated the same way. The full story: [Memory](memory.md).

## 4. Give the room a workspace (optional)

In the room's settings, set a **workspace folder**: the room's file tools then work inside that folder, with per-tool toggles and two access modes (**Full access** or **Bounded workspace**). Shell access is off by default.

macOS note: if the workspace is in a protected folder (Documents, Desktop, Downloads, iCloud Drive), macOS may block directory listing for the terminal that launched Exxperts. Check from that same terminal:

```bash
ls ~/Documents | head
```

If that fails with `Operation not permitted`, grant your terminal access in System Settings → Privacy & Security → Files and Folders, or choose a non-protected folder.

## Where your data lives

| Path | Purpose |
| --- | --- |
| `~/.exxperts/app/` | Product state: rooms (memory, events, threads), schedules, usage, artifacts, feature config. |
| `~/.exxperts/agent/` | Runtime state: provider credentials, model config, CLI sessions. |

Each room is a self-contained folder under `~/.exxperts/app/personalized-agents/<room-id>/`: its constitution, durable memory, full event history with content fingerprints, and saved threads, all in plain files you can read.

## Back up and move your rooms

Because a room is just a folder, backing it up or moving it to another machine is a copy:

1. Finish the session in the room (checkpoint if you want the latest conversation remembered) and close it.
2. Copy the room's folder, `~/.exxperts/app/personalized-agents/<room-id>/`, to the same path on the other machine (or archive it: `tar -czf my-room.tgz -C ~/.exxperts/app/personalized-agents <room-id>`).
3. On the other machine, install Exxperts and sign in to the **same provider profile**; saved threads are model-locked, so the room needs a profile that offers its model.
4. If the room had a workspace, set it again in room settings; workspace grants reference absolute paths on the original machine and don't carry over. The workspace section warns when the saved folder isn't found on this machine.

The room appears on Home automatically; no import step. Copying all of `~/.exxperts/` backs up everything, credentials included, so treat that copy as sensitive.

## Uninstall

Desktop app: quit it from the tray, then delete the app (macOS: drag it out of Applications; Windows: uninstall from Settings, or just delete the portable folder). Terminal install: stop the server with `Ctrl-C`; if you installed the package globally, `npm uninstall -g @exxeta/exxperts-app`. Your rooms and credentials stay in `~/.exxperts/`; delete that folder only if you want to erase all local product state.

## Going further

- [How Exxperts works](how-exxperts-works.md): the architecture of rooms, prompt layers, and the approval-gated memory lifecycle.
- [Memory](memory.md): the full memory model and who approves what.
- [Provider setup and AI profiles](provider-setup.md): all provider paths in detail.
- [MCP client support](mcp.md): connect MCP tool servers.
- [Web search](web-search.md): built in via DuckDuckGo, no setup; SearXNG is the reliable path for heavy use or networks where DuckDuckGo blocks automated queries.
- CLI/TUI: `exxperts cli` (or `./scripts/exxperts-cli`) opens the terminal experience, sharing the same rooms and credentials.
