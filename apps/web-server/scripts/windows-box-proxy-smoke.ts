// The Windows box's proxy (src/room-box/windows/box-proxy.ts), in plain Node
// on any computer: a stand-in server answers each site, a stand-in lookup
// answers each name, and a stand-in dial notes the address it is given and
// connects to a test server here. Rows: a site the server allowed is reached at
// the address the proxy checked, by CONNECT and by a plain request that keeps
// its Host line; a declined site, a site whose ask failed and one that doesn't
// resolve are refused, and the server hears each reason: a plain request gets
// no answer at all, so no client saves the reason as the page, and CONNECT gets
// 403; CONNECT to port 80; an answer cut off midway is cut off for the client,
// and one Node cannot pass on, or from a site that can't be reached, is no
// answer; a raw address and localhost are refused from their text, with no
// ask and no lookup; a name that answers a local address at the dial, or one
// local address among several, reaches nothing; one lookup per connection;
// in a room on Auto a private-network address is refused as a local one is, and
// the same name is dialled in Semi after a yes;
// Windows' certificate-check user agent said to the server on a plain request
// alone, and answered 403, 400 or 502 with the reason; the computer's own curl
// with -o saves nothing for a refused site and the page for an allowed one; a
// client that goes while its ask waits told to the server, for that ask alone;
// a fresh port each time, closed with the proxy.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { SiteAnswer, SiteAsk, SiteAskHow } from "../src/room-box/box-process.js";
import { FREE_PRIVATE_REFUSAL } from "../src/room-box/card-text.js";
import { LOCAL_REFUSAL } from "../src/room-box/site-asks.js";
import { type BoxProxy, type LookedUp, openBoxProxy } from "../src/room-box/windows/box-proxy.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
		process.exit(1);
	}
}

const show = (value: unknown) => JSON.stringify(value);
const PUBLIC = "93.184.216.34";
const OTHER_PUBLIC = "93.184.216.35";
// The address of a site that breaks off its answer, and of one whose answer Node can't pass on.
const CUT = "93.184.216.36";
const ODD = "93.184.216.37";
// The address of a site that can't be reached: a port nothing listens on.
const DOWN = "93.184.216.38";

// ---- The site the proxy dials: a test server that says what reached it ---------------------------

const reachedTarget: { host?: string; path: string }[] = [];
const target = http.createServer((request, response) => {
	reachedTarget.push({ host: request.headers.host, path: request.url ?? "" });
	response.end(`host=${request.headers.host} path=${request.url}`);
});
await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
const targetPort = (target.address() as net.AddressInfo).port;

