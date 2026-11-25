// Pure logic for the composer @-mention consult popover (Consult MR-3, spec §4.3).
//
// No React imports: everything here is a pure function so the smoke battery
// (apps/web-server/scripts/consult-mention-smoke.ts) can exercise it directly,
// and the React layer (components/mention-consult-popover.tsx + the composer in
// components/in-room-chat.tsx) only drives state and rendering.

// A room the user can consult. Sourced from the rooms list the client already
// fetches (GET /api/persistent-agents); only the fields the popover needs.
export interface MentionCandidateRoom {
	id: string;
	displayName: string;
	// PersistentAgentStatusValue on the live list, kept as a loose string so this
	// module never imports server types. The picker shows no status; the consult
	// card carries a room's memory warnings.
	status?: string;
	// Archived rooms are excluded from candidates. The live list is already
	// archived-free (the server filters them out), but the invariant is enforced
	// here too so the logic is correct in isolation.
	archived?: boolean;
	// memoryStatus.lastCheckpointAt — ISO string, or null when never checkpointed.
	lastCheckpointAt?: string | null;
}

// The active @-mention trigger in the draft: where the '@' sits, the caret, and
// the captured filter query.
export interface MentionQueryMatch {
	// Index of the '@' in the draft.
	start: number;
	// Caret index (end of the typed query).
	caret: number;
	// The captured filter query — may be empty right after typing '@'.
	query: string;
}

// The characters of a room word after '@': letters and digits in any script,
// and the '.', '_' and '-' a room's id may hold. The trigger, the label at the
// first space and the line for a later word share it.
const WORD = "[\\p{L}\\p{N}._-]";

// The trigger: the text BEFORE the caret is an '@' at the very start of the
// draft, the word typed so far, and at most the one space after it, so the list
// stays open when that space found no single room (see labelAtFirstSpace). An
// '@' anywhere else opens no list.
const MENTION_TRIGGER = new RegExp(`^@(${WORD}*) ?$`, "u");

// A word at the start of the draft with the whitespace after it, then the rest.
const LEADING_WORD = new RegExp(`^@(${WORD}+)\\s+`, "u");

// An '@' word after the start: at a line's start or after a space, never glued to a word (an email).
const LATER_WORD = new RegExp(`(?<=\\s)@(${WORD}+)`, "gu");

// Detect an active mention trigger against the text BEFORE the caret. Returns
// null when no trigger is open (the draft does not begin with '@', or the caret
// sits past the word and its space).
export function detectMentionQuery(text: string, caretIndex: number): MentionQueryMatch | null {
	const caret = Math.max(0, Math.min(caretIndex, text.length));
	const before = text.slice(0, caret);
	const match = MENTION_TRIGGER.exec(before);
	if (!match) return null;
	return { start: 0, caret, query: match[1] };
}

// Whether a room's name, or its id, starts with the word. An id counts by its
// start only where ids are made from names (idsByStart), as on the desktop: a
// shared server's ids are random, so a word that starts one says nothing.
function startsWithWord(room: MentionCandidateRoom, needle: string, idsByStart: boolean): boolean {
	return room.displayName.toLowerCase().startsWith(needle) || (idsByStart && room.id.toLowerCase().startsWith(needle));
}

// The one room a word names: the room whose name or id is the word, ignoring
// case; with none, the room whose name starts with it, or whose id does where
// ids count by their start. Two that fit either way name none: the page never
// picks between them.
export function fitRoom(word: string, candidates: MentionCandidateRoom[], currentRoomId: string, idsByStart = true): MentionCandidateRoom | null {
	const needle = word.toLowerCase();
	if (!needle) return null;
	const eligible = candidates.filter((room) => !isExcluded(room, currentRoomId));
	const exact = eligible.filter((room) => room.id.toLowerCase() === needle || room.displayName.toLowerCase() === needle);
	if (exact.length > 0) return exact.length === 1 ? exact[0] : null;
	const starts = eligible.filter((room) => startsWithWord(room, needle, idsByStart));
	return starts.length === 1 ? starts[0] : null;
}

// The draft after picking a room from the list: the '@' word and the space
// after it go, since the room sits on the box as a label.
export function draftAfterPick(text: string): string {
	return text.replace(new RegExp(`^@${WORD}*\\s*`, "u"), "");
}

// The room a word at the start names, once the space after it arrives (typed,
// or pasted with the rest): the draft keeps only what follows. Null while that
// space was already there before this edit, so a room is never picked again
// from text the person has gone on writing.
export function labelAtFirstSpace(previous: string, next: string, candidates: MentionCandidateRoom[], currentRoomId: string, idsByStart = true): { room: MentionCandidateRoom; rest: string } | null {
	const match = LEADING_WORD.exec(next);
	if (!match || LEADING_WORD.test(previous)) return null;
	const room = fitRoom(match[1], candidates, currentRoomId, idsByStart);
	return room ? { room, rest: next.slice(match[0].length) } : null;
}

