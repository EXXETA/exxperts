// `exxperts remote ...` — the CLI face of remote mode. Talks to the RUNNING
// server's loopback admin API with the client auth token; remote mode's
// source of truth (the state file, the device records) lives server-side.
// The one offline affordance is `disable`, which deletes the state file
// directly when no server is up, so "make it off" always works.
const fs = require("node:fs");
const http = require("node:http");
const readline = require("node:readline");
const { productAppStatePath } = require("./product-state-paths.cjs");

const DEFAULT_PORT = Number(process.env.PORT || 8787);

function usage() {
  console.log(`Usage: exxperts remote <enable|disable|status|devices|revoke|hide|expose> [--port <port>]

  enable            turn remote mode on and pair a device (shows a QR, waits for your approval)
  disable           turn remote mode off instantly (works even when the server is down)
  status            show whether remote mode is serving, on which address, and paired devices
  devices           list paired devices
  revoke <id>       sign a device out everywhere and remove it
  hide <room>       hide a room from remote devices
  expose <room>     make a room reachable remotely again (the default for every room)

Remote mode serves the app to your own enrolled devices over your private tunnel
(Tailscale or compatible). It is off by default; when off, the server is
loopback-only, exactly as without this feature.`);
}

function readAuthToken() {
  const fromEnv = String(process.env.EXXPERTS_AUTH_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(productAppStatePath("auth-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function api(port, token, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          "X-Exxperts-Auth": token,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch {}
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function serverReachable(port) {
  try {
    const res = await api(port, "", "GET", "/healthz", null);
    return res.status === 200;
  } catch {
    return false;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function formatDevices(devices) {
  if (!devices.length) return "  (no paired devices)";
  return devices
    .map((d) => `  ${d.id}  ${d.name}  ${d.capability === "full" ? "full access" : "viewing only"}  last seen ${d.lastSeenAt ? d.lastSeenAt.slice(0, 16).replace("T", " ") : "never"}`)
    .join("\n");
}

// The serving URL as a device sees it: name-primary under https (the
// certificate is for the MagicDNS name), address-primary on plain http.
function servingUrl(s, fallbackPort) {
  const host = s.scheme === "https" && s.dnsName ? s.dnsName : s.address.includes(":") ? `[${s.address}]` : s.address;
  return `${s.scheme || "http"}://${host}:${s.port || fallbackPort}`;
}

async function cmdStatus(port, token) {
  const status = await api(port, token, "GET", "/api/remote/status", null);
  if (status.status !== 200) {
    console.error(`Could not read remote status (HTTP ${status.status}).`);
    return 1;
  }
  const s = status.body;
  if (s.enabled) {
    console.log(`Remote mode is ON, serving ${servingUrl(s, port)} to your enrolled devices.`);
    if (s.scheme === "http" && s.tlsFallbackReason) {
      console.log(`Plain http inside the encrypted tunnel (${s.tlsFallbackReason}).`);
    }
  } else if (s.stateFile === "valid") {
    console.log(`Remote mode is enabled but NOT serving: ${s.degradedReason || "waiting for the tunnel address"}.`);
    console.log("Local use is unaffected. It resumes by itself when the tunnel is back.");
  } else if (s.stateFile === "malformed") {
    console.log(`Remote mode is OFF (state file unreadable: ${s.degradedReason || "malformed"}). Run exxperts remote enable to rewrite it.`);
  } else {
    console.log("Remote mode is OFF. The server is loopback-only.");
  }
  const devices = await api(port, token, "GET", "/api/remote/devices", null);
  if (devices.status === 200) {
    console.log("Paired devices:");
    console.log(formatDevices(devices.body.devices));
  }
  const rooms = await api(port, token, "GET", "/api/remote/rooms", null);
  if (rooms.status === 200 && rooms.body.hidden.length) {
    console.log(`Hidden from remote: ${rooms.body.hidden.join(", ")}`);
  }
  return 0;
}

async function cmdEnable(port, token) {
  const enable = await api(port, token, "POST", "/api/remote/enable", null);
  if (enable.status !== 200) {
    console.error(enable.body && enable.body.error ? enable.body.error : `Could not enable remote mode (HTTP ${enable.status}).`);
    return 1;
  }
  const enabledStatus = enable.body.status || { address: enable.body.address, port };
  console.log(`Remote mode is ON, serving ${servingUrl(enabledStatus, port)} to your enrolled devices.`);
  if (enabledStatus.scheme === "http" && enabledStatus.tlsFallbackReason) {
    console.log(`Plain http inside the encrypted tunnel (${enabledStatus.tlsFallbackReason}).`);
  }
  console.log("");

  const minted = await api(port, token, "POST", "/api/remote/enroll-code", null);
  if (minted.status !== 200) {
    console.error(minted.body && minted.body.error ? minted.body.error : "Could not create a pairing code.");
    return 1;
  }
  const pairingUrl = String(minted.body.url);
  console.log("Pair a device: make sure it is on your tunnel (Tailscale app, same account), then scan:");
  console.log("");
  try {
    require("qrcode-terminal").generate(pairingUrl, { small: true });
  } catch {
    // QR rendering is a nicety; the URL below is the mechanism.
  }
  console.log(pairingUrl);
  console.log("");
  console.log("The code works once and expires in 10 minutes. Waiting for the device (Ctrl+C to stop waiting; remote stays on)...");

  // Poll for the pairing request the phone parks, then ask for the explicit
  // approval that enrollment requires.
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const pending = await api(port, token, "GET", "/api/remote/enroll-pending", null);
    if (pending.status !== 200 || !pending.body.pending.length) continue;
    const request = pending.body.pending[0];
    const answer = await ask(`"${request.deviceName}" asks to pair. Approve? [y/N] `);
    if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
      const approve = await api(port, token, "POST", "/api/remote/enroll-approve", { requestId: request.requestId });
      if (approve.status === 200) {
        console.log("Approved. The device signs itself in within a few seconds.");
        console.log("Manage devices anytime: exxperts remote status");
        return 0;
      }
      console.error("Approval failed; the request may have expired. Run exxperts remote enable again for a fresh code.");
      return 1;
    }
    await api(port, token, "POST", "/api/remote/enroll-deny", { requestId: request.requestId });
    console.log("Declined. The code is used up; run exxperts remote enable again for a fresh one.");
    return 0;
  }
  console.log("No device paired before the code expired. Remote stays on; run exxperts remote enable again for a fresh code.");
  return 0;
}

async function main(argv, invokedAs) {
  const args = [...argv];
  let port = DEFAULT_PORT;
  const portIndex = args.indexOf("--port");
  if (portIndex !== -1) {
    port = Number(args[portIndex + 1]);
    args.splice(portIndex, 2);
    if (!Number.isInteger(port) || port <= 0) {
      console.error(`${invokedAs}: --port needs a number`);
      process.exit(2);
    }
  }
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(command ? 0 : 2);
  }

  const running = await serverReachable(port);

  if (command === "disable" && !running) {
    // Offline disable: delete the state file so the next boot is plain OFF.
    try {
      fs.unlinkSync(productAppStatePath("remote-mode.json"));
      console.log("Remote mode is OFF on disk (the server did not answer on this port).");
      console.log("If the app is still running somewhere, restart it to be sure remote is fully off.");
    } catch (err) {
      if (err && err.code === "ENOENT") console.log("Remote mode is already OFF.");
      else {
        console.error(`Could not remove the remote state file: ${err.message}`);
        process.exit(1);
      }
    }
    process.exit(0);
  }

  if (!running) {
    console.error(`The Exxperts server is not running on port ${port}. Start it with: exxperts web`);
    process.exit(1);
  }
  const token = readAuthToken();
  if (!token) {
    console.error("No auth token found. Start the app once with: exxperts web");
    process.exit(1);
  }

  try {
    if (command === "status") process.exit(await cmdStatus(port, token));
    if (command === "enable") process.exit(await cmdEnable(port, token));
    if (command === "disable") {
      const res = await api(port, token, "POST", "/api/remote/disable", null);
      if (res.status !== 200) {
        console.error(`Could not disable remote mode (HTTP ${res.status}).`);
        process.exit(1);
      }
      console.log("Remote mode is OFF. The server is loopback-only again, and every remote session is signed out.");
      process.exit(0);
    }
    if (command === "devices") {
      const res = await api(port, token, "GET", "/api/remote/devices", null);
      if (res.status !== 200) { console.error(`Could not list devices (HTTP ${res.status}).`); process.exit(1); }
      console.log(formatDevices(res.body.devices));
      process.exit(0);
    }
    if (command === "revoke") {
      const id = String(args[1] || "");
      if (!id) { console.error("Usage: exxperts remote revoke <device-id> (ids: exxperts remote devices)"); process.exit(2); }
      const res = await api(port, token, "POST", "/api/remote/devices/revoke", { id });
      if (res.status === 404) { console.error("No such device."); process.exit(1); }
      if (res.status !== 200) { console.error(`Could not revoke (HTTP ${res.status}).`); process.exit(1); }
      console.log("Revoked. Its sessions are closed and its key no longer works.");
      process.exit(0);
    }
    if (command === "hide" || command === "expose") {
      const room = String(args[1] || "");
      if (!room) { console.error(`Usage: exxperts remote ${command} <room-id>`); process.exit(2); }
      const res = await api(port, token, "POST", "/api/remote/rooms/exposure", { id: room, exposed: command === "expose" });
      if (res.status !== 200) { console.error(`Could not update exposure (HTTP ${res.status}).`); process.exit(1); }
      if (command === "hide") {
        console.log(`Room "${room}" is hidden from remote devices.`);
        console.log("Hiding tidies the remote view; it is not a security control. To keep a room truly unreachable from a device, revoke that device (exxperts remote revoke).");
      } else {
        console.log(`Room "${room}" is reachable remotely.`);
      }
      process.exit(0);
    }
    console.error(`${invokedAs}: unknown command "${command}"`);
    usage();
    process.exit(2);
  } catch (err) {
    console.error(`${invokedAs}: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { main };
