import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

import type { SiteAnswer, SiteAsk, SiteAskHow } from "../box-process.js";
import { canonicalHost, LOCAL_REFUSAL, localAddress, publicOnlyRefusal, siteRefusal } from "../site-asks.js";

/**
 * The Windows box's one way out: a small HTTP proxy on 127.0.0.1, run by the
 * box's own process on a fresh port each turn, for CONNECT and plain `http://`.
 * Each connection is asked of the server, which gives the Mac's site decision.
 * After a yes the proxy looks the name up once, refuses when any answer is a
 * local address (or, for a yes that says public only, any address that isn't
 * public), and dials one of the addresses it checked, by number: a name
 * that answers otherwise later reaches nothing. The proxy tells the server each
 * refusal with its reason, so the model can learn why. A refused CONNECT is
 * answered 403 with the reason. A plain request the proxy refuses, doesn't take
 * or can't pass on gets no answer at all: the connection ends, since a client
 * that saves any answer (curl's -o) would keep the proxy's words in the
 * person's file. Windows' certificate checks keep 403, 400 or 502 with the reason.
 * Each ask says when its client has gone, and a plain request with Windows'
 * certificate-check user agent says it is one: the server then refuses it at
 * once unless the site is allowed already.
 */

/** One address a name gave, as `dns.lookup` with `all` gives it. */
export type LookedUp = { address: string; family: number };

export interface BoxProxyOptions {
	/** The server's site decision. */
	ask: (site: SiteAsk, how: SiteAskHow) => Promise<SiteAnswer>;
	/** Every refusal, with its reason: from the site's text, the server's own, at the lookup, or when the ask failed. */
	refused: (site: SiteAsk, reason: string) => void;
	/** The name's lookup; Windows' own by default. Smokes give a stand-in. */
	lookup?: (name: string) => Promise<LookedUp[]>;
	/** Opens the connection to a checked address; a plain TCP connection by default. Smokes give a stand-in. */
	dial?: (address: string, port: number) => net.Socket;
}

export interface BoxProxy {
	port: number;
	/** Ends the proxy and every connection through it. */
	close: () => Promise<void>;
}

const ASK_FAILED = "the room could not check this site";

// What a CONNECT client may send while its answer is awaited, kept for after the head; past it, it is no longer read.
const EARLY_LIMIT_BYTES = 64 * 1024;

/** How Windows' own fetches for a certificate check name themselves, over plain http. Anything may send it: it earns a refusal sooner, and a worded answer that a command sending it could save, as any refusal gave before. */
const CERTIFICATE_CHECK_AGENT = /^Microsoft-CryptoAPI\//;

const systemLookup = (name: string) => dns.lookup(name, { all: true });
const tcpDial = (address: string, port: number) => net.connect({ host: address, port });

type Decision = { ok: true; address: string } | { ok: false; reason: string };

/** The site's authority, `host:port`, as a URL holds it; null when it isn't one. */
function siteOf(authority: string, defaultPort: number): SiteAsk | null {
	try {
		const url = new URL(`http://${authority}`);
		if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
		// The URL drops a written :80 as http's own: the text keeps it.
		const port = url.port !== "" ? Number(url.port) : /:\d+$/.test(authority) ? 80 : defaultPort;
		return { host: url.hostname, port };
	} catch {
		return null;
	}
}

