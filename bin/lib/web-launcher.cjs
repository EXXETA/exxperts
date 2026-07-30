const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { ensureProductAppUserDirs, productAppStatePath } = require("./product-state-paths.cjs");

function usage(command) {
  return `Usage: ${command} [--port <port>] [--no-open] [--help]\n\nStarts the local exxperts business/user web app, serves the built UI,\nand opens the browser unless --no-open is set.\n\nOptions:\n  --port <port>   Port for the local server (default: 8787 or PORT)\n  --no-open       Do not open a browser\n  --help          Show this help\n`;
}

function parseArgs(argv) {
  const opts = { port: process.env.PORT || "8787", open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--port") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--port requires a value");
      opts.port = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!/^\d+$/.test(String(opts.port))) throw new Error(`Invalid port: ${opts.port}`);
  return opts;
}

function ensureDirs() {
  ensureProductAppUserDirs();
}

function loadDotenv(root) {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
  } catch {}
}

// One-shot pre-flight before spawning the server: is something already on the
// chosen port? "responding" (an earlier exxperts web server, or another app,
// answers HTTP there) and "unresponsive" (the port is held but nothing ever
// replies — a wedged process) both mean the fresh server child would only die
// with EADDRINUSE after its slow TypeScript startup, while the readiness poll
// gets answered by the OLD server — an instant false "running" banner, a
// browser opened at stale code, and an unexplained exit up to a minute later.
// ECONNREFUSED means the port is free; any other socket error stays
// inconclusive and the launch proceeds — the server's own EADDRINUSE message
// is the backstop for those.
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
      res.resume();
      resolve("responding");
    });
    req.on("error", (err) => resolve(err && err.code === "ECONNREFUSED" ? "free" : "inconclusive"));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve("unresponsive");
    });
  });
}

function portHeldMessage(command, port, portState) {
  const cause = portState === "responding"
    ? `Port ${port} is already in use. Most likely an exxperts web server from an earlier launch is still running (this can happen after an update, or when a previous session did not shut down).`
    : `Port ${port} is held by a process that is not responding; most likely an earlier exxperts web server that got stuck.`;
  const reuse = portState === "responding"
    ? `\n  - Or, to keep using the already-running server, open http://localhost:${port} in your browser.`
    : "";
  return `${cause}

What you can do:
  - Stop the other process: close its terminal window, or end the stray
    exxperts/node process (Windows: Task Manager, macOS: Activity Monitor),
    then run \`${command}\` again.
  - Or start on a different port: ${command} --port ${Number(port) + 1}${reuse}`;
}

function waitFor(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// The server mints its client auth token (or honors EXXPERTS_AUTH_TOKEN)
// before it starts listening, so once /healthz answers the token is readable.
// The browser is opened at /auth/session?token=<token>, which exchanges the
// token for an HttpOnly cookie and redirects to the app.
function readAuthToken() {
  const fromEnv = String(process.env.EXXPERTS_AUTH_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(productAppStatePath("auth-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch (err) {
    console.error(`Could not open browser automatically. Open ${url} manually.`);
  }
}

function main(argv = process.argv.slice(2), command = path.basename(process.argv[1] || "exxperts")) {
  const root = path.resolve(__dirname, "..", "..");

  // Product setup commands should not start the web server or require an
  // already-configured AI provider. Route them directly to the runtime setup
  // handler, matching the exxcode launcher behavior.
  if (argv[0] === "setup") {
    loadDotenv(root);
    const env = { ...process.env, EXXETA_HOME: root };
    const result = spawnSync(process.execPath, [path.join(root, "runtime", "packages", "coding-agent", "dist", "cli.js"), ...argv], {
      stdio: "inherit",
      env,
      cwd: process.cwd(),
    });
    process.exit(result.status ?? (result.signal ? 1 : 0));
  }

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(`\n${usage(command)}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage(command));
    return;
  }

  ensureDirs();
  loadDotenv(root);

  (async () => {
    const portState = await probePort(opts.port);
    if (portState === "responding" || portState === "unresponsive") {
      console.error(portHeldMessage(command, opts.port, portState));
      process.exit(1);
    }

    const tsxCli = require.resolve("tsx/cli");
    const serverEntry = path.join(root, "apps", "web-server", "src", "index.ts");
    const env = {
      ...process.env,
      EXXETA_HOME: root,
      NODE_ENV: process.env.NODE_ENV || "production",
      PORT: String(opts.port),
    };

    const server = spawn(process.execPath, [tsxCli, serverEntry], {
      cwd: root,
      stdio: "inherit",
      env,
    });

    function stop() {
      if (!server.killed) server.kill("SIGTERM");
    }
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    server.on("error", (err) => {
      console.error(`Could not start the exxperts web server: ${err.message}`);
      process.exit(1);
    });
    server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

    const url = `http://localhost:${opts.port}`;
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      // If the server child already died (e.g. port in use), it printed why —
      // don't claim the app is running just because something answers on the port.
      if (server.exitCode !== null) return;
      ready = await waitFor(`${url}/healthz`);
      if (!ready) await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) {
      // Say so and keep waiting instead of claiming success: the first start
      // after an install or update pays a cold TypeScript startup that can
      // outlast the poll window, especially on Windows.
      console.error(`\nThe web server is not answering on ${url} yet. The first start after an install or update can be slow; still waiting. Press Ctrl+C to stop.`);
      while (!ready) {
        if (server.exitCode !== null) return;
        ready = await waitFor(`${url}/healthz`);
        if (!ready) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (server.exitCode !== null) return;
    const token = readAuthToken();
    const signInUrl = token ? `${url}/auth/session?token=${encodeURIComponent(token)}` : url;
    console.error(`\nexxperts web running at ${url}\nPress Ctrl+C to stop.\n`);
    if (opts.open) openBrowser(signInUrl);
    else if (token) console.error(`Open this link once to sign the browser in:\n${signInUrl}\n`);
  })().catch((err) => {
    console.error(`Could not start exxperts web: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = { main, usage };
