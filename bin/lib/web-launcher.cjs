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
  server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

  (async () => {
    const url = `http://localhost:${opts.port}`;
    for (let i = 0; i < 40; i++) {
      // If the server child already died (e.g. port in use), it printed why —
      // don't claim the app is running just because something answers on the port.
      if (server.exitCode !== null) return;
      if (await waitFor(`${url}/healthz`)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (server.exitCode !== null) return;
    const token = readAuthToken();
    const signInUrl = token ? `${url}/auth/session?token=${encodeURIComponent(token)}` : url;
    console.error(`\nexxperts web running at ${url}\nPress Ctrl+C to stop.\n`);
    if (opts.open) openBrowser(signInUrl);
    else if (token) console.error(`Open this link once to sign the browser in:\n${signInUrl}\n`);
  })();
}

module.exports = { main, usage };
