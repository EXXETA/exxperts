const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { ensureProductAppUserDirs } = require("./product-state-paths.cjs");
const stateProfiles = require("./state-profiles.cjs");
const { serverLaunchArgs } = require("./server-entry.cjs");

// --port and --no-open work but stay out of the help: tests, CI and a home
// computer serving a phone use them; a person never needs them.
const HELP = "Usage: exxperts\nOpens exxperts in your browser. Everything else is in the app.";
const REMOVED = "The terminal app and its commands were removed in exxperts 0.15. Run `exxperts` to open the app; everything else is in the app.";

// Any word this command does not know gets REMOVED: it is either one of the
// terminal app's commands or a typo, and both are answered by the app.
function parseArgs(argv) {
  const opts = { port: process.env.PORT || "8787", open: true, help: false, unknown: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--port") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--port requires a value");
      opts.port = value;
    } else {
      return { ...opts, unknown: arg };
    }
  }
  if (!/^\d+$/.test(String(opts.port))) throw new Error(`Invalid port: ${opts.port}`);
  return opts;
}

// A start that fails says why: the launcher's own reason, then the failing
// lines of the health check's start checks (scripts/doctor.mjs
// --start-checks), which name the fix for a broken install. Only the first
// line of a system error is shown, so a person never gets a stack.
function cannotStart(root, reason) {
  console.error(reason);
  const checks = spawnSync(process.execPath, [path.join(root, "scripts", "doctor.mjs"), "--start-checks"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
  });
  const failing = String(checks.stdout || "").trimEnd();
  if (failing) console.error(`\n${failing}`);
  process.exit(1);
}

function firstLine(err) {
  return String(err && err.message ? err.message : err).split("\n")[0];
}

// What a server that died while starting printed, without Node's crash dump:
// its own sentences stay, and an uncaught error comes down to its message
// (from the line that names the error to the first stack frame, so a
// compiler's file, position and explanation stay), with the source excerpt
// Node prints above it, a "Require stack" list, the frames, the error's
// fields and the "Node.js v.." footer gone.
function withoutCrashDump(text) {
  const lines = text.split(/\r?\n/);
  const error = uncaughtError(lines);
  if (!error) return text;
  const { message } = error;
  let { shown } = error;
  let start = message;
  // Node's excerpt: "<file>:<line>", the source line, the caret, then a blank
  // line (Node 22 and later) or the error line right away (Node 20, which
  // also prints a blank line above the excerpt).
  const caret = lines[message - 1] === "" ? message - 2 : message - 1;
  if (caret >= 2 && /^\s*\^+\s*$/.test(lines[caret])) start = lines[caret - 3] === "" ? caret - 3 : caret - 2;
  const requireStack = shown.indexOf("Require stack:");
  if (requireStack > 0) shown = shown.slice(0, requireStack);
  return [...lines.slice(0, start), ...shown].join("\n").trim();
}

