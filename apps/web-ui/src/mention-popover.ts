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
	// module never imports server types. Drives the status dot only.
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

// A resolved leading mention: the room the draft names and the question with the
// mention stripped.
export interface ResolvedLeadingMention {
	room: MentionCandidateRoom;
	question: string;
}

export interface MentionCompletion {
	text: string;
	caret: number;
}

// Spec §4.3 trigger: an '@' at a word boundary (start-of-text or after
// whitespace), then the mention charset, anchored to the end of the text BEFORE
// the caret.
const MENTION_TRIGGER = /(^|\s)@([a-zA-Z0-9._-]*)$/;

// A leading mention: the draft begins with '@<token>' followed by whitespace,
// then the question. Token charset matches the trigger. The token is the room id
// the completion inserts (see completeMention).
const LEADING_MENTION = /^@([a-zA-Z0-9._-]+)\s+([\s\S]*)$/;

// Detect an active mention trigger against the text BEFORE the caret. Returns
// null when no trigger is open (no '@', '@' not at a word boundary, or the caret
// sits inside a word after the query).
export function detectMentionQuery(text: string, caretIndex: number): MentionQueryMatch | null {
	const caret = Math.max(0, Math.min(caretIndex, text.length));
	const before = text.slice(0, caret);
	const match = MENTION_TRIGGER.exec(before);
	if (!match) return null;
	const query = match[2];
	const start = caret - query.length - 1; // position of the '@'
	return { start, caret, query };
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
// the MR-4 card). Prefix match is case-insensitive against id OR displayName.
// Order: freshest memory first (you usually want the most up-to-date room),
// then alphabetical by displayName as a stable tiebreak.
export function filterMentionCandidates(
	candidates: MentionCandidateRoom[],
	query: string,
	currentRoomId: string,
): MentionCandidateRoom[] {
	const needle = query.toLowerCase();
	return candidates
		.filter((room) => !isExcluded(room, currentRoomId))
		.filter((room) => {
			if (!needle) return true;
			return room.id.toLowerCase().startsWith(needle) || room.displayName.toLowerCase().startsWith(needle);
		})
		.sort((a, b) => {
			const fa = checkpointOrder(a);
			const fb = checkpointOrder(b);
			if (fa !== fb) return fb - fa;
			return a.displayName.localeCompare(b.displayName);
		});
}

// Complete the mention in the draft: replace the '@query' span with '@<id> '
// (trailing space) and report the caret position after it. The mention token is
// the room id — it always matches the trigger charset, unlike displayNames which
// may contain spaces or punctuation.
export function completeMention(text: string, match: MentionQueryMatch, room: MentionCandidateRoom): MentionCompletion {
	const before = text.slice(0, match.start);
	const after = text.slice(match.caret).replace(/^\s+/, ""); // avoid a doubled space when completing mid-text
	const token = `@${room.id} `;
	const nextText = `${before}${token}${after}`;
	return { text: nextText, caret: before.length + token.length };
}

// Resolve a leading mention at the START of the draft to a known room and strip
// it, yielding the question to consult with. Returns null (→ normal send) when
// the draft does not begin with a mention, the token names no known/eligible
// room, or there is no question after the mention.
export function resolveLeadingMention(
	text: string,
	candidates: MentionCandidateRoom[],
	currentRoomId: string,
): ResolvedLeadingMention | null {
	const match = LEADING_MENTION.exec(text);
	if (!match) return null;
	const token = match[1].toLowerCase();
	const question = match[2].trim();
	if (!question) return null;
	const room = candidates.find((candidate) => !isExcluded(candidate, currentRoomId) && candidate.id.toLowerCase() === token);
	if (!room) return null;
	return { room, question };
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

// The right-aligned memory-freshness hint, e.g. "last checkpoint 2 days ago".
// Returns null when the checkpoint time is unknown or unparseable — the row then
// omits the hint (spec §4.3).
export function memoryFreshnessHint(lastCheckpointAt: string | null | undefined, now: number = Date.now()): string | null {
	if (!lastCheckpointAt) return null;
	const parsed = Date.parse(lastCheckpointAt);
	if (Number.isNaN(parsed)) return null;
	return `last checkpoint ${relativeTime(Math.max(0, now - parsed))}`;
}
