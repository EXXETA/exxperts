#!/usr/bin/env node
// Start the Exxperts web server + Vite UI together and open the browser.
// Stops both when you Ctrl+C. Cross-platform port of the former bash-only
// scripts/exxeta-web (which now delegates here).

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
function readAuthToken() {
  const fromEnv = (process.env.EXXPERTS_AUTH_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    // Mirrors productAppStatePath("auth-token") in the web server; this dev
    // script cannot import the TS helper, so the two must move together.
    return fs.readFileSync(path.join(os.homedir(), ".exxperts", "app", "auth-token"), "utf8").trim() || null;
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

killStalePortListeners();
await new Promise((r) => setTimeout(r, 1000));

const cacheDir = path.join(EXXETA_HOME, ".exxperts-cache");
fs.mkdirSync(cacheDir, { recursive: true });
const serverLog = path.join(cacheDir, "web-server.log");
const uiLog = path.join(cacheDir, "web-ui.log");

function startDevService(relCwd, logPath) {
  const logFd = fs.openSync(logPath, "w");
  const cwd = path.join(EXXETA_HOME, relCwd);
  // npm on Windows is a .cmd shim, which Node only spawns through a shell.
  const child = isWindows
    ? spawn("npm run dev", { cwd, stdio: ["ignore", logFd, logFd], shell: true })
    : spawn("npm", ["run", "dev"], { cwd, stdio: ["ignore", logFd, logFd] });
  child.on("spawn", () => fs.closeSync(logFd));
  return child;
}

console.log(`starting web server  → ${serverLog}`);
const serverChild = startDevService(path.join("apps", "web-server"), serverLog);

console.log(`starting Vite UI     → ${uiLog}`);
const uiChild = startDevService(path.join("apps", "web-ui"), uiLog);

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  console.log(`\nstopping (PIDs: ${serverChild.pid}, ${uiChild.pid})`);
  for (const child of [serverChild, uiChild]) {
    if (child.pid && child.exitCode === null) {
      if (isWindows) forceKillPid(child.pid);
      else child.kill("SIGTERM");
    }
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

await waitForUrl("http://localhost:8787/healthz");
await waitForUrl("http://localhost:5173/");

console.log(`
  ✓ web server  http://localhost:8787  (logs: ${serverLog})
  ✓ web UI      http://localhost:5173  (logs: ${uiLog})
`);
const authToken = readAuthToken();
if (!authToken) console.log("No auth token at ~/.exxperts/app/auth-token; the browser will show the sign-in hint page.");
console.log("Opening browser…");
openBrowser(authToken ? `http://localhost:5173/auth/session?token=${encodeURIComponent(authToken)}` : "http://localhost:5173");

console.log("\nPress Ctrl+C to stop both.");
await Promise.all([
  new Promise((r) => serverChild.on("exit", r)),
  new Promise((r) => uiChild.on("exit", r)),
]);