/** A raw site that answers each connection with `text`, then closes it. */
async function rawSite(text: string): Promise<{ server: net.Server; port: number }> {
	const server = net.createServer((socket) => {
		socket.once("data", () => socket.end(text));
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: (server.address() as net.AddressInfo).port };
}
const cut = await rawSite("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nonly ten b");
const odd = await rawSite("HTTP/1.1 000 Zero\r\nContent-Length: 2\r\n\r\nok");
const closedPort = await new Promise<number>((resolve) => {
	const server = net.createServer().listen(0, "127.0.0.1", () => {
		const { port } = server.address() as net.AddressInfo;
		server.close(() => resolve(port));
	});
});

// ---- One proxy with its stand-ins -------------------------------------------------------------------

type Rig = { proxy: BoxProxy; asks: SiteAsk[]; hows: SiteAskHow[]; refusals: { site: SiteAsk; reason: string }[]; lookups: string[]; dials: { address: string; port: number }[] };

/** A proxy whose server answers by `answer`, whose lookup answers by `names` (one list per call, the last kept) or by `nameServer`, and whose dial reaches the test server. */
async function rig(answer: (site: SiteAsk) => Promise<SiteAnswer>, names: Record<string, LookedUp[][]>, nameServer?: (name: string) => Promise<LookedUp[]>): Promise<Rig> {
	const asks: SiteAsk[] = [];
	const hows: SiteAskHow[] = [];
	const refusals: Rig["refusals"] = [];
	const lookups: string[] = [];
	const dials: Rig["dials"] = [];
	const proxy = await openBoxProxy({
		ask: (site, how) => {
			asks.push(site);
			hows.push(how);
			return answer(site);
		},
		refused: (site, reason) => refusals.push({ site, reason }),
		lookup: async (name) => {
			const before = lookups.filter((looked) => looked === name).length;
			lookups.push(name);
			if (nameServer) return nameServer(name);
			const answers = names[name];
			if (!answers) throw new Error(`ENOTFOUND ${name}`);
			return answers[Math.min(before, answers.length - 1)];
		},
		dial: (address, port) => {
			dials.push({ address, port });
			return net.connect({ host: "127.0.0.1", port: address === CUT ? cut.port : address === ODD ? odd.port : address === DOWN ? closedPort : targetPort });
		},
	});
	return { proxy, asks, hows, refusals, lookups, dials };
}

const allowAll = async (): Promise<SiteAnswer> => ({ allow: true });
const v4 = (address: string): LookedUp => ({ address, family: 4 });

/** A plain request through the proxy: its status, its body, and whether the body came whole; status 0 when the connection ended with no answer. */
function plain(proxy: BoxProxy, url: string, host = new URL(url).host, userAgent?: string): Promise<{ status: number; body: string; complete: boolean }> {
	return new Promise((resolve, reject) => {
		const request = http.request({ host: "127.0.0.1", port: proxy.port, path: url, headers: { host, ...(userAgent ? { "user-agent": userAgent } : {}) }, agent: false }, (answer) => {
			let body = "";
			answer.on("data", (chunk) => { body += chunk; });
			answer.on("error", () => {});
			answer.on("close", () => resolve({ status: answer.statusCode ?? 0, body, complete: answer.complete }));
		});
		request.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" ? resolve(NO_ANSWER) : reject(error)));
		request.end();
	});
}
const NO_ANSWER = { status: 0, body: "", complete: false };
const CHECK_AGENT = "Microsoft-CryptoAPI/10.0";

/** CONNECT through the proxy, then one request in the tunnel when it opens: the proxy's status line and all that came back. */
function connect(proxy: BoxProxy, authority: string): Promise<{ status: string; text: string }> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port: proxy.port });
		let text = "";
		socket.on("data", (chunk) => {
			text += chunk;
			if (text.startsWith("HTTP/1.1 200") && text.includes("\r\n\r\n") && !text.includes("tunnel-asked")) {
				text += "tunnel-asked\n";
				socket.write(`GET /through-the-tunnel HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
			}
		});
		socket.on("end", () => resolve({ status: text.split("\r\n")[0], text }));
		socket.on("error", reject);
		socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
	});
}

// ---- Rows -------------------------------------------------------------------------------------------

await row("allowed: a plain request reaches the site at the address the proxy checked, by number, with its own Host line and path", async () => {
	const { proxy, asks, lookups, dials, refusals } = await rig(allowAll, { "allowed.example": [[v4(PUBLIC)]] });
	const answer = await plain(proxy, "http://allowed.example:8080/page?q=1");
	assert(answer.status === 200 && answer.body === "host=allowed.example:8080 path=/page?q=1", show(answer));
	assert(show(asks) === show([{ host: "allowed.example", port: 8080 }]) && show(dials) === show([{ address: PUBLIC, port: 8080 }]), show({ asks, dials }));
	assert(show(lookups) === show(["allowed.example"]) && refusals.length === 0, show({ lookups, refusals }));
	// Port 80 when the address names none.
	await plain(proxy, "http://allowed.example/");
	assert(show(dials.at(-1)) === show({ address: PUBLIC, port: 80 }), show(dials));
	await proxy.close();
});

await row("allowed: CONNECT opens a tunnel to the checked address, and what goes through it reaches the site", async () => {
	const { proxy, asks, lookups, dials } = await rig(allowAll, { "allowed.example": [[v4(PUBLIC)]] });
	const tunnel = await connect(proxy, "allowed.example:443");
	assert(tunnel.status === "HTTP/1.1 200 Connection Established" && tunnel.text.includes("host=allowed.example:443 path=/through-the-tunnel"), show(tunnel));
	assert(show(asks) === show([{ host: "allowed.example", port: 443 }]) && show(dials) === show([{ address: PUBLIC, port: 443 }]) && lookups.length === 1, show({ asks, dials, lookups }));
	await proxy.close();
});

await row("allowed: CONNECT to port 80, named in the request, reaches the site decision and the site", async () => {
	const { proxy, asks, dials } = await rig(allowAll, { "allowed.example": [[v4(PUBLIC)]] });
	const tunnel = await connect(proxy, "allowed.example:80");
	assert(tunnel.status === "HTTP/1.1 200 Connection Established" && tunnel.text.includes("host=allowed.example:80 path=/through-the-tunnel"), show(tunnel));
	assert(show(asks) === show([{ host: "allowed.example", port: 80 }]) && show(dials) === show([{ address: PUBLIC, port: 80 }]), show({ asks, dials }));
	await proxy.close();
});

await row("allowed: a site that breaks off its answer midway breaks it off for the client too, and one whose answer can't be passed on gets no answer, with the proxy still up", async () => {
	const { proxy } = await rig(allowAll, { "cut.example": [[v4(CUT)]], "odd.example": [[v4(ODD)]], "allowed.example": [[v4(PUBLIC)]] });
	const broken = await Promise.race([plain(proxy, "http://cut.example/"), new Promise<string>((resolve) => setTimeout(() => resolve("still waiting after 5 s"), 5_000))]);
	assert(typeof broken !== "string" && broken.status === 200 && !broken.complete && broken.body === "only ten b", show(broken));
	const answer = await plain(proxy, "http://odd.example/");
	assert(show(answer) === show(NO_ANSWER), show(answer));
	assert((await plain(proxy, "http://allowed.example/")).status === 200, "the proxy after the odd answer");
	await proxy.close();
});

await row("allowed, but the site can't be reached: a plain request gets no answer, and CONNECT gets 502, with the proxy still up", async () => {
	const { proxy, dials } = await rig(allowAll, { "down.example": [[v4(DOWN)]], "allowed.example": [[v4(PUBLIC)]] });
	const answer = await plain(proxy, "http://down.example/");
	assert(show(answer) === show(NO_ANSWER) && show(dials) === show([{ address: DOWN, port: 80 }]), show({ answer, dials }));
	const tunnel = await connect(proxy, "down.example:443");
	assert(tunnel.status === "HTTP/1.1 502 Bad Gateway" && tunnel.text.endsWith("down.example could not be reached"), show(tunnel));
	assert((await plain(proxy, "http://allowed.example/")).status === 200, "the proxy after the site that can't be reached");
	await proxy.close();
});

await row("declined: a plain request gets no answer and CONNECT 403 with the server's reason, and the server hears each refusal; no lookup and no dial", async () => {
	const { proxy, refusals, lookups, dials } = await rig(async () => ({ allow: false, reason: "the person said no" }), { "declined.example": [[v4(PUBLIC)]] });
	const answer = await plain(proxy, "http://declined.example/");
	assert(show(answer) === show(NO_ANSWER), show(answer));
	const tunnel = await connect(proxy, "declined.example:443");
	assert(tunnel.status === "HTTP/1.1 403 Forbidden" && tunnel.text.endsWith("the person said no"), show(tunnel));
	assert(show(refusals) === show([{ site: { host: "declined.example", port: 80 }, reason: "the person said no" }, { site: { host: "declined.example", port: 443 }, reason: "the person said no" }]), show(refusals));
	assert(lookups.length === 0 && dials.length === 0, show({ lookups, dials }));
	await proxy.close();
});

await row("refused: a site whose ask failed, and an allowed one that doesn't resolve, get no answer and the server hears why", async () => {
	const failing = await rig(async () => { throw new Error("the server went away"); }, {});
	assert((await plain(failing.proxy, "http://allowed.example/")).status === 0 && failing.refusals[0]?.reason === "the room could not check this site" && failing.lookups.length === 0, show(failing.refusals));
	await failing.proxy.close();
	const unknown = await rig(allowAll, {});
	const answer = await plain(unknown.proxy, "http://nowhere.example/");
	assert(show(answer) === show(NO_ANSWER) && unknown.refusals[0]?.reason === "nowhere.example did not resolve" && unknown.dials.length === 0, show({ answer, refusals: unknown.refusals }));
	await unknown.proxy.close();
});

await row("refused from the text: raw addresses and localhost in every spelling, with no ask and no lookup", async () => {
	const { proxy, asks, lookups, dials, refusals } = await rig(allowAll, { localhost: [[v4(PUBLIC)]] });
	for (const host of ["127.0.0.1", "127.1", "2130706433", "0x7f.0.0.1", "[::1]", "localhost", "LOCALHOST.", "box.localhost"]) {
		const answer = await plain(proxy, `http://${host}:${targetPort}/`);
		assert(answer.status === 0 && refusals.at(-1)?.reason === LOCAL_REFUSAL, `${host}: ${show(answer)}`);
		const tunnel = await connect(proxy, `${host}:${targetPort}`);
		assert(tunnel.status === "HTTP/1.1 403 Forbidden", `${host}: ${show(tunnel)}`);
	}
	const raw = await plain(proxy, `http://${PUBLIC}/`);
	assert(raw.status === 0 && /raw address/.test(refusals.at(-1)?.reason ?? ""), show(raw));
	assert(asks.length === 0 && lookups.length === 0 && dials.length === 0 && refusals.length === 17, show({ asks, lookups, dials, refusals: refusals.length }));
	await proxy.close();
});

await row("the dial guard: a name that answers a public address to the server and 127.0.0.1 at the dial reaches nothing, after one lookup of the proxy's", async () => {
	const reached = reachedTarget.length;
	// One name server for both: the server's own decision looks the name up first, as the Mac's does, and is answered with a public address.
	const rebinding = { "rebind.example": [[v4(PUBLIC)], [v4("127.0.0.1")]] };
	const lookedUp: string[] = [];
	const nameServer = async (name: string) => {
		lookedUp.push(name);
		return lookedUp.length % 2 === 1 ? rebinding["rebind.example"][0] : rebinding["rebind.example"][1];
	};
	const { proxy, dials, refusals } = await rig(async (site) => ((await nameServer(site.host)).every((entry) => entry.address === PUBLIC) ? { allow: true } : { allow: false, reason: "local" }), {}, nameServer);
	const answer = await plain(proxy, "http://rebind.example/");
	const tunnel = await connect(proxy, "rebind.example:443");
	assert(answer.status === 0 && tunnel.status === "HTTP/1.1 403 Forbidden", show({ answer, tunnel }));
	assert(dials.length === 0 && reachedTarget.length === reached, show(dials));
	// Two connections: the server's lookup and the proxy's one for each.
	assert(lookedUp.length === 4, `one lookup of the proxy's per connection: ${show(lookedUp)}`);
	assert(show(refusals.map((refusal) => refusal.reason)) === show([LOCAL_REFUSAL, LOCAL_REFUSAL]), show(refusals));
	await proxy.close();
});

await row("the dial guard: one local answer among several is refused; all public is dialled, at an address the proxy checked", async () => {
	const { proxy, dials, lookups, refusals } = await rig(allowAll, {
		"mixed.example": [[v4(PUBLIC), v4("169.254.169.254")]],
		"mixed6.example": [[v4(PUBLIC), { address: "::1", family: 6 }]],
		"public.example": [[v4(OTHER_PUBLIC), v4(PUBLIC)]],
	});
	for (const host of ["mixed.example", "mixed6.example"]) {
		const answer = await plain(proxy, `http://${host}/`);
		assert(answer.status === 0 && refusals.at(-1)?.reason === LOCAL_REFUSAL, `${host}: ${show(answer)}`);
	}
	assert(dials.length === 0, show(dials));
	assert((await plain(proxy, "http://public.example/")).status === 200 && [OTHER_PUBLIC, PUBLIC].includes(dials[0]?.address ?? ""), show(dials));
	assert(show(lookups) === show(["mixed.example", "mixed6.example", "public.example"]), show(lookups));
	await proxy.close();
});

await row("a room on Auto: a public name is dialled at the address the proxy checked; a name with a private-network address, or one among public ones, is refused with Auto's reason; a local one keeps its own; one lookup each, no dial", async () => {
	const free = async (): Promise<SiteAnswer> => ({ allow: true, publicOnly: true });
	const { proxy, asks, dials, lookups, refusals } = await rig(free, {
		"public.example": [[v4(PUBLIC)]],
		"intranet.example": [[v4("192.168.1.20")]],
		"carrier.example": [[v4("100.64.0.7")]],
		"ula.example": [[{ address: "fd00::7", family: 6 }]],
		"half.example": [[v4(PUBLIC), v4("10.0.0.7")]],
		"loop.example": [[v4("127.0.0.1")]],
	});
	assert((await plain(proxy, "http://public.example/")).status === 200 && show(dials) === show([{ address: PUBLIC, port: 80 }]), show(dials));
	assert((await connect(proxy, "public.example:443")).status === "HTTP/1.1 200 Connection Established" && show(dials.at(-1)) === show({ address: PUBLIC, port: 443 }), show(dials));
	for (const host of ["intranet.example", "carrier.example", "ula.example", "half.example"]) {
		const answer = await plain(proxy, `http://${host}/`);
		assert(answer.status === 0 && refusals.at(-1)?.reason === FREE_PRIVATE_REFUSAL, `${host}: ${show(answer)}`);
	}
	assert((await connect(proxy, "intranet.example:443")).status === "HTTP/1.1 403 Forbidden", "a tunnel to a private name");
	const local = await plain(proxy, "http://loop.example/");
	assert(local.status === 0 && refusals.at(-1)?.reason === LOCAL_REFUSAL, show(local));
	assert(dials.length === 2, `only the public name was dialled: ${show(dials)}`);
	assert(show(lookups) === show(["public.example", "public.example", "intranet.example", "carrier.example", "ula.example", "half.example", "intranet.example", "loop.example"]), `one lookup per connection: ${show(lookups)}`);
	assert(show(refusals.map((refusal) => refusal.reason)) === show([...Array(5).fill(FREE_PRIVATE_REFUSAL), LOCAL_REFUSAL]), show(refusals));
	assert(asks.length === lookups.length, `one ask per connection: ${show(asks)}`);
	await proxy.close();
});

await row("the same private-network name in Semi, after the person's yes: dialled", async () => {
	const { proxy, dials } = await rig(allowAll, { "intranet.example": [[v4("192.168.1.20")]] });
	assert((await plain(proxy, "http://intranet.example/")).status === 200 && show(dials) === show([{ address: "192.168.1.20", port: 80 }]), show(dials));
	await proxy.close();
});

await row("requests the proxy doesn't take: https:// sent plainly and a path alone get no answer, CONNECT without a port 400, and none is asked", async () => {
	const { proxy, asks } = await rig(allowAll, {});
	assert(show(await plain(proxy, "https://allowed.example/", "allowed.example")) === show(NO_ANSWER), "https:// sent plainly");
	assert(show(await plain(proxy, "/page", "allowed.example")) === show(NO_ANSWER), "a path alone");
	assert((await connect(proxy, "allowed.example")).status === "HTTP/1.1 400 Bad Request", "CONNECT without a port");
	assert(asks.length === 0, show(asks));
	await proxy.close();
});

await row("certificate checks: a plain request with Windows' certificate-check user agent says it is one; any other user agent, none, and CONNECT with that one don't", async () => {
	const { proxy, hows } = await rig(async () => ({ allow: false, reason: "refused" }), {});
	const checks = (how: SiteAskHow) => how.certificateCheck === true;
	await plain(proxy, "http://crl.example/a.crl", "crl.example", CHECK_AGENT);
	await plain(proxy, "http://crl.example/a.crl", "crl.example", "curl/8.0 Microsoft-CryptoAPI/10.0");
	await plain(proxy, "http://crl.example/a.crl", "crl.example", "microsoft-cryptoapi/10.0");
	await plain(proxy, "http://crl.example/a.crl");
	const socket = net.connect({ host: "127.0.0.1", port: proxy.port });
	await new Promise<void>((resolve) => {
		socket.on("data", () => {});
		socket.on("close", () => resolve());
		socket.write("CONNECT crl.example:443 HTTP/1.1\r\nHost: crl.example:443\r\nUser-Agent: Microsoft-CryptoAPI/10.0\r\n\r\n");
	});
	assert(show(hows.map(checks)) === show([true, false, false, false, false]), show(hows.map(checks)));
	await proxy.close();
});

await row("certificate checks keep their answers: a refusal 403 with its reason, a request the proxy doesn't take 400, a site that can't be reached 502", async () => {
	const { proxy, refusals } = await rig(async (site) => (site.host === "crl.example" ? { allow: false, reason: "refused" } : { allow: true }), { "down.example": [[v4(DOWN)]] });
	const refused = await plain(proxy, "http://crl.example/a.crl", "crl.example", CHECK_AGENT);
	assert(refused.status === 403 && refused.body === "refused" && show(refusals) === show([{ site: { host: "crl.example", port: 80 }, reason: "refused" }]), show({ refused, refusals }));
	const notTaken = await plain(proxy, "/a.crl", "crl.example", CHECK_AGENT);
	assert(notTaken.status === 400 && notTaken.body === "only http:// requests and CONNECT are taken here", show(notTaken));
	const down = await plain(proxy, "http://down.example/a.crl", "down.example", CHECK_AGENT);
	assert(down.status === 502 && down.body === "down.example could not be reached", show(down));
	await proxy.close();
});

/** The computer's own curl through the proxy, `-o` into `file`: its exit code, or null when the computer has none. `-q` and `--noproxy ""` keep this computer's curl settings out. */
function curl(proxy: BoxProxy, url: string, file: string): Promise<number | null> {
	return new Promise((resolve) => {
		execFile("curl", ["-q", "-sS", "--noproxy", "", "--proxy", `http://127.0.0.1:${proxy.port}`, url, "-o", file], (error) => {
			const code = (error as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code;
			resolve(code === "ENOENT" ? null : typeof code === "number" ? code : 0);
		});
	});
}

await row("the computer's curl with -o: a refused site leaves no file under a new name and an existing file as it was; an allowed site saves the page", async () => {
	const { proxy } = await rig(async (site) => (site.host === "declined.example" ? { allow: false, reason: "the person declined this site" } : { allow: true }), { "allowed.example": [[v4(PUBLIC)]] });
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "box-proxy-curl-"));
	try {
		const fresh = path.join(folder, "c.html");
		const exit = await curl(proxy, "http://declined.example/", fresh);
		if (exit === null) {
			console.log("  this computer has no curl: the row checks nothing here");
			return;
		}
		assert(exit !== 0 && !fs.existsSync(fresh), `a refused site left ${fs.existsSync(fresh) ? show(fs.readFileSync(fresh, "utf8")) : "no file"}, curl exit ${exit}`);
		const existing = path.join(folder, "mine.html");
		fs.writeFileSync(existing, "the person's own page");
		assert((await curl(proxy, "http://declined.example/", existing)) !== 0 && fs.readFileSync(existing, "utf8") === "the person's own page", `an existing file: ${show(fs.readFileSync(existing, "utf8"))}`);
		const saved = path.join(folder, "page.html");
		assert((await curl(proxy, "http://allowed.example/page", saved)) === 0 && fs.readFileSync(saved, "utf8") === "host=allowed.example path=/page", "the allowed page");
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
		await proxy.close();
	}
});

