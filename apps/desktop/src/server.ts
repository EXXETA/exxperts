// Manages the exxperts web server as a child process of the desktop app.
//
// The shell stays additive: it launches the exact same server the `exxperts
// web` launcher runs (tsx over apps/web-server/src/index.ts with EXXETA_HOME,
// NODE_ENV=production and PORT), waits for /healthz, and reads the minted auth
// token from the app state dir. Nothing server-side changes for the app.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { app } from "electron";

export const PORT = Number(process.env.EXXPERTS_DESKTOP_PORT ?? 8787);
export const SERVER_ORIGIN = `http://localhost:${PORT}`;

const LOG_LINES_KEPT = 300;

// Packaged: the release-archive tree (app/ + vendor/node/) ships as an
// extraResource next to the asar, so the payload is exactly what the prebuilt
// archives install. Dev: the repo checkout three levels up from dist/.
export function serverRoot(): string {
  const override = process.env.EXXPERTS_DESKTOP_SERVER_ROOT;
  if (override && override.trim()) return path.resolve(override.trim());
  if (app.isPackaged) return path.join(process.resourcesPath, "server", "app");
  return path.resolve(__dirname, "..", "..", "..");
}

// The server must run under a real Node, not under Electron via
// ELECTRON_RUN_AS_NODE: the runtime's native modules (koffi, clipboard) are
// built for the plain-node ABI. Packaged builds will point this at the
// vendored node from the release archive.
export function nodeBinary(): string {
  const override = process.env.EXXPERTS_DESKTOP_NODE;
  if (override && override.trim()) return override.trim();
  if (app.isPackaged) {
    const vendored = process.platform === "win32"
      ? path.join(process.resourcesPath, "server", "vendor", "node", "node.exe")
      : path.join(process.resourcesPath, "server", "vendor", "node", "bin", "node");
    if (fs.existsSync(vendored)) return vendored;
    throw new Error(`The bundled Node runtime is missing at ${vendored}; the app package is incomplete.`);
  }
  const probe = process.platform === "win32"
    ? spawnSync("where", ["node"], { encoding: "utf8" })
    : spawnSync("/bin/sh", ["-lc", "command -v node"], { encoding: "utf8" });
  const found = probe.status === 0 ? (probe.stdout.split(/\r?\n/)[0] ?? "").trim() : "";
  if (found) return found;
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find a Node runtime to start the exxperts server. Install Node or set EXXPERTS_DESKTOP_NODE.");
}

// Scratch mode: relocate ALL exxperts state (app + agent) under a scratch home
// so dev runs never touch the real ~/.exxperts. The server and everything it
// spawns resolve state via os.homedir()/HOME and EXXPERTS_CODING_AGENT_DIR.
export function stateHome(): string {
  const scratch = process.env.EXXPERTS_DESKTOP_SCRATCH_HOME;
  if (scratch && scratch.trim()) return path.resolve(scratch.trim());
  return os.homedir();
}

export function serverEnv(): NodeJS.ProcessEnv {
  const root = serverRoot();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXXETA_HOME: root,
    NODE_ENV: process.env.NODE_ENV || "production",
    PORT: String(PORT),
  };
  const scratch = process.env.EXXPERTS_DESKTOP_SCRATCH_HOME;
  if (scratch && scratch.trim()) {
    const home = path.resolve(scratch.trim());
    env.HOME = home;
    env.USERPROFILE = home;
    env.EXXPERTS_CODING_AGENT_DIR = path.join(home, ".exxperts", "agent");
  }
  return env;
}

// The server tree's own version (in a packaged app: the bundled payload,
// which can differ from the shell version between releases).
export function payloadVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(serverRoot(), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export type PortState =
  | { kind: "free" }
  | { kind: "exxperts" }
  | { kind: "other"; detail: string };

// Classifies what (if anything) is listening on our port before we spawn.
export async function probePort(): Promise<PortState> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) });
    const body = await res.text();
    try {
      // The real /healthz answers {ok:true, persona:"..."}; require both so a
      // random local service echoing {"ok":true} is never offered for takeover.
      const parsed = JSON.parse(body) as { ok?: unknown; persona?: unknown };
      if (parsed && parsed.ok === true && typeof parsed.persona === "string") return { kind: "exxperts" };
    } catch {
      // fall through: something non-exxperts answered
    }
    return { kind: "other", detail: `HTTP ${res.status} from an unrecognized service` };
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
    if (code === "ECONNREFUSED") return { kind: "free" };
    if (err instanceof Error && err.name === "TimeoutError") return { kind: "other", detail: "a service that did not answer /healthz in time" };
    // ECONNRESET and friends: something owns the socket but is not speaking
    // plain HTTP to us; treat as an unrecognized occupant.
    return { kind: "other", detail: code ? String(code) : "an unrecognized service" };
  }
}

