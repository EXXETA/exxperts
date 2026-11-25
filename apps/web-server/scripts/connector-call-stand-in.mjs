// A connector program for the smokes (connector-call-stop-smoke.ts,
// connector-tool-facts-smoke.ts): it speaks MCP over standard input and output
// and writes what reaches it to the file STAND_IN_LOG names, one JSON line each,
// with its process id and STAND_IN_NAME. Its tool `work` takes as long as it is told, reports
// progress when it is told and the caller asked for it, and stops on a cancel
// unless told to ignore it; `fail` answers with its own error; `add_tool` adds
// the tool `added` (not marked read-only), tells the client its list changed,
// and answers once the client has listed again; `add_two` adds `added`, tells
// the client, then adds `second` 700 ms later and tells it again. A client that
// declares forms also gets the tool `form_only`. Settings, all optional:
// - STAND_IN_INSTRUCTIONS: the instructions it gives as it connects;
// - STAND_IN_CHILD=1: it starts a program of its own, which ends when its input does;
// - STAND_IN_START_MS: it answers nothing for this long after it starts, as a slow first start;
// - STAND_IN_FIRST_LIST_MS: its first listing answers this late;
// - STAND_IN_RELIST_MS: its second listing answers this late, with the list as it was when asked;
// - STAND_IN_STAYS=1: it keeps running when its input closes and when asked to end, until it is killed.
import { spawn } from "node:child_process";
import fs from "node:fs";

const log = (event) => fs.appendFileSync(process.env.STAND_IN_LOG, `${JSON.stringify({ ...event, name: process.env.STAND_IN_NAME ?? "", pid: process.pid, at: Date.now() })}\n`);

const TOOLS = [
	{
		name: "work",
		description: "Works for as long as it is told.",
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: "object",
			properties: {
				label: { type: "string" },
				ms: { type: "number" },
				progressEvery: { type: "number" },
				ignoreCancel: { type: "boolean" },
			},
		},
	},
	{ name: "fail", description: "Answers with its own error.", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
	{ name: "add_tool", description: "Adds a tool.", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
	{ name: "add_two", description: "Adds two tools, one after the other.", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
];
const ADDED = { name: "added", title: "Added Tool", description: "A tool added while connected.", inputSchema: { type: "object" } };
const SECOND = { name: "second", description: "A second tool added while connected.", inputSchema: { type: "object" } };
const FORM_ONLY = { name: "form_only", description: "Offered to a client that declares forms.", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } };

let added = false;
let second = false;
let listings = 0;
let declaresForms = false;
/** add_tool's answers that wait for the client's next listing. */
let waitingForListing = [];
/** The calls still running, by request id: their timers, and whether they go on after a cancel. */
const running = new Map();

function makeHandler(send) {
	function startWork(id, args, progressToken) {
		const label = String(args.label ?? "");
		const ms = Number(args.ms ?? 0);
		const every = Number(args.progressEvery ?? 0);
		let progress = 0;
		const ticker = every > 0 && progressToken !== undefined
			? setInterval(() => send({ method: "notifications/progress", params: { progressToken, progress: (progress += 1), message: `step ${progress}` } }), every)
			: undefined;
		const finish = setTimeout(() => {
			clearInterval(ticker);
			running.delete(id);
			log({ event: "answer", id, label });
			send({ id, result: { content: [{ type: "text", text: `${label} done after ${ms} ms` }] } });
		}, ms);
		running.set(id, { ticker, finish, ignoreCancel: args.ignoreCancel === true, label });
	}

	return function handle(message) {
		const { id, method, params } = message;
		if (method === "initialize") {
			declaresForms = params?.capabilities?.elicitation !== undefined;
			log({ event: "initialize", forms: declaresForms, sampling: params?.capabilities?.sampling !== undefined });
			const instructions = process.env.STAND_IN_INSTRUCTIONS;
			return send({ id, result: { protocolVersion: params?.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "call-stand-in", version: "1.0.0" }, ...(instructions ? { instructions } : {}) } });
		}
		if (method === "tools/list") {
			log({ event: "list" });
			const tools = [...TOOLS, ...(added ? [ADDED] : []), ...(second ? [SECOND] : []), ...(declaresForms ? [FORM_ONLY] : [])];
			const answers = waitingForListing;
			waitingForListing = [];
			listings += 1;
			const late = Number((listings === 1 ? process.env.STAND_IN_FIRST_LIST_MS : listings === 2 ? process.env.STAND_IN_RELIST_MS : 0) ?? 0);
			setTimeout(() => {
				send({ id, result: { tools } });
				for (const answer of answers) answer();
			}, late);
			return;
		}
		if (method === "ping") return send({ id, result: {} });
		if (method === "tools/call") {
			const args = params?.arguments ?? {};
			log({ event: "call", id, tool: params?.name, label: String(args.label ?? ""), progress: params?._meta?.progressToken !== undefined });
			if (params?.name === "fail") return send({ id, result: { isError: true, content: [{ type: "text", text: "The project Q3 is locked." }] } });
			if (params?.name === "add_tool") {
				added = true;
				waitingForListing.push(() => send({ id, result: { content: [{ type: "text", text: "A tool was added." }] } }));
				return send({ method: "notifications/tools/list_changed" });
			}
			if (params?.name === "add_two") {
				added = true;
				send({ method: "notifications/tools/list_changed" });
				setTimeout(() => {
					second = true;
					send({ method: "notifications/tools/list_changed" });
				}, 700);
				return send({ id, result: { content: [{ type: "text", text: "Two tools are being added." }] } });
			}
			if (params?.name === "added") return send({ id, result: { content: [{ type: "text", text: "added done" }] } });
			return startWork(id, args, params?._meta?.progressToken);
		}
		if (method === "notifications/cancelled") {
			const call = running.get(params?.requestId);
			log({ event: "cancel", id: params?.requestId, label: call?.label ?? "", reason: String(params?.reason ?? "") });
			if (call && !call.ignoreCancel) {
				clearInterval(call.ticker);
				clearTimeout(call.finish);
				running.delete(params.requestId);
			}
			return;
		}
		if (id !== undefined && method) send({ id, error: { code: -32601, message: `No method ${method}` } });
	};
}

function onStandardInput() {
	const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	const handle = makeHandler(send);
	const startMs = Number(process.env.STAND_IN_START_MS ?? 0);
	const readyAt = Date.now() + startMs;
	if (startMs > 0) setTimeout(() => log({ event: "ready" }), startMs);
	let buffered = "";
	process.stdin.on("data", (chunk) => {
		const lines = (buffered + chunk.toString("utf8")).split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const message = JSON.parse(line);
			setTimeout(() => handle(message), Math.max(0, readyAt - Date.now()));
		}
	});
	// Its input ends: once the lines read before it are handled (their timers come first), it ends, and a program of
	// its own with it, as a browser-driving connector closes its browser. Still in its slow first start, it ends at
	// once, as a program that never got to answer does, and the lines it was holding go with it.
	process.stdin.on("end", () => {
		if (process.env.STAND_IN_STAYS === "1") return;
		setTimeout(() => {
			child?.kill();
			process.exit(0);
		}, 0);
	});
}

let child;
if (process.env.STAND_IN_STAYS === "1") {
	process.on("SIGTERM", () => log({ event: "sigterm" }));
	setInterval(() => {}, 60_000);
}
if (process.env.STAND_IN_CHILD === "1") {
	child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
	log({ event: "child", child: child.pid });
}
process.on("exit", () => log({ event: "exit" }));
log({ event: "start" });

onStandardInput();
