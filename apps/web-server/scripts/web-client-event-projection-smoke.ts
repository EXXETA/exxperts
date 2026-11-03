import { createWebClientEventProjector, PREVIEW_FIELD_MAX_CHARS, THINKING_END_MAX_CHARS } from "../src/web-client-event-projection.js";

const projectAgentEventForWebClient = createWebClientEventProjector();

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A deliberately large accumulated message: the projection must keep this
// bulk off the wire for every message_update variant.
const bulk = "thinking… ".repeat(2_000);
const partial = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: bulk },
		{ type: "text", text: "Hello world, final answer text." },
	],
};
const wrap = (assistantMessageEvent: any) => ({
	type: "message_update",
	assistantMessageEvent: { ...assistantMessageEvent, partial },
	message: { ...partial },
});

// Each row runs on its own, so one that fails does not hide the next.
const failures: string[] = [];
function row(name: string, run: () => void): void {
	try {
		run();
	} catch (error) {
		failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

try {
	// text_delta: exact legacy slim shape, delta preserved, bulk dropped.
	const delta = projectAgentEventForWebClient(wrap({ type: "text_delta", contentIndex: 1, delta: "Hel" }));
	assert(delta.type === "message_update", "text_delta stays a message_update");
	assert(delta.assistantMessageEvent.type === "text_delta", "text_delta keeps its type");
	assert(delta.assistantMessageEvent.contentIndex === 1, "text_delta keeps contentIndex");
	assert(delta.assistantMessageEvent.delta === "Hel", "text_delta keeps the delta");
	assert(!("message" in delta), "text_delta drops the accumulated message");
	assert(!("partial" in delta.assistantMessageEvent), "text_delta drops the partial");

	// A delta sequence reassembles byte-identical.
	const source = "Hello world, final answer text.";
	const pieces = source.match(/.{1,7}/g) ?? [];
	const reassembled = pieces
		.map((p) => projectAgentEventForWebClient(wrap({ type: "text_delta", contentIndex: 1, delta: p })))
		.map((e) => e.assistantMessageEvent.delta)
		.join("");
	assert(reassembled === source, "projected deltas must reassemble byte-identical");

	// text_end: keeps the completed block text (the client's reconciliation
	// path reads it), drops both full-message copies.
	const textEnd = projectAgentEventForWebClient(wrap({ type: "text_end", contentIndex: 1, content: source }));
	assert(textEnd.assistantMessageEvent.type === "text_end", "text_end keeps its type");
	assert(textEnd.assistantMessageEvent.content === source, "text_end keeps the final block text");
	assert(!("message" in textEnd), "text_end drops the accumulated message");
	assert(!("partial" in textEnd.assistantMessageEvent), "text_end drops the partial");

	// Starts and progress with nothing to say: type-only heartbeats.
	const heartbeats: Array<[string, any]> = [
		["text_start", { type: "text_start", contentIndex: 1 }],
		// A call the provider has not named yet: the step waits for the delta that names it.
		["toolcall_start", { type: "toolcall_start", contentIndex: 5 }],
	];
	for (const [name, update] of heartbeats) {
		const projected = projectAgentEventForWebClient(wrap(update));
		assert(projected.type === "message_update", `${name} stays a message_update`);
		assert(projected.assistantMessageEvent.type === name, `${name} keeps its type`);
		const keys = Object.keys(projected.assistantMessageEvent).sort();
		assert(keys.join(",") === "contentIndex,type", `${name} carries only type+contentIndex, got: ${keys.join(",")}`);
		assert(!("message" in projected), `${name} drops the accumulated message`);
		assert(!JSON.stringify(projected).includes("thinking… thinking"), `${name} must not leak bulk content`);
	}

	// A tool call as the model writes it: id and name from the start, then the label's fields as they grow.
	row("tool-call previews", () => {
		const project = createWebClientEventProjector();
		const call = { type: "toolCall", id: "call-1", name: "bash", arguments: {} as Record<string, unknown> };
		const message = { role: "assistant", api: "anthropic-messages", content: [call] };
		const at = (update: any) => project({ type: "message_update", assistantMessageEvent: { ...update, partial: message }, message });
		const start = at({ type: "toolcall_start", contentIndex: 0 }).assistantMessageEvent;
		assert(start.id === "call-1" && start.name === "bash" && JSON.stringify(start.preview) === "{}", `a call's start names it at once, got ${JSON.stringify(start)}`);
		call.arguments = { command: "git st" };
		const grown = at({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"git st' }).assistantMessageEvent;
		assert(grown.preview.command === "git st" && grown.id === "call-1" && grown.name === "bash", `a delta carries the command so far, got ${JSON.stringify(grown)}`);
		const same = at({ type: "toolcall_delta", contentIndex: 0, delta: "" }).assistantMessageEvent;
		assert(Object.keys(same).sort().join(",") === "contentIndex,type", `an unchanged preview sends only a heartbeat, got ${JSON.stringify(same)}`);
		call.arguments = { command: "git status", timeout: 30 };
		const done = project({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message }, message }).assistantMessageEvent;
		assert(done.type === "toolcall_end" && done.preview.command === "git status" && !("timeout" in done.preview), `the end carries the final label fields only, got ${JSON.stringify(done)}`);
		call.arguments = { command: "x".repeat(PREVIEW_FIELD_MAX_CHARS + 50) };
		const long = at({ type: "toolcall_delta", contentIndex: 0, delta: "x" }).assistantMessageEvent;
		assert(long.preview.command.length === PREVIEW_FIELD_MAX_CHARS, `a field is clipped to ${PREVIEW_FIELD_MAX_CHARS}, got ${long.preview.command.length}`);
		// What the label reads of other tools: a search's pattern and folder, a shelf file's name and query, a page's address.
		const others = createWebClientEventProjector();
		const otherCall = { type: "toolCall", id: "call-9", name: "grep", arguments: { pattern: "limit", path: "src", context: 3, ignoreCase: true } };
		const otherMessage = { role: "assistant", content: [otherCall] };
		const grep = others({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: otherMessage }, message: otherMessage }).assistantMessageEvent;
		assert(JSON.stringify(grep.preview) === JSON.stringify({ path: "src", pattern: "limit" }), `a search sends its pattern and folder only, got ${JSON.stringify(grep)}`);
	});

	// A file write names its file and how far it has got, and never carries the file's text.
	row("file write and edit", () => {
		const project = createWebClientEventProjector();
		const call = { type: "toolCall", id: "call-2", name: "write", arguments: {} as Record<string, unknown> };
		const message = { role: "assistant", api: "anthropic-messages", content: [{ type: "text", text: "Here" }, call] };
		const delta = (piece: string, args: Record<string, unknown>) => {
			call.arguments = args;
			return project({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: piece, partial: message }, message }).assistantMessageEvent;
		};
		const first = delta('{"path":"notes/plan.md","content":"secret plan', { path: "notes/plan.md", content: "secret plan" });
		const second = delta(" goes on", { path: "notes/plan.md", content: "secret plan goes on" });
		assert(first.preview.path === "notes/plan.md" && first.preview.sizeSoFar === '{"path":"notes/plan.md","content":"secret plan'.length, `a write names its file and size, got ${JSON.stringify(first)}`);
		assert(second.preview.sizeSoFar === first.preview.sizeSoFar + " goes on".length, `the size grows with each delta, got ${JSON.stringify(second)}`);
		assert(![first, second].some((frame) => JSON.stringify(frame).includes("secret")), "a write's content never travels in a preview");
		const edit = createWebClientEventProjector();
		const editCall = { type: "toolCall", id: "call-3", name: "edit", arguments: { path: "a.ts", oldText: "secret old", newText: "secret new", edits: [{ oldText: "secret a", newText: "secret b" }] } };
		const editMessage = { role: "assistant", content: [editCall] };
		const edited = edit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: editMessage }, message: editMessage });
		assert(!JSON.stringify(edited).includes("secret") && edited.assistantMessageEvent.preview.path === "a.ts", `an edit's texts never travel, got ${JSON.stringify(edited)}`);
	});

	// Thinking: its start and end on the server's clock, its deltas, and the final text only when it differs.
	row("thinking frames", () => {
		let clock = 1_000;
		const project = createWebClientEventProjector(() => clock);
		const block = { type: "thinking", thinking: "", thinkingSignature: "sig-secret" };
		const message = { role: "assistant", api: "anthropic-messages", content: [block] };
		const at = (update: any) => project({ type: "message_update", assistantMessageEvent: { ...update, partial: message }, message }).assistantMessageEvent;
		const start = at({ type: "thinking_start", contentIndex: 0 });
		assert(JSON.stringify(start) === JSON.stringify({ type: "thinking_start", contentIndex: 0, at: 1_000 }), `a thought's start carries its time only, got ${JSON.stringify(start)}`);
		const delta = at({ type: "thinking_delta", contentIndex: 0, delta: "Checking the file" });
		assert(JSON.stringify(delta) === JSON.stringify({ type: "thinking_delta", contentIndex: 0, delta: "Checking the file" }), `a thinking delta carries its words, got ${JSON.stringify(delta)}`);
		clock = 13_500;
		const end = at({ type: "thinking_end", contentIndex: 0, content: "Checking the file" });
		assert(JSON.stringify(end) === JSON.stringify({ type: "thinking_end", contentIndex: 0, at: 13_500 }), `an end whose text the deltas built sends no text, got ${JSON.stringify(end)}`);
		at({ type: "thinking_start", contentIndex: 0 });
		at({ type: "thinking_delta", contentIndex: 0, delta: "draft" });
		const rewritten = at({ type: "thinking_end", contentIndex: 0, content: "y".repeat(THINKING_END_MAX_CHARS + 10) });
		assert(rewritten.content?.length === THINKING_END_MAX_CHARS, `a final text that differs is sent, clipped, got ${rewritten.content?.length}`);
		const redacted = createWebClientEventProjector();
		const redactedMessage = { role: "assistant", api: "anthropic-messages", content: [{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true }] };
		const r = (update: any) => redacted({ type: "message_update", assistantMessageEvent: { ...update, partial: redactedMessage }, message: redactedMessage }).assistantMessageEvent;
		assert(r({ type: "thinking_start", contentIndex: 0 }).redacted === true, "a redacted block says so");
		const redactedDelta = r({ type: "thinking_delta", contentIndex: 0, delta: "[Reasoning redacted]" });
		const redactedEnd = r({ type: "thinking_end", contentIndex: 0, content: "[Reasoning redacted]" });
		assert(![redactedDelta, redactedEnd].some((frame) => JSON.stringify(frame).includes("redacted]")), `a redacted block sends no words, got ${JSON.stringify([redactedDelta, redactedEnd])}`);
	});

	// The provider's own search: its id, name and query, then whether it worked, each on the server's clock, and nothing of the message.
	row("provider search frames", () => {
		const projectSearch = createWebClientEventProjector(() => 42_000);
		const message = { role: "assistant", content: [{ type: "text", text: "x".repeat(4_000) }] };
		const searchStart = projectSearch({ type: "message_update", assistantMessageEvent: { type: "server_tool_start", id: "srvtoolu_1", name: "web_search", partial: message }, message }).assistantMessageEvent;
		assert(JSON.stringify(searchStart) === JSON.stringify({ type: "server_tool_start", id: "srvtoolu_1", name: "web_search", at: 42_000 }), `a search's start carries its id and name, got ${JSON.stringify(searchStart)}`);
		const withQuery = projectSearch({ type: "message_update", assistantMessageEvent: { type: "server_tool_start", id: "srvtoolu_1", name: "web_search", input: { query: "latest Node release", allowed_domains: ["nodejs.org"] }, partial: message }, message });
		assert(JSON.stringify(withQuery) === JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "server_tool_start", id: "srvtoolu_1", name: "web_search", at: 42_000, query: "latest Node release" } }), `a search's start again carries only its query, got ${JSON.stringify(withQuery)}`);
		const ended = projectSearch({ type: "message_update", assistantMessageEvent: { type: "server_tool_end", id: "srvtoolu_1", ok: false, partial: message }, message });
		assert(JSON.stringify(ended) === JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "server_tool_end", id: "srvtoolu_1", ok: false, at: 42_000 } }), `a search's end says only whether it worked and when, got ${JSON.stringify(ended)}`);
	});

	// A whole turn with a signed thought, a redacted one and the provider's search: no frame carries a signature, a redacted payload or the raw wire blocks.
	const signedTurn = () => {
		const signed = { type: "thinking", thinking: "Weighing the sources", thinkingSignature: "SIGNED-PAYLOAD" };
		const hidden = { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "REDACTED-PAYLOAD", redacted: true };
		const text = { type: "text", text: "Node 24 is current." };
		const raw = [{ type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "node" } }, { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: [{ encrypted_content: "RAW-WIRE-BLOCK" }] }];
		const message = { role: "assistant", api: "anthropic-messages", content: [signed, hidden, text], rawContent: raw, stopReason: "stop" };
		const update = (assistantMessageEvent: any) => ({ type: "message_update", assistantMessageEvent: { ...assistantMessageEvent, partial: message }, message });
		return [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", message },
			update({ type: "thinking_start", contentIndex: 0 }),
			update({ type: "thinking_delta", contentIndex: 0, delta: "Weighing the sources" }),
			update({ type: "thinking_end", contentIndex: 0, content: "Weighing the sources" }),
			update({ type: "thinking_start", contentIndex: 1 }),
			update({ type: "thinking_delta", contentIndex: 1, delta: "[Reasoning redacted]" }),
			update({ type: "thinking_end", contentIndex: 1, content: "[Reasoning redacted]" }),
			update({ type: "server_tool_start", id: "srvtoolu_2", name: "web_search", input: { query: "node" } }),
			update({ type: "server_tool_end", id: "srvtoolu_2", ok: true }),
			update({ type: "text_start", contentIndex: 2 }),
			update({ type: "text_delta", contentIndex: 2, delta: "Node 24 is current." }),
			update({ type: "text_end", contentIndex: 2, content: "Node 24 is current." }),
			update({ type: "future_variant", contentIndex: 2 }),
			{ type: "message_end", message },
			{ type: "turn_end", message, toolResults: [] },
			{ type: "agent_end", messages: [{ role: "user", content: "which node?" }, message] },
		];
	};
	row("no signature, redacted payload or raw blocks", () => {
		const frames = signedTurn();
		const projected = frames.map(createWebClientEventProjector());
		for (const [index, frame] of projected.entries()) {
			const wire = JSON.stringify(frame);
			for (const secret of ["SIGNED-PAYLOAD", "REDACTED-PAYLOAD", "RAW-WIRE-BLOCK", "thinkingSignature", "rawContent", "[Reasoning redacted]"]) {
				assert(!wire.includes(secret), `frame ${index} (${frames[index].type}/${(frames[index] as any).assistantMessageEvent?.type ?? ""}) carries ${secret}: ${wire.slice(0, 300)}`);
			}
		}
		const end = projected.find((frame) => frame.type === "message_end");
		assert(end.message.content[0].thinking === "Weighing the sources" && end.message.content[2].text === "Node 24 is current." && end.message.stopReason === "stop", `message_end keeps what the page reads, got ${JSON.stringify(end).slice(0, 300)}`);
		const own = frames.find((frame) => frame.type === "message_end") as any;
		assert(own.message.content[0].thinkingSignature === "SIGNED-PAYLOAD" && own.message.rawContent.length === 2, "the session's own message keeps its signature and raw blocks");
		const delta = projected.find((frame) => frame.assistantMessageEvent?.type === "thinking_delta" && frame.assistantMessageEvent.contentIndex === 0);
		assert(delta.assistantMessageEvent.delta === "Weighing the sources", "with thinking words on, a delta carries the thought");
	});

	// The one constant set to no: a thought's start and end carry only their time (and a redacted mark), its deltas only their kind, and no frame carries a thinking word.
	row("thinking words off", () => {
		const quiet = signedTurn().map(createWebClientEventProjector(Date.now, false));
		for (const [index, frame] of quiet.entries()) {
			assert(!JSON.stringify(frame).includes("Weighing"), `with thinking words off, frame ${index} carries a thinking word: ${JSON.stringify(frame).slice(0, 300)}`);
			const kind = frame.assistantMessageEvent?.type;
			const allowed = kind === "thinking_delta" ? ["contentIndex", "type"] : ["at", "contentIndex", "redacted", "type"];
			if (typeof kind === "string" && kind.startsWith("thinking_")) assert(Object.keys(frame.assistantMessageEvent).every((key) => allowed.includes(key)), `with thinking words off, ${kind} carries more than its time, got ${JSON.stringify(frame)}`);
		}
		assert(quiet.some((frame) => frame.assistantMessageEvent?.type === "thinking_end" && typeof frame.assistantMessageEvent.at === "number"), "with thinking words off, a thought's end still carries its time");
		assert(quiet.some((frame) => frame.assistantMessageEvent?.type === "text_delta" && frame.assistantMessageEvent.delta === "Node 24 is current."), "with thinking words off, the answer's words still travel");
	});

	// Frames with nothing to clean pass through by reference, untouched.
	for (const passthrough of [
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "notes" }, { type: "text", text: "Hi" }] } },
		{ type: "agent_start" },
	]) {
		assert(projectAgentEventForWebClient(passthrough) === passthrough, `${passthrough.type} passes through untouched`);
	}
	// A step's start gains when it began, its end when it ended, both on the server's clock, and each keeps the rest as it was.
	let clock = 1_000;
	const projectOnClock = createWebClientEventProjector(() => clock);
	const started = projectOnClock({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
	assert(started.toolCallId === "t1" && started.toolName === "bash" && started.args.command === "ls" && started.startedAt === 1_000, `a step's start carries when it began, got ${JSON.stringify(started)}`);
	clock = 4_500;
	const stepEnd = { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt" }] }, isError: false };
	const ended = projectOnClock(stepEnd);
	assert(ended.toolCallId === "t1" && ended.isError === false && ended.result.content[0].text === "a.txt" && ended.endedAt === 4_500, `a step's end carries when it ended, got ${JSON.stringify(ended)}`);
	assert(!("endedAt" in stepEnd), "the session's own event is left as it was");
	const realClock = projectAgentEventForWebClient({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
	assert(Math.abs(realClock.startedAt - Date.now()) < 5_000, `without a clock of its own the projector reads the server's, got ${realClock.startedAt}`);

	// Unknown message_update variants pass through untouched (forward-compat).
	const unknown = wrap({ type: "future_delta", contentIndex: 0, delta: "?" });
	assert(projectAgentEventForWebClient(unknown) === unknown, "unknown update variants pass through untouched");

	// Size sanity: a projected thinking_delta frame is tiny vs the original.
	const original = wrap({ type: "thinking_delta", contentIndex: 0, delta: "x" });
	const projectedSize = JSON.stringify(projectAgentEventForWebClient(original)).length;
	const originalSize = JSON.stringify(original).length;
	assert(projectedSize < 120, `heartbeat frame should be tiny, got ${projectedSize} bytes`);
	assert(projectedSize < originalSize / 100, `expected >100x reduction, got ${originalSize} -> ${projectedSize}`);

	if (failures.length) throw new Error(`${failures.length} row(s) failed:\n${failures.join("\n")}`);
	console.log(`web-client event projection smoke passed (thinking_delta frame: ${originalSize} -> ${projectedSize} bytes)`);
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
