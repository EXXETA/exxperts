// Projection for agent-session events forwarded to the web client over the
// WebSocket. Every message_update from the agent loop carries the full
// accumulated assistant message twice (the `message` field plus
// `assistantMessageEvent.partial`), so a long thinking or tool-call phase
// floods the socket with hundreds of progressively larger frames the UI
// parses and discards. Slim each variant to what the web client actually
// reads: text deltas, text_end's final block text, and type-only heartbeats
// for the rest (a "model is busy" signal). message_end is not a
// message_update and passes through untouched — it stays the authoritative
// full-message reconciliation for the client.
export const projectAgentEventForWebClient = (event: any): any => {
	// A step's start carries when it began. The frame is kept as sent for a
	// reattach, so a page that reloads counts the step's time on from here.
	if (event?.type === "tool_execution_start") return { ...event, startedAt: Date.now() };
	if (event?.type !== "message_update") return event;
	const update = event.assistantMessageEvent;
	switch (update?.type) {
		case "text_delta":
			return {
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: update.contentIndex,
					delta: update.delta ?? "",
				},
			};
		case "text_end":
			return {
				type: "message_update",
				assistantMessageEvent: {
					type: "text_end",
					contentIndex: update.contentIndex,
					content: update.content ?? "",
				},
			};
		case "text_start":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return {
				type: "message_update",
				assistantMessageEvent: {
					type: update.type,
					contentIndex: update.contentIndex,
				},
			};
		default:
			return event;
	}
};