function pidsOnPort(): number[] {
  if (process.platform === "win32") {
    const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    if (out.status !== 0) return [];
    const pids = new Set<number>();
    for (const line of out.stdout.split(/\r?\n/)) {
      if (line.includes(`:${PORT}`) && /LISTENING/i.test(line)) {
        const pid = Number(line.trim().split(/\s+/).pop());
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
    }
    return [...pids];
  }
  const out = spawnSync("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stops whatever is listening on the port (used after the user confirms the
// takeover dialog): polite signal first, escalate only if it lingers.
export async function takeOverPort(): Promise<void> {
  for (const escalate of [false, true]) {
    const pids = pidsOnPort();
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", escalate ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"]);
        } else {
          process.kill(pid, escalate ? "SIGKILL" : "SIGTERM");
        }
      } catch {
        // already gone
      }
    }
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (pidsOnPort().length === 0) return;
    }
  }
  if (pidsOnPort().length > 0) throw new Error(`Could not free port ${PORT}; the existing server refused to stop.`);
}

export class ServerHandle {
  private child: ChildProcess | null = null;
  private logLines: string[] = [];
  private exited: { code: number | null; signal: string | null } | null = null;
  private stopping = false;
  private unexpectedExit: ((code: number | null, signal: string | null) => void) | null = null;

  get running(): boolean {
    return this.child !== null && this.exited === null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  // Fired when the child dies WITHOUT stop() having been asked for - the
  // watchdog signal. Survives restarts (start() re-arms it on the new child).
  onUnexpectedExit(cb: (code: number | null, signal: string | null) => void): void {
    this.unexpectedExit = cb;
  }

  logTail(lines = 40): string {
    return this.logLines.slice(-lines).join("\n");
  }

  start(): void {
    const root = serverRoot();
    const requireFromRoot = createRequire(path.join(root, "package.json"));
    // Deliberately NOT tsx/cli: that is a wrapper which spawns the real
    // server as a grandchild, so signals to our child hit the wrapper and a
    // SIGKILL orphans the actual server (found live: the orphan kept
    // answering /healthz and faked out the watchdog). Spawning node with
    // tsx's loader flags directly makes the child BE the server - one
    // process, exact signals, exact watchdog.
    const tsxDir = path.dirname(requireFromRoot.resolve("tsx/package.json"));
    const serverEntry = path.join(root, "apps", "web-server", "src", "index.ts");
    const child = spawn(nodeBinary(), [
      "--require", path.join(tsxDir, "dist", "preflight.cjs"),
      "--import", pathToFileURL(path.join(tsxDir, "dist", "loader.mjs")).href,
      serverEntry,
    ], {
      cwd: root,
      env: serverEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer, sink: NodeJS.WriteStream) => {
      const text = chunk.toString("utf8");
      sink.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.logLines.push(line);
      }
      if (this.logLines.length > LOG_LINES_KEPT) this.logLines = this.logLines.slice(-LOG_LINES_KEPT);
    };
    child.stdout?.on("data", (c: Buffer) => keep(c, process.stdout));
    child.stderr?.on("data", (c: Buffer) => keep(c, process.stderr));
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      if (!this.stopping) this.unexpectedExit?.(code, signal);
    });
    this.child = child;
    this.exited = null;
    this.stopping = false;
  }

  // Mirrors web-launcher.cjs: poll /healthz, but bail out the moment the
  // child dies so a crash surfaces its log instead of a timeout.
  async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) {
        throw new Error(`The exxperts server exited during startup (code ${this.exited.code ?? "?"}${this.exited.signal ? `, signal ${this.exited.signal}` : ""}).`);
      }
      try {
        const res = await fetch(`${SERVER_ORIGIN}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (res.status < 500) return;
      } catch {
        // not up yet
      }
      await sleep(250);
    }
    throw new Error(`The exxperts server did not become ready on port ${PORT} within ${Math.round(timeoutMs / 1000)}s.`);
  }

  // The server mints the token before listen(), so after /healthz answers the
  // file exists; the short retry covers filesystem lag only. An exported
  // EXXPERTS_AUTH_TOKEN wins: the server then uses the env value and never
  // writes the file, so reading a (possibly stale) file would 403.
  async authToken(): Promise<string> {
    const envToken = process.env.EXXPERTS_AUTH_TOKEN?.trim();
    if (envToken) return envToken;
    const tokenFile = path.join(stateHome(), ".exxperts", "app", "auth-token");
    for (let i = 0; i < 20; i++) {
      try {
        const token = fs.readFileSync(tokenFile, "utf8").trim();
        if (token) return token;
      } catch {
        // not there yet
      }
      await sleep(150);
    }
    throw new Error(`No auth token appeared at ${tokenFile}; cannot sign the window in.`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    if (!child || this.exited) return;
    child.kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !this.exited) {
      await sleep(100);
    }
    if (!this.exited) {
      child.kill("SIGKILL");
      // Wait for the kill to land so quit cannot exit above a live child.
      const hardDeadline = Date.now() + 2000;
      while (Date.now() < hardDeadline && !this.exited) {
        await sleep(50);
      }
    }
  }
}
