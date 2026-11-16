// A real connector for the smokes: it answers MCP over HTTP, lists the tools
// it is told to with the marks it is told to, and counts what reaches it.
import http from "node:http";
import type { AddressInfo } from "node:net";

export type ConnectorTool = { name: string; annotations?: Record<string, unknown> };

/**
 * A web connector's name for the smokes: a connector at this computer's own
 * address is a program here, and its tools never get Allow for this room
 * (room-scope.ts), so a smoke that needs a web connector names it by a
 * reserved name and carries it to its connector through a proxy, which is the
 * connector itself: it answers whatever address a request names.
 */
const WEB_HOST = "asana.example.test";
const DIRECT = "127.0.0.1,localhost,::1";

export interface MarkedConnector {
	server: http.Server;
	/** Its address on this computer: a program here, as the gate reads it. */
	url(): string;
	/** Its web name, reached through `proxyEnv` or `proxyHere`; `path` gives another address at the same name. */
	webUrl(path?: string): string;
	/** What a server started for the smoke needs to reach `webUrl`: the proxy settings and the preload that follows them, with this computer's addresses direct. */
	proxyEnv(): Record<string, string>;
	/** Reaches `webUrl` from this process, every fetch to this computer's addresses still direct. */
	proxyHere(): Promise<void>;
	tools: ConnectorTool[];
	/** The name of each tool call that reached the connector, in order. */
	called: string[];
	/** Where each tool call reached it, in the same order: the address it named, as `webUrl` or `url` gives it. */
	calledAt: string[];
	resourceReads(): number;
}

export function markedConnector(): MarkedConnector {
	let resourceReads = 0;
	const answer = (method: string, params: any, at: string): unknown => {
		if (method === "initialize") return { protocolVersion: params?.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "smoke-connector", version: "1.0.0" } };
		if (method === "tools/list") return { tools: connector.tools.map((tool) => ({ inputSchema: { type: "object" }, ...tool })) };
		if (method === "resources/list") return { resources: [{ uri: "smoke://notes", name: "notes" }] };
		if (method === "resources/read") {
			resourceReads += 1;
			return { contents: [{ uri: "smoke://notes", text: "the notes" }] };
		}
		if (method === "tools/call") {
			connector.called.push(String(params?.name));
			connector.calledAt.push(at);
			return { content: [{ type: "text", text: `ran ${params?.name}` }] };
		}
		return {};
	};
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			if (req.method !== "POST") return void res.writeHead(405).end();
			const message = JSON.parse(raw);
			if (message.id === undefined) return void res.writeHead(202).end();
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method, message.params, new URL(req.url ?? "/", `http://${req.headers.host}`).href) }));
		});
	});
	// A proxy may tunnel even a plain web address (undici's agent does): the tunnel leads back to this same connector.
	server.on("connect", (_req, socket, head) => {
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) socket.unshift(head);
		server.emit("connection", socket);
	});
	const proxyAddress = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const connector: MarkedConnector = {
		server,
		url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
		webUrl: (path = "/mcp") => `http://${WEB_HOST}${path}`,
		proxyEnv: () => ({
			HTTP_PROXY: proxyAddress(),
			http_proxy: proxyAddress(),
			NO_PROXY: DIRECT,
			no_proxy: DIRECT,
			// Added to what the smoke runner already loads.
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./smoke-proxy-preload.mjs", import.meta.url).href}`.trim(),
		}),
		proxyHere: async () => {
			const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
			setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: proxyAddress(), noProxy: DIRECT }));
		},
		tools: [],
		called: [],
		calledAt: [],
		resourceReads: () => resourceReads,
	};
	return connector;
}
