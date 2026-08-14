import type { ContextEvent, ExtensionAPI } from "@exxeta/exxperts-runtime";

// Old bulky tool results stop being replayed in full on every later turn.
//
// A room's session file keeps everything a tool ever returned: a fetched page
// can be 50KB, a search can be a wall of snippets, a file read can be a whole
// document. All of it is replayed into the model's context on every subsequent
// turn, forever, so a long-lived room pays for its oldest page over and over.
//
// The fix runs at replay time only. This hooks the `context` event, which the
// extension runner fires with a structuredClone of the message list right
// before the provider call, so what is edited here is a copy: the agent's own
// state and the session file on disk stay lossless. Nothing is ever deleted;
// an aged result is replaced by a short note that says what was there and
// tells the model it can run the tool again.
//
// The unit of age is the USER turn, not the assistant message. That distinction
// is the whole safety of this: the agent loop appends one assistant message per
// tool round trip, so a single question that takes fourteen fetches to answer
// produces fourteen assistant messages. Counting those as turns would stub the
// room's own working notes out from under it halfway through the job it is
// still doing, and would move the boundary several times inside one question,
// which is exactly the repeated cache invalidation the step below exists to
// prevent. A tool result belongs to the user turn it happened within, and
// everything in the most recent few user turns is kept whole no matter how many
// tool steps those turns took.
//
// Three things this deliberately does NOT touch:
//
//  - Compaction reads the un-aged message list, so a compaction summary is
//    still written from the real text of every tool result rather than from
//    these notes. That payload is bounded on its own: generateSummary
//    (compaction/compaction.ts:540-562) serializes through
//    serializeConversation (compaction/utils.ts:109-160), which truncates every
//    tool result to TOOL_RESULT_MAX_CHARS = 2000 (compaction/utils.ts:89, 156)
//    and drops image blocks entirely (utils.ts:150-153). Measured on a
//    twenty-result conversation carrying 50,000 characters and a 100,000
//    character image each: 3.0 MB of messages serialized to a 42 KB prompt,
//    longest single result 2,091 characters, no image data present. So aging
//    the replayed context cannot set up an oversized summarization request.
//  - Right after a compaction the kept tail holds only a few user turns, so the
//    boundary computes to zero and aging quiesces by itself until the room has
//    accumulated turns again. That is the correct behaviour and needs no
//    special case: a freshly compacted room has nothing old to age.
//  - Checkpoints, absorb and structural review read the session store directly
//    and are likewise unaffected, which is what keeps them full fidelity.
//
// The stub keeps the tool call id, tool name, error flag and timestamp. Every
// provider requires each tool call in an assistant message to be answered by a
// matching tool result, so a dropped result would break the request outright.

// ---------------------------------------------------------------------------
// Policy. Constants for now: there is no setting for this, and the defaults are
// chosen so that a normal working session never notices.
// ---------------------------------------------------------------------------

// Only results from these tools are ever aged. Everything here can return a
// large body of text that the room can fetch again if it turns out to need it.
// Two deliberate absences:
//  - `read`, the workspace file read, is left out. In a room with local file
//    access the model reconstructs the exact old text of an edit from what an
//    earlier read returned, so aging a read is a failed edit later.
//  - Tools whose answers are small by construction (directory listings, writes,
//    connector calls) are left out too, because stubbing them would cost
//    context rather than save it.
export const AGING_TOOL_ALLOWLIST = [
	"fetch_url",
	"web_search",
	"read_file",
	"read_spreadsheet",
	"search_file",
	"grep",
] as const;

// Results at or below this size are never aged: the note that would replace
// them is not meaningfully smaller than the result itself. Image data counts
// towards the size, so a real screenshot is over the line on its own while a
// small icon stays under it.
export const MIN_AGING_CHARS = 2000;

// Results produced in the most recent this-many user turns are always kept
// verbatim, however large they are and however many tool steps those turns
// took. This is the working set: the model is still reasoning about what it
// just fetched.
export const KEEP_WINDOW_TURNS = 6;

// The aging boundary only moves in steps of this many user turns. Prompt
// caching on the subscription providers keys on a prefix of the conversation,
// so any edit to an older message invalidates the cache from that point on. A
// boundary that advanced every turn would invalidate the cache every turn,
// which costs more than the aging saves. Quantized like this, and measured in
// user turns so that a long tool-heavy answer cannot move it at all, the cache
// is invalidated at most once per this many turns and is warm in between.
export const AGING_BOUNDARY_STEP_TURNS = 4;

const AGING_TOOL_SET = new Set<string>(AGING_TOOL_ALLOWLIST);

export interface AgedToolResultMarker {
	originalChars: number;
	imageCount: number;
	charsSaved: number;
}

export interface ToolResultAgingStats {
	agedCount: number;
	charsSaved: number;
}

interface TextBlockLike {
	type: "text";
	text: string;
}

interface ToolResultLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: unknown;
	details?: unknown;
	isError?: boolean;
	timestamp?: number | string;
}

function isToolResult(message: unknown): message is ToolResultLike {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "toolResult";
}

function isUser(message: unknown): boolean {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "user";
}

/**
 * What a tool result actually costs to replay: its text, and the encoded size
 * of any images it carries. Images are measured rather than merely counted,
 * because a screenshot is the largest thing a result can hold and a favicon is
 * not, and the size floor should be able to tell those apart.
 */