// The uncaught error in Node's crash text: the index of the line that names
// it and the lines of its message, or null. With stack frames the message
// runs from that line to the first frame. Without any (a stack trace limit
// of 0), Node prints the error inspected, "[<name>: <message>]" and its
// fields, above the "Node.js v.." footer; the brackets come off.
function uncaughtError(lines) {
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  if (firstFrame !== -1) {
    let message = firstFrame - 1;
    while (message > 0 && !/^\S*(Error|Exception)\b/.test(lines[message])) message--;
    return { message, shown: lines.slice(message, firstFrame) };
  }
  if (!lines.some((line) => /^Node\.js v\d/.test(line))) return null;
  const message = lines.findIndex((line) => /^\[\S*(Error|Exception)\b/.test(line));
  const close = lines.findIndex((line, index) => index >= message && /\]( \{)?$/.test(line));
  if (message === -1 || close === -1) return null;
  const shown = lines.slice(message, close + 1);
  shown[0] = shown[0].slice(1);
  shown[shown.length - 1] = shown[shown.length - 1].replace(/\]( \{)?$/, "");
  return { message, shown };
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
  // A missing opener (a Linux without xdg-open) fails after the spawn, as an
  // error event; unheard, it would end the launcher and leave the server.
  const failed = () => console.error(`Could not open the browser. Open this link once to sign the browser in:\n${url}\n`);
  try {
    const opener = spawn(command, args, { detached: true, stdio: "ignore" });
    opener.on("error", failed);
    opener.unref();
  } catch {
    failed();
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
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.unknown !== null) {
    console.error(REMOVED);
    process.exit(1);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  // Complete a move a dying run left behind, then point this process at the
  // exxperts home before ANYTHING (the data folders, profile pointer reads)
  // resolves a state path.
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
    cannotStart(root, err.message);
  }
  try {
    ensureProductAppUserDirs();
  } catch (err) {
    cannotStart(root, `Could not create the exxperts data folders: ${firstLine(err)}`);
  }
  loadDotenv(root);

  (async () => {
    const portState = await probePort(opts.port);
    if (portState === "responding" || portState === "unresponsive") {
      cannotStart(root, portHeldMessage(command, opts.port, portState));
    }
    const serverArgs = serverLaunchArgs(root);
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
      // The server's stderr is held while it starts: a server that dies
      // before it answers would print Node's raw stack there. Once it
      // answers, it passes straight through.
      server = spawn(process.execPath, serverArgs, {
        cwd: root,
        stdio: ["inherit", "inherit", "pipe"],
        env: { ...legEnv, EXXPERTS_REAL_HOME: home, ...stateProfiles.serverEnvForProfile(home, activeProfile) },
      });
      server.stderr.setEncoding("utf8");
      let heldStderr = "";
      let holdingStderr = true;
      server.stderr.on("data", (chunk) => {
        if (holdingStderr) heldStderr += chunk;
        else process.stderr.write(chunk);
      });
      const passStderrThrough = () => {
        if (!holdingStderr) return;
        holdingStderr = false;
        process.stderr.write(heldStderr);
        heldStderr = "";
      };
      // A process the server started can hold its stderr open, so the wait
      // for the rest of it is short.
      const stderrClosed = new Promise((resolve) => server.stderr.on("close", resolve));
      const stderrRead = () => Promise.race([stderrClosed, new Promise((r) => setTimeout(r, 2000))]);
      const exited = new Promise((resolve) => {
        server.on("error", (err) => cannotStart(root, `Could not start the exxperts web server: ${firstLine(err)}`));
        server.on("exit", (code, signal) => resolve({ code, signal }));
      });
      // A server ended by a signal keeps exitCode null and sets signalCode.
      const running = () => server.exitCode === null && server.signalCode === null;

      let ready = false;
      // If the server child already died (e.g. port in use), it printed why —
      // don't claim the app is running just because something answers on the port.
      for (let i = 0; i < 40 && !ready && running(); i++) {
        ready = await waitFor(`${url}/healthz`);
        if (!ready) await new Promise((r) => setTimeout(r, 250));
      }
      if (!ready && running()) {
        // Say so and keep waiting instead of claiming success: the first start
        // after an install or update pays a cold TypeScript startup that can
        // outlast the poll window, especially on Windows.
        console.error(`\nThe web server is not answering on ${url} yet. The first start after an install or update can be slow; still waiting. Press Ctrl+C to stop.`);
        while (!ready && running()) {
          ready = await waitFor(`${url}/healthz`);
          if (!ready) await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (running()) {
        passStderrThrough();
        // The token is re-read per leg: it lives inside the profile, so a
        // switch rotates it. The browser only opens on the first leg: after
        // a switch the already-open page signs itself into the new profile,
        // and a second tab would just be litter; the link is still printed
        // for anyone who closed that page.
        const token = readAuthToken(home);
        const signInUrl = token ? `${url}/auth/session?token=${encodeURIComponent(token)}` : url;
        console.error(`\nexxperts running at ${url}\nPress Ctrl+C to stop.\n`);
        if (opts.open && firstLeg) openBrowser(signInUrl);
        else if (token) console.error(`Open this link once to sign the browser in:\n${signInUrl}\n`);
      }
      const startedLeg = ready;
      firstLeg = false;

      const { code, signal } = await exited;
      if (!stopping && code === stateProfiles.SWITCH_EXIT_CODE) {
        // The server already updated the active-profile pointer (or recorded
        // a home-move intent); the next leg picks it up. No port pre-flight:
        // our own child just released the port.
        if (fs.existsSync(stateProfiles.homeMoveIntentPath(loginHome))) {
          console.error("\nMoving where exxperts keeps its data; restarting exxperts…\n");
        } else {
          const next = stateProfiles.readActiveProfile(home);
          console.error(`\nSwitching to ${next === null ? "the standard profile (.exxperts)" : `profile "${next}"`}; restarting exxperts…\n`);
        }
        continue;
      }
      // A server that never answered stopped while starting: the server said
      // what it knew, and the launcher adds the start checks. Its stderr may
      // still be arriving when it exits, so it is read to the end first.
      if (!stopping && !startedLeg) {
        if (holdingStderr) {
          await stderrRead();
          holdingStderr = false;
          const said = withoutCrashDump(heldStderr);
          if (said) console.error(said);
        }
        cannotStart(root, `The exxperts server stopped while starting (exit code ${code ?? signal}).`);
      }
      // The server's last words and the launcher's own queued writes reach a
      // slow pipe before the exit.
      passStderrThrough();
      await stderrRead();
      process.stderr.write("", () => process.exit(code ?? (signal ? 1 : 0)));
      return;
    }
  })().catch((err) => cannotStart(root, `Could not start exxperts: ${firstLine(err)}`));
}

module.exports = { main };
