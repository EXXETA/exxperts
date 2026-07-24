const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureProductAppUserDirs, productAppStatePath, ensureCliLauncherStateDir } = require("./product-state-paths.cjs");
const roomLock = require("./room-lock.cjs");
const roomPicker = require("./room-picker.cjs");

const ROOM_EXTENSIONS = [
  "content-policy",
  "permissions",
  "web-search",
  "fetch_url",
  "mcp",
  "cli-rooms",
];

// Package-manager commands are runtime commands, not rooms: route them
// straight to the CLI runtime (like `setup`) instead of the room picker.
// `uninstall` and `config` are handled by the runtime as well (alias of
// `remove` / interactive config selector).
const PACKAGE_COMMANDS = ["install", "remove", "uninstall", "update", "list", "config"];

const TERMINAL_RESTORE_SEQUENCE = [
  "\x1b[?2004l", // bracketed paste off
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l", // mouse modes off
  "\x1b[<u", // pop Kitty keyboard protocol flags if the child pushed them
  "\x1b[>4;0m", // xterm modifyOtherKeys off
  "\x1b[?25h", // cursor visible
  "\x1b]9;4;0;\x07", // clear terminal progress
].join("");

let terminalRestoreUsed = false;

function hasInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && (process.stdout.isTTY || process.stderr.isTTY));
}

function writeTerminalRestoreSequences() {
  if (!hasInteractiveTerminal()) return;
  const stream = process.stdout.isTTY ? process.stdout : process.stderr;
  try {
    stream.write(TERMINAL_RESTORE_SEQUENCE);
  } catch {}
}

function drainTerminalInputAfterChild(timeoutMs = 180) {
  if (!hasInteractiveTerminal()) return;
  const script = `
const timeoutMs = Number(process.argv[1] || 180);
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") process.exit(0);
let done = false;
function finish() {
  if (done) return;
  done = true;
  try { process.stdin.removeAllListeners("data"); } catch {}
  try { process.stdin.setRawMode(false); } catch {}
  try { process.stdin.pause(); } catch {}
  process.exit(0);
}
try { process.stdin.setRawMode(true); } catch {}
try { process.stdin.resume(); } catch {}
process.stdin.on("data", () => {});
setTimeout(finish, timeoutMs);
setTimeout(finish, timeoutMs + 250);
`;
  try {
    spawnSync(process.execPath, ["-e", script, String(timeoutMs)], {
      stdio: ["inherit", "ignore", "ignore"],
      timeout: timeoutMs + 750,
    });
  } catch {}
}

function restoreTerminalAfterChild() {
  if (!hasInteractiveTerminal()) return;
  terminalRestoreUsed = true;
  writeTerminalRestoreSequences();
  drainTerminalInputAfterChild();
  writeTerminalRestoreSequences();
}

function spawnCliRuntime(command, args, options, restoreTerminal = true) {
  const result = spawnSync(command, args, options);
  if (restoreTerminal) restoreTerminalAfterChild();
  return result;
}

function exitWithTerminalRestore(code) {
  if (terminalRestoreUsed) writeTerminalRestoreSequences();
  process.exit(code);
}

function usage(command) {
  return `Usage: ${command} [runtime options]\n\nOpens the exxperts rooms picker. Pick a room (your own persistent workspace,\nwith its own memory and exxpert) or create a new one. The package install\ndirectory is used as EXXETA_HOME.\n\nExplicit packaged commands:\n  exxperts web       Open the web app\n  exxperts cli       Open this rooms CLI/TUI\n  exxperts           Pick a surface interactively (web app recommended)\n\nPackage commands (routed to the runtime):\n  exxperts install|remove|update|list|config …\n\nOptions:\n  --help, -h      Show this launcher help\n\nOther arguments are passed through to the room runtime.\n`;
}

function warnAboutPiExtensionInstall(args) {
  if (args[0] !== "install") return;
  console.warn(
    "WARNING: Rooms will not load Pi Extensions, unless explicitly approved in the source code.",
  );
}

