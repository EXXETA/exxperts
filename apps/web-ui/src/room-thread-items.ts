import { modelNotOnAccount } from "../../web-server/src/model-not-on-account";
import { modelNotOffered } from "../../web-server/src/model-not-offered";
import { isTurnRunningNote, type TurnFailure, savedLineShown, isRetryNote, isStopLine } from "./turn-failure-line";
import { REMOVED_IDS_CAP } from "../../web-server/src/thread-items-by-id";
import type { PersistentAgentId, WebChatModelOption, ChatItem, PersistentAgentStatus, PersistentAgentThreadOrigin, PersistentAgentThreadRecord } from "./types";

type PersistentAgentThread = {
	state: "live" | "standby";
	agentId: PersistentAgentId;
	displayName: string;
	conversationId: string;
	model: WebChatModelOption;
	items: ChatItem[];
};
// A just-created room is not in the room list yet; its create answer brings
// the model rows along.
type PersistentAgentTarget = { id: PersistentAgentId; displayName?: string; models?: PersistentAgentStatus["models"] };
type MaintainTarget = { agentId: PersistentAgentId; displayName: string };
type PersistentChatConfig = Pick<PersistentAgentThread, "agentId" | "displayName" | "conversationId" | "model"> | null;

interface SessionUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
	/** What the last turn LEFT BEHIND, when the provider measured it separately from what it cost. */
	contextTokens: number | null;
}

function threadRecordToLocalThread(record: PersistentAgentThreadRecord, fallbackDisplayName = "Persistent room"): PersistentAgentThread {
	if (record.state === "closed") throw new Error("This room thread is closed and cannot be resumed.");
	const model: WebChatModelOption = { provider: record.model.provider, model: record.model.model, label: record.model.label || `${record.model.provider}/${record.model.model}` };
	return {
		state: record.state === "active" ? "live" : "standby",
		agentId: record.agentId,
		displayName: fallbackDisplayName,
		conversationId: record.threadId,
		model,
		items: settleLoadedItems(Array.isArray(record.items) ? record.items as ChatItem[] : []).filter((item) => !isSavedModelWaitLine(item) && !isSavedRetryNote(item) && !isTurnRunningNote(item)).map(withSavedFailureLineShown),
	};
}

// Which of the plain lines a failed attempt calls for: an overflow by the server's cause, the model not on the account or no longer offered by its words.
function failureKindOf(detail: string, failure?: TurnFailure): { contextOverflow: boolean; notOnAccount: boolean; notOffered: boolean } {
	// A context overflow is a size problem, not a sign-in problem: the
	// "check AI setup" advice would send the user to the wrong place.
	const contextOverflow = failure === "overflow";
	const notOnAccount = !contextOverflow && modelNotOnAccount(detail);
	const notOffered = !contextOverflow && !notOnAccount && (modelNotOffered(detail) || failure === "not-offered");
	return { contextOverflow, notOnAccount, notOffered };
}

// A saved line as it shows on the way in: an older build's read into fields and today's words, a plan's reset worded for now (turn-failure-line.ts).
function withSavedFailureLineShown(item: ChatItem): ChatItem {
	return item.kind === "system" && typeof item.text === "string" ? savedLineShown(item) : item;
}

// Older builds wrote the "signed out" or "no longer offered" refusal into the
// conversation as a red line. The room says it once, in the notice above the
// composer, so a saved copy is not shown again.
const SAVED_MODEL_WAIT_LINE = /is signed out, so this conversation cannot continue on |^This room's (?:memory )?model, .+, is (?:signed out|no longer offered)\./;
// A retry note saved while the runtime was retrying: the retry ended long ago, with the app or the connection.
function isSavedRetryNote(item: ChatItem): boolean {
	return item.kind === "system" && isRetryNote(String(item.text ?? ""));
}
function isSavedModelWaitLine(item: ChatItem): boolean {
	return item.kind === "system" && item.level === "error" && SAVED_MODEL_WAIT_LINE.test(String(item.text ?? ""));
}

/**
 * A thread on disk can carry a reply mid-flight: the browser saves while an
 * answer streams (the `streaming` mark lets a reload draw the caret in the
 * right place), and if that tab died before its next save the mark stays.
 * Opened later, nothing is streaming any more: such a segment is shown as
 * settled, and one that never received a character (the slot reserved for
 * a reply the moment its message ended) is dropped rather than shown as a
 * permanent "…". A turn still cooking is reattached separately and rebuilds
 * its tail from the anchor, so this loses nothing live.
 */
function settleLoadedItems(items: ChatItem[]): ChatItem[] {
	const settled: ChatItem[] = [];
	for (const item of items) {
		if (item.kind === "assistant" && item.streaming) {
			if (!String(item.text ?? "").trim()) continue;
			settled.push({ ...item, streaming: false });
			continue;
		}
		settled.push(item);
	}
	return settled;
}

