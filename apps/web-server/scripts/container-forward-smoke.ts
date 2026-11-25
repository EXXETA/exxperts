// `exxperts --container` (bin/lib/container-forward.cjs, wired in
// bin/lib/web-launcher.cjs). Two halves, and the smoke says which one ran.
// Everywhere: the peer rule alone, the addresses that get a listener, the
// refused peer's line once per address, the listeners passing a connection
// through untouched and failing closed, and a start without the flag leaving
// this machine's own non-loopback address unanswered. Not Linux: the flag is
// refused before anything starts. Whether a container's marks are found, and
// the start lines with and without the line a start where none is found adds.
// Linux: through this machine's own
// non-loopback IPv4 address the app answers with the server's checks intact
// (Host, Origin, the proxy refusal, the token, the live connection's origin
// pin), a profile switch keeps the listeners, a listener that can't bind stops
// the start, and Ctrl+C or the server's own end leaves nothing listening. With
// no such address the smoke fails and says why.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, withoutSignInTokens } from "./smoke-server-process.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exxperts = path.join(repoRoot, "bin", "exxperts.cjs");
const forward = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "container-forward.cjs")) as {
	acceptsPeer(address: string): boolean;
	listenAddresses(interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[];
	peerDoor(log: (line: string) => void): (peer: { remoteAddress?: string; destroy(): void }) => boolean;
	openContainerListeners(port: number, options?: { addresses?: string[]; log?: (line: string) => void }): Promise<{ addresses: string[]; close(): void }>;
	looksLikeContainer(options?: { exists?: (file: string) => boolean; env?: Record<string, string | undefined> }): boolean;
	containerStartLines(url: string, port: string | number, addresses: string[], signInUrl: string | null, containerFound: boolean): string;
};

// The line a --container start adds when no container's mark is found, written
// out by hand.
const noContainerLine = (port: number) => `exxperts found no sign of a container here. If this is an ordinary Linux computer, other computers on its network can reach port ${port}, and only the sign-in link's key protects it: start exxperts without --container there.\n`;

const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-container-forward-")));

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const homeEnv = (home: string, extra: Record<string, string | undefined> = {}) =>
	smokeHomeEnv(home, { EXXETA_PERSISTENT_AGENTS_ROOT: path.join(home, "rooms"), ...SMOKE_SERVER_AUTH_ENV, ...extra });

function freshHome(name: string): string {
	const home = path.join(tempRoot, name);
	fs.mkdirSync(home, { recursive: true });
	return home;
}

/** Whether a TCP connection to host:port is accepted. */
function connects(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		socket.once("connect", () => { socket.destroy(); resolve(true); });
		socket.once("error", () => resolve(false));
	});
}

// Raw requests, so Host, Origin and the proxy headers are exactly what is sent.
function rawRequest(host: string, port: number, pathname: string, headers: Record<string, string>): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host, port, path: pathname, method: "GET", agent: false, headers, setDefaultHeaders: false } as http.RequestOptions, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk as Buffer));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
		});
		req.on("error", reject);
		req.end();
	});
}

// The live connection's handshake: 101 when accepted, the refusal's status,
// or -1 when the socket was reset while refusing.
function wsUpgrade(host: string, port: number, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host, port, path: "/ws", method: "GET", agent: false,
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				// Computed at runtime so no base64 literal sits in the source.
				"Sec-WebSocket-Key": Buffer.from("the sample nonce").toString("base64"),
				"Sec-WebSocket-Version": "13",
				...headers,
			},
		}, (res) => {
			res.on("error", () => {});
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("upgrade", (res, socket) => {
			socket.destroy();
			resolve(res.statusCode ?? 101);
		});
		req.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNRESET") resolve(-1);
			else reject(error);
		});
		req.end();
	});
}

interface Launch {
	child: ChildProcessWithoutNullStreams;
	output(): string;
	/** Waits until the output holds `text` the given number of times, or the launcher exits. */
	waitFor(text: string, times?: number): Promise<void>;
	exited: Promise<number | null>;
}

