import type { FastifyRequest } from "fastify";

import type { QuestionAuthority } from "./web-ui-context.js";
import type { PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import type { SteerRequest, SteerRouted } from "./steer-route.js";
import { itemsAsShown, type MessageAuthor, type MessageSender, type ShownPrompt, type ThreadItem } from "./thread-items-by-id.js";
import type { PersistentRoomBackgroundExecutionResult } from "./persistent-room-background-execution.js";
import { isSharedServer, serverHooks } from "./server-hooks.js";

// In-process registry of live web (WS) room sessions, keyed by agent id. The
// room lock guarantees at most one live web session per room on the desktop,
// and on a shared server the room's host is its one session (roomHosts), so a
// plain map is enough. Lifecycle endpoints (Memento) use this to quiesce an in-flight
// turn and to tell the connected client its thread just closed, instead of
// refusing with a 409 the user cannot act on.
type PersistentRoomLiveSession = {
	connectionId: string;
	conversationId: string;
	/** Abort any in-flight turn and dispose the session (same machinery as the WS "abort" frame + disconnect cleanup). */
	quiesceForBoundary: () => Promise<void>;
	/** Best-effort info line to the connected client. */
	notify: (message: string) => void;
	/** Close the socket; its close handler releases the room lock. */
	closeSocket: () => void;
	/**
	 * Moves this connection's conversation to another model between turns:
	 * the session is disposed, the conversation switched on disk, and a new
	 * session bound on the new model through the single rebind gate.
	 */
	/** Resolves with the id of the "Continued on" line the switch wrote, and of the one it replaced (a switch right after another), else null. */
	switchModel: (lock: PersistentAgentModelLock, notice: string) => Promise<{ noticeId: string; replaces: string | null }>;
	/** The context the provider last reported for this conversation, or null when it has not answered since the last compaction. */
	measuredContextTokens: () => number | null;
	/** The bound session's tool definitions by the one estimator, or null with no session. */
	toolDefinitionTokens: () => number | null;
};

const persistentRoomLiveSessions = new Map<string, PersistentRoomLiveSession>();

// Rooms whose web client disconnected while a turn was in flight and whose
// turn keeps cooking detached. The room lock stays held until
// the finished answer lands in the thread file; this set only makes the
// refusal message honest for a connection attempt that bounces off that lock
// ("finishing a response" rather than "open in another browser session").
const detachedCookingRooms = new Set<string>();

// Stepping back into a room: the handle a NEW connection uses to
// adopt a room's detached cooking turn instead of bouncing off it. Registered
// by the detaching connection's close handler, removed the moment the turn
// settles, and implemented entirely inside the detaching connection's closure
// so adoption never reaches into that closure's internals directly. The claim
// happens synchronously at connect time; the adopt (sink attach + buffered
// replay) happens after the new session is bound, in one synchronous block, so
// no frame can slip between the replay snapshot and the live sink.
type DetachedCookingTurnHandle = {
	readonly conversationId: string;
	readonly turnId: string;
	/** The user-authored text of the cooking turn's prompt, so the adopting client can restore the bubble when its persisted transcript lacks it. */
	readonly userText: string;
	/** A keyed turn's question (thread-items-by-id.ts): its id and its file chips, so the page puts back a question by id, words or none; absent for an old-style turn and a Try again. `userText` is then the bubble's words. */
	readonly promptId?: string;
	readonly promptFiles?: ShownPrompt["files"];
	settled: boolean;
	/** Who answers the turn's questions, when a page's message started it on a shared server. */
	readonly asker?: Asker;
	/** The connection that took over the room lock for this cooking turn (set at claim, before the adopt). */
	claimantConnectionId: string | null;
	/** The connection currently receiving the live stream (null while nobody is inside). */
	adopterConnectionId: string | null;
	/** Snapshot of every frame the turn has produced so far, from turn start, each serialised once as it was first sent. */
	bufferedTurnFrames: () => string[];
	/** True once the turn overflowed the replay byte cap: adoption must degrade to the honest bounce, never a truncated replay. */
	replayUnavailable: () => boolean;
	/** Free the replay buffer once the last possible replay has happened (the mid-bind claimant's settled replay). */
	releaseReplayBuffer: () => void;
	/** The last persisted thread item at TURN START, as stored: a reattach moves it past any earlier answer the page saved after it (earlierTurnsAnchorItemId in room-socket.ts) before handing it to the client as the supersede anchor, so completed prior turns can never be mistaken for this turn's debris. `null` means the thread was empty at turn start; `undefined` means unknown (the read failed), which clients treat conservatively. */
	readonly anchorItemId: string | null | undefined;
	/** How many prompts of earlier turns the file still lacked when this turn's message arrived (they are saved after the anchor); null for a continued turn, which has no prompt of its own. */
	readonly earlierPromptsAfterAnchor: number | null;
	/** When the turn began (epoch ms), so a restored prompt bubble carries the time it was sent rather than the time it was repaired. */
	readonly startedAt?: number;
	/** Record who now owns the room-lock record (an ordinary web-over-web takeover) and how to release it; a previous claimant's release is invoked owner-checked, which only stops its now-pointless heartbeat, and the previous holder, ADOPTER or still-binding CLAIMANT, is told it was displaced through the hook it registered here (an adopter upgrades the hook at adopt time), so no window is ever left silently lock-less. */
	claim: (connectionId: string, releaseLock: () => void, onDisplaced: () => void) => void;
	/** Route future turn frames to `sink`; a question for the asker alone comes with each page's own copy. Returns false for a stale claimant or a settled turn. */
	adopt: (connectionId: string, sink: (frame: string, perPage?: PageFrame) => void, hooks: { onSettled: () => void; onDisplaced: () => void }) => boolean;
	/** The adopter left (or died) mid-cook: back to detached cooking with the away limits re-armed, unless they still run, and frames buffer-only. No-op for a stale claimant. */
	redetach: (connectionId: string) => void;
	/** The adopter is ready for live frames (its replay is done): the away limits stand down, and the turn's questions reach it again, and any still open are asked again there. An adopter that cannot answer (a viewing-only device) leaves them declined as if nobody were in the room, and in a room on Auto without protection keeps the away limits running, or starts them again, since it can't stop the turn. No-op for a stale claimant. */
	attachQuestions: (connectionId: string, canAnswer: boolean, authority: QuestionAuthority) => void;
	/** The turn's open questions, and the answers taken, for a page joining the adopter's room, as that page's person is shown them. No-op for a stale claimant. */
	catchUpQuestions: (connectionId: string, page: RoomPage, sendTo: (frame: string) => void) => void;
	/** The adopter's answer to one of the turn's questions. Ignored from any other connection, so only the window that holds the turn answers. */
	answerQuestion: (connectionId: string, id: string, value: unknown, answeredBy: QuestionAuthority) => void;
	/** Stop the cooking turn through the same cancelling machinery the abort frame uses. Claimant-checked like adopt/redetach: a displaced connection's Stop must never abort the stream the current adopter is watching. `shown`: how much of the answer being written the page had shown; `forNext`: the person's waiting messages stopped it, not their Stop. */
	stop: (connectionId: string, shown?: number, forNext?: boolean) => Promise<void>;
	/** Stop after the answer ended, naming the part the page still revealed (`shown`: its characters kept), claimant-checked like stop. */
	stopRevealPart: (connectionId: string, partId: string, shown: number) => void;
	/** A message sent while the cooking turn answers, routed as the steer frame is, claimant-checked like stop; resolves to the frame the page gets. `who`: the sending page's person, as roomPerson names them. */
	steerTurn: (connectionId: string, request: SteerRequest, who: RoomPerson | undefined) => Promise<SteerRouted>;
	/** Who sent the turn's question and the messages it took, by the conversation's id of each: a page stepping in is told. */
	authors: () => ReadonlyArray<readonly [string, MessageAuthor | undefined]>;
	/** The turn's question and the messages it took as the server holds them, over a copy a page saved under their ids: a page stepping in is handed these. */
	messages: () => ThreadItem[];
	/** Edit or Remove on a message the cooking turn holds, claimant-checked like stop; resolves true once it is out of the runtime's queue. */
	withdrawSteer: (connectionId: string, id: string) => Promise<boolean>;
	/** Resolves when the cooking turn, whose answer has ended, records its finish; undefined while it still answers. A prompt from the adopter waits for it rather than being refused as a running turn. */
	windingDown: () => Promise<void> | undefined;
	/** The id of the last item the cooking turn's landing wrote; undefined until it lands, or when it wrote nothing of its own. The adopter's next message starts after it, whatever the page saved meanwhile. */
	landedItemId: () => string | undefined;
	/** The messages the cooking turn still holds for its next step or its answer's end, [{ id, text }], so the window that steps back in shows them waiting. Empty for any connection but the claimant, and once settled. */
	waiting: (connectionId: string) => Array<{ id: string; text: string }>;
};

const detachedCookingTurnHandles = new Map<string, DetachedCookingTurnHandle>();

// The limits of a turn that runs while nobody is in the room (none while
// someone watches: Stop is theirs). Unwatched, a hung provider stream would
// hold the room lock, bounce the connections detachedCookingRooms bounces and
// block archive, purge and a model switch until the person steps back in and
// stops it; a tool loop would spend money nobody sees. Past either limit the
// turn is aborted as a user stop aborts it, and the landing says which limit
// ended it, under the steps it finished.
// Silence: any runtime event of the turn is progress, and the clock waits
// while a local tool runs, since a quiet command is not a hung stream. 10
// minutes is as long as the Claude SDK itself waits for a first answer, and
// above the quiet stretches of a working turn (a long context's first token, a
// long thinking block). The Memory workers stop on silence too, sooner,
// because their calls are short; a room's turn writes code and runs long tool
// chains.
// Total: 60 minutes of working on its own, counted from the person's last
// leave, lets a long refactor of many steps finish while bounding a loop that
// never ends. Env overrides are for tests only.
const DETACHED_TURN_SILENCE_MS = Number(process.env.EXXETA_DETACHED_TURN_SILENCE_MS ?? "") || 10 * 60_000;
const DETACHED_TURN_LIMIT_MS = Number(process.env.EXXETA_DETACHED_TURN_DEADLINE_MS ?? "") || 60 * 60_000;

// A turn waits for the runtime's shortening after an overflow at most this long, so a summary that never ends cannot hold the conversation.
const OVERFLOW_RECOVERY_CEILING_MS = 4 * 60_000;

// The reattach replay buffer is byte-capped. A turn whose
// frames exceed this stops buffering, frees what it held, and marks itself
// replay-unavailable: a reattach then gets the honest room_cooking bounce (the
// landing still carries the full answer) instead of a truncated replay whose
// persist could clobber the clean landing. 8MB covers any turn a room can
// realistically stream while bounding tool-heavy monsters. Env override for
// tests only.
const REATTACH_REPLAY_CAP_BYTES = Number(process.env.EXXETA_REATTACH_REPLAY_CAP_BYTES ?? "") || 8 * 1024 * 1024;

// Test-only introspection (EXXPERTS_TEST_INTROSPECTION=1): per-room replay
// buffer stats, so tests can pin the buffer lifecycle (released at settle,
// overflow marked) from the outside. Never populated in normal operation.
const TEST_INTROSPECTION_ENABLED = process.env.EXXPERTS_TEST_INTROSPECTION === "1";

const reattachBufferProbe = new Map<string, { frames: number; bytes: number; overflowed: boolean }>();

/** The sentence a switch gets while the room answers. */
const SWITCH_WHILE_ANSWERING_MESSAGE = "The room is answering. Switch the model when the answer has finished.";

// --- One session per room on a shared server ---------------------------------

/** A page's own live connection, as a room socket uses it. */
type PageConnection = {
	readonly readyState: number;
	readonly OPEN: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	on(event: "message", listener: (raw: Buffer) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	off(event: "message", listener: (raw: Buffer) => void): unknown;
};

/** A page on a room's one session: its own connection, and the request that opened it. */
type RoomPage = { readonly socket: PageConnection; readonly req: FastifyRequest };

type RoomMessageListener = (raw: Buffer, from: RoomPage) => void;

/** A frame as one page is shown it, serialised. */
type PageFrame = (page: RoomPage) => string;

/** A page's person, as the edition's roomPerson slot names them: opaque ids, and the name others see ("" when unknown). */
type RoomPerson = { readonly person: string; readonly space: string; readonly name: string };

/** The person of the page that sent this request, or undefined where the edition names nobody or the slot throws. */
function pagePerson(req: FastifyRequest): RoomPerson | undefined {
	try {
		return serverHooks().roomPerson?.(req);
	} catch {
		return undefined;
	}
}

/**
 * Who answers the questions of an answer a page's message started on a shared
 * server: that page's person, from any of their pages; or, where that person
 * can't be read, the page itself and no other.
 */
type Asker = { readonly kind: "person"; readonly who: RoomPerson } | { readonly kind: "page"; readonly page: RoomPage };

/** The asker of an answer this page's message starts on a shared server. */
function askerOf(page: RoomPage): Asker {
	const who = pagePerson(page.req);
	return who ? { kind: "person", who } : { kind: "page", page };
}

/** Whether this page may answer a question of the asker's answer: a page of the same person, or the asking page itself; a page with no person answers only its own. */
function answersFor(page: RoomPage, asker: Asker): boolean {
	if (asker.kind === "page") return page === asker.page;
	const person = pagePerson(page.req);
	return person !== undefined && person.person === asker.who.person && person.space === asker.who.space;
}

/** The asker as every page is shown them: their name, null when nobody knows it. */
const askedByOf = (asker: Asker) => ({ name: asker.kind === "person" && asker.who.name ? asker.who.name : null });

/** A page's person as the server stamps them on a message they send: their ids alone; nothing where the edition names nobody. */
const authorOfPerson = (who: RoomPerson | undefined): MessageAuthor | undefined => (who ? { person: who.person, space: who.space } : undefined);

/**
 * Who sent a message, as the page of this reader is shown it: the reader
 * themselves, or the sender by the name they have now (the edition's personName
 * slot). A sender the slot no longer knows has left; a slot that throws, or none,
 * names nobody, as an unread record says nothing of whether they left.
 */
function senderFor(reader: RoomPerson | undefined, author: MessageAuthor): MessageSender {
	if (reader && reader.person === author.person && reader.space === author.space) return { is: "you" };
	let name: string | undefined;
	try {
		const slot = serverHooks().personName;
		if (!slot) return { is: "unnamed" };
		name = slot(author);
	} catch {
		return { is: "unnamed" };
	}
	if (name === undefined) return { is: "left" };
	return name ? { is: "named", name } : { is: "unnamed" };
}

/** A sender per reader, each author's name asked once: one page's frame or one conversation read. */
function sendersFor(reader: RoomPerson | undefined): (author: MessageAuthor) => MessageSender {
	const known = new Map<string, MessageSender>();
	return (author) => {
		const key = JSON.stringify([author.space, author.person]);
		const sender = known.get(key) ?? senderFor(reader, author);
		known.set(key, sender);
		return sender;
	};
}

/** The conversation's items as the person of this request is shown them: who sent each message, and no stored author. */
function itemsShownTo(req: FastifyRequest, items: readonly unknown[]): unknown[] {
	return itemsAsShown(items, sendersFor(pagePerson(req)));
}

/** The frame that tells a page who sent these messages, by id, as the person of its request is shown them; nothing when none has an author. */
function sendersFrame(authors: ReadonlyArray<readonly [string, MessageAuthor | undefined]>): ((req: FastifyRequest) => { type: "message_senders"; senders: Record<string, MessageSender> }) | undefined {
	const known = authors.filter((entry): entry is readonly [string, MessageAuthor] => entry[1] !== undefined);
	if (known.length === 0) return undefined;
	return (req) => {
		const senderOf = sendersFor(pagePerson(req));
		return { type: "message_senders", senders: Object.fromEntries(known.map(([id, author]) => [id, senderOf(author)])) };
	};
}

/** Whether a frame asks the person something: a card that takes an answer, not a notice or a status. */
function asksAnswer(frame: unknown): boolean {
	const shown = frame as { type?: unknown; id?: unknown; kind?: unknown } | null;
	return shown?.type === "ui_request" && typeof shown.id === "string" && shown.kind !== "notify" && shown.kind !== "status";
}

/**
 * A frame as this page is shown it while the asker's answer runs: a card that
 * asks names the asker on every page, so a saved card says who answered it, and
 * waits for them on any page that can't answer; any other frame as it is.
 */
function questionFor(page: RoomPage, frame: unknown, asker: Asker): string {
	if (!asksAnswer(frame)) return JSON.stringify(frame);
	const askedBy = askedByOf(asker);
	return JSON.stringify({ ...(frame as object), askedBy, ...(answersFor(page, asker) ? {} : { waitingFor: askedBy }) });
}

/**
 * One socket-shaped object over every page on a room, so the session that
 * opened it serves them all: a frame goes to every page whose connection is
 * open, a message comes with the page it came from, and "close" fires once,
 * when the last page has left. Its readyState is open while any page's is.
 */
type RoomSocket = {
	readonly OPEN: number;
	readonly readyState: number;
	send(data: string): void;
	/** Sends to every open page but this one; to every open page when it is none. */
	sendToOthers(data: string, except: RoomPage | undefined): void;
	/** Sends every open page its own copy. */
	sendEach(build: PageFrame): void;
	close(code?: number, reason?: string): void;
	on(event: "message", listener: RoomMessageListener): RoomSocket;
	on(event: "close", listener: () => void): RoomSocket;
	off(event: "message", listener: RoomMessageListener): RoomSocket;
	off(event: "close", listener: () => void): RoomSocket;
	/** Adds a page; false once the last page has left, when the socket takes no more. */
	add(page: RoomPage): boolean;
	/** Whether this page is on it now and still open: a page whose close has begun is gone already. */
	has(page: RoomPage): boolean;
};

const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;

function createRoomSocket(first: RoomPage): RoomSocket {
	const pages = new Set<RoomPage>();
	const messageListeners = new Set<RoomMessageListener>();
	const closeListeners = new Set<() => void>();
	let ended = false;
	const isOpen = (page: RoomPage) => page.socket.readyState === page.socket.OPEN;
	const room: RoomSocket = {
		OPEN: SOCKET_OPEN,
		get readyState() {
			if (ended) return SOCKET_CLOSED;
			return [...pages].some(isOpen) ? SOCKET_OPEN : SOCKET_CLOSING;
		},
		send(data) {
			room.sendToOthers(data, undefined);
		},
		sendToOthers(data, except) {
			for (const page of pages) {
				if (page === except || !isOpen(page)) continue;
				try { page.socket.send(data); } catch {}
			}
		},
		sendEach(build) {
			for (const page of pages) {
				if (!isOpen(page)) continue;
				try { page.socket.send(build(page)); } catch {}
			}
		},
		close(code, reason) {
			for (const page of [...pages]) {
				try { page.socket.close(code, reason); } catch {}
			}
		},
		on(event: "message" | "close", listener: any) {
			(event === "message" ? messageListeners : closeListeners).add(listener);
			return room;
		},
		off(event: "message" | "close", listener: any) {
			(event === "message" ? messageListeners : closeListeners).delete(listener);
			return room;
		},
		add(page) {
			if (ended) return false;
			pages.add(page);
			const onMessage = (raw: Buffer) => {
				for (const listener of [...messageListeners]) listener(raw, page);
			};
			page.socket.on("message", onMessage);
			page.socket.on("close", () => {
				page.socket.off("message", onMessage);
				pages.delete(page);
				if (pages.size > 0 || ended) return;
				ended = true;
				for (const listener of [...closeListeners]) listener();
			});
			return true;
		},
		has: (page) => pages.has(page) && isOpen(page),
	};
	room.add(first);
	return room;
}

// How long a room's open conversation must be quiet (no answer running, nothing
// sent) before a due schedule runs into it, and how long a question that
// scheduled answer asks waits for a page before it is declined: a person who
// stepped away gets the same grace either way. Only a smoke's own entry file
// shortens it.
let roomQuietSpellMs = 5 * 60_000;
const roomQuietSpell = (): number => roomQuietSpellMs;
function shortenRoomQuietSpellForSmoke(ms: number): void {
	roomQuietSpellMs = ms;
}

/** The code a scheduled answer through the host is refused with when the host ended before it could begin. */
const ROOM_HOST_ENDED = "room_host_ended";

/** A due schedule's prompt, run through the room's host as an answer of the room's own conversation. */
type ScheduledAsk = {
	readonly runId: string;
	readonly prompt: string;
	readonly signal?: AbortSignal;
	/** Called once when the signal or a server stop cut the answer, with what it spent until then. */
	readonly onCut?: (spent: Pick<ScheduledAnswer, "model" | "usage">) => void;
};
/** What a scheduled answer through the host gives back: the conversation, the model it ran on, its text and what it spent. */
type ScheduledAnswer = Pick<PersistentRoomBackgroundExecutionResult, "threadId" | "model" | "assistantText" | "usage" | "declinedQuestions">;

/** A room's one live session on a shared server: the conversation it holds, and how a page joins it. */
type RoomHost = {
	readonly conversationId: string;
	/** When a page last sent something or an answer last ended, in ms; the host's start until then. */
	lastActivityAt(): number;
	/** Runs a due schedule as the conversation's next answer; rejects with code `turn_running` when an answer took the room first, ROOM_HOST_ENDED when the host ended. */
	runScheduled(ask: ScheduledAsk): Promise<ScheduledAnswer>;
	/**
	 * A page asks to join; its own held frames, those it sent before the room opened, are handled after the catch-up, and whether
	 * they overflowed is read then, as more may come meanwhile. `admitted` runs once the host lets the page's person in.
	 */
	join(page: RoomPage, held: { frames: Buffer[]; overflowed: () => boolean; stopHolding: () => void }, admitted: () => void): Promise<void>;
	/** The room's conversation is another one now (its one writer, persistent-agent-threads.ts): every page follows it, and the host ends. */
	pointerMoved(conversationId: string): void;
	/** The room was archived or deleted for good: every page is told, the room lock is given up at once, and the host ends. */
	roomGone(how: "archived" | "deleted"): void;
	/** A delete is about to take the room: the lock is given up at once and the host ends; the pages are told the room was deleted only when the delete says it landed. */
	deleteBegins(): (landed: boolean) => void;
	/** The stored pending transfers of the host's conversation changed (its writers, persistent-agent-threads.ts): every page takes this queue as its own. */
	pendingTransfersChanged(blocks: readonly string[]): void;
};

// The rooms' hosts, by room id, on a shared server only: a page that opens a
// room with a host joins it. Registered in the same tick as the room lock is
// taken, removed in the same tick as the host's last page leaves.
const roomHosts = new Map<string, RoomHost>();

/** The room's host when this lock is the host's own: a web lock this process took for a room with a host, on a shared server. */
function hostHoldingRoom(roomId: string, lock: { surface?: string; pid?: number } | null | undefined): RoomHost | undefined {
	if (!lock || !isSharedServer() || lock.surface !== "web" || lock.pid !== process.pid) return undefined;
	return roomHosts.get(roomId);
}

export { answersFor, askedByOf, askerOf, authorOfPerson, itemsShownTo, pagePerson, questionFor, sendersFrame, ROOM_HOST_ENDED, DETACHED_TURN_LIMIT_MS, DETACHED_TURN_SILENCE_MS, OVERFLOW_RECOVERY_CEILING_MS, REATTACH_REPLAY_CAP_BYTES, SWITCH_WHILE_ANSWERING_MESSAGE, TEST_INTROSPECTION_ENABLED, createRoomSocket, detachedCookingRooms, detachedCookingTurnHandles, hostHoldingRoom, persistentRoomLiveSessions, reattachBufferProbe, roomHosts, roomQuietSpell, shortenRoomQuietSpellForSmoke };
export type { Asker, RoomPerson, DetachedCookingTurnHandle, PageFrame, PersistentRoomLiveSession, RoomHost, RoomPage, RoomSocket, ScheduledAnswer, ScheduledAsk };
