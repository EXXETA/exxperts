const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { ensureProductAppUserDirs, productAppStatePath } = require("./product-state-paths.cjs");
const stateProfiles = require("./state-profiles.cjs");

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
function readAuthToken(home) {
  const fromEnv = String(process.env.EXXPERTS_AUTH_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  // The token belongs to the ACTIVE profile's tree (standard ~/.exxperts or
  // ~/.exxperts-<name>/.exxperts) inside the home THIS leg runs against, so
  // the caller passes that home in rather than asking the environment.
  try {
    return fs.readFileSync(stateProfiles.activeTokenPath(home), "utf8").trim() || null;
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

  // The login home anchors the exxperts-home pointer and move intents, and
  // stays the home every tool a room spawns sees.
  const loginHome = os.homedir();
  // The environment this process was STARTED with, before any adopt points its
  // state home somewhere in place. Every server leg is built from this copy:
  // the data folder can move between legs, and a leg that inherited the
  // previous leg's adopted process.env would run against the folder the data
  // just left.
  const baseEnv = { ...process.env };
  // Complete a move a dying run left behind, then point this process at the
  // exxperts home before ANYTHING (setup branch, ensureDirs, profile pointer
  // reads) resolves a state path.
  // A move that cannot run is not a reason not to start: it left the old home
  // intact and the pointer still names it, so the run continues there and
  // says why. Only an unusable home is fatal.
  try {
    stateProfiles.performPendingHomeMove(loginHome);
  } catch (err) {
    console.error(`\nCould not move the exxperts data: ${err.message}\nContinuing with the current location.\n`);
  }
  try {
    stateProfiles.adoptStateHome(loginHome);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

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
    // Spread per leg on top of a fresh copy of baseEnv: the exxperts home can
    // move between legs, and each leg adopts the home into its own copy.
    const extraEnv = {
      EXXETA_HOME: root,
      NODE_ENV: process.env.NODE_ENV || "production",
      PORT: String(opts.port),
      // This launcher restarts the server on profile switches and executes
      // home moves (loop below); the routes refuse on servers that run
      // without a supervisor.
      EXXPERTS_SWITCH_SUPERVISED: "1",
      EXXPERTS_HOME_MOVE_SUPERVISED: "1",
      // Where the home pointer and move intents live, whatever the data
      // folder currently is.
      EXXPERTS_LOGIN_HOME: loginHome,
    };
    const url = `http://localhost:${opts.port}`;

    let server = null;
    let stopping = false;
    let firstLeg = true;
    function stop() {
      stopping = true;
      if (server && !server.killed) server.kill("SIGTERM");
    }
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    // Runs until the server exits for any reason other than a profile switch
    // (the sentinel exit code). Each leg reads the active-profile pointer and
    // points the server's env at that profile's tree; the standard profile
    // runs with the plain environment. Nothing is ever renamed.
    for (;;) {
      if (stopping) process.exit(0);
      const legEnv = { ...baseEnv, ...extraEnv };
      // A leg that exited for a home move left an intent behind: execute it
      // now, while nothing has the trees open.
      try {
        stateProfiles.performPendingHomeMove(loginHome);
      } catch (err) {
        console.error(`\nCould not move the exxperts data: ${err.message}\nContinuing with the current location.\n`);
      }
      // The pointer says where this leg belongs: the new home after a move
      // that ran, the intact old one after a move that failed, and no pointer
      // at all (the login home) after a move back. Adopted into this leg's own
      // env copy, so no leg can inherit the one before it.
      const { home } = stateProfiles.adoptStateHome(loginHome, legEnv);
      const activeProfile = stateProfiles.readActiveProfile(home);
      server = spawn(process.execPath, [tsxCli, serverEntry], {
        cwd: root,
        stdio: "inherit",
        env: { ...legEnv, EXXPERTS_REAL_HOME: home, ...stateProfiles.serverEnvForProfile(home, activeProfile) },
      });
      const exited = new Promise((resolve) => {
        server.on("error", (err) => {
          console.error(`Could not start the exxperts web server: ${err.message}`);
          process.exit(1);
        });
        server.on("exit", (code, signal) => resolve({ code, signal }));
      });

      let ready = false;
      // If the server child already died (e.g. port in use), it printed why —
      // don't claim the app is running just because something answers on the port.
      for (let i = 0; i < 40 && !ready && server.exitCode === null; i++) {
        ready = await waitFor(`${url}/healthz`);
        if (!ready) await new Promise((r) => setTimeout(r, 250));
      }
      if (!ready && server.exitCode === null) {
        // Say so and keep waiting instead of claiming success: the first start
        // after an install or update pays a cold TypeScript startup that can
        // outlast the poll window, especially on Windows.
        console.error(`\nThe web server is not answering on ${url} yet. The first start after an install or update can be slow; still waiting. Press Ctrl+C to stop.`);
        while (!ready && server.exitCode === null) {
          ready = await waitFor(`${url}/healthz`);
          if (!ready) await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (server.exitCode === null) {
        // The token is re-read per leg: it lives inside the profile, so a
        // switch rotates it. The browser only opens on the first leg: after
        // a switch the already-open page signs itself into the new profile,
        // and a second tab would just be litter; the link is still printed
        // for anyone who closed that page.
        const token = readAuthToken(home);
        const signInUrl = token ? `${url}/auth/session?token=${encodeURIComponent(token)}` : url;
        console.error(`\nexxperts web running at ${url}\nPress Ctrl+C to stop.\n`);
        if (opts.open && firstLeg) openBrowser(signInUrl);
        else if (token) console.error(`Open this link once to sign the browser in:\n${signInUrl}\n`);
      }
      firstLeg = false;

      const { code, signal } = await exited;
      if (!stopping && code === stateProfiles.SWITCH_EXIT_CODE) {
        // The server already updated the active-profile pointer (or recorded
        // a home-move intent); the next leg picks it up. No port pre-flight:
        // our own child just released the port.
        if (fs.existsSync(stateProfiles.homeMoveIntentPath(loginHome))) {
          console.error("\nMoving where exxperts keeps its data; restarting exxperts web…\n");
        } else {
          const next = stateProfiles.readActiveProfile(home);
          console.error(`\nSwitching to ${next === null ? "the standard profile (.exxperts)" : `profile "${next}"`}; restarting exxperts web…\n`);
        }
        continue;
      }
      process.exit(code ?? (signal ? 1 : 0));
    }
  })().catch((err) => {
    console.error(`Could not start exxperts web: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = { main, usage };
