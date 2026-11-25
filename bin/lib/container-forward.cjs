// `exxperts --container`: the server keeps listening on 127.0.0.1 only, and
// the launcher also listens on the container's own IPv4 addresses at the same
// port, passing each connection through to 127.0.0.1 untouched. A port the
// container runtime publishes arrives on those addresses, so the person's own
// computer reaches the app; the server's checks see a loopback peer and run
// unchanged on every request. The boundary is publishing the port to the
// person's own computer only: the peer rule below is a best-effort filter on
// the peer the launcher sees, since a runtime's port forwarder usually
// replaces the true source with its own private gateway address.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const { pipeline } = require("node:stream");

// The private tunnel's range (Tailscale and compatible meshes). Remote mode
// listens on the machine's own address there at the same port
// (apps/web-server/src/remote-mode.ts), so it gets no listener here, and a
// peer from it is dropped like any other non-private one.
const TUNNEL = new net.BlockList();
TUNNEL.addSubnet("100.64.0.0", 10, "ipv4");

const ACCEPTED_PEERS = new net.BlockList();
ACCEPTED_PEERS.addSubnet("127.0.0.0", 8, "ipv4");
ACCEPTED_PEERS.addSubnet("10.0.0.0", 8, "ipv4");
ACCEPTED_PEERS.addSubnet("172.16.0.0", 12, "ipv4");
ACCEPTED_PEERS.addSubnet("192.168.0.0", 16, "ipv4");
ACCEPTED_PEERS.addSubnet("169.254.0.0", 16, "ipv4");

/** Whether a connection from this peer address is passed on: loopback, private or link-local IPv4 only. */
function acceptsPeer(address) {
  return net.isIPv4(String(address)) && ACCEPTED_PEERS.check(address, "ipv4");
}

/** The addresses that get a listener: each non-loopback IPv4 address outside the tunnel's range, once. */
function listenAddresses(interfaces = os.networkInterfaces()) {
  const found = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!net.isIPv4(entry.address) || entry.address.startsWith("127.") || TUNNEL.check(entry.address, "ipv4")) continue;
      found.add(entry.address);
    }
  }
  return [...found];
}

// A refused peer's line is printed once per address; past this many
// addresses the refusals go on, unprinted, so a flood can't grow the set.
const REFUSED_LINES_LIMIT = 256;
// Connections one listener passes on at once; past it the listener takes no
// more until one ends. A browser opens a handful.
const CONNECTIONS_LIMIT = 256;

/**
 * The door every accepted connection passes: true for a peer the rule
 * accepts; any other is destroyed, and the first one from each address prints
 * one line through `log`.
 */
function peerDoor(log) {
  const refused = new Set();
  return (peer) => {
    if (acceptsPeer(peer.remoteAddress)) return true;
    // A peer gone before it was accepted has no address to name.
    if (peer.remoteAddress && !refused.has(peer.remoteAddress) && refused.size < REFUSED_LINES_LIMIT) {
      refused.add(peer.remoteAddress);
      log(`Refused a connection from ${peer.remoteAddress}: with --container exxperts accepts only this computer's own and private addresses.`);
    }
    peer.destroy();
    return false;
  };
}

/**
 * Opens one listener per address at `port`, each passing accepted connections
 * to 127.0.0.1:`port`. Resolves to the open listeners' addresses and a
 * close(); rejects with the reason when there is no address or one cannot
 * bind, with every listener it opened closed again.
 */
async function openContainerListeners(port, { addresses = listenAddresses(), log = (line) => console.error(line) } = {}) {
  if (addresses.length === 0) throw new Error("Could not start exxperts for a container: it has no address besides 127.0.0.1.");
  const sockets = new Set();
  const listeners = [];
  const close = () => {
    for (const listener of listeners) listener.close();
    for (const socket of sockets) socket.destroy();
  };
  const admits = peerDoor(log);
  const forward = (peer) => {
    if (!admits(peer)) return;
    const upstream = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    for (const socket of [peer, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    // Each direction ends on its own, so a side that has finished sending
    // still gets its answer; an error or an early close on either side ends
    // both.
    pipeline(peer, upstream, () => {});
    pipeline(upstream, peer, () => {});
  };
  for (const address of addresses) {
    const listener = net.createServer({ allowHalfOpen: true }, forward);
    listener.maxConnections = CONNECTIONS_LIMIT;
    listeners.push(listener);
    try {
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen({ host: address, port }, resolve);
      });
    } catch (err) {
      close();
      throw new Error(`Could not start exxperts for a container: ${address}:${port} is not free to listen on (${err.code || err.message}).`);
    }
    // Once listening, an error taking a connection (too many open files, say)
    // costs that connection only: one line per kind, and the listener stays.
    const said = new Set();
    listener.removeAllListeners("error");
    listener.on("error", (err) => {
      const kind = err.code || err.message;
      if (said.has(kind)) return;
      said.add(kind);
      log(`exxperts for a container could not take a connection on ${address}:${port} (${kind}).`);
    });
  }
  return { addresses, close };
}

// The marks container runtimes leave: Docker's file, Podman's, the file
// systemd writes inside a container, the `container` variable Podman, LXC and
// systemd-nspawn set, and the variable Kubernetes sets in every pod. Some
// sandboxes that are small virtual machines carry none of them, so a miss
// only chooses whether the start lines warn; it never refuses.
const CONTAINER_FILES = ["/.dockerenv", "/run/.containerenv", "/run/systemd/container"];
const CONTAINER_VARIABLES = ["container", "KUBERNETES_SERVICE_HOST"];

/** Whether any container mark is found. Reads whether each is there, never a value into a log. */
function looksLikeContainer({ exists = fs.existsSync, env = process.env } = {}) {
  return CONTAINER_FILES.some((file) => exists(file)) || CONTAINER_VARIABLES.some((name) => Boolean(env[name]));
}

/**
 * The lines a start with --container prints, in place of the usual "running
 * at". Where no container is found the listeners may face an ordinary
 * computer's network, and one line says so.
 */
function containerStartLines(url, port, addresses, signInUrl, containerFound) {
  const also = addresses.map((address) => `${address}:${port}`).join(", ");
  const lines = [
    "",
    `exxperts running at ${url} for a container, also on ${also}.`,
    `Publish this port to your own computer only, with the same number on both sides: -p 127.0.0.1:${port}:${port}`,
    ...(containerFound
      ? []
      : [`exxperts found no sign of a container here. If this is an ordinary Linux computer, other computers on its network can reach port ${port}, and only the sign-in link's key protects it: start exxperts without --container there.`]),
    "Press Ctrl+C to stop.",
    "",
  ];
  if (signInUrl) lines.push("Open this link once in your computer's browser to sign it in:", signInUrl, "");
  return lines.join("\n");
}

module.exports = { acceptsPeer, listenAddresses, peerDoor, openContainerListeners, looksLikeContainer, containerStartLines };