function ensureDirs() {
  ensureProductAppUserDirs();
}

function loadDotenv(root) {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
  } catch {}
}

// Exxeta brand palette as raw truecolor ANSI (the TUI theme can't reach this
// pre-launch banner, so we hand-roll the brand colours here).
const BRAND = {
  R: "\x1b[0m",
  B: "\x1b[1m",
  D: "\x1b[2m",
  lila: "\x1b[38;2;140;165;255m",
  yellow: "\x1b[38;2;235;255;89m",
};

// Clear the visible screen and home the cursor (scrollback preserved) so each
// transition — picker, room entry, memento/switch — starts clean instead of
// painting a banner over the previous session's leftover frame.
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

// Half-block "exxperts" logotype, rendered entirely in lila. Derived by
// downscaling the plain-wordmark brand PNG (Bandeins Strange Bold, no
// ligature) into the half-block pixel grid, so the letterforms are the real ones.
const WORDMARK = [
  "                                                             ██",
  "   ▄▄▄▄    ▄▄    ▄▄  ▄▄    ▄▄  ▄▄  ▄▄▄       ▄▄▄▄    ▄▄▄▄▄ ▄███▄▄  ▄▄▄▄▄▄",
  " ███████▄  ▀██  ██▀  ▀██  ██▀  ████▀▀██▄   ███████▄  █████ ██████ ████████",
  "███▄▄▄▄██▄  ▀████▀    ▀████▀   ██▀    ███ ███▄▄▄▄██  ██      ██    ██▄▄",
  "███▀▀▀▀▀▀▀   ████      ████    ██▄    ▄██ ███▀▀▀▀▀▀▀ ██      ██     ▀▀██▄",
  "▀██▄▄▄▄██  ▄██▀▀██▄  ▄██▀▀██▄  ███▄▄▄▄██▀ ▀██▄▄▄▄██  ██      ██▄▄  ▄▄▄▄███",
  "  ▀████▀   ██▀  ▀██  ██▀  ▀██  ██▀▀███▀     ▀████▀   ██      ████▀▀███████",
  "                               ██",
  "                               ██",
];

function brandWordmark(indent) {
  const pad = " ".repeat(indent);
  const { R, lila } = BRAND;
  return WORDMARK.map((line) => `${pad}${lila}${line}${R}`).join("\n");
}

function readJsonMarker(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    fs.rmSync(file, { force: true });
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function createLauncherStateDir() {
  try {
    const base = path.join(os.tmpdir(), "exxperts", "launcher-state");
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(base, `${process.pid}-`));
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
    return { dir, temporary: true };
  } catch {
    return { dir: ensureCliLauncherStateDir(), temporary: false };
  }
}

function cleanupLauncherStateDir(state) {
  if (!state?.temporary) return;
  try {
    fs.rmSync(state.dir, { recursive: true, force: true });
  } catch {}
}

function isPrintMode(args) {
  return args.some((a) => a === "-p" || a === "--print");
}

function runtimeMayUseTui(args) {
  if (isPrintMode(args)) return false;
  if (args.some((a) => a === "--mode")) return false;
  if (args.some((a) => a === "--version" || a === "-v" || a === "--help" || a === "-h")) return false;
  if (args.some((a) => a === "--export" || a === "--list-models")) return false;
  return true;
}

function runPersistentRoomBootstrap(root, room) {
  const tsxCli = require.resolve("tsx/cli");
  const helper = path.join(root, "bin", "lib", "persistent-room-bootstrap.ts");
  const result = spawnSync(
    process.execPath,
    [tsxCli, helper],
    {
      cwd: root,
      env: { ...process.env, EXXETA_HOME: root },
      input: JSON.stringify({ agentId: room.agentId, threadId: room.threadId, model: room.model, cwd: process.cwd() }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "persistent room bootstrap failed").trim();
    throw new Error(message);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`persistent room bootstrap returned invalid JSON: ${error.message}`);
  }
}

