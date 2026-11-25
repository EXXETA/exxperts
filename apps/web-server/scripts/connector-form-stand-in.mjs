// A connector program for connector-form-smoke.ts: it speaks MCP over standard
// input and output and writes what reaches it to the file STAND_IN_LOG names,
// one JSON line each: what the client said it can do, and what each of its
// asks got back. Its tool `ask` asks the person for a form (`form`: "all", a
// field of every kind, or "one") and can stop waiting for it after `giveUpMs`;
// `ask_page` asks them to open a page; `work` takes `ms`, logs its end and answers; `borrow`
// asks to run a text on the person's model, whether or not the client offered it.
import fs from "node:fs";

const log = (event) => fs.appendFileSync(process.env.STAND_IN_LOG, `${JSON.stringify({ ...event, at: Date.now() })}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

/** A field of every kind the forms standard has, some of them needed, with their limits. */
const FORMS = {
	all: {
		message: "Tell us about the trip.",
		requestedSchema: {
			type: "object",
			properties: {
				name: { type: "string", title: "Your name", minLength: 2 },
				nights: { type: "integer", title: "Nights", minimum: 1, maximum: 14 },
				budget: { type: "number", title: "Budget" },
				email: { type: "string", format: "email", title: "Email" },
				site: { type: "string", format: "uri", title: "Hotel page" },
				start: { type: "string", format: "date", title: "Start date" },
				room: { type: "string", title: "Room", oneOf: [{ const: "single", title: "Single" }, { const: "double", title: "Double" }] },
				extras: { type: "array", title: "Extras", items: { type: "string", enum: ["breakfast", "parking", "late checkout"] }, minItems: 1, maxItems: 2 },
				insured: { type: "boolean", title: "Travel insurance", default: false },
				notes: { type: "string", description: "Anything the hotel should know." },
			},
			required: ["name", "nights", "email", "room", "extras"],
		},
	},
	one: { message: "Which city?", requestedSchema: { type: "object", properties: { city: { type: "string", title: "City" } }, required: ["city"] } },
};

const TOOLS = [
	{ name: "ask", description: "Asks the person for details.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { label: { type: "string" }, form: { type: "string" }, giveUpMs: { type: "number" } } } },
	{ name: "ask_page", description: "Asks the person to open a page.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { label: { type: "string" } } } },
	{ name: "work", description: "Works for as long as it is told.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { label: { type: "string" }, ms: { type: "number" } } } },
	{ name: "borrow", description: "Asks to run a text on the person's model.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { label: { type: "string" } } } },
];

let asks = 0;
/** The requests this program sent the client, by id: what to do with the client's answer. */
const waiting = new Map();
const answer = (id, text, isError = false) => send({ id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });

/** Sends the client a request of this program's own; `then` gets its result or its error. */
function request(method, params, then) {
	const id = `stand-in-${(asks += 1)}`;
	waiting.set(id, then);
	send({ id, method, params });
	return id;
}

function call(id, name, args) {
	const label = String(args.label ?? "");
	log({ event: "call", id, name, label });
	if (name === "work") {
		return setTimeout(() => {
			log({ event: "worked", label });
			answer(id, `${label} done`);
		}, Number(args.ms ?? 0));
	}
	if (name === "borrow") {
		return request("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: "Borrowed text, never to reach a model." } }], maxTokens: 16 }, (outcome) => {
			log({ event: "borrow", label, ...(outcome.error ? { code: outcome.error.code } : { answered: true }) });
			if (outcome.error) answer(id, `Couldn't use the model: ${outcome.error.message}`, true);
			else answer(id, "The model answered.");
		});
	}
	if (name === "ask_page") {
		return request("elicitation/create", { mode: "url", message: "Open the sign-up page.", url: "https://example.com/sign-up", elicitationId: `page-${label}` }, (outcome) => {
			log({ event: "page", label, ...(outcome.error ? { code: outcome.error.code } : { action: outcome.result?.action }) });
			answer(id, outcome.error ? `The page wasn't opened: ${outcome.error.message}` : `page ${outcome.result?.action}`, Boolean(outcome.error));
		});
	}
	const form = FORMS[String(args.form ?? "one")] ?? FORMS.one;
	let over = false;
	const asked = request("elicitation/create", { mode: "form", ...form }, (outcome) => {
		if (over) return;
		over = true;
		clearTimeout(giveUp);
		log({ event: "form", label, ...(outcome.error ? { code: outcome.error.code } : { action: outcome.result?.action, content: outcome.result?.content }) });
		answer(id, outcome.error ? `The form failed: ${outcome.error.message}` : `Form ${outcome.result?.action}.`);
	});
	const giveUp = Number(args.giveUpMs ?? 0) > 0 ? setTimeout(() => {
		over = true;
		send({ method: "notifications/cancelled", params: { requestId: asked, reason: "Took too long." } });
		log({ event: "gave-up", label });
		answer(id, "Form not answered in time.");
	}, Number(args.giveUpMs)) : undefined;
}

function handle(message) {
	const { id, method, params } = message;
	if (method === undefined && id !== undefined && waiting.has(id)) {
		const then = waiting.get(id);
		waiting.delete(id);
		return then({ result: message.result, error: message.error });
	}
	if (method === "initialize") {
		log({ event: "hello", capabilities: params?.capabilities ?? {} });
		return send({ id, result: { protocolVersion: params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "form-stand-in", version: "1.0.0" } } });
	}
	if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
	if (method === "ping") return send({ id, result: {} });
	if (method === "tools/call") return call(id, params?.name, params?.arguments ?? {});
	if (id !== undefined && method) send({ id, error: { code: -32601, message: `No method ${method}` } });
}

let buffered = "";
process.stdin.on("data", (chunk) => {
	const lines = (buffered + chunk.toString("utf8")).split("\n");
	buffered = lines.pop() ?? "";
	for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on("end", () => process.exit(0));
