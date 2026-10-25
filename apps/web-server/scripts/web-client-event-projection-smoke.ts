import { projectAgentEventForWebClient } from "../src/web-client-event-projection.js";

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

	// Thinking/toolcall variants and starts: type-only heartbeats.
	const heartbeats: Array<[string, any]> = [
		["text_start", { type: "text_start", contentIndex: 1 }],
		["thinking_start", { type: "thinking_start", contentIndex: 0 }],
		["thinking_delta", { type: "thinking_delta", contentIndex: 0, delta: bulk }],
		["thinking_end", { type: "thinking_end", contentIndex: 0, content: bulk }],
		["toolcall_start", { type: "toolcall_start", contentIndex: 2 }],
		["toolcall_delta", { type: "toolcall_delta", contentIndex: 2, delta: '{"path":' }],
		["toolcall_end", { type: "toolcall_end", contentIndex: 2, toolCall: { id: "t1", name: "read", arguments: { path: "/x" } } }],
	];
	for (const [name, update] of heartbeats) {
		const projected = projectAgentEventForWebClient(wrap(update));
		assert(projected.type === "message_update", `${name} stays a message_update`);
		assert(projected.assistantMessageEvent.type === name, `${name} keeps its type`);
		assert(typeof projected.assistantMessageEvent.contentIndex === "number", `${name} keeps contentIndex`);
		const keys = Object.keys(projected.assistantMessageEvent).sort();
		assert(keys.join(",") === "contentIndex,type", `${name} carries only type+contentIndex, got: ${keys.join(",")}`);
		assert(!("message" in projected), `${name} drops the accumulated message`);
		assert(!JSON.stringify(projected).includes("thinking… thinking"), `${name} must not leak bulk content`);
	}

	// Non-message_update events pass through by reference, untouched.
	for (const passthrough of [
		{ type: "message_start", message: { ...partial } },
		{ type: "message_end", message: { ...partial } },
		{ type: "agent_start" },
	]) {
		assert(projectAgentEventForWebClient(passthrough) === passthrough, `${passthrough.type} passes through untouched`);
	}
	// A step's start gains when it began, and keeps the rest as it was.
	const before = Date.now();
	const started = projectAgentEventForWebClient({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
	assert(started.toolCallId === "t1" && started.toolName === "bash" && started.args.command === "ls" && started.startedAt >= before && started.startedAt <= Date.now(), `a step's start carries when it began, got ${JSON.stringify(started)}`);

	// Unknown message_update variants pass through untouched (forward-compat).
	const unknown = wrap({ type: "future_delta", contentIndex: 0, delta: "?" });
	assert(projectAgentEventForWebClient(unknown) === unknown, "unknown update variants pass through untouched");

	// Size sanity: a projected thinking_delta frame is tiny vs the original.
	const original = wrap({ type: "thinking_delta", contentIndex: 0, delta: "x" });
	const projectedSize = JSON.stringify(projectAgentEventForWebClient(original)).length;
	const originalSize = JSON.stringify(original).length;
	assert(projectedSize < 120, `heartbeat frame should be tiny, got ${projectedSize} bytes`);
	assert(projectedSize < originalSize / 100, `expected >100x reduction, got ${originalSize} -> ${projectedSize}`);

	console.log(`web-client event projection smoke passed (thinking_delta frame: ${originalSize} -> ${projectedSize} bytes)`);
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
