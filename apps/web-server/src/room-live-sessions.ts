import type { PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import type { SteerRequest, SteerRouted } from "./steer-route.js";
import type { ShownPrompt } from "./thread-items-by-id.js";

// In-process registry of live web (WS) room sessions, keyed by agent id. The
// room lock guarantees at most one live web session per room, so a plain map
// is enough. Lifecycle endpoints (Memento) use this to quiesce an in-flight
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
	/** Route future turn frames to `sink` and stand the away limits down (somebody is watching again). Returns false for a stale claimant or a settled turn. */
	adopt: (connectionId: string, sink: (frame: string) => void, hooks: { onSettled: () => void; onDisplaced: () => void }) => boolean;
	/** The adopter left (or died) mid-cook: back to detached cooking with the away limits re-armed and frames buffer-only. No-op for a stale claimant. */
	redetach: (connectionId: string) => void;
	/** The adopter is ready for live frames (its replay is done): the turn's questions reach it again, and any still open are asked again there. An adopter that cannot answer (a viewing-only device) leaves them declined as if nobody were in the room. No-op for a stale claimant. */
	attachQuestions: (connectionId: string, canAnswer: boolean) => void;
	/** The adopter's answer to one of the turn's questions. Ignored from any other connection, so only the window that holds the turn answers. */
	answerQuestion: (connectionId: string, id: string, value: unknown) => void;
	/** Stop the cooking turn through the same cancelling machinery the abort frame uses. Claimant-checked like adopt/redetach: a displaced connection's Stop must never abort the stream the current adopter is watching. `shown`: how much of the answer being written the page had shown; `forNext`: the person's waiting messages stopped it, not their Stop. */
	stop: (connectionId: string, shown?: number, forNext?: boolean) => Promise<void>;
	/** Stop after the answer ended, naming the part the page still revealed (`shown`: its characters kept), claimant-checked like stop. */
	stopRevealPart: (connectionId: string, partId: string, shown: number) => void;
	/** A message sent while the cooking turn answers, routed as the steer frame is, claimant-checked like stop; resolves to the frame the page gets. */
	steerTurn: (connectionId: string, request: SteerRequest) => Promise<SteerRouted>;
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

export { DETACHED_TURN_LIMIT_MS, DETACHED_TURN_SILENCE_MS, OVERFLOW_RECOVERY_CEILING_MS, REATTACH_REPLAY_CAP_BYTES, SWITCH_WHILE_ANSWERING_MESSAGE, TEST_INTROSPECTION_ENABLED, detachedCookingRooms, detachedCookingTurnHandles, persistentRoomLiveSessions, reattachBufferProbe };
export type { DetachedCookingTurnHandle, PersistentRoomLiveSession };
