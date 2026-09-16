#!/usr/bin/env node
// Start the Exxperts web server + Vite UI together and open the browser.
// Stops both when you Ctrl+C. Cross-platform port of the former bash-only
// scripts/exxeta-web (which now delegates here).

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXXETA_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.EXXETA_HOME = EXXETA_HOME;
process.chdir(EXXETA_HOME);

const COMMAND_NAME = process.env.EXXPERTS_WEB_COMMAND_NAME || "./scripts/exxeta-web";
const DEV_PORTS = [8787, 5173];
const isWindows = process.platform === "win32";

function usage() {
  console.log(`Usage: ${COMMAND_NAME} [--help]

Starts the current-branch Exxperts web dev app: the web server plus Vite UI.
Logs are written to .exxperts-cache/ and both services stop on Ctrl+C.

Options:
  --help, -h      Show this help without starting services`);
}

const args = process.argv.slice(2);
if (args[0] === "--help" || args[0] === "-h") {
  usage();
  process.exit(0);
}
if (args.length > 0) {
  console.error(`Unknown option: ${args[0]}\n`);
  usage();
  process.exit(2);
}

// The web server starts with its cwd in apps/web-server, so a bare
// `import "dotenv/config"` would look for apps/web-server/.env and miss the
// repo-root .env. Point dotenv at the root .env so dev web mode picks up the
// same config (EXXETA_SEARCH_*, PORT, keys) as the CLI and installed product.
process.env.DOTENV_CONFIG_PATH = process.env.DOTENV_CONFIG_PATH || path.join(EXXETA_HOME, ".env");

function listeningPids(port) {
  try {
    if (isWindows) {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (m && Number(m[1]) === port && Number(m[2]) > 0) pids.add(m[2]);
      }
      return [...pids];
    }
    const out = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf-8" });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function forceKillPid(pid) {
  try {
    if (isWindows) execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    else process.kill(Number(pid), "SIGKILL");
  } catch {
    // Already gone.
  }
}

// npm run dev is a tree (npm → tsx watch → server). Killing just the npm
// process orphans tsx watch, which keeps watching and later spawns a
// competing server; the services run in their own process group (below) so
// the whole tree can be ended at once.
function killTree(pid) {
  if (!pid) return;
  if (isWindows) {
    forceKillPid(pid);
    return;
  }
  try {
    process.kill(-Number(pid), "SIGKILL");
  } catch {
    forceKillPid(pid);
  }
}

function killStalePortListeners() {
  for (const port of DEV_PORTS) {
    const pids = listeningPids(port);
    if (pids.length) {
      console.log(`killing stale process on :${port} (${pids.join(" ")})`);
      for (const pid of pids) forceKillPid(pid);
    }
  }
}

function waitForUrl(url, attempts = 20, delayMs = 500) {
  return new Promise((resolve) => {
    let remaining = attempts;
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        // Match the old `curl -fsS` readiness check: any HTTP error is not ready.
        if (res.statusCode && res.statusCode < 400) return resolve(true);
        retry();
      });
      req.on("error", retry);
      req.setTimeout(500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (--remaining <= 0) return resolve(false);
      setTimeout(tryOnce, delayMs);
    };
    tryOnce();
  });
}

