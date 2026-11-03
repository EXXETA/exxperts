/**
 * The steps of a turn nobody watched, rebuilt from its session messages so a
 * landing can save them as the cards the page shows live: done, failed, or
 * stopped for a call that never got its result. A search the provider ran
 * itself is no block of a message, so it comes from the turn's events and
 * lands as a step too. The messages the person sent that the turn took
 * between its steps land beside them, where it took them.
 *
 * A keyed turn (thread-items-by-id.ts) also keeps its answer here, one part
 * per stretch of text as the page shows it, and names every part, step and
 * search the way its frames name them, so a landing writes the turn as it
 * was shown live, under the ids the page holds.
 */
import { answerPartId, ECHO_WINDOW_MS, evenedText, searchStepId, stepId } from "./thread-items-by-id.js";

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

/** `steered`: the room took it while it answered, so it is part of that answer's turn. */
export interface TurnSteerItem { kind: "user"; id: string; text: string; ts: number; steered: true }

/** A tool the provider ran itself (its own web search): it sits after the block written before it. `ok` stays unset until it ends. */
type ProviderTool = { id: string; name: string; query?: string; ok?: boolean; after: number };

/** A stretch of a keyed turn's answer: `stoppedAt` when a Stop or a cut kept only its first words. */
type AnswerPart = { id: string; text: string; ts: number; stoppedAt?: number };

/** A landed answer part as the turn writes it. */
export interface TurnPartItem { kind: "assistant"; id: string; text: string; streaming: false; ts: number; stoppedAt?: number }

/**
 * What a frame of a keyed turn carries for the page: the id of its item (a
 * part, a step or a search), with `opens` on the frame that opens the item.
 */
export type FrameIds = { itemId?: string; opens?: boolean };

/** A frame the projection cut to its kind (web-client-event-projection.ts): the coalescer merges a run of them into one. */
function isBareHeartbeat(update: any): boolean {
	return Object.keys(update).every((field) => field === "type" || field === "contentIndex");
}

/**
 * A keyed turn's projected frame with its item's id, inside the update of a
 * message_update and on the event otherwise. The frame that opens the item
 * always carries it, a bare text_start included; a later frame carries it
 * when it says something of its own, so a newer tool preview the coalescer
 * keeps in place of an older one still names the step, and a bare heartbeat
 * never does, so a run of them still merges (turn-frame-coalescer.ts).
 * `echoOf` on the message_end of a message that repeats an earlier part.
 */
export function withFrameIds(projected: any, ids: FrameIds, echoOf: string | undefined): any {
	const update = projected?.type === "message_update" ? projected.assistantMessageEvent : undefined;
	const itemId = ids.itemId && (ids.opens || !update || !isBareHeartbeat(update)) ? ids.itemId : undefined;
	if (!itemId && !echoOf) return projected;
	const named = itemId ? (update ? { ...projected, assistantMessageEvent: { ...update, itemId } } : { ...projected, itemId }) : projected;
	return echoOf ? { ...named, echoOf } : named;
}