await row("a client that goes while its ask waits tells the server, for that ask alone; one that stays is answered as before", async () => {
	const answers: ((answer: SiteAnswer) => void)[] = [];
	const { proxy, hows } = await rig(() => new Promise<SiteAnswer>((resolve) => answers.push(resolve)), { "stays.example": [[v4(PUBLIC)]] });
	const asked = (count: number) => new Promise<void>((resolve) => {
		const look = () => (hows.length >= count ? resolve() : setTimeout(look, 10));
		look();
	});
	// A plain request that goes, one that stays, and a CONNECT that goes.
	const going = http.request({ host: "127.0.0.1", port: proxy.port, path: "http://gone.example/", headers: { host: "gone.example" }, agent: false });
	going.on("error", () => {});
	going.end();
	await asked(1);
	const staying = plain(proxy, "http://stays.example/");
	await asked(2);
	const tunnel = net.connect({ host: "127.0.0.1", port: proxy.port });
	tunnel.on("error", () => {});
	tunnel.write("CONNECT tunnel-gone.example:443 HTTP/1.1\r\nHost: tunnel-gone.example:443\r\n\r\n");
	await asked(3);
	const aborted = () => hows.map((how) => how.signal?.aborted === true);
	assert(show(aborted()) === show([false, false, false]), `told before anyone went: ${show(aborted())}`);
	going.destroy();
	tunnel.destroy();
	const told = Date.now();
	while (show(aborted()) !== show([true, false, true]) && Date.now() - told < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
	assert(show(aborted()) === show([true, false, true]), `which asks were told their client went: ${show(aborted())}`);
	for (const answer of answers) answer({ allow: true });
	assert((await staying).status === 200, "the client that stayed");
	await proxy.close();
});

await row("ports: each proxy listens on a fresh port of 127.0.0.1; closing it closes the port and cuts an open tunnel", async () => {
	const first = await rig(allowAll, { "allowed.example": [[v4(PUBLIC)]] });
	const second = await rig(allowAll, {});
	assert(first.proxy.port !== second.proxy.port && first.proxy.port > 0, `${first.proxy.port} ${second.proxy.port}`);
	await second.proxy.close();
	// A tunnel left open: the proxy's end closes it.
	const socket = net.connect({ host: "127.0.0.1", port: first.proxy.port });
	const opened = new Promise<void>((resolve) => socket.once("data", () => resolve()));
	socket.write("CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n");
	await opened;
	const cut = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	await first.proxy.close();
	await cut;
	for (const port of [first.proxy.port, second.proxy.port]) {
		const refused = await new Promise<string>((resolve) => {
			const probe = net.connect({ host: "127.0.0.1", port }, () => {
				probe.destroy();
				resolve("open");
			});
			probe.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
		});
		assert(refused === "ECONNREFUSED", `port ${port}: ${refused}`);
	}
});

target.close();
cut.server.close();
odd.server.close();
console.log("windows-box-proxy-smoke: ok");