function launch(args: string[], home: string, env: Record<string, string> = {}): Launch {
	const child = spawn(process.execPath, [exxperts, ...args], { ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: tempRoot, env: homeEnv(home, env) as NodeJS.ProcessEnv });
	let output = "";
	child.stdout.on("data", (chunk) => { output += String(chunk); });
	child.stderr.on("data", (chunk) => { output += String(chunk); });
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	const count = (text: string) => output.split(text).length - 1;
	return {
		child,
		output: () => output,
		exited,
		async waitFor(text, times = 1) {
			const deadline = Date.now() + 180_000;
			while (count(text) < times && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
			assert(count(text) >= times, `waited for ${JSON.stringify(text)} x${times}, got exit ${child.exitCode ?? child.signalCode}:\n${withoutSignInTokens(output)}`);
		},
	};
}

// A process's children, read from /proc (Linux only).
function childPids(parent: number): number[] {
	const children: number[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
			const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
			if (ppid === parent) children.push(Number(entry));
		} catch {}
	}
	return children;
}

// The server itself: the launcher starts it through tsx's command, which runs
// it as a child of its own, so it is the last process down the launcher's line
// that runs the web server (a helper the server starts runs something else).
function serverPid(launcher: number): number | undefined {
	const runsServer = (pid: number) => {
		try {
			return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("web-server");
		} catch {
			return false;
		}
	};
	let pid: number | undefined;
	for (let next = childPids(launcher).find(runsServer); next !== undefined; next = childPids(next).find(runsServer)) pid = next;
	return pid;
}