export function createTurnStepLog(key?: string) {
	const entries: Array<{ call: { id: string; name: string; args: unknown } } | { steer: { id: string; text: string; ts: number } } | { providerTool: ProviderTool } | { part: AnswerPart } | { hiddenFailure: string }> = [];
	const results = new Map<string, { text: string; isError: boolean; details?: unknown }>();
	// The message being written: its own searches, and the newest block it has started.
	let providerTools: ProviderTool[] = [];
	let lastBlock = -1;
	// Keyed only: the counts the ids are made from, and the message being written.
	let partCount = 0;
	let callCount = 0;
	let searchCount = 0;
	const callIds = new Map<string, string>();
	const callNames = new Map<string, string>();
	const searchIds = new Map<string, string>();
	let open: { partIds: string[]; partsAtStart: number; textSincePart: boolean; breakPending: boolean; streamedText: boolean } | null = null;
	// The parts written so far, for the echo test, and the last message's stretches, for a cut after it ended.
	const finished: Array<{ id: string; evened: string; endedAt: number }> = [];
	let lastMessageParts: Array<{ part: AnswerPart; raw: string }> = [];
	/** A text block after a break opens a new part: the page closes its bubble at a thinking block, a shown step or a search, once text was written. */
	const breakIfWritten = () => { if (open?.textSincePart) open.breakPending = true; };
	const keyedFrame = (event: any): FrameIds => {
		if (!key) return {};
		if (event?.type === "message_start" && event.message?.role === "assistant") {
			const partsAtStart = partCount;
			open = { partIds: [answerPartId(key, ++partCount)], partsAtStart, textSincePart: false, breakPending: false, streamedText: false };
			return { itemId: open.partIds[0], opens: true };
		}
		const update = event?.type === "message_update" ? event.assistantMessageEvent : undefined;
		if (!update || !open) return {};
		switch (update.type) {
			case "text_start":
				if (!open.breakPending) return {};
				open.breakPending = false;
				open.textSincePart = false;
				open.partIds.push(answerPartId(key, ++partCount));
				return { itemId: open.partIds.at(-1), opens: true };
			case "text_delta":
				if (String(update.delta ?? "")) open.streamedText = true;
				if (String(update.delta ?? "").trim()) open.textSincePart = true;
				return {};
			case "thinking_start":
				breakIfWritten();
				return {};
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end": {
				const block = update.partial?.content?.[update.contentIndex] ?? update.toolCall;
				const callId = String(block?.id ?? "");
				const name = String(block?.name ?? "");
				// The projection sends a call lacking its id or its name as a heartbeat: the step opens on the first frame that has both.
				if (!callId || !name) return {};
				const known = callIds.get(callId);
				if (known) return { itemId: known };
				callIds.set(callId, stepId(key, ++callCount));
				if (shownLive(name, false)) breakIfWritten();
				return { itemId: callIds.get(callId), opens: true };
			}
			case "server_tool_start": {
				const searchId = String(update.id ?? "");
				if (!searchId) return {};
				const known = searchIds.get(searchId);
				if (known) return { itemId: known };
				searchIds.set(searchId, searchStepId(key, ++searchCount));
				breakIfWritten();
				return { itemId: searchIds.get(searchId), opens: true };
			}
			default:
				return {};
		}
	};
	/**
	 * A keyed message's stretches from its final content, broken where the
	 * page broke it, named in the order its frames opened them; a stretch no
	 * frame opened takes the next number. `shownAtStop`: the person stopped
	 * it with this many characters of the message on screen, counted across
	 * its stretches as written.
	 */
	const keyedParts = (content: any[], shownAtStop: number | undefined, now: number): Array<{ part: AnswerPart; raw: string; firstBlock: number }> => {
		const stretches: Array<{ raw: string; firstBlock: number }> = [];
		let written = false;
		let pending = false;
		const breakHere = () => { if (written) pending = true; };
		for (const tool of providerTools) if (tool.after < 0) breakHere();
		content.forEach((block: any, index: number) => {
			if (block?.type === "text" && typeof block.text === "string") {
				if (pending || stretches.length === 0) {
					pending = false;
					written = false;
					stretches.push({ raw: "", firstBlock: index });
				}
				stretches.at(-1)!.raw += block.text;
				if (block.text.trim()) written = true;
			} else if (block?.type === "thinking" || (block?.type === "toolCall" && shownLive(String(block.name ?? ""), false))) {
				breakHere();
			}
			for (const tool of providerTools) if (tool.after === index) breakHere();
		});
		let left = shownAtStop;
		return stretches.map((stretch, index) => {
			const id = open?.partIds[index] ?? answerPartId(key!, ++partCount);
			if (left === undefined) return { part: { id, text: stretch.raw.trim(), ts: now }, raw: stretch.raw, firstBlock: stretch.firstBlock };
			const kept = stretch.raw.slice(0, Math.max(0, left)).trim();
			left = Math.max(0, left - stretch.raw.length);
			return { part: { id, text: kept, ts: now, ...(kept === stretch.raw.trim() ? {} : { stoppedAt: kept.length }) }, raw: stretch.raw, firstBlock: stretch.firstBlock };
		});
	};
	/** Cuts a part already in the log to its first `kept` characters; a part cut to nothing writes nothing. */
	const cutPart = (part: AnswerPart, kept: number) => {
		if (kept >= part.text.length) return;
		part.text = part.text.slice(0, Math.max(0, kept)).trimEnd();
		part.stoppedAt = part.text.length;
	};
	return {
		/**
		 * Takes the turn's events; only the provider's own tools are kept from
		 * them, the rest comes from `note`. A keyed turn's frame answers with
		 * the id of its item, and `opens` when it opens it.
		 */
		frame(event: any): FrameIds {
			const ids = keyedFrame(event);
			if (event?.type === "message_start") {
				providerTools = [];
				lastBlock = -1;
			}
			const update = event?.type === "message_update" ? event.assistantMessageEvent : undefined;
			if (typeof update?.contentIndex === "number") lastBlock = Math.max(lastBlock, update.contentIndex);
			if ((update?.type !== "server_tool_start" && update?.type !== "server_tool_end") || typeof update.id !== "string" || !update.id) return ids;
			let tool = providerTools.find((known) => known.id === update.id);
			if (!tool && update.type === "server_tool_start") {
				tool = { id: update.id, name: String(update.name || "tool"), after: lastBlock };
				providerTools.push(tool);
			}
			if (!tool) return ids;
			if (update.type === "server_tool_end") tool.ok = update.ok === true;
			// A start comes again once the call's arguments are known.
			else if (typeof update.input?.query === "string" && update.input.query) tool.query = update.input.query;
			return ids;
		},
		/** A message of the person's the turn took between its steps; `id` is its bubble's, so a landing replaces the bubble the page saved instead of adding a second. */
		tookMessage(id: string, text: string): void {
			if (text.trim()) entries.push({ steer: { id, text: text.trim(), ts: Date.now() } });
		},
		/**
		 * Takes every message the turn ends; only tool calls, their results and
		 * where the provider's own tools sat among them are kept, and for a
		 * keyed turn its answer's stretches. `retrying`: the runtime asks this
		 * attempt again, so its retry streams under the same ids and it keeps
		 * no part. A keyed message that streamed no text and repeats a part of
		 * this turn finished within the echo window is an echo: it keeps no
		 * part and answers `echoOf` that part's id.
		 */
		note(message: any, options: { retrying?: boolean; shownAtStop?: number; now?: number } = {}): { echoOf?: string } {
			let echoOf: string | undefined;
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				const now = options.now ?? Date.now();
				const parts = key && !options.retrying ? keyedParts(message.content, message.stopReason === "aborted" ? options.shownAtStop : undefined, now) : [];
				const whole = evenedText(parts.map(({ part }) => part.text).join(" "));
				if (key && whole && open && !open.streamedText) echoOf = finished.find((earlier) => earlier.evened === whole && now - earlier.endedAt < ECHO_WINDOW_MS)?.id;
				if (key && options.retrying && open) partCount = open.partsAtStart;
				const written = echoOf ? [] : parts;
				const placeProviderTools = (placed: (after: number) => boolean) => {
					for (const tool of providerTools.filter((known) => placed(known.after))) entries.push({ providerTool: tool });
				};
				placeProviderTools((after) => after < 0);
				message.content.forEach((part: any, index: number) => {
					for (const stretch of written) if (stretch.firstBlock === index && (stretch.part.text || stretch.part.stoppedAt !== undefined)) entries.push({ part: stretch.part });
					const id = part?.type === "toolCall" ? String(part.id ?? part.toolCallId ?? "") : "";
					if (id) {
						callNames.set(id, String(part.name ?? "tool"));
						// A call no frame announced is named here, once.
						if (key && !callIds.has(id)) callIds.set(id, stepId(key, ++callCount));
						entries.push({ call: { id, name: String(part.name ?? "tool"), args: part.arguments ?? part.args ?? {} } });
					}
					placeProviderTools((after) => after === index);
				});
				placeProviderTools((after) => after >= message.content.length);
				for (const { part } of written) if (part.text) finished.push({ id: part.id, evened: evenedText(part.text), endedAt: now });
				if (key && !options.retrying) lastMessageParts = written.map(({ part, raw }) => ({ part, raw }));
				providerTools = [];
				lastBlock = -1;
				open = null;
			} else if (message?.role === "toolResult" && message.toolCallId) {
				const callId = String(message.toolCallId);
				results.set(callId, { text: resultText(message.content), isError: message.isError === true, ...(message.details !== undefined ? { details: message.details } : {}) });
				// The page adds a hidden call's card only when its result failed, so the landing puts it there.
				if (key && message.isError === true && !shownLive(callNames.get(callId) ?? String(message.toolName ?? ""), false)) entries.push({ hiddenFailure: callId });
			}
			return echoOf ? { echoOf } : {};
		},
		/** A cut of the last message after it ended (the page still revealed it): `shownChars` of it as written. Answers the cut parts, each with the characters it keeps. */
		cutLastMessage(shownChars: number): Array<{ id: string; kept: number }> {
			let left = shownChars;
			const cuts: Array<{ id: string; kept: number }> = [];
			for (const { part, raw } of lastMessageParts) {
				const kept = raw.slice(0, Math.max(0, left)).trim().length;
				left = Math.max(0, left - raw.length);
				if (kept >= part.text.length) continue;
				cutPart(part, kept);
				cuts.push({ id: part.id, kept: part.text.length });
			}
			return cuts;
		},
		/** A cut of one named part of this turn, before it landed: answers the words it keeps, or undefined when the turn holds no such part. */
		cutNamedPart(partId: string, kept: number): string | undefined {
			for (const entry of entries) {
				if (!("part" in entry) || entry.part.id !== partId) continue;
				cutPart(entry.part, kept);
				return entry.part.text;
			}
			return undefined;
		},
		/** The ids of the last message's parts, newest last. */
		lastMessagePartIds(): string[] {
			return lastMessageParts.map(({ part }) => part.id);
		},
		items(idPrefix: string): Array<TurnStepItem | TurnSteerItem> {
			const items: Array<TurnStepItem | TurnSteerItem> = [];
			for (const entry of entries) {
				if ("part" in entry || "hiddenFailure" in entry) continue;
				if ("steer" in entry) {
					items.push({ kind: "user", ...entry.steer, steered: true });
					continue;
				}
				if ("providerTool" in entry) {
					const tool = entry.providerTool;
					items.push({ kind: "tool", id: `${idPrefix}-${items.length + 1}`, name: tool.name, args: tool.query ? { query: tool.query } : {}, status: tool.ok === undefined ? "stopped" : tool.ok ? "done" : "error" });
					continue;
				}
				const call = entry.call;
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
		/** A keyed turn's items in the order the page showed them, under the ids its frames named: its parts, steps, searches and taken messages. */
		keyedItems(): Array<TurnStepItem | TurnSteerItem | TurnPartItem> {
			if (!key) return [];
			const step = (call: { id: string; name: string; args: unknown }): TurnStepItem => {
				const result = results.get(call.id);
				return {
					kind: "tool",
					id: callIds.get(call.id) ?? `${key}-t0`,
					name: call.name,
					args: call.args,
					status: !result ? "stopped" : result.isError ? "error" : "done",
					...(result ? { result: result.text } : {}),
					...(result?.details !== undefined ? { details: result.details } : {}),
				};
			};
			const calls = new Map(entries.flatMap((entry) => ("call" in entry ? [[entry.call.id, entry.call] as const] : [])));
			return entries.flatMap((entry): Array<TurnStepItem | TurnSteerItem | TurnPartItem> => {
				if ("part" in entry) return [{ kind: "assistant", id: entry.part.id, text: entry.part.text, streaming: false, ts: entry.part.ts, ...(entry.part.stoppedAt !== undefined ? { stoppedAt: entry.part.stoppedAt } : {}) }];
				if ("steer" in entry) return [{ kind: "user", ...entry.steer, steered: true }];
				if ("hiddenFailure" in entry) {
					const call = calls.get(entry.hiddenFailure);
					return call ? [step(call)] : [];
				}
				if ("providerTool" in entry) {
					const tool = entry.providerTool;
					return [{ kind: "tool", id: searchIds.get(tool.id) ?? searchStepId(key, ++searchCount), name: tool.name, args: tool.query ? { query: tool.query } : {}, status: tool.ok === undefined ? "stopped" : tool.ok ? "done" : "error" }];
				}
				return shownLive(entry.call.name, false) ? [step(entry.call)] : [];
			});
		},
	};
}

/** The answer's text as a turn lands it, after one more assistant message: a failed attempt the runtime asks again (`retrying`) gives way to its retry, as on the page. `retryFrom`: the text before that attempt. */
export function landedTextAfter(landed: { text: string; retryFrom?: string }, text: string, retrying: boolean): { text: string; retryFrom?: string } {
	const before = landed.retryFrom ?? landed.text;
	const next = text ? { text: [before, text].filter(Boolean).join("\n\n") } : landed;
	return retrying ? { text: next.text, retryFrom: before } : next;
}