// The first room a later '@' word names, for the line that says how to ask it.
export function laterMentionRoom(text: string, candidates: MentionCandidateRoom[], currentRoomId: string, idsByStart = true): MentionCandidateRoom | null {
	for (const match of text.matchAll(LATER_WORD)) {
		const room = fitRoom(match[1].replace(/\.+$/, ""), candidates, currentRoomId, idsByStart);
		if (room) return room;
	}
	return null;
}

function isExcluded(room: MentionCandidateRoom, currentRoomId: string): boolean {
	// The current room can never consult itself; archived rooms are never offered.
	return Boolean(room.archived) || room.id === currentRoomId;
}

// Freshest checkpoint first ordering key; unknown/never-checkpointed sinks last.
function checkpointOrder(room: MentionCandidateRoom): number {
	if (!room.lastCheckpointAt) return -Infinity;
	const parsed = Date.parse(room.lastCheckpointAt);
	return Number.isNaN(parsed) ? -Infinity : parsed;
}

// Filter + order the candidates for a given query. Excludes the current room and
// archived rooms; needs_absorb rooms are included (the warning surfaces later on
// the MR-4 card). Prefix match is case-insensitive against displayName, and
// against the id where ids count by their start (startsWithWord), and a whole
// id always lists its room.
// Order: freshest memory first (you usually want the most up-to-date room),
// then alphabetical by displayName as a stable tiebreak.
export function filterMentionCandidates(
	candidates: MentionCandidateRoom[],
	query: string,
	currentRoomId: string,
	idsByStart = true,
): MentionCandidateRoom[] {
	const needle = query.toLowerCase();
	return candidates
		.filter((room) => !isExcluded(room, currentRoomId))
		.filter((room) => {
			if (!needle) return true;
			return room.id.toLowerCase() === needle || startsWithWord(room, needle, idsByStart);
		})
		.sort((a, b) => {
			const fa = checkpointOrder(a);
			const fb = checkpointOrder(b);
			if (fa !== fb) return fb - fa;
			return a.displayName.localeCompare(b.displayName);
		});
}

// Send's hover while a room is on the box and no question is typed yet.
export const TYPE_QUESTION = "Type your question";

// The label's name for a room the list no longer has (archived or gone since it was picked).
export const ANOTHER_ROOM = "another room";

// While the room on the box is one the list no longer has: Send's hover, and with a full stop the line above the box and the card's line.
export const ROOM_GONE = "That room is no longer available";

// The room on the box's label, while the list still has it: null for one archived or gone since.
export function listedRoom(roomId: string, candidates: readonly MentionCandidateRoom[], currentRoomId: string): MentionCandidateRoom | null {
	return candidates.find((room) => room.id === roomId && !isExcluded(room, currentRoomId)) ?? null;
}

// Where a message goes, on the box's label and on a queued bubble.
export function askingWords(roomName: string): string {
	return `Asking ${roomName}`;
}

// The line above the box while a later '@' word names one of the person's rooms.
export function askHint(roomName: string): string {
	return `To ask ${roomName}, start the message with @.`;
}

// How many leading characters of the displayName the query matches, for the lila
// prefix highlight. Zero when the query only matched the id (no displayName
// prefix to highlight).
export function mentionHighlightLength(displayName: string, query: string): number {
	if (!query) return 0;
	return displayName.toLowerCase().startsWith(query.toLowerCase()) ? query.length : 0;
}

function relativeTime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 45) return "moments ago";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
	if (days < 30) {
		const weeks = Math.round(days / 7);
		return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
	}
	if (days < 365) {
		const months = Math.round(days / 30);
		return `${months} month${months === 1 ? "" : "s"} ago`;
	}
	const years = Math.round(days / 365);
	return `${years} year${years === 1 ? "" : "s"} ago`;
}

// The right-aligned memory-freshness hint, e.g. "remembered 2 days ago".
// Returns null when the checkpoint time is unknown or unparseable — the row then
// omits the hint (spec §4.3).
export function memoryFreshnessHint(lastCheckpointAt: string | null | undefined, now: number = Date.now()): string | null {
	if (!lastCheckpointAt) return null;
	const parsed = Date.parse(lastCheckpointAt);
	if (Number.isNaN(parsed)) return null;
	return `remembered ${relativeTime(Math.max(0, now - parsed))}`;
}
