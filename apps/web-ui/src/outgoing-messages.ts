import { bubbleIdOf } from "../../web-server/src/steer-route";

/**
 * Messages the person sent while the room answers, until the room has them.
 * Enter queues: the page sends the message as a steer and the server decides
 * where it goes (steer-route.ts), in after the running step or after the
 * answer it thinks or writes. Cmd/Ctrl+Enter or Send now stops the answer at
 * the words on screen and that message goes as the next one, alone; the
 * others queued with it wait for the new answer as queued messages do. "@Room question"
 * typed while the room answers waits here, and goes to that room as a consult
 * once the answer ends.
 *
 * A message no answer will take stays as a held message (the server keeps it
 * on disk, held-messages-store.ts): nothing sends it by itself; the person
 * sends, edits or removes it. The server keeps the ones only the page has
 * too (`keptChanges`), so a reload or a closed window loses none.
 *
 * Each message shows as its own "Queued" bubble under the answer until the
 * room takes it; the bubble is drawn from this list and never saved. A
 * message the room took becomes the conversation's own bubble, `bubbleIdOf`
 * its id, where the room took it.
 */

export type OutgoingState =
	/** Sent to the server, which has not said yet where it goes. */
	| "routing"
	/** The running answer holds it for its next step or its end. */
	| "waiting"
	/** "@Room question": the page holds it until the answer ends, then asks that room. */
	| "consult"
	/** The answer stopped for it, or no answer ran to take it: it goes as the next message once the turn has ended. */
	| "next"
	/** Queued when the answer stopped for another message: it waits for the new answer, as a queued message. */
	| "later"
	/** No answer will take it: it waits for the person, on disk. */
	| "held";

export interface OutgoingMessage {
	id: string;
	text: string;
	state: OutgoingState;
	/** A "consult" message's room and question. */
	consult?: { roomId: string; question: string };
	/** A consult Send now chose: it goes before the messages left waiting behind it. */
	first?: true;
}

/** A message as a server frame lists it. */
export interface ListedMessage {
	id: string;
	text: string;
}

export type OutgoingAction =
	| { type: "add"; id: string; text: string; state: "routing" | "next" | "later" | "consult"; consult?: { roomId: string; question: string } }
	/** The server's steer_waiting. */
	| { type: "waiting"; id: string }
	/** The answer stops for them, or no answer ran to take them: they go next. */
	| { type: "next"; ids: readonly string[] }
	/**
	 * The answer stops for this one: it goes next, alone (a consult, first),
	 * and the others queued for the answer wait for the new one, also those the
	 * server handed back for the cut before it said so.
	 */
	| { type: "now"; id: string }
	/** The new answer runs: these go to it as queued messages. */
	| { type: "steer"; ids: readonly string[] }
	/** No new answer ran: these go as the next message. */
	| { type: "promote"; ids: readonly string[] }
	/** The room took them in, they went as the next message, the box took them back, or the person removed them. */
	| { type: "gone"; ids: readonly string[] }
	/** These are held now; one not in the list yet joins it held. */
	| { type: "held"; messages: readonly ListedMessage[] }
	/**
	 * A new connection, once its ready said what the server has: the running
	 * answer's waiting messages, the conversation's held ones, and the ones the
	 * last turn took. What only this page had (sent but never answered, going
	 * next, or a consult) is held from here; `heldFromPage` names those, for
	 * the server to keep.
	 */
	| { type: "reconcile"; waiting: readonly ListedMessage[]; held: readonly ListedMessage[]; taken: readonly string[] }
	/** Another conversation opened. */
	| { type: "clear" };

