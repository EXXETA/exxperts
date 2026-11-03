// Projection for agent-session events forwarded to the web client over the
// WebSocket. Every message_update from the agent loop carries the full
// accumulated assistant message twice (the `message` field plus
// `assistantMessageEvent.partial`), so a long thinking or tool-call phase
// floods the socket with hundreds of progressively larger frames the UI
// parses and discards. Slim each variant to what the web client actually
// reads:
//   - text deltas, and text_end's final block text;
//   - thinking as it is written: its start and end stamped with the server's
//     clock, so a reattach shows the same duration, and its deltas;
//   - a tool call as the model writes it: its id and name from the start,
//     then the few short arguments a step's label reads, each time they
//     change. A file's content or an edit's text never travels here;
//   - a tool the provider runs itself (its own web search): its id, name and
//     query when it starts, and whether it worked when it ends;
//   - type-only heartbeats for the rest (a "model is busy" signal).
// message_end stays the authoritative full-message reconciliation for the
// client. No frame carries what the page never reads and the provider keeps
// for itself: a thinking signature (a ChatGPT one is the whole encrypted
// reasoning item), a redacted block's payload, or the raw wire blocks.

/**
 * Whether the model's thinking words reach the page. Set to false, a
 * thought's start and end carry only their time, its deltas only their kind,
 * and no message frame carries thinking text; the room still shows that it
 * thinks and for how long.
 */
export const THINKING_WORDS_TO_PAGE = true;

/** The arguments a step's label reads (Message.tsx, summariseToolArgs and the connector labels), and nothing else. */
const PREVIEW_FIELDS = ["command", "path", "pattern", "name", "query", "topic", "url", "template", "vault", "title", "id", "server", "connect", "tool", "describe"] as const;
export const PREVIEW_FIELD_MAX_CHARS = 300;
/** Writing a file or an edit says how far the model has got. */
const SIZED_TOOLS = new Set(["write", "edit"]);
/** A model's final thinking text, when it differs from what its deltas built, is sent up to this length. */
export const THINKING_END_MAX_CHARS = 20_000;

export type ToolCallPreview = Partial<Record<(typeof PREVIEW_FIELDS)[number], string>> & { sizeSoFar?: number };

function previewOf(name: string, args: unknown, argumentChars: number): ToolCallPreview {
	const preview: ToolCallPreview = {};
	const source = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	for (const field of PREVIEW_FIELDS) {
		const value = source[field];
		if (typeof value === "string" && value) preview[field] = value.slice(0, PREVIEW_FIELD_MAX_CHARS);
	}
	if (SIZED_TOOLS.has(name)) preview.sizeSoFar = argumentChars;
	return preview;
}

const heartbeat = (type: string, contentIndex: unknown) => ({ type: "message_update", assistantMessageEvent: { type, contentIndex } });

/** A message as the page may see it: no raw wire blocks, and thinking blocks without their signature, a redacted payload, or (when off) their words. */
function cleanMessage(message: any, thinkingWords: boolean): any {
	if (!message || typeof message !== "object" || Array.isArray(message)) return message;
	const content = message.content;
	const dirtyThinking = Array.isArray(content) && content.some((block: any) => block?.type === "thinking" && ("thinkingSignature" in block || block.redacted === true || (!thinkingWords && block.thinking)));
	if (!("rawContent" in message) && !dirtyThinking) return message;
	const { rawContent: _raw, ...rest } = message;
	if (!dirtyThinking) return rest;
	return {
		...rest,
		content: content.map((block: any) => {
			if (block?.type !== "thinking") return block;
			const { thinkingSignature: _signature, ...kept } = block;
			// A redacted block's text is a placeholder, never the model's words.
			return block.redacted === true || !thinkingWords ? { ...kept, thinking: "" } : kept;
		}),
	};
}

/** Every message a frame carries, cleaned: the event's own, a run's list, a turn's tool results, and an update's copies. */
function cleanFrame(event: any, thinkingWords: boolean): any {
	if (!event || typeof event !== "object") return event;
	let out = event;
	const replace = (key: string, value: unknown) => {
		if (value !== out[key]) out = { ...out, [key]: value };
	};
	if ("message" in event) replace("message", cleanMessage(event.message, thinkingWords));
	for (const key of ["messages", "toolResults"]) {
		const list = event[key];
		if (!Array.isArray(list)) continue;
		const cleaned = list.map((message) => cleanMessage(message, thinkingWords));
		if (cleaned.some((message, index) => message !== list[index])) replace(key, cleaned);
	}
	const update = event.assistantMessageEvent;
	if (update && typeof update === "object") {
		let cleanedUpdate = update;
		for (const key of ["partial", "message", "error"]) {
			if (!(key in update)) continue;
			const cleaned = cleanMessage(update[key], thinkingWords);
			if (cleaned !== update[key]) cleanedUpdate = { ...cleanedUpdate, [key]: cleaned };
		}
		replace("assistantMessageEvent", cleanedUpdate);
	}
	return out;
}