// Consult MR-5: reconstruct which consult items still show the pending hint when
// a thread is restored — the `count` most recent consult items in the transcript,
// since each un-consumed transfer contributes exactly one queued block and one
// (trailing) consult item.
function deriveTrailingConsultIds(items: ChatItem[], count: number): Set<string> {
	const ids = new Set<string>();
	if (count <= 0) return ids;
	for (let i = items.length - 1; i >= 0 && ids.size < count; i--) {
		const item = items[i];
		if (item.kind === "consult") ids.add(item.id);
	}
	return ids;
}

const ZERO_USAGE: SessionUsage = {
	turns: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	totalTokens: 0,
	contextTokens: null,
};

let __nextId = 1;
const nid = () => `i_${Date.now().toString(36)}_${__nextId++}_${Math.random().toString(36).slice(2, 7)}`;

const newConversationId = () => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
const DIRECT_RESUME_INCOMPATIBLE_MODEL_MESSAGE = "This conversation's model is not available now. Choose another model in Room settings, Model, to continue it.";

function formatDirectResumeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (/model is not approved/i.test(message)) return DIRECT_RESUME_INCOMPATIBLE_MODEL_MESSAGE;
	return message || "Could not continue this conversation.";
}

/**
 * A tool call that was in flight when its turn ended will never get a result:
 * the toolResult event that would settle it is exactly what the abort or the
 * failure prevented. Left alone it spins forever, in the transcript and on
 * disk, its bundle keeps claiming the room is still reading, and the reply's
 * copy button waits on it. Stopped rather than failed, because the tool
 * itself did nothing wrong.
 */
/** The work a turn had in flight, ended where the turn ended: a step being written or running is stopped, a thought still going ends now. */
function stopWorkInFlight(items: ChatItem[], now = Date.now()): ChatItem[] {
	const stopped = items.some(isStepInFlight)
		? items.map((it) => (isStepInFlight(it) ? { ...it, status: "stopped" as const } : it))
		: items;
	return endLiveThinking(stopped, now);
}

/** A thought still going ends now: its row reads how long it took. */
function endLiveThinking(items: ChatItem[], now = Date.now()): ChatItem[] {
	return items.some((it) => it.kind === "thinking" && it.ms === undefined)
		? items.map((it) => (it.kind === "thinking" && it.ms === undefined ? { ...it, ms: Math.max(0, now - it.ts) } : it))
		: items;
}

/**
 * What a failed attempt leaves after the person's message, which goes with the
 * message when the server hands it back: its lines, words and thinking, and
 * steps that never got a result (a provider's search the failure cut, a step
 * still being written). A step with a result ran, and the server keeps such a
 * turn where it is.
 */
function leftByFailedAttempt(item: ChatItem): boolean {
	return item.kind === "system" || item.kind === "assistant" || item.kind === "thinking" || (item.kind === "tool" && item.result === undefined);
}

/** A step the model is still writing, or one that runs. */
function isStepInFlight(item: ChatItem): boolean {
	return item.kind === "tool" && (item.status === "writing" || item.status === "running");
}

/**
 * What a room saves of its conversation: never the running-turn note, the
 * model's thinking, or a step the model is still writing (it is saved from
 * running on, with its whole arguments), and no step's end time, which only
 * the window that watched it knows. Nothing new reaches the saved thread.
 */
function itemsToSave(items: ChatItem[]): ChatItem[] {
	return items.flatMap((item): ChatItem[] => {
		if (isTurnRunningNote(item) || item.kind === "thinking") return [];
		if (item.kind !== "tool") return [item];
		if (item.status === "writing") return [];
		if (item.endedAt === undefined) return [item];
		const { endedAt: _endedAt, ...saved } = item;
		return [saved];
	});
}

/**
 * A turn whose card says the person pressed Stop before answering has said how
 * it ended, so the turn's own Stop line goes: one Stop line, not two. The card
 * and the turn's end reach the page in either order, so both apply it.
 */
function withoutStopLineUnderStoppedCard(items: ChatItem[]): ChatItem[] {
	const lastUser = items.map((item) => item.kind).lastIndexOf("user");
	if (!items.slice(lastUser + 1).some((item) => item.kind === "approval" && item.stopped)) return items;
	return items.filter((item, index) => index <= lastUser || item.kind !== "system" || !isStopLine(item.text));
}

/**
 * The body of a conversation save, the same for every writer (the debounced
 * save, a reconnect's, the keepalive on the way out). `pendingHandoffs` is
 * kept as stored when absent; `removed` names the items the page took out
 * on purpose, which no copy of the conversation brings back.
 */