function measureContent(content: unknown): { chars: number; imageChars: number; imageCount: number } {
	if (typeof content === "string") return { chars: content.length, imageChars: 0, imageCount: 0 };
	if (!Array.isArray(content)) return { chars: 0, imageChars: 0, imageCount: 0 };
	let chars = 0;
	let imageChars = 0;
	let imageCount = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const type = (block as { type?: unknown }).type;
		if (type === "image") {
			imageCount += 1;
			const data = (block as { data?: unknown }).data;
			if (typeof data === "string") imageChars += data.length;
			continue;
		}
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") chars += text.length;
	}
	return { chars, imageChars, imageCount };
}

/**
 * The note that replaces an aged result. Plain language on purpose: the model
 * reads this and has to understand both what is missing and what to do about it.
 */
export function agedToolResultNote(input: { toolName: string; chars: number; imageCount: number; timestamp?: number | string }): string {
	const size = input.imageCount > 0
		? `${input.chars} characters and ${input.imageCount} ${input.imageCount === 1 ? "image" : "images"}`
		: `${input.chars} characters`;
	const stamp = Number(input.timestamp);
	const when = Number.isFinite(stamp) && input.timestamp !== undefined && input.timestamp !== null && input.timestamp !== ""
		? new Date(stamp).toISOString()
		: "an earlier point in this conversation";
	return `[An old tool result was removed here to keep the conversation lean: ${input.toolName}, ${size}, from ${when}. Re-run the tool if you need this information again.]`;
}

/**
 * Which user turn the aging boundary sits at, given how many user turns the
 * conversation has. Results from turns at or below the boundary are aged. Zero
 * means nothing is old enough yet, which is also the state a freshly compacted
 * room is in.
 */
export function agingBoundaryTurn(totalUserTurns: number): number {
	const beyondKeepWindow = totalUserTurns - KEEP_WINDOW_TURNS;
	if (beyondKeepWindow <= 0) return 0;
	return Math.floor(beyondKeepWindow / AGING_BOUNDARY_STEP_TURNS) * AGING_BOUNDARY_STEP_TURNS;
}

/** Reads the marker this extension leaves on a result it aged, for diagnostics. */
export function readAgedToolResultMarker(message: unknown): AgedToolResultMarker | null {
	if (!isToolResult(message)) return null;
	const details = (message as ToolResultLike).details;
	if (!details || typeof details !== "object") return null;
	const marker = (details as { agedToolResult?: unknown }).agedToolResult;
	if (!marker || typeof marker !== "object") return null;
	const originalChars = (marker as { originalChars?: unknown }).originalChars;
	if (typeof originalChars !== "number") return null;
	const imageCount = (marker as { imageCount?: unknown }).imageCount;
	const charsSaved = (marker as { charsSaved?: unknown }).charsSaved;
	return {
		originalChars,
		imageCount: typeof imageCount === "number" ? imageCount : 0,
		charsSaved: typeof charsSaved === "number" ? charsSaved : 0,
	};
}

/**
 * The whole policy, as a pure function over a message list. Same input, same
 * output: nothing here reads a clock or any state outside the list.
 *
 * The caller owns the array. This returns a new array; only the tool results it
 * ages are new objects, every other message is passed through untouched so the
 * cached prefix stays byte-identical.
 */
export function ageToolResults<T>(messages: readonly T[]): { messages: T[]; stats: ToolResultAgingStats } {
	const stats: ToolResultAgingStats = { agedCount: 0, charsSaved: 0 };
	let totalUserTurns = 0;
	for (const message of messages) if (isUser(message)) totalUserTurns += 1;

	const boundary = agingBoundaryTurn(totalUserTurns);
	if (boundary <= 0) return { messages: [...messages], stats };

	// A tool result belongs to the user turn it happened within, which is the
	// most recent user message before it, however many assistant messages and
	// tool round trips that turn went through.
	let turn = 0;
	const result: T[] = [];
	for (const message of messages) {
		if (isUser(message)) turn += 1;
		// turn 0 means a result with no user message before it, which is not a
		// shape this should be editing: leave anything like that exactly as found.
		if (turn === 0 || turn > boundary || !isToolResult(message)) {
			result.push(message);
			continue;
		}
		const toolResult = message as ToolResultLike;
		if (toolResult.isError === true || !AGING_TOOL_SET.has(toolResult.toolName)) {
			result.push(message);
			continue;
		}
		const { chars, imageChars, imageCount } = measureContent(toolResult.content);
		const replayCost = chars + imageChars;
		if (replayCost <= MIN_AGING_CHARS) {
			result.push(message);
			continue;
		}
		const note: TextBlockLike = {
			type: "text",
			text: agedToolResultNote({ toolName: toolResult.toolName, chars, imageCount, timestamp: toolResult.timestamp }),
		};
		const charsSaved = Math.max(0, replayCost - note.text.length);
		const aged = {
			...toolResult,
			content: [note],
			details: { agedToolResult: { originalChars: chars, imageCount, charsSaved } satisfies AgedToolResultMarker },
		};
		stats.agedCount += 1;
		stats.charsSaved += charsSaved;
		result.push(aged as unknown as T);
	}
	return { messages: result, stats };
}

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event: ContextEvent) => {
		const messages = Array.isArray(event?.messages) ? event.messages : [];
		if (messages.length === 0) return undefined;
		const aged = ageToolResults(messages);
		if (aged.stats.agedCount === 0) return undefined;
		return { messages: aged.messages };
	});
}