const ROOM_CONTROLLED_VALUE_FLAGS = new Set([
  "--provider",
  "--model",
  "--models",
  "--api-key",
  "--session",
  "--fork",
  "--session-dir",
  "--system-prompt",
  "--raw-system-prompt",
  "--append-system-prompt",
  "--tools",
  "-t",
  "--theme",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
]);

const ROOM_CONTROLLED_BOOLEAN_FLAGS = new Set([
  "--no-session",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--no-extensions",
  "-ne",
  "--no-context-files",
  "-nc",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
]);

function flagToken(arg) {
  const eqIndex = String(arg).indexOf("=");
  return eqIndex === -1 ? arg : String(arg).slice(0, eqIndex);
}

function sanitizeRoomPassthroughArgs(passthroughArgs) {
  const sanitized = [];
  for (let i = 0; i < passthroughArgs.length; i += 1) {
    const arg = passthroughArgs[i];
    const flag = flagToken(arg);
    if (ROOM_CONTROLLED_VALUE_FLAGS.has(flag)) {
      const next = passthroughArgs[i + 1];
      if (!String(arg).includes("=") && next !== undefined && !String(next).startsWith("-")) i += 1;
      continue;
    }
    if (ROOM_CONTROLLED_BOOLEAN_FLAGS.has(flag)) continue;
    sanitized.push(arg);
  }
  return sanitized;
}

function requirePiRuntimeField(runtime, field) {
  const value = runtime?.[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`persistent room Pi runtime is missing ${field}`);
  return value;
}

function roomRuntimeArgs(root, boot, passthroughArgs) {
  const pkg = path.join(root, "pi-package");
  const runtimeKind = boot.runtime?.kind || "transcript-recap-v1";
  const args = [
    path.join(root, "runtime", "packages", "coding-agent", "dist", "cli.js"),
  ];

  if (runtimeKind === "pi-session-jsonl") {
    args.push(
      "--session", requirePiRuntimeField(boot.runtime, "sessionFilePath"),
      "--raw-system-prompt", requirePiRuntimeField(boot.runtime, "bootPromptSnapshot"),
    );
  } else if (runtimeKind === "transcript-recap-v1") {
    args.push(
      // Fold the restored live-thread recap into the system prompt so the model
      // has it as continuation context, without it showing up in the visible chat.
      "--system-prompt", boot.restoredBlock ? `${boot.systemPrompt}\n\n${boot.restoredBlock}` : boot.systemPrompt,
      "--no-session",
    );
  } else {
    throw new Error(`unsupported persistent room runtime kind: ${runtimeKind}`);
  }

  args.push(
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--theme", path.join(pkg, "themes", "exxeta.json"),
    "--quiet",
  );
  if (boot.allowedToolNames.length > 0) {
    args.push("--tools", boot.allowedToolNames.join(","));
  } else {
    args.push("--no-tools");
  }
  for (const ext of ROOM_EXTENSIONS) args.push("-e", path.join(pkg, "extensions", ext));
  args.push(...sanitizeRoomPassthroughArgs(passthroughArgs));
  // Keep the room/thread-selected model last so room mode cannot be overridden
  // by caller passthrough flags. The sanitizer also removes scoped model flags
  // that would allow model cycling outside the room lock.
  args.push("--provider", boot.model.provider, "--model", boot.model.model);
  return args;
}

// The room banner now renders inside the TUI as a header (cli-rooms setHeader)
// so it survives terminal resize/maximize. Here we only clear the previous
// session's leftover frame so the new room screen starts clean.
function clearForRoomEntry(passthroughArgs) {
  const interactive = process.stderr.isTTY && !isPrintMode(passthroughArgs);
  if (!interactive) return;
  process.stderr.write(CLEAR_SCREEN);
}

