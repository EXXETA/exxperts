/**
 * The steps of a turn nobody watched, rebuilt from its session messages so a
 * landing can save them as the cards the page shows live: done, failed, or
 * stopped for a call that never got its result.
 */

export interface TurnStepItem {
	kind: "tool";
	id: string;
	name: string;
	args: unknown;
	status: "done" | "error" | "stopped";
	result?: string;
	details?: unknown;
}

/** The page's rules for live steps: memory and knowledge lookups stay behind the activity line, and they and a hand-off show only when they failed. */
function shownLive(name: string, isError: boolean): boolean {
	if (name === "memory_recall") return true;
	if (name.startsWith("kb_") || name.startsWith("memory_")) return isError;
	if (name === "delegate_task") return isError;
	return true;
}

function resultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
}

export function createTurnStepLog() {
	const calls: Array<{ id: string; name: string; args: unknown }> = [];
	const results = new Map<string, { text: string; isError: boolean; details?: unknown }>();
	return {
		/** Takes every message the turn ends; only tool calls and their results are kept. */
		note(message: any): void {
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content) {
					const id = part?.type === "toolCall" ? String(part.id ?? part.toolCallId ?? "") : "";
					if (id) calls.push({ id, name: String(part.name ?? "tool"), args: part.arguments ?? part.args ?? {} });
				}
			} else if (message?.role === "toolResult" && message.toolCallId) {
				results.set(String(message.toolCallId), { text: resultText(message.content), isError: message.isError === true, ...(message.details !== undefined ? { details: message.details } : {}) });
			}
		},
		items(idPrefix: string): TurnStepItem[] {
			const items: TurnStepItem[] = [];
			for (const call of calls) {
				const result = results.get(call.id);
				if (!shownLive(call.name, result?.isError === true)) continue;
				items.push({
					kind: "tool",
					id: `${idPrefix}-${items.length + 1}`,
					name: call.name,
					args: call.args,
					status: !result ? "stopped" : result.isError ? "error" : "done",
					...(result ? { result: result.text } : {}),
					...(result?.details !== undefined ? { details: result.details } : {}),
				});
			}
			return items;
		},
	};
}

/** The answer's text as a turn lands it, after one more assistant message: a failed attempt the runtime asks again (`retrying`) gives way to its retry, as on the page. `retryFrom`: the text before that attempt. */
export function landedTextAfter(landed: { text: string; retryFrom?: string }, text: string, retrying: boolean): { text: string; retryFrom?: string } {
	const before = landed.retryFrom ?? landed.text;
	const next = text ? { text: [before, text].filter(Boolean).join("\n\n") } : landed;
	return retrying ? { text: next.text, retryFrom: before } : next;
}