/**
 * One projector per session subscriber: it remembers, per content block of the
 * message being written, what it last sent, so an unchanged tool preview sends
 * nothing new and a thinking block's end knows what its deltas built.
 * `now` is the server's clock and `thinkingWords` the page's share of the
 * thinking; a smoke passes its own of each.
 */
export function createWebClientEventProjector(now: () => number = Date.now, thinkingWords: boolean = THINKING_WORDS_TO_PAGE): (event: any) => any {
	const toolCalls = new Map<unknown, { sent: string; chars: number }>();
	const thinking = new Map<unknown, string>();
	return (event) => {
		// A step's start carries when it began, and its end when it ended. The
		// frames are kept as sent for a reattach, so a page that reloads counts
		// the step's time from here.
		if (event?.type === "tool_execution_start") return { ...event, startedAt: now() };
		if (event?.type === "tool_execution_end") return { ...event, endedAt: now() };
		if (event?.type === "message_start") {
			toolCalls.clear();
			thinking.clear();
		}
		if (event?.type !== "message_update") return cleanFrame(event, thinkingWords);
		const update = event.assistantMessageEvent;
		const block = update?.partial?.content?.[update?.contentIndex];
		switch (update?.type) {
			case "text_delta":
				return { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: update.contentIndex, delta: update.delta ?? "" } };
			case "text_end":
				return { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: update.contentIndex, content: update.content ?? "" } };
			case "text_start":
				return heartbeat("text_start", update.contentIndex);
			case "thinking_start": {
				const redacted = block?.redacted === true;
				// With words off a thought still has its start and end, with their times: a bare frame would collapse into the run around it.
				if (!thinkingWords) return { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: update.contentIndex, at: now(), ...(redacted ? { redacted: true } : {}) } };
				thinking.set(update.contentIndex, "");
				return { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: update.contentIndex, at: now(), ...(redacted ? { redacted: true } : {}) } };
			}
			case "thinking_delta": {
				if (!thinkingWords || block?.redacted === true) return heartbeat("thinking_delta", update.contentIndex);
				const delta = String(update.delta ?? "");
				thinking.set(update.contentIndex, (thinking.get(update.contentIndex) ?? "") + delta);
				return { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: update.contentIndex, delta } };
			}
			case "thinking_end": {
				if (!thinkingWords) return { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: update.contentIndex, at: now() } };
				const built = thinking.get(update.contentIndex) ?? "";
				thinking.delete(update.contentIndex);
				const content = block?.redacted === true ? "" : String(update.content ?? "");
				const differs = content.length > 0 && content !== built;
				return { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: update.contentIndex, at: now(), ...(differs ? { content: content.slice(0, THINKING_END_MAX_CHARS) } : {}) } };
			}
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end": {
				const call = update.type === "toolcall_end" ? update.toolCall ?? block : block;
				const id = typeof call?.id === "string" ? call.id : "";
				const name = typeof call?.name === "string" ? call.name : "";
				const seen = toolCalls.get(update.contentIndex) ?? { sent: "", chars: 0 };
				if (update.type === "toolcall_delta") seen.chars += String(update.delta ?? "").length;
				toolCalls.set(update.contentIndex, seen);
				// A provider that names the call only in a later delta: the step waits for it.
				if (!id || !name) return heartbeat(update.type, update.contentIndex);
				const preview = previewOf(name, call.arguments, seen.chars);
				const key = JSON.stringify(preview);
				if (update.type === "toolcall_delta" && key === seen.sent) return heartbeat(update.type, update.contentIndex);
				seen.sent = key;
				return { type: "message_update", assistantMessageEvent: { type: update.type, contentIndex: update.contentIndex, id, name, preview } };
			}
			case "server_tool_start": {
				const query = typeof update.input?.query === "string" && update.input.query ? update.input.query.slice(0, PREVIEW_FIELD_MAX_CHARS) : "";
				return { type: "message_update", assistantMessageEvent: { type: "server_tool_start", id: String(update.id ?? ""), name: String(update.name ?? ""), at: now(), ...(query ? { query } : {}) } };
			}
			case "server_tool_end":
				return { type: "message_update", assistantMessageEvent: { type: "server_tool_end", id: String(update.id ?? ""), ok: update.ok === true, at: now() } };
			default:
				return cleanFrame(event, thinkingWords);
		}
	};
}