export function reduceOutgoing(list: readonly OutgoingMessage[], action: OutgoingAction): OutgoingMessage[] {
	// A message only moves forward: once the answer stops for it, it never waits again.
	const move = (ids: readonly string[], to: OutgoingState, from: readonly OutgoingState[]) => list.map((message) => (ids.includes(message.id) && from.includes(message.state) ? { ...message, state: to } : message));
	switch (action.type) {
		case "add":
			if (!action.text.trim() || list.some((message) => message.id === action.id)) return [...list];
			return [...list, { id: action.id, text: action.text.trim(), state: action.state, ...(action.consult ? { consult: action.consult } : {}) }];
		case "waiting":
			return move([action.id], "waiting", ["routing"]);
		case "next":
			return move(action.ids, "next", ["routing", "waiting", "next"]);
		case "now":
			return list.map((message): OutgoingMessage => {
				if (message.id === action.id) return message.state === "consult" ? { ...message, first: true } : message.state === "held" ? message : { ...message, state: "next" };
				return message.state === "routing" || message.state === "waiting" || message.state === "next" ? { ...message, state: "later" } : message;
			});
		case "steer":
			return move(action.ids, "routing", ["later"]);
		case "promote":
			return move(action.ids, "next", ["later"]);
		case "gone":
			return list.filter((message) => !action.ids.includes(message.id));
		case "held": {
			const ids = new Set(action.messages.map((message) => message.id));
			const known = new Set(list.map((message) => message.id));
			const kept = list.map((message) => (ids.has(message.id) ? { ...message, state: "held" as const } : message));
			return [...kept, ...action.messages.filter((message) => !known.has(message.id) && message.text.trim()).map((message) => ({ id: message.id, text: message.text.trim(), state: "held" as const }))];
		}
		case "reconcile": {
			const waiting = new Set(action.waiting.map((message) => message.id));
			const held = new Set(action.held.map((message) => message.id));
			const kept = list
				// A held message the server no longer has was sent or removed in another window.
				.filter((message) => !action.taken.includes(message.id) && (message.state !== "held" || held.has(message.id) || waiting.has(message.id)))
				.map((message): OutgoingMessage => ({ ...message, state: waiting.has(message.id) ? "waiting" : "held" }));
			const known = new Set(kept.map((message) => message.id));
			const added = [...action.waiting.map((message) => ({ ...message, state: "waiting" as const })), ...action.held.map((message) => ({ ...message, state: "held" as const }))]
				.filter((message) => !known.has(message.id) && !action.taken.includes(message.id) && message.text.trim() && known.add(message.id))
				.map((message) => ({ ...message, text: message.text.trim() }));
			return [...kept, ...added];
		}
		case "clear":
			return [];
	}
}

/** States the server keeps on disk for the conversation: the ones only this page has, and the held ones. */
const KEPT_STATES: readonly OutgoingState[] = ["consult", "next", "later", "held"];

/**
 * What the server must keep or let go after a change: a message entering a
 * kept state goes to it (`hold`), one leaving them (taken in, sent, edited,
 * removed, or steered to the answer, which holds it itself) comes off (`drop`).
 */
export function keptChanges(before: readonly OutgoingMessage[], after: readonly OutgoingMessage[]): { hold: ListedMessage[]; drop: string[] } {
	const kept = (list: readonly OutgoingMessage[]) => new Map(list.filter((message) => KEPT_STATES.includes(message.state)).map((message) => [message.id, message]));
	const was = kept(before);
	const now = kept(after);
	return {
		hold: [...now.values()].filter((message) => !was.has(message.id)).map(({ id, text }) => ({ id, text })),
		drop: [...was.keys()].filter((id) => !now.has(id)),
	};
}

/** What a reconcile turns into held messages that only this page had: the page asks the server to keep them. */
export function heldFromPage(list: readonly OutgoingMessage[], ready: { waiting: readonly ListedMessage[]; held: readonly ListedMessage[]; taken: readonly string[] }): ListedMessage[] {
	const known = new Set([...ready.waiting, ...ready.held].map((message) => message.id));
	return list.filter((message) => message.state !== "held" && !known.has(message.id) && !ready.taken.includes(message.id)).map(({ id, text }) => ({ id, text }));
}