function threadSaveBody(save: { state: "active" | "standby"; origin: PersistentAgentThreadOrigin; model: WebChatModelOption; items: ChatItem[]; pendingHandoffs?: string[]; removed: readonly string[] }): string {
	return JSON.stringify({ state: save.state, origin: save.origin, model: save.model, items: itemsToSave(save.items), ...(save.pendingHandoffs !== undefined ? { pendingHandoffs: save.pendingHandoffs } : {}), ...(save.removed.length ? { removed: save.removed } : {}) });
}

/**
 * The ids the page took out of each conversation on purpose (a message
 * handed back to the box), oldest first, until a save that named them
 * succeeds. A save names at most the server's cap; the rest wait for the next.
 */
class PendingRemovals {
	private readonly byConversation = new Map<string, string[]>();
	private static key(room: string, conversation: string): string {
		return JSON.stringify([room, conversation]);
	}
	add(room: string, conversation: string, ids: readonly string[]): void {
		const key = PendingRemovals.key(room, conversation);
		const pending = this.byConversation.get(key) ?? [];
		this.byConversation.set(key, [...pending, ...ids.filter((id) => id && !pending.includes(id))]);
	}
	all(room: string, conversation: string): string[] {
		return [...(this.byConversation.get(PendingRemovals.key(room, conversation)) ?? [])];
	}
	/** What one save names: the oldest, up to the cap. */
	forSave(room: string, conversation: string): string[] {
		return this.all(room, conversation).slice(0, REMOVED_IDS_CAP);
	}
	/** A save that named these succeeded: only they are done. */
	clear(room: string, conversation: string, saved: readonly string[]): void {
		const key = PendingRemovals.key(room, conversation);
		const left = (this.byConversation.get(key) ?? []).filter((id) => !saved.includes(id));
		if (left.length) this.byConversation.set(key, left);
		else this.byConversation.delete(key);
	}
}

/**
 * What a window holds after it reconnects: the saved copy, less the items
 * this tab removed on purpose, with the items only this tab holds (no saved
 * item has their id), each after the nearest earlier item of this tab that
 * the result holds, or at the end. An approval card is one question, by its
 * request: a saved card for the same request stands, and this tab's older
 * card goes. The handoff queue is the saved one, then this tab's entries
 * whose transferred card only this tab holds (`cardOf` names an entry's
 * card), in this tab's order: an entry another window used up stays used up.
 */
function reconnectedThread(saved: { items: ChatItem[]; queue: string[] }, local: { items: ChatItem[]; queue: string[] }, removed: ReadonlySet<string>, cardOf: (entry: string) => string | undefined): { items: ChatItem[]; queue: string[] } {
	const items = saved.items.filter((item) => !removed.has(item.id));
	const savedIds = new Set(saved.items.map((item) => item.id));
	const savedCardByRequest = new Map(saved.items.flatMap((item) => (item.kind === "approval" ? [[item.requestId, item.id] as const] : [])));
	// Where this tab's items sit in the result: by their own id, a card of a saved question by the saved card's.
	const placeOf = (item: ChatItem): string => (item.kind === "approval" ? savedCardByRequest.get(item.requestId) ?? item.id : item.id);
	const onlyHere = new Set<string>();
	let lastHeld: string | undefined;
	for (const item of local.items) {
		if (removed.has(item.id)) continue;
		const place = placeOf(item);
		if (savedIds.has(place)) {
			if (items.some((held) => held.id === place)) lastHeld = place;
			continue;
		}
		const at = lastHeld === undefined ? -1 : items.findIndex((held) => held.id === lastHeld);
		if (at >= 0) items.splice(at + 1, 0, item);
		else items.push(item);
		onlyHere.add(item.id);
		lastHeld = item.id;
	}
	const queue = [...saved.queue, ...local.queue.filter((entry) => {
		const card = cardOf(entry);
		return card !== undefined && onlyHere.has(card);
	})];
	return { items, queue };
}

/** The id a keyed turn's frame names its item by (room-socket.ts, its head comment), or undefined on a frame without one. */
function frameItemId(frame: unknown): string | undefined {
	const id = (frame as { itemId?: unknown } | null)?.itemId;
	return typeof id === "string" && id ? id : undefined;
}

function hasUserInput(items: ChatItem[]): boolean {
	return items.some((item) => item.kind === "user" && item.text.trim().length > 0);
}

function hasUserVisibleTurn(items: ChatItem[]): boolean {
	return items.some((item) => (item.kind === "user" || item.kind === "assistant") && item.text.trim().length > 0);
}

export { PendingRemovals, ZERO_USAGE, deriveTrailingConsultIds, failureKindOf, frameItemId, reconnectedThread, threadSaveBody, formatDirectResumeError, hasUserInput, hasUserVisibleTurn, endLiveThinking, itemsToSave, leftByFailedAttempt, newConversationId, nid, stopWorkInFlight, threadRecordToLocalThread, withoutStopLineUnderStoppedCard };
export type { MaintainTarget, PersistentAgentTarget, PersistentAgentThread, PersistentChatConfig, SessionUsage };
