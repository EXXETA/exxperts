// What a restart is known to lose today, and the cases that once failed and pass
// now. restart-rows-smoke.ts runs them all, so this list stays true: a known case
// that no longer fails fails the check until its line comes off, a probe that
// fails with no line here fails it too, and a settled case that fails again fails
// it. RESTART_ONLY=<id> in front of a repro line runs that one alone.

export interface KnownCase {
	id: string;
	/** The file that holds what is lost. */
	file: string;
	/** What the person meets. */
	meets: string;
	repro: string;
}

export const KNOWN_CASES: KnownCase[] = [];

/**
 * A kill at one write, after which the next turn must work: a case that once
 * failed and passes today, or a piece's own write (PIECE_WRITES). Which write
 * to die at is found by its target, so a step that moves fails nobody and a
 * write that is gone from the trace fails the check. The run prints the step
 * it found as a KILL_ONLY= line.
 */
export interface SettledCase {
	id: string;
	what: string;
	save: string;
	op: string;
	target: RegExp;
	how: string;
	/** Runs on a server that counts as shared. */
	sharedServer?: boolean;
	/** The smoke that line runs on: none for a case only the rows run. */
	killSmoke?: string;
	repro: string;
}

const FORGET = "npm run smokes kill-at-write-forget-turn";
const REMEMBER = "npm run smokes kill-at-write-remember";
const NOTES_AND_FILES = "npm run smokes kill-at-write-smoke";
const CREATE = "npm run smokes kill-at-write-create";

export const SETTLED_CASES: SettledCase[] = [
	{ id: "forget-boot-snapshot", what: "Forget cut after the boot snapshot was written: the retry met it and stuck, with the words in two files.", save: "forget", op: "renameSync", target: /postmem_[^/]*\.jsonl$/, how: "before", killSmoke: FORGET, repro: "RESTART_ONLY=forget-boot-snapshot npm run smokes restart-rows" },
	{ id: "remember-boot-snapshot", what: "Remember cut after the boot snapshot was written: the retry wrote the page twice.", save: "remember", op: "renameSync", target: /postcp_[^/]*\.jsonl$/, how: "before", killSmoke: REMEMBER, repro: "RESTART_ONLY=remember-boot-snapshot npm run smokes restart-rows" },
	{ id: "empty-memento-record", what: "Forget cut as it wrote its memento record: an empty record.", save: "forget", op: "writeFileSync", target: /events[\\/]memento[\\/].*\.tmp-/, how: "torn-empty", killSmoke: FORGET, repro: "RESTART_ONLY=empty-memento-record npm run smokes restart-rows" },
	{ id: "doubled-note", what: "A note added and landed, the answer never sent: the retry doubled the note.", save: "add", op: "renameSync", target: /L1b[\\/]current\.md$/, how: "after", killSmoke: NOTES_AND_FILES, repro: "RESTART_ONLY=doubled-note npm run smokes restart-rows" },
	{ id: "note-in-two-places", what: "A note deleted from the core, not yet in the archive: the note in both or in neither.", save: "delete", op: "renameSync", target: /L1b[\\/]archive[\\/]entries\.md$/, how: "before", killSmoke: NOTES_AND_FILES, repro: "RESTART_ONLY=note-in-two-places npm run smokes restart-rows" },
	{ id: "partial-attachment", what: "An upload cut mid-write: a partial attachment listed.", save: "upload", op: "writeSync", target: /\.kill-upload\.txt\.tmp-/, how: "torn-half", killSmoke: NOTES_AND_FILES, repro: "RESTART_ONLY=partial-attachment npm run smokes restart-rows" },
	{ id: "attachment-listed-twice", what: "An upload landed, the answer never sent: a retry listed it twice.", save: "upload", op: "linkSync", target: /kill-upload\.txt$/, how: "after", killSmoke: NOTES_AND_FILES, repro: "RESTART_ONLY=attachment-listed-twice npm run smokes restart-rows" },
	{ id: "half-built-room", what: "A room cut while it was built: half a room, status error, memory refused.", save: "create", op: "writeFileSync", target: /\.being-built-/, how: "torn-half", killSmoke: CREATE, repro: "RESTART_ONLY=half-built-room npm run smokes restart-rows" },
	{ id: "second-room-from-a-retry", what: "A room landed, the answer never sent: the retry made a second room.", save: "create", op: "renameSync", target: /personalized-agents[\\/]kill-created-room$/, how: "after", killSmoke: CREATE, repro: "RESTART_ONLY=second-room-from-a-retry npm run smokes restart-rows" },
	{ id: "torn-session-append", what: "A session append cut in half: the next turn failed on the torn line.", save: "turn", op: "writeFileSync", target: /pi-sessions[\\/]pi_kill_room\.jsonl$/, how: "torn-half", killSmoke: FORGET, repro: "RESTART_ONLY=torn-session-append npm run smokes restart-rows" },
	{ id: "torn-session-append-shared", what: "The same on a shared server.", save: "turn", op: "writeFileSync", target: /pi-sessions[\\/]pi_kill_room\.jsonl$/, how: "torn-half", sharedServer: true, repro: "RESTART_ONLY=torn-session-append-shared npm run smokes restart-rows" },
];

/** Each piece's file in the room folder (turn-pieces-store.ts), its write cut halfway by a kill; the saves that write them are restart-rows-smoke.ts's own. */
export const PIECE_WRITES: SettledCase[] = [
	{ id: "torn-running-turn", what: "A keyed turn's running-turn file cut as it began.", save: "keyed-turn", op: "writeFileSync", target: /turn-pieces[\\/]pi_kill_room\.running\.json\.tmp-/, how: "torn-half", repro: "RESTART_ONLY=torn-running-turn npm run smokes restart-rows" },
	{ id: "torn-turn-items", what: "The latest-turn marker cut as a turn began.", save: "keyed-turn", op: "writeFileSync", target: /turn-pieces[\\/]pi_kill_room\.items\.json\.tmp-/, how: "torn-half", repro: "RESTART_ONLY=torn-turn-items npm run smokes restart-rows" },
	{ id: "torn-taken-messages", what: "The taken messages cut as the turn took one.", save: "taken-message", op: "writeFileSync", target: /turn-pieces[\\/]pi_kill_room\.taken\.json\.tmp-/, how: "torn-half", repro: "RESTART_ONLY=torn-taken-messages npm run smokes restart-rows" },
	{ id: "torn-stop-note", what: "The Stop note cut as the stopped turn settled.", save: "stop-note", op: "writeFileSync", target: /turn-pieces[\\/]pi_kill_room\.note\.json\.tmp-/, how: "torn-half", repro: "RESTART_ONLY=torn-stop-note npm run smokes restart-rows" },
	{ id: "torn-kept-landing", what: "The kept landing cut as the refused turn settled.", save: "kept-landing", op: "writeFileSync", target: /turn-pieces[\\/]pi_kill_room\.kept\.json\.tmp-/, how: "torn-half", repro: "RESTART_ONLY=torn-kept-landing npm run smokes restart-rows" },
];