// The server mints its client auth token before it listens, so once /healthz
// answers the token file exists. Opening the Vite origin through
// /auth/session (proxied to the server) sets the cookie on localhost:5173.
function readAuthToken(home) {
  const fromEnv = (process.env.EXXPERTS_AUTH_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    // The token belongs to the ACTIVE profile's tree, standard or named,
    // inside the home the running server leg was started against.
    return fs.readFileSync(stateProfiles.activeTokenPath(home), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : isWindows ? "cmd" : "xdg-open";
  const cmdArgs = isWindows ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, cmdArgs, { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.error(`Could not open browser automatically. Open ${url} manually.`);
  }
}

// Profile switching (Settings → Profiles): the server exits with a sentinel
// after updating the active-profile pointer; some supervisor must restart it
// against the pointer. In dev that supervisor is this harness, because tsx
// watch cannot do it (it only reruns on file changes). ~/.exxperts itself never
// moves; a profile runs via env indirection at ~/.exxperts-<name>.
const stateProfiles = createRequire(import.meta.url)(path.join(EXXETA_HOME, "bin", "lib", "state-profiles.cjs"));

// Exxperts home: the login home anchors the pointer and move intents, and
// stays the home every child sees. A stranded move completes here, then this
// process (and every child) resolves its STATE against the resolved home.
const loginHome = os.homedir();
// The environment this harness was STARTED with, before any adopt repoints
// its state home in place: every server leg is built from this copy, so a leg
// can never inherit the home an earlier leg was pointed at.
const baseEnv = { ...process.env };
// A move that cannot run leaves the old home intact and the pointer still
// naming it, so the harness starts there and says why; only an unusable home
// is fatal.
try {
  stateProfiles.performPendingHomeMove(loginHome);
} catch (err) {
  console.error(`\ncould not move the exxperts data: ${err.message}\ncontinuing with the current location…`);
}
try {
  stateProfiles.adoptStateHome(loginHome);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

killStalePortListeners();
await new Promise((r) => setTimeout(r, 1000));

const cacheDir = path.join(EXXETA_HOME, ".exxperts-cache");
fs.mkdirSync(cacheDir, { recursive: true });
const serverLog = path.join(cacheDir, "web-server.log");
const uiLog = path.join(cacheDir, "web-ui.log");

function startDevService(relCwd, logPath, env = process.env) {
  const logFd = fs.openSync(logPath, "w");
  const cwd = path.join(EXXETA_HOME, relCwd);
  // npm on Windows is a .cmd shim, which Node only spawns through a shell.
  const child = isWindows
    ? spawn("npm run dev", { cwd, stdio: ["ignore", logFd, logFd], shell: true, env })
    : spawn("npm", ["run", "dev"], { cwd, stdio: ["ignore", logFd, logFd], env, detached: true });
  child.on("spawn", () => fs.closeSync(logFd));
  return child;
}

// This harness IS the switch supervisor for dev runs; the marker tells the
// switch route so (it refuses on unsupervised servers). Each server start
// builds its environment from baseEnv, adopts the exxperts home into that own
// copy, and resolves the active-profile pointer inside it: a leg started from
// a repointed process.env would run against the home the data just left.
function serverLeg() {
  const env = {
    ...baseEnv,
    EXXPERTS_SWITCH_SUPERVISED: "1",
    EXXPERTS_HOME_MOVE_SUPERVISED: "1",
    EXXPERTS_LOGIN_HOME: loginHome,
  };
  const { home } = stateProfiles.adoptStateHome(loginHome, env);
  env.EXXPERTS_REAL_HOME = home;
  Object.assign(env, stateProfiles.serverEnvForProfile(home, stateProfiles.readActiveProfile(home)));
  return { env, home };
}

console.log(`starting web server  → ${serverLog}`);
let leg = serverLeg();
let serverChild = startDevService(path.join("apps", "web-server"), serverLog, leg.env);

console.log(`starting Vite UI     → ${uiLog}`);
const uiChild = startDevService(path.join("apps", "web-ui"), uiLog);

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  console.log(`\nstopping (PIDs: ${serverChild.pid}, ${uiChild.pid})`);
  for (const child of [serverChild, uiChild]) {
    if (child.pid && child.exitCode === null) killTree(child.pid);
  }
  killStalePortListeners();
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
// The service trees run in their own process groups (killTree), so they no
// longer die with this harness's group: a closed terminal (SIGHUP) must tear
// them down explicitly or they linger on :8787/:5173.
process.on("SIGHUP", () => {
  cleanup();
  process.exit(129);
});

await waitForUrl("http://localhost:8787/healthz");
await waitForUrl("http://localhost:5173/");

console.log(`
  ✓ web server  http://localhost:8787  (logs: ${serverLog})
  ✓ web UI      http://localhost:5173  (logs: ${uiLog})
`);
const authToken = readAuthToken(leg.home);
if (!authToken) console.log("No auth token at ~/.exxperts/app/auth-token; the browser will show the sign-in hint page.");
console.log("Opening browser…");
openBrowser(authToken ? `http://localhost:5173/auth/session?token=${encodeURIComponent(authToken)}` : "http://localhost:5173");

// Switch watcher: the pointer changing plus a dead server means a profile
// switch is waiting for its restart. The old npm/tsx-watch tree is torn down
// first so a watch-triggered restart can never race the new one.
// ponytail: 1s poll; event-driven detection if this ever feels slow.
let lastActive = stateProfiles.readActiveProfile(leg.home);
let switching = false;
const switchWatcher = setInterval(() => {
  void (async () => {
    if (switching) return;
    // A home-move intent plus a dead server means a move is waiting for its
    // restart, exactly like a changed pointer means a profile switch. The
    // pointer that matters is the one in the home the running leg was started
    // against, which an executed move has not left yet.
    const movePending = fs.existsSync(stateProfiles.homeMoveIntentPath(loginHome));
    const active = stateProfiles.readActiveProfile(leg.home);
    if (active === lastActive && !movePending) return;
    // Latch BEFORE the first await: the healthz probe can outlast a whole
    // tick, and an unlatched second tick would kill the fresh server tree.
    switching = true;
    try {
      if (await waitForUrl("http://localhost:8787/healthz", 1, 0)) return;
      if (serverChild.pid && serverChild.exitCode === null) killTree(serverChild.pid);
      for (const pid of listeningPids(8787)) forceKillPid(pid);
      if (movePending) {
        try {
          stateProfiles.performPendingHomeMove(loginHome);
          console.log("\nmoving where exxperts keeps its data; restarting the web server…");
        } catch (err) {
          console.error(`\ncould not move the exxperts data: ${err.message}\ncontinuing with the current location…`);
        }
      } else {
        console.log(`\nswitching to ${active === null ? "the standard profile (.exxperts)" : `profile "${active}"`}; restarting the web server…`);
      }
      // The next leg adopts the home the pointer names now: the new one after a
      // move that ran, the intact old one after a move that failed.
      leg = serverLeg();
      lastActive = stateProfiles.readActiveProfile(leg.home);
      serverChild = startDevService(path.join("apps", "web-server"), serverLog, leg.env);
    } finally {
      switching = false;
    }
  })().catch((err) => {
    console.error(`\ncould not restart the web server: ${err.message}`);
  });
}, 500);

console.log("\nPress Ctrl+C to stop both.");
// The UI child is the harness's lifetime anchor: the server child is
// replaced on every profile switch, so its exit is not an ending.
await new Promise((r) => uiChild.on("exit", r));
clearInterval(switchWatcher);