// Prompt for a room name + user, then create the room via the shared scaffold
// helper (same logic the web app uses). Returns { agentId } or null on cancel.
async function runCreateRoom(root, env) {
  const { R, lila, D } = BRAND;
  const name = await roomPicker.promptLine(`\n  ${lila}New room name${R} ${D}(e.g. Product Strategy)${R}: `);
  if (!name) return null;
  const userName = (await roomPicker.promptLine(`  ${lila}Your name${R} ${D}(e.g. Fernando)${R}: `)) || "you";

  const tsxCli = require.resolve("tsx/cli");
  const helper = path.join(root, "bin", "lib", "persistent-room-create.ts");
  const result = spawnSync(process.execPath, [tsxCli, helper], {
    cwd: root,
    env: { ...env, EXXETA_HOME: root },
    input: JSON.stringify({ displayName: name, userName }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(`\n  Could not create room: ${(result.stderr || result.stdout || "unknown error").trim()}\n`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    console.error("\n  Could not create room: invalid response from create helper.\n");
    return null;
  }
}

async function main(argv = process.argv.slice(2), command = path.basename(process.argv[1] || "exxperts-cli")) {
  const root = path.resolve(__dirname, "..", "..");

  // Product setup and package-manager commands should not require an agent
  // file, banner, theme, or extension wrapper. Route supported commands
  // directly to the runtime, warning when a Pi extension will not load in rooms.
  if (argv[0] === "setup" || PACKAGE_COMMANDS.includes(argv[0])) {
    warnAboutPiExtensionInstall(argv);
    loadDotenv(root);
    const env = { ...process.env, EXXETA_HOME: root };
    const result = spawnCliRuntime(process.execPath, [path.join(root, "runtime", "packages", "coding-agent", "dist", "cli.js"), ...argv], {
      stdio: "inherit",
      env,
      cwd: process.cwd(),
    });
    exitWithTerminalRestore(result.status ?? (result.signal ? 1 : 0));
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage(command));
    return;
  }

  ensureDirs();
  loadDotenv(root);

  const launcherState = createLauncherStateDir();
  const roomStateFile = path.join(launcherState.dir, ".room-state");

  const env = {
    ...process.env,
    EXXETA_HOME: root,
    EXXPERTS_LAUNCHER_STATE_DIR: launcherState.dir,
    // Force the brand theme as the active theme (registering it via --theme is
    // not enough; the active theme otherwise defaults to the saved setting).
    EXXETA_THEME: process.env.EXXETA_THEME || "exxeta",
  };

  // The exxperts CLI is rooms-only: it opens a room picker (mirroring the web
  // dashboard), then runs the selected room. There is no standalone coding agent.
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY && !isPrintMode(argv));
  let room = null;
  let passthroughArgs = argv.slice();
  let exitCode = 0;

  while (true) {
    if (!room) {
      if (!interactive) {
        console.error("\n  The exxperts CLI opens an interactive room picker — run it in a terminal (no -p/--print).\n");
        exitCode = 1;
        break;
      }
      const rooms = roomPicker.listRooms(productAppStatePath("personalized-agents"));
      const choice = await roomPicker.runRoomPicker({ rooms, brand: BRAND, wordmark: brandWordmark(2) });
      if (choice.action === "quit") break;
      if (choice.action === "enter") {
        room = { agentId: choice.agentId };
        passthroughArgs = [];
        continue;
      }
      if (choice.action === "create") {
        const created = await runCreateRoom(root, env);
        if (created?.agentId) {
          room = { agentId: created.agentId };
          passthroughArgs = [];
        }
        continue; // back to the picker if creation was cancelled
      }
      continue;
    }

    let boot;
    try {
      boot = runPersistentRoomBootstrap(root, room);
    } catch (error) {
      const message = String(error.message || "");
      if (/needs_absorb/i.test(message)) {
        // The room's recent-context buffer is full. Only the web app's
        // Maintain/Absorb resets it (checkpoints don't), so point the user there.
        console.error(`\n  This room's memory buffer is full and needs maintenance.\n  Open it in the web app to run Maintain, then it'll be available here again.\n`);
      } else {
        console.error(`\n  Could not open room: ${message}\n`);
      }
      room = null;
      passthroughArgs = [];
      continue;
    }

    const roomLockOwner = { surface: "cli", pid: process.pid, label: boot.agentId };
    const acquired = roomLock.tryAcquire(boot.agentId, roomLockOwner);
    if (!acquired.ok) {
      const by = acquired.heldBy;
      const where = by.surface === "web" ? "the web app" : "another CLI session";
      const since = new Date(by.acquiredAt).toLocaleTimeString();
      console.error(`\nRoom "${boot.displayName || boot.agentId}" is currently open in ${where} (since ${since}).\nClose it there first to avoid conflicting edits.\n`);
      // Hold the message until acknowledged — the picker redraw would
      // otherwise wipe it before it can be read.
      await roomPicker.promptLine("  Press enter to return to your rooms… ");
      room = null;
      passthroughArgs = [];
      continue;
    }

    clearForRoomEntry(passthroughArgs);
    const workspaceToolNames = Array.isArray(boot.workspaceCapability?.availableToolNames)
      ? boot.workspaceCapability.availableToolNames.join(",")
      : "";
    const roomBashEnabled = boot.workspaceToolsEnabled && boot.workspaceAccessMode === "localFiles" && boot.workspaceCapability?.bashEnabled === true;
    const roomEnv = {
      ...env,
      EXXETA_PERSONA: "business",
      EXXETA_ACTIVE_AGENT: boot.agentId,
      EXXETA_PERSISTENT_ROOM_SESSION: "1",
      EXXETA_PERSISTENT_ROOM_AGENT: boot.agentId,
      EXXETA_PERSISTENT_ROOM_THREAD: boot.threadId,
      EXXETA_PERSISTENT_ROOM_MODEL_PROVIDER: boot.model.provider,
      EXXETA_PERSISTENT_ROOM_MODEL_ID: boot.model.model,
      EXXETA_PERSISTENT_ROOM_MODEL_LABEL: boot.model.label || "",
      EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE: boot.workspaceToolsEnabled ? (boot.workspaceAccessMode || boot.workspaceCapability?.workspaceAccessMode || "bounded") : "",
      EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS: boot.workspaceToolsEnabled ? workspaceToolNames : "",
      EXXETA_PERSISTENT_ROOM_BASH_ENABLED: roomBashEnabled ? "1" : "",
      EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT: boot.workspaceToolsEnabled ? "manual" : "",
    };
    const result = spawnCliRuntime(process.execPath, roomRuntimeArgs(root, boot, passthroughArgs), {
      stdio: "inherit",
      env: roomEnv,
      cwd: boot.runtimeCwd || process.cwd(),
    }, runtimeMayUseTui(passthroughArgs));
    exitCode = result.status ?? (result.signal ? 1 : 0);
    passthroughArgs = [];
    roomLock.release(boot.agentId, roomLockOwner);

    const roomMarker = readJsonMarker(roomStateFile);
    if (roomMarker?.action === "enter" && roomMarker.agentId) {
      // Switch directly to another room (e.g. /exxperts-room <name>).
      room = { agentId: String(roomMarker.agentId), threadId: roomMarker.threadId ? String(roomMarker.threadId) : undefined, model: roomMarker.model };
      continue;
    }
    // Leaving a room (/exxperts-room-exit) returns to the picker; /quit exits.
    room = null;
    if (roomMarker?.action === "exit") continue;
    break;
  }

  cleanupLauncherStateDir(launcherState);
  exitWithTerminalRestore(exitCode);
}

module.exports = { main, usage, roomRuntimeArgs, sanitizeRoomPassthroughArgs, BRAND, brandWordmark };