const isLinux = process.platform === "linux";
let running: ChildProcessWithoutNullStreams | undefined;
const others: (net.Server | http.Server)[] = [];
try {
	// --- The peer rule alone.
	for (const address of ["172.17.0.1", "192.168.65.1", "192.168.215.1", "10.0.2.2", "169.254.1.1", "127.0.0.1"]) {
		assert(forward.acceptsPeer(address), `${address} must be accepted`);
	}
	for (const address of ["8.8.8.8", "100.64.0.1", "203.0.113.7", "172.32.0.1", "::1", "::ffff:10.0.0.1", ""]) {
		assert(!forward.acceptsPeer(address), `${address} must be dropped`);
	}

	// A dropped peer is destroyed and prints its line once per address; an
	// accepted one passes without a line.
	{
		const lines: string[] = [];
		const admits = forward.peerDoor((line) => lines.push(line));
		let destroyed = 0;
		const peer = (remoteAddress: string | undefined) => ({ remoteAddress, destroy: () => { destroyed++; } });
		assert(!admits(peer("203.0.113.7")) && !admits(peer("203.0.113.7")) && !admits(peer("8.8.8.8")), "public peers must be dropped");
		// A peer gone before it was accepted has no address: dropped, with no line.
		assert(!admits(peer(undefined)), "a peer with no address must be dropped");
		assert(admits(peer("172.17.0.1")), "a private peer must be accepted");
		assert(destroyed === 4, `each dropped peer is destroyed, got ${destroyed}`);
		assert(lines.length === 2 && lines[0] === "Refused a connection from 203.0.113.7: with --container exxperts accepts only this computer's own and private addresses." && lines[1].startsWith("Refused a connection from 8.8.8.8:"), `one line per refused address, got ${JSON.stringify(lines)}`);
	}

	// --- Which addresses get a listener: non-loopback IPv4, once each,
	// never the tunnel's range (remote mode's own listener sits there at the
	// same port), never IPv6.
	{
		const entry = (address: string, family: "IPv4" | "IPv6", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as os.NetworkInterfaceInfo;
		const chosen = forward.listenAddresses({
			lo: [entry("127.0.0.1", "IPv4", true), entry("::1", "IPv6", true)],
			eth0: [entry("172.17.0.2", "IPv4"), entry("fe80::1", "IPv6")],
			eth1: [entry("172.17.0.2", "IPv4"), entry("10.0.2.15", "IPv4")],
			tailscale0: [entry("100.101.102.103", "IPv4"), entry("100.64.0.1", "IPv4")],
		});
		assert(JSON.stringify(chosen) === JSON.stringify(["172.17.0.2", "10.0.2.15"]), `listener addresses, got ${JSON.stringify(chosen)}`);
		assert(forward.listenAddresses({ lo: [entry("127.0.0.1", "IPv4", true)] }).length === 0, "loopback alone gives no address");
	}

	// --- A container's marks: each one alone counts, an empty variable or a
	// name in other letters does not, and with none found the answer is no.
	{
		const marks = ["/.dockerenv", "/run/.containerenv", "/run/systemd/container"];
		const looked: string[] = [];
		const nothing = (file: string) => { looked.push(file); return false; };
		assert(!forward.looksLikeContainer({ exists: nothing, env: { PATH: "/usr/bin", CONTAINER: "docker", container: "", KUBERNETES_SERVICE_HOST: "" } }), "with no mark found it is not a container");
		assert(marks.every((file) => looked.includes(file)), `each mark's file is looked for, got ${JSON.stringify(looked)}`);
		for (const file of marks) {
			assert(forward.looksLikeContainer({ exists: (found) => found === file, env: {} }), `${file} alone marks a container`);
		}
		for (const name of ["container", "KUBERNETES_SERVICE_HOST"]) {
			assert(forward.looksLikeContainer({ exists: () => false, env: { [name]: "docker" } }), `${name} alone marks a container`);
		}
	}

	// --- The start lines: the no-container line sits after the publish line
	// when no mark is found, and is absent when one is.
	{
		const lines = (containerFound: boolean) => forward.containerStartLines("http://localhost:18790", 18790, ["172.17.0.2"], "http://localhost:18790/auth/session?token=t", containerFound);
		const head = "\nexxperts running at http://localhost:18790 for a container, also on 172.17.0.2:18790.\nPublish this port to your own computer only, with the same number on both sides: -p 127.0.0.1:18790:18790\n";
		const tail = "Press Ctrl+C to stop.\n\nOpen this link once in your computer's browser to sign it in:\nhttp://localhost:18790/auth/session?token=t\n";
		assert(lines(true) === head + tail, `a container found: no extra line, got:\n${lines(true)}`);
		assert(lines(false) === head + noContainerLine(18790) + tail, `no container found: the line after the publish line, got:\n${lines(false)}`);
	}

	const own = forward.listenAddresses()[0];
	assert(own, "this machine needs a non-loopback IPv4 address outside 100.64/10 for this smoke: connect it to a network");

	// --- The listeners on their own: a connection through this machine's own
	// address reaches 127.0.0.1 and comes back byte for byte; no address, or
	// one that can't bind, rejects with the reason and leaves nothing open.
	{
		const port = await freePort();
		const seen: string[] = [];
		const echo = net.createServer((socket) => {
			seen.push(socket.remoteAddress ?? "");
			socket.pipe(socket);
		});
		others.push(echo);
		await new Promise<void>((resolve) => echo.listen({ host: "127.0.0.1", port }, resolve));
		const listeners = await forward.openContainerListeners(port, { addresses: [own], log: () => {} });
		const back = await new Promise<string>((resolve, reject) => {
			const socket = net.connect({ host: own, port }, () => socket.end("hello through the door\r\n"));
			let text = "";
			socket.on("data", (chunk) => { text += String(chunk); });
			socket.on("end", () => resolve(text));
			socket.on("error", reject);
		});
		assert(back === "hello through the door\r\n", `the bytes come back untouched, got ${JSON.stringify(back)}`);
		assert(seen.length === 1 && seen[0] === "127.0.0.1", `the server sees a loopback peer, got ${JSON.stringify(seen)}`);
		listeners.close();
		assert(!(await connects(own, port)), "after close nothing listens on the address");
		assert(await connects("127.0.0.1", port), "closing the listeners leaves 127.0.0.1 alone");

		await forward.openContainerListeners(port, { addresses: [] }).then(
			() => assert(false, "no address must reject"),
			(error: Error) => assert(error.message === "Could not start exxperts for a container: it has no address besides 127.0.0.1.", `no address: got ${error.message}`),
		);
		const taken = net.createServer();
		others.push(taken);
		const takenPort = await freePort();
		await new Promise<void>((resolve) => taken.listen({ host: own, port: takenPort }, resolve));
		await forward.openContainerListeners(takenPort, { addresses: ["127.0.0.1", own] }).then(
			() => assert(false, "a taken address must reject"),
			(error: Error) => assert(error.message === `Could not start exxperts for a container: ${own}:${takenPort} is not free to listen on (EADDRINUSE).`, `taken address: got ${error.message}`),
		);
		assert(!(await connects("127.0.0.1", takenPort)), "a failed open closes the listeners it had opened");
	}

	// --- Flag off: 127.0.0.1 answers, this machine's own address does not.
	{
		const port = await freePort();
		const plain = launch(["--no-open", "--port", String(port)], freshHome("plain"));
		running = plain.child;
		await plain.waitFor("\nexxperts running at ");
		assert((await rawRequest("127.0.0.1", port, "/healthz", { Host: `localhost:${port}` })).status === 200, "without the flag 127.0.0.1 answers");
		assert(!(await connects(own, port)), `without the flag nothing listens on ${own}:${port}`);
		await stopSmokeServer(plain.child);
		running = undefined;
	}

	if (!isLinux) {
		// --- Not Linux: the one line, exit 1, and nothing started.
		const port = await freePort();
		const home = freshHome("not-linux");
		const refused = launch(["--container", "--port", String(port)], home);
		const code = await refused.exited;
		assert(code === 1 && refused.output() === "--container is for running exxperts inside a Linux container. On this computer, start it with: exxperts\n", `not Linux: expected the refusal line and exit 1, got ${code}:\n${withoutSignInTokens(refused.output())}`);
		assert(!(await connects("127.0.0.1", port)) && !(await connects(own, port)), "not Linux: no server is left running");
		assert(!fs.existsSync(path.join(home, ".exxperts")), "not Linux: the refusal comes before anything is created");
		console.log(`container-forward smoke: ok (not Linux: the refusal half ran on ${process.platform}; the listeners' Linux half runs where the smokes run on Linux)`);
	} else {
		// --- Through this machine's own address, the server's checks hold.
		const port = await freePort();
		const home = freshHome("container");
		const started = launch(["--container", "--port", String(port)], home);
		running = started.child;
		await started.waitFor("\nexxperts running at ");
		const addresses = forward.listenAddresses().map((address) => `${address}:${port}`).join(", ");
		// The no-container line follows what this machine shows; a CI runner
		// has no mark, a Docker container has one. The start below that ends
		// for good sets a mark, so a run on a machine with none sees both.
		const containerFound = forward.looksLikeContainer();
		const startLines = `\nexxperts running at http://localhost:${port} for a container, also on ${addresses}.\nPublish this port to your own computer only, with the same number on both sides: -p 127.0.0.1:${port}:${port}\n${containerFound ? "" : noContainerLine(port)}Press Ctrl+C to stop.\n\nOpen this link once in your computer's browser to sign it in:\nhttp://localhost:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}\n`;
		await started.waitFor(startLines);

		const host = { Host: `localhost:${port}` };
		assert((await rawRequest(own, port, "/healthz", host)).status === 200, "/healthz through the address answers 200");
		const exchange = await rawRequest(own, port, `/auth/session?token=${SMOKE_AUTH_TOKEN}`, host);
		const cookie = ([] as string[]).concat(exchange.headers["set-cookie"] ?? []).join("; ");
		assert(exchange.status === 302 && cookie.includes(`exxperts_auth=${SMOKE_AUTH_TOKEN}`), `the sign-in link signs in, got ${exchange.status} ${cookie}`);
		const signedIn = { ...host, Cookie: `exxperts_auth=${SMOKE_AUTH_TOKEN}` };
		assert((await rawRequest(own, port, "/api/persistent-agents", signedIn)).status === 200, "a signed-in request answers 200");
		assert((await rawRequest(own, port, "/api/persistent-agents", host)).status === 401, "without the token 401");

		const foreignHost = await rawRequest(own, port, "/healthz", { Host: `${own}:${port}` });
		assert(foreignHost.status === 403, `a Host of another machine 403, got ${foreignHost.status}`);
		assert((await rawRequest(own, port, "/healthz", { ...host, Origin: "http://evil.example" })).status === 403, "an Origin of another machine 403");
		const proxied = await rawRequest(own, port, "/healthz", { ...host, "X-Forwarded-For": "203.0.113.7" });
		assert(proxied.status === 403 && JSON.parse(proxied.body).code === "reverse_proxy_unsupported", `a proxy header 403 reverse_proxy_unsupported, got ${proxied.status} ${proxied.body}`);
		const otherPage = await wsUpgrade(own, port, { ...signedIn, Origin: `http://localhost:${port + 1}` });
		assert(otherPage === 403 || otherPage === -1, `the live connection from another local page is refused, got ${otherPage}`);
		assert((await wsUpgrade(own, port, { ...signedIn, Origin: `http://localhost:${port}` })) === 101, "the live connection from the app's own origin opens");

		// A profile switch restarts the server on the same port; the listeners stay.
		const api = (pathname: string, body: unknown) => fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Exxperts-Auth": SMOKE_AUTH_TOKEN }, body: JSON.stringify(body) });
		assert((await api("/api/settings/state-profile/create", { name: "Other" })).status === 200, "the profile is created");
		assert((await api("/api/settings/state-profile/switch", { name: "Other" })).status === 200, "the switch answers 200");
		await started.waitFor(startLines, 2);
		assert(started.output().includes('Switching to profile "Other"'), `the switch restarted the server:\n${withoutSignInTokens(started.output())}`);
		assert((await rawRequest(own, port, "/healthz", host)).status === 200, "after a switch the address still answers");

		// --- Ctrl+C (SIGINT to the launcher's process group) leaves nothing listening.
		process.kill(-started.child.pid!, "SIGINT");
		await started.exited;
		running = undefined;
		assert(!(await connects(own, port)) && !(await connects("127.0.0.1", port)), "after Ctrl+C nothing listens");

		// The server ending for good takes the listeners with it.
		{
			const endPort = await freePort();
			const ending = launch(["--container", "--port", String(endPort)], freshHome("ending"), { container: "podman" });
			running = ending.child;
			await ending.waitFor(`\nPublish this port to your own computer only, with the same number on both sides: -p 127.0.0.1:${endPort}:${endPort}\nPress Ctrl+C to stop.\n`);
			const server = serverPid(ending.child.pid!);
			assert(server !== undefined, "the launcher's server is found");
			process.kill(server, "SIGKILL");
			const code = await ending.exited;
			running = undefined;
			assert(code !== 0, `the launcher ends with the server, got ${code}`);
			assert(!(await connects(own, endPort)), "when the server ends for good nothing listens on the address");
		}

		// --- Fail closed: the address's port already taken.
		{
			const takenPort = await freePort();
			const taken = net.createServer();
			others.push(taken);
			await new Promise<void>((resolve) => taken.listen({ host: own, port: takenPort }, resolve));
			const failing = launch(["--container", "--port", String(takenPort)], freshHome("taken"));
			running = failing.child;
			const code = await failing.exited;
			running = undefined;
			assert(code !== 0 && code !== null, `a listener that can't bind fails the start, got ${code}:\n${withoutSignInTokens(failing.output())}`);
			assert(failing.output().includes(`Could not start exxperts for a container: ${own}:${takenPort} is not free to listen on (EADDRINUSE).`), `the reason is printed:\n${withoutSignInTokens(failing.output())}`);
			assert(!failing.output().includes("exxperts running at "), `no start lines:\n${withoutSignInTokens(failing.output())}`);
			assert(!(await connects("127.0.0.1", takenPort)), "the server the launcher started is gone");
		}

		console.log(`container-forward smoke: ok (Linux half ran, through ${own}; ${containerFound ? "a container's mark found here" : "no container's mark found here"})`);
	}
} finally {
	await stopSmokeServer(running);
	for (const server of others) server.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