export { bubbleIdOf };

/** A bubble under the answer: its words and what the person can do with it. */
export interface QueuedBubble {
	id: string;
	text: string;
	held: boolean;
	/** It can go back into the box or be removed: nothing is sending it right now. */
	takeBack: boolean;
	/** Cmd/Ctrl+Enter in an empty box sends this one now: the first queued for the answer. */
	chord: boolean;
}

/**
 * Taken back on the page alone (held, a consult, one waiting for the new
 * answer), or by the server out of the running answer's queue (waiting).
 * One on its way to the server or going next is already being sent.
 */
const TAKE_BACK_STATES: readonly OutgoingState[] = ["held", "waiting", "later", "consult"];

/** The bubbles under the answer: every message the room has not taken, oldest first. */
export function queuedBubbles(list: readonly OutgoingMessage[]): QueuedBubble[] {
	const first = queuedForAnswer(list)[0]?.id;
	return list.map((message) => ({ id: message.id, text: message.text, held: message.state === "held", takeBack: TAKE_BACK_STATES.includes(message.state), chord: message.id === first }));
}

/** Waiting for a new answer, oldest first. */
export function laterIds(list: readonly OutgoingMessage[]): string[] {
	return list.filter((message) => message.state === "later").map((message) => message.id);
}

/** Everything that goes as the next message, in the order it was sent; one message, joined by blank lines. */
export function nextBatch(list: readonly OutgoingMessage[]): { ids: string[]; text: string } | null {
	const batch = list.filter((message) => message.state === "next");
	if (batch.length === 0) return null;
	return { ids: batch.map((message) => message.id), text: batch.map((message) => message.text).join("\n\n") };
}

/** The first consult waiting for the answer's end. */
export function nextConsult(list: readonly OutgoingMessage[]): OutgoingMessage | null {
	return list.find((message) => message.state === "consult") ?? null;
}

/** A consult Send now chose: it goes before anything else queued. */
export function firstConsult(list: readonly OutgoingMessage[]): OutgoingMessage | null {
	return list.find((message) => message.state === "consult" && message.first) ?? null;
}

/** A cut is settling: a message typed now waits for the new answer instead of going to the server. */
export function cutSettling(list: readonly OutgoingMessage[]): boolean {
	return list.some((message) => message.state === "next");
}

/** Queued for the running answer (Send now and Cmd/Ctrl+Enter send them now); held messages are not. */
export function queuedForAnswer(list: readonly OutgoingMessage[]): OutgoingMessage[] {
	return list.filter((message) => message.state !== "held");
}

/** Stop or Esc: every message queued for the answer goes back into the box, oldest first, joined. */
export function handBackAll(list: readonly OutgoingMessage[]): { ids: string[]; text: string } {
	const back = queuedForAnswer(list);
	return { ids: back.map((message) => message.id), text: back.map((message) => message.text).join("\n\n") };
}

/** The box's text with the handed-back messages above it, joined by blank lines; the cursor goes at the end. */
export function boxWithHandBack(handed: string, box: string): string {
	return [handed.trim(), box.trim()].filter(Boolean).join("\n\n");
}

/** Under each bubble the room has not taken. */
export const WAITING_CAPTION = "Queued";
/** Send's hover while the room answers and files are staged: a queued message carries words only. */
export const QUEUE_REFUSED_FILES = "Send files once the answer ends";
/** Send's hover while the room answers and the message is past the held limits. */
export const QUEUE_REFUSED_TOO_LONG = "Too long to queue";

/** The messages a server frame lists, read leniently. */
export function readMessageList(raw: unknown): ListedMessage[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry: any) => (typeof entry?.id === "string" && entry.id && typeof entry?.text === "string" && entry.text.trim() ? [{ id: entry.id, text: entry.text }] : []));
}

/** Message ids a server frame lists, read leniently. */
export function readMessageIds(raw: unknown): string[] {
	return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}