export async function openBoxProxy(options: BoxProxyOptions): Promise<BoxProxy> {
	const lookup = options.lookup ?? systemLookup;
	const dial = options.dial ?? tcpDial;

	/** The address this connection may reach, or why not. Never a lookup before the server's yes, and one at most after it. */
	async function decide(site: SiteAsk, how: SiteAskHow): Promise<Decision> {
		const fromText = siteRefusal(site.host);
		if (fromText) return refuse(site, fromText);
		let answer: SiteAnswer;
		try {
			answer = await options.ask(site, how);
		} catch {
			return refuse(site, ASK_FAILED);
		}
		if (!answer.allow) return refuse(site, answer.reason);
		// Not null and never an address: the text check passed.
		const name = canonicalHost(site.host) as string;
		let addresses: LookedUp[];
		try {
			addresses = await lookup(name);
		} catch {
			addresses = [];
		}
		if (addresses.length === 0) return refuse(site, `${name} did not resolve`);
		const closed = answer.publicOnly ? publicOnlyRefusal(addresses.map((entry) => entry.address)) : addresses.some((entry) => localAddress(entry.address)) ? LOCAL_REFUSAL : null;
		if (closed) return refuse(site, closed);
		return { ok: true, address: addresses[0].address };
	}

	function refuse(site: SiteAsk, reason: string): Decision {
		options.refused(site, reason);
		return { ok: false, reason };
	}

	const sockets = new Set<net.Socket>();
	const keep = (socket: net.Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		// A connection that breaks ends itself; nothing else hears of it.
		socket.on("error", () => socket.destroy());
	};

	const server = http.createServer(async (request, response) => {
		const certificateCheck = CERTIFICATE_CHECK_AGENT.test(request.headers["user-agent"] ?? "");
		// Windows' own check never writes a file, and how it takes a cut connection is unknown: it keeps its answer.
		const fail = (status: number, reason: string) => {
			if (!certificateCheck) return void response.destroy();
			if (!response.headersSent) response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
			response.end(reason);
		};
		let url: URL;
		try {
			url = new URL(request.url ?? "");
		} catch {
			return fail(400, "only http:// requests and CONNECT are taken here");
		}
		const site = url.protocol === "http:" ? siteOf(url.host, 80) : null;
		if (!site) return fail(400, "only http:// requests and CONNECT are taken here");
		// The response closes once it has ended, or when its client goes first.
		const gone = new AbortController();
		response.once("close", () => gone.abort());
		const decision = await decide(site, { signal: gone.signal, certificateCheck });
		if (!decision.ok) return fail(403, decision.reason);
		// The client's own header lines, Host included, but the proxy's own.
		const headers: string[] = [];
		for (let index = 0; index < request.rawHeaders.length; index += 2) {
			if (!/^proxy-/i.test(request.rawHeaders[index])) headers.push(request.rawHeaders[index], request.rawHeaders[index + 1]);
		}
		const upstream = http.request({ method: request.method, path: `${url.pathname}${url.search}`, headers, setHost: false, createConnection: () => {
			const socket = dial(decision.address, site.port);
			keep(socket);
			return socket;
		} });
		upstream.on("response", (answer) => {
			try {
				response.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
			} catch {
				// A status or header line Node won't send on: refused here, never a throw that ends the box's process.
				answer.destroy();
				return fail(502, `${site.host} gave an answer that can't be passed on`);
			}
			// A site that breaks off its answer breaks it off here too, so the client never takes part of it for the whole.
			answer.once("close", () => {
				if (!answer.complete) response.destroy();
			});
			answer.pipe(response);
		});
		upstream.on("error", () => (response.headersSent ? response.destroy() : fail(502, `${site.host} could not be reached`)));
		request.pipe(upstream);
	});
	server.on("connection", keep);
	server.on("connect", async (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
		const answer = (status: string, reason: string) => client.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(reason)}\r\nconnection: close\r\n\r\n${reason}`);
		const site = siteOf(request.url ?? "", 0);
		if (!site || site.port === 0) return answer("400 Bad Request", "CONNECT takes a host and a port");
		// Read while the answer is awaited, or a client that goes is never heard: Node hands the socket over unread and half-open.
		const gone = new AbortController();
		const leave = () => gone.abort();
		client.once("end", leave);
		client.once("close", leave);
		const early: Buffer[] = [head];
		let earlySize = head.length;
		const hold = (chunk: Buffer) => {
			early.push(chunk);
			earlySize += chunk.length;
			if (earlySize > EARLY_LIMIT_BYTES) client.pause();
		};
		client.on("data", hold);
		const decision = await decide(site, { signal: gone.signal });
		client.off("data", hold);
		client.off("end", leave);
		client.pause();
		if (gone.signal.aborted || client.destroyed) return void client.destroy();
		if (!decision.ok) return answer("403 Forbidden", decision.reason);
		const sent = Buffer.concat(early);
		const upstream = dial(decision.address, site.port);
		keep(upstream);
		upstream.once("connect", () => {
			upstream.once("close", () => client.destroy());
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (sent.length > 0) upstream.write(sent);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		upstream.once("error", () => {
			if (!client.destroyed && client.bytesWritten === 0) answer("502 Bad Gateway", `${site.host} could not be reached`);
		});
		client.once("close", () => upstream.destroy());
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		port: (server.address() as net.AddressInfo).port,
		close: () => new Promise((resolve) => {
			server.close(() => resolve());
			for (const socket of sockets) socket.destroy();
		}),
	};
}
